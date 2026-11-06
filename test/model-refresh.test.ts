import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelRefresher, MODEL_RECHECK_MS } from "../src/assembly/model-refresh.js";
import type { LlmConfig } from "../src/autonomy/llm.js";

const llm = (model: string): LlmConfig =>
  ({ baseUrl: "https://x.test", apiKey: "k", model, timeoutMs: 1000 }) as LlmConfig;

interface Harness {
  readonly logs: string[];
  readonly env: NodeJS.ProcessEnv;
  setNow: (ms: number) => void;
  setCurrent: (v: LlmConfig | null | undefined) => void;
  current: () => LlmConfig | null | undefined;
  loadCalls: () => number;
  refresh: () => Promise<void>;
}

const harness = (
  initial: LlmConfig | null | undefined,
  loadResult: (() => Promise<{ config: LlmConfig; keySource: string } | null>) | null,
): Harness => {
  let current = initial;
  let nowMs = 1_700_000_000_000; // 真实量级：首次 tick 一定先查一次，之后才节流
  let loads = 0;
  const logs: string[] = [];
  const refresh = createModelRefresher(
    {
      log: (line: string) => logs.push(line),
      now: () => nowMs,
      loadConfig: async () => {
        loads += 1;
        if (loadResult === null) throw new Error("boom");
        return loadResult();
      },
      getLlm: () => current,
      setLlm: (next) => {
        current = next;
      },
    } as never,
    {},
  );
  return {
    logs,
    env: {},
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setCurrent: (v) => {
      current = v;
    },
    current: () => current,
    loadCalls: () => loads,
    refresh,
  };
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("模型凭据刷新（F282）", () => {
  it("没有凭据时每拍都查：一旦读到就装上并记一条日志（装上后转为 30 分钟节流）", async () => {
    const h = harness(null, async () => ({ config: llm("m1"), keySource: "env" }));
    await h.refresh();
    expect(h.loadCalls()).toBe(1);
    expect(h.current()?.model).toBe("m1");
    expect(h.logs.join("\n")).toContain("检测到凭据（key=env）");
    await h.refresh();
    expect(h.loadCalls()).toBe(1);
    h.setNow(1_700_000_000_000 + MODEL_RECHECK_MS);
    await h.refresh();
    expect(h.loadCalls()).toBe(2);
  });

  it("已有凭据时：首拍查一次，此后 30 分钟内不重查，到点再复核", async () => {
    const h = harness(llm("m1"), async () => ({ config: llm("m1"), keySource: "env" }));
    await h.refresh();
    expect(h.loadCalls()).toBe(1);
    h.setNow(1_700_000_000_000 + MODEL_RECHECK_MS - 1);
    await h.refresh();
    expect(h.loadCalls()).toBe(1);
    h.setNow(1_700_000_000_000 + MODEL_RECHECK_MS);
    await h.refresh();
    expect(h.loadCalls()).toBe(2);
  });

  it("凭据被吊销（读不到）：清掉 llm 并退回降级模板，记一条日志", async () => {
    const h = harness(llm("m1"), async () => null);
    await h.refresh();
    expect(h.current()).toBeNull();
    expect(h.logs.join("\n")).toContain("凭据不可用");
  });

  it("读凭据抛错：保持现状（不误清、不误装），下一拍再试", async () => {
    const h = harness(llm("m1"), null);
    await h.refresh();
    expect(h.current()?.model).toBe("m1");
    h.setNow(1_700_000_000_000 + MODEL_RECHECK_MS + 1);
    await h.refresh();
    expect(h.current()?.model).toBe("m1");
    expect(h.logs).toEqual([]);
    expect(h.loadCalls()).toBe(2);
  });

  it("从没有凭据到仍没有：不吵人（不打日志）", async () => {
    const h = harness(null, async () => null);
    await h.refresh();
    expect(h.current()).toBeNull();
    expect(h.logs).toEqual([]);
  });

  it("装配锁：入口已改用 createModelRefresher，旧的 30 分钟判断只在新模块里出现", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../scripts/autonomy/main.mjs", import.meta.url), "utf8");
    expect(main).toContain('from "../../dist/assembly/model-refresh.js"');
    expect(main).toContain("createModelRefresher({");
    expect(main).not.toContain("lastKeyCheck");
  });
});
