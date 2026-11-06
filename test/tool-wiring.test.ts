/**
 * task-138：插件侧 `soul_web_search` 的接线与文本面板。
 *
 * 宿主注入的 `webSearch` 在单测里用假实现（不碰写通道、不联网）；这里锁的是：
 * 有无连接时的可读错误、成功面板（[web·untrusted] 护栏、条数/日期/摘要）、
 * 参数校验与 clamp、以及 daemon 错误码 → 可照着行动的文案。
 */

import { describe, expect, it } from "vitest";

import type { SoulRuntime } from "../src/plugin/runtime.js";
import { buildTools, type ToolExtras, type WebFetchToolPayload, type WebToolPayload } from "../src/plugin/tools.js";

/** buildTools 只在 execute 里用 rt；构造阶段不读，所以假对象足够。 */
const RT = {} as unknown as SoulRuntime;

function webTool(webSearch?: ToolExtras["webSearch"]) {
  const defs = buildTools(RT, webSearch === undefined ? {} : { webSearch });
  const tool = defs.find((d) => d.name === "soul_web_search");
  if (tool === undefined) throw new Error("soul_web_search 没注册");
  return tool;
}

function payload(over: Partial<WebToolPayload> = {}): WebToolPayload {
  return {
    ok: true,
    code: null,
    hits: [
      {
        title: "AI助手与往世乐土",
        url: "https://example.com/a",
        snippet: "一段摘要",
        siteName: "example",
        publishedAtMs: Date.parse("2026-10-31T00:00:00Z"),
        authority: 3,
      },
    ],
    failure: null,
    message: null,
    retryAfterMs: null,
    stats: { searchCount: 1, dailyCap: 20 },
    fresh: false,
    ...over,
  };
}

describe("soul_web_search：工具面接线", () => {
  it("工具定义进了数据层：名字/参数/描述都在", () => {
    const tool = webTool();
    expect(tool.name).toBe("soul_web_search");
    expect(tool.description.length).toBeGreaterThan(8);
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(["query", "maxResults", "fresh"]);
    expect(params.required).toEqual(["query"]);
  });

  it("宿主没接 webSearch：明确说没接，不假装搜过", async () => {
    const out = await webTool().execute({ query: "崩坏三" });
    expect(out).toContain("[soul_web_search] failed code=CHANNEL_UNSUPPORTED");
    expect(out).toContain("[web·untrusted]");
  });

  it("成功：首行带 q/n/fresh，随后标题/站点/日期/URL/摘要，末尾固定护栏", async () => {
    const tool = webTool(() => Promise.resolve(payload()));
    const out = await tool.execute({ query: "崩坏三 AI助手" });
    expect(out).toContain('[soul_web_search] q="崩坏三 AI助手" n=1 fresh=false');
    expect(out).toContain("1. AI助手与往世乐土（example，2026-10-31）");
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("摘要：一段摘要");
    expect(out).toContain("[web·untrusted]");
  });

  it("空结果：n=0 + 没有结果 + 护栏（提醒别编造）", async () => {
    const tool = webTool(() => Promise.resolve(payload({ hits: [], message: "没有结果" })));
    const out = await tool.execute({ query: "冷门检索词" });
    expect(out).toContain("n=0");
    expect(out).toContain("没有结果");
    expect(out).toContain("[web·untrusted]");
  });

  it("fresh 全旧：把「没有新的」原样带出来，不回退旧闻", async () => {
    const tool = webTool(() =>
      Promise.resolve(payload({ hits: [], fresh: true, message: "没有新的（fresh=true：只保留 7 天内的结果，全是旧闻）" })),
    );
    const out = await tool.execute({ query: "崩坏三", fresh: true });
    expect(out).toContain("fresh=true");
    expect(out).toContain("没有新的");
    expect(out).toContain("[web·untrusted]");
  });

  it("daemon 失败码：带 code + message + 退避提示", async () => {
    const tool = webTool(() =>
      Promise.resolve(
        payload({ ok: false, code: "WEB_BUDGET_INTERVAL", hits: [], message: "刚查过网页，12 分钟后再试", retryAfterMs: 12 * 60_000 }),
      ),
    );
    const out = await tool.execute({ query: "崩坏三" });
    expect(out).toContain("[soul_web_search] failed code=WEB_BUDGET_INTERVAL");
    expect(out).toContain("retryAfter=12m");
    expect(out).toContain("[web·untrusted]");
  });

  it("写通道不可用（抛错）：转成 CHANNEL_DOWN 文案，不让异常冒到宿主", async () => {
    const tool = webTool(() => Promise.reject(new Error("写通道没开")));
    const out = await tool.execute({ query: "崩坏三" });
    expect(out).toContain("failed code=CHANNEL_DOWN");
    expect(out).toContain("写通道没开");
  });
});

