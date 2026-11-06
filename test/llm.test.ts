import { describe, expect, it } from "vitest";

import {
  chatComplete,
  DEFAULT_FLASH_MODEL,
  formatUsageLog,
  DEFAULT_PRO_MODEL,
  pickTaskPolicy,
  resolveLlmConfig,
  type FetchLike,
  type LlmConfig,
} from "../src/autonomy/llm.js";

const cfg: LlmConfig = { baseUrl: "https://example.test", apiKey: "sk-secret", model: "m1", proModel: "p1", timeoutMs: 1000 };

function fetchReturning(status: number, body: string): FetchLike {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
}

function okBody(content: string): string {
  return JSON.stringify({ model: "m1", choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
}

describe("resolveLlmConfig", () => {
  it("缺 key 返回 null（自主进程据此降级）", () => {
    expect(resolveLlmConfig({})).toBeNull();
    expect(resolveLlmConfig({ AI_COMPANION_LLM_API_KEY: "  " })).toBeNull();
  });

  it("默认值 + 环境覆盖 + 去掉 baseUrl 尾部斜杠（F353：默认 flash/pro 双档、超时 90s）", () => {
    const got = resolveLlmConfig({ AI_COMPANION_LLM_API_KEY: "k", AI_COMPANION_LLM_BASE_URL: "https://x.test/v1/", AI_COMPANION_LLM_MODEL: "m2" });
    expect(got).toEqual({
      baseUrl: "https://x.test/v1",
      apiKey: "k",
      model: "m2",
      proModel: DEFAULT_PRO_MODEL,
      timeoutMs: 90_000,
    });
    const defaults = resolveLlmConfig({ AI_COMPANION_LLM_API_KEY: "k" });
    expect(defaults?.model).toBe(DEFAULT_FLASH_MODEL);
    expect(defaults?.proModel).toBe(DEFAULT_PRO_MODEL);
    expect(
      resolveLlmConfig({ AI_COMPANION_LLM_API_KEY: "k", AI_COMPANION_LLM_MODEL_PRO: "pro-x", AI_COMPANION_LLM_TIMEOUT_MS: "5000" })?.proModel,
    ).toBe("pro-x");
  });
});

describe("pickTaskPolicy（F353 任务档位表）", () => {
  it("对话/理解类用 pro+thinking，短句类用 flash 非思考", () => {
    expect(pickTaskPolicy(cfg, "chat")).toEqual({ model: "p1", thinking: "enabled", reasoningEffort: "low", maxTokens: 800 });
    expect(pickTaskPolicy(cfg, "dream")).toEqual({ model: "p1", thinking: "enabled", reasoningEffort: "high", maxTokens: 600 });
    expect(pickTaskPolicy(cfg, "reconsolidation").reasoningEffort).toBe("high");
    expect(pickTaskPolicy(cfg, "self_model").maxTokens).toBe(900);
    expect(pickTaskPolicy(cfg, "insight").thinking).toBe("enabled");
    for (const task of ["proactive", "selftalk", "learn"] as const) {
      const policy = pickTaskPolicy(cfg, task);
      expect(policy).toEqual({ model: "m1", thinking: "disabled", reasoningEffort: undefined, maxTokens: 400 });
    }
  });

  it("没有 proModel 时退回默认 pro 名，不返回 undefined", () => {
    const legacy: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m1", timeoutMs: 1000 };
    expect(pickTaskPolicy(legacy, "chat").model).toBe(DEFAULT_PRO_MODEL);
  });
});

describe("chatComplete", () => {
  it("解析 choices/usage，并把 key 放在 Authorization", async () => {
    let seen: { url: string; auth: string | undefined; body: string } | undefined;
    const fetchImpl: FetchLike = (url, init) => {
      seen = { url, auth: init.headers.authorization, body: init.body };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(okBody(" 你好 ")) });
    };
    const reply = await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl });
    expect(reply.text).toBe("你好");
    expect(reply.model).toBe("m1");
    expect(reply.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    expect(seen?.url).toBe("https://example.test/chat/completions");
    expect(seen?.auth).toBe("Bearer sk-secret");
    expect(seen?.body).toContain('"model":"m1"');
  });

  it("未指定任务时：显式关闭 thinking、不带 reasoning_effort、保留 temperature（旧行为）", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(okBody("好")) });
    };
    await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl });
    expect(body?.model).toBe("m1");
    expect(body?.thinking).toEqual({ type: "disabled" });
    expect(body?.reasoning_effort).toBeUndefined();
    expect(body?.temperature).toBe(0.9);
    expect(body?.max_tokens).toBe(220);
  });

  it("指定 task=chat 时：走 pro、开 thinking、带 reasoning_effort、不带 temperature；显式 maxTokens 覆盖档位", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(okBody("好")) });
    };
    await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl, task: "chat" });
    expect(body?.model).toBe("p1");
    expect(body?.thinking).toEqual({ type: "enabled" });
    expect(body?.reasoning_effort).toBe("low");
    expect(body?.temperature).toBeUndefined();
    expect(body?.max_tokens).toBe(800);

    await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl, task: "chat", maxTokens: 64 });
    expect(body?.max_tokens).toBe(64);
  });

  it("thinking 默认开启的模型若被思考链吃光 token，报错文案可区分", async () => {
    const body = JSON.stringify({ model: "x", choices: [{ message: { content: "", reasoning_content: "想了很久" } }] });
    const err = await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl: fetchReturning(200, body) }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("思考链占满了 max_tokens");
  });

  it("非 2xx 抛错，错误里有状态码与截断正文，但不含 key", async () => {
    const err = await chatComplete(cfg, [{ role: "user", content: "hi" }], {
      fetchImpl: fetchReturning(429, "rate limited ".repeat(50)),
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain("429");
    expect(err.message).not.toContain("sk-secret");
    expect(err.message.length).toBeLessThan(400);
  });

  it("没有内容 / 不是 JSON 都抛错", async () => {
    await expect(chatComplete(cfg, [], { fetchImpl: fetchReturning(200, JSON.stringify({ choices: [] })) })).rejects.toThrow("没有内容");
    await expect(chatComplete(cfg, [], { fetchImpl: fetchReturning(200, "<html>") })).rejects.toThrow("不是 JSON");
  });
});

describe("F354：用量与缓存命中", () => {
  it("usage 透传 prompt/completion 与 cache 命中/未命中字段", async () => {
    const fetchImpl = fetchReturning(
      200,
      JSON.stringify({
        model: "m1",
        choices: [{ message: { content: "好" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 },
      }),
    );
    const reply = await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl });
    expect(reply.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cacheHitTokens: 64,
      cacheMissTokens: 36,
    });
  });

  it("服务端没给 cache 字段时是 undefined，不伪造 0", async () => {
    const reply = await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl: fetchReturning(200, okBody("好")) });
    expect(reply.usage).toEqual({ promptTokens: 7, completionTokens: 3, cacheHitTokens: undefined, cacheMissTokens: undefined });
  });

  it("formatUsageLog：有 usage 输出一行，无 usage 返回 undefined", async () => {
    const withUsage = await chatComplete(cfg, [{ role: "user", content: "hi" }], { fetchImpl: fetchReturning(200, okBody("好")) });
    // 缺失的 cache 字段不出现（不把“未知”伪造成 0 命中）
    expect(formatUsageLog("chat", withUsage)).toBe("[llm] task=chat model=m1 in=7 out=3");
    expect(formatUsageLog("chat", { text: "x", model: "m1", usage: undefined })).toBeUndefined();
    expect(
      formatUsageLog("chat", {
        text: "x",
        model: "p1",
        usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 64, cacheMissTokens: 36 },
      }),
    ).toBe("[llm] task=chat model=p1 in=100 out=20 cached=64 miss=36");
  });
});