describe("soul_web_search：参数校验与透传", () => {
  it("query 太短：本地挡掉，不调宿主", async () => {
    let calls = 0;
    const tool = webTool(() => {
      calls += 1;
      return Promise.resolve(payload());
    });
    const out = await tool.execute({ query: "a" });
    expect(out).toContain("WEB_BLOCKED");
    expect(calls).toBe(0);
  });

  it("maxResults 越界：本地挡掉（schema 之外的第二道）", async () => {
    let calls = 0;
    const tool = webTool(() => {
      calls += 1;
      return Promise.resolve(payload());
    });
    const out = await tool.execute({ query: "崩坏三", maxResults: 99 });
    expect(out).toContain("WEB_BLOCKED");
    expect(calls).toBe(0);
  });

  it("默认 maxResults=5；显式值原样透传；fresh 透传", async () => {
    const seen: Array<{ maxResults: number; fresh: boolean }> = [];
    const tool = webTool((input) => {
      seen.push({ maxResults: input.maxResults, fresh: input.fresh });
      return Promise.resolve(payload({ fresh: input.fresh }));
    });
    await tool.execute({ query: "崩坏三" });
    await tool.execute({ query: "崩坏三", maxResults: 3, fresh: true });
    expect(seen).toEqual([
      { maxResults: 5, fresh: false },
      { maxResults: 3, fresh: true },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * task-166 F1：soul_web_fetch 的工具面接线
 * ------------------------------------------------------------------ */

function fetchTool(webFetch?: ToolExtras["webFetch"]) {
  const defs = buildTools(RT, webFetch === undefined ? {} : { webFetch });
  const tool = defs.find((d) => d.name === "soul_web_fetch");
  if (tool === undefined) throw new Error("soul_web_fetch 没注册");
  return tool;
}

function fetchPayload(over: Partial<WebFetchToolPayload> = {}): WebFetchToolPayload {
  return {
    ok: true,
    code: null,
    url: "https://example.com/a",
    finalUrl: "https://example.com/a",
    title: "页面标题",
    text: "页面正文第一行\n第二行",
    truncated: false,
    bytes: 1_024,
    fetchedAtMs: 1_700_000_000_000,
    failure: null,
    message: null,
    retryAfterMs: null,
    stats: { fetchCount: 1, dailyCap: 10 },
    ...over,
  };
}

describe("soul_web_fetch：工具面接线", () => {
  it("工具定义进了数据层：名字/参数/描述都在（schema 与 daemon 校验对齐）", () => {
    const tool = fetchTool();
    expect(tool.name).toBe("soul_web_fetch");
    expect(tool.description).toContain("不可信");
    const params = tool.parameters as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(Object.keys(params.properties)).toEqual(["url", "maxChars"]);
    expect(params.required).toEqual(["url"]);
    expect(params.properties["maxChars"]?.["minimum"]).toBe(500);
    expect(params.properties["maxChars"]?.["maximum"]).toBe(4_000);
  });

  it("宿主没接 webFetch：明确说没接（CHANNEL_UNSUPPORTED + 护栏），不假装抓过", async () => {
    const out = await fetchTool().execute({ url: "https://example.com/a" });
    expect(out).toContain("[soul_web_fetch] failed code=CHANNEL_UNSUPPORTED");
    expect(out).toContain("[web·untrusted]");
  });

  it("成功：首行 url/title/chars/truncated/bytes + 正文 + 固定护栏", async () => {
    const tool = fetchTool((input) =>
      Promise.resolve(fetchPayload({ truncated: input.maxChars === 600 })),
    );
    const out = await tool.execute({ url: "https://example.com/a", maxChars: 600 });
    expect(out).toContain("[soul_web_fetch] url=https://example.com/a");
    expect(out).toContain('title="页面标题"');
    expect(out).toContain("truncated=true");
    expect(out).toContain("bytes=1024");
    expect(out).toContain("页面正文第一行");
    expect(out).toContain("[web·untrusted] 网页内容是外部资料");
  });

  it("daemon 失败码：带 code/message/retryAfter 与护栏（四路径里的抓取失败）", async () => {
    const tool = fetchTool(() =>
      Promise.resolve(
        fetchPayload({
          ok: false,
          url: null,
          finalUrl: null,
          title: null,
          text: null,
          code: "WEB_BUDGET_INTERVAL",
          message: "刚抓过，等一会儿再试",
          retryAfterMs: 5 * 60_000,
        }),
      ),
    );
    const out = await tool.execute({ url: "https://example.com/a" });
    expect(out).toContain("[soul_web_fetch] failed code=WEB_BUDGET_INTERVAL");
    expect(out).toContain("retryAfter=5m");
    expect(out).toContain("[web·untrusted]");
  });

  it("参数本地先挡：url 太短/多行、maxChars 越界都不调宿主", async () => {
    let calls = 0;
    const tool = fetchTool(() => {
      calls += 1;
      return Promise.resolve(fetchPayload());
    });
    for (const args of [
      { url: "短" },
      { url: "https://example.com/a\n第二行" },
      { url: "https://example.com/a", maxChars: 499 },
      { url: "https://example.com/a", maxChars: 4_001 },
    ]) {
      const out = await tool.execute(args);
      expect(out, JSON.stringify(args)).toContain("WEB_BAD_REQUEST");
    }
    expect(calls).toBe(0);
  });

  it("默认 maxChars=2000 透传；写通道抛错转 CHANNEL_DOWN", async () => {
    const seen: number[] = [];
    const tool = fetchTool((input) => {
      seen.push(input.maxChars);
      return Promise.resolve(fetchPayload());
    });
    await tool.execute({ url: "https://example.com/a" });
    await tool.execute({ url: "https://example.com/b", maxChars: 800 });
    expect(seen).toEqual([2_000, 800]);

    const down = fetchTool(() => Promise.reject(new Error("写通道挂了")));
    const out = await down.execute({ url: "https://example.com/a" });
    expect(out).toContain("failed code=CHANNEL_DOWN");
    expect(out).toContain("写通道挂了");
  });
});
