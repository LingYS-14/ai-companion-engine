/**
 * task-138：`soul_web_search` 的 daemon 侧纯编排。
 *
 * 这里全部用假 search（禁止真连网）：锁的是闸顺序（开关 → 凭据 → 共享额度 → 发起 →
 * 成功计数 → fresh → clamp）与错误码映射。真实 HTTP 已在 test/web-search.test.ts 覆盖。
 */

import { describe, expect, it } from "vitest";

import { emptyWebUsage, type WebUsage } from "../src/web/budget.js";
import type { WebConfig } from "../src/web/config.js";
import type { WebSearchHit, WebSearchResult } from "../src/web/types.js";
import { runWebToolSearch, WEB_TOOL_DEFAULT_COUNT, WEB_TOOL_FRESH_WINDOW_MS } from "../src/web/tool-run.js";
import { runWebToolSearch as runWebToolSearchFromBarrel } from "../src/web/index.js";

const NOW = Date.parse("2026-11-02T12:00:00+08:00");

const CFG: WebConfig = {
  enabled: true,
  searchDailyCap: 20,
  fetchDailyCap: 10,
  minIntervalMs: 1_800_000,
  timeoutMs: 8_000,
  sourceCredibility: 0.55,
};

function usage(over: Partial<WebUsage> = {}): WebUsage {
  return { ...emptyWebUsage(NOW, 480), ...over };
}

function hit(over: Partial<WebSearchHit> = {}): WebSearchHit {
  return {
    title: "AI助手与往世乐土",
    url: "https://example.com/a",
    snippet: "一段摘要",
    siteName: "example",
    publishedAtMs: NOW - 60 * 60 * 1000,
    authority: 3,
    rerankScore: 2,
    summary: "更长的摘要正文",
    ...over,
  };
}

function ok(hits: readonly WebSearchHit[]): WebSearchResult {
  return { ok: true, hits, failure: null, status: 200 };
}

function failed(failure: WebSearchResult["failure"], status: number | null = null): WebSearchResult {
  return { ok: false, hits: [], failure, status };
}

interface Call {
  readonly query: string;
  readonly count: number;
}

function base(over: Partial<Parameters<typeof runWebToolSearch>[0]> = {}): Parameters<typeof runWebToolSearch>[0] {
  const calls: Call[] = [];
  return {
    query: "崩坏三 AI助手",
    fresh: false,
    nowMs: NOW,
    cfg: CFG,
    usage: usage(),
    hasKey: true,
    search: (query, count) => {
      calls.push({ query, count });
      return Promise.resolve(ok([hit()]));
    },
    ...over,
  } as Parameters<typeof runWebToolSearch>[0] & { readonly calls?: readonly Call[] };
}

describe("barrel 导出（B1 回归锁）", () => {
  it("src/web/index.ts 必须导出 runWebToolSearch（daemon 静态 import 的入口）", () => {
    expect(typeof runWebToolSearchFromBarrel).toBe("function");
    expect(runWebToolSearchFromBarrel).toBe(runWebToolSearch);
  });
});

describe("runWebToolSearch：闸顺序", () => {
  it("WEB_SEARCH_ENABLED=0：不发请求、码 WEB_DISABLED、账本不变", async () => {
    let calls = 0;
    const input = base({
      cfg: { ...CFG, enabled: false },
      search: () => {
        calls += 1;
        return Promise.resolve(ok([]));
      },
    });
    const r = await runWebToolSearch(input);
    expect(calls).toBe(0);
    expect(r.result.ok).toBe(false);
    expect(r.result.code).toBe("WEB_DISABLED");
    expect(r.usage).toEqual(input.usage);
  });

  it("没有 key：码 WEB_NO_KEY（比 daily 闸更早，省一次无用判断）", async () => {
    const r = await runWebToolSearch(base({ hasKey: false }));
    expect(r.result.code).toBe("WEB_NO_KEY");
  });

  it("日额度用尽：码 WEB_BUDGET_DAILY，不发请求", async () => {
    let calls = 0;
    const r = await runWebToolSearch(
      base({
        usage: usage({ searchCount: 20 }),
        search: () => {
          calls += 1;
          return Promise.resolve(ok([]));
        },
      }),
    );
    expect(calls).toBe(0);
    expect(r.result.code).toBe("WEB_BUDGET_DAILY");
    expect(r.result.stats).toEqual({ searchCount: 20, dailyCap: 20 });
  });

  it("最小间隔内：码 WEB_BUDGET_INTERVAL，并给 retryAfterMs", async () => {
    const lastSearchAtMs = NOW - 60_000;
    const r = await runWebToolSearch(base({ usage: usage({ lastSearchAtMs }) }));
    expect(r.result.code).toBe("WEB_BUDGET_INTERVAL");
    expect(r.result.retryAfterMs).toBe(CFG.minIntervalMs - 60_000);
  });

  it("query 太短/含控制字符：码 WEB_BLOCKED，不发请求", async () => {
    let calls = 0;
    const search = () => {
      calls += 1;
      return Promise.resolve(ok([]));
    };
    const short = await runWebToolSearch(base({ query: "a", search }));
    expect(short.result.code).toBe("WEB_BLOCKED");
    const control = await runWebToolSearch(base({ query: "坏\u0001词", search }));
    expect(control.result.code).toBe("WEB_BLOCKED");
    expect(calls).toBe(0);
  });
});

describe("runWebToolSearch：成功路径", () => {
  it("命中映射成工具 payload，并只加一次成功计数", async () => {
    const r = await runWebToolSearch(base());
    expect(r.result.ok).toBe(true);
    expect(r.result.hits).toEqual([
      {
        title: "AI助手与往世乐土",
        url: "https://example.com/a",
        snippet: "一段摘要",
        siteName: "example",
        publishedAtMs: NOW - 60 * 60 * 1000,
        authority: 3,
      },
    ]);
    expect(r.usage.searchCount).toBe(1);
    expect(r.usage.lastSearchAtMs).toBe(NOW);
    expect(r.result.stats).toEqual({ searchCount: 1, dailyCap: 20 });
  });

  it("空结果不算额度：只记「尝试」时间，不计数", async () => {
    const r = await runWebToolSearch(base({ search: () => Promise.resolve(ok([])) }));
    expect(r.result.ok).toBe(true);
    expect(r.result.hits).toEqual([]);
    expect(r.result.message).toBe("没有结果");
    expect(r.usage.searchCount).toBe(0);
    expect(r.usage.lastSearchAtMs).toBe(NOW);
  });

  it("maxResults 默认 5、越界 clamp 到 1–10", async () => {
    const counts: number[] = [];
    const search = (query: string, count: number) => {
      counts.push(count);
      return Promise.resolve(ok([]));
    };
    await runWebToolSearch(base({ search }));
    await runWebToolSearch(base({ search, maxResults: 0 }));
    await runWebToolSearch(base({ search, maxResults: 99 }));
    await runWebToolSearch(base({ search, maxResults: 3 }));
    expect(counts).toEqual([WEB_TOOL_DEFAULT_COUNT, 1, 10, 3]);
  });

  it("不修改传进来的账本（纯函数）", async () => {
    const inputUsage = usage();
    const frozen = JSON.parse(JSON.stringify(inputUsage)) as WebUsage;
    await runWebToolSearch(base({ usage: inputUsage }));
    expect(inputUsage).toEqual(frozen);
  });
});

describe("runWebToolSearch：fresh 过滤", () => {
  it("fresh=true 且结果全旧：返回空 + fresh 标记 + 「没有新的」，不回退旧闻", async () => {
    const old = hit({ publishedAtMs: NOW - WEB_TOOL_FRESH_WINDOW_MS - 1 });
    const r = await runWebToolSearch(base({ fresh: true, search: () => Promise.resolve(ok([old])) }));
    expect(r.result.ok).toBe(true);
    expect(r.result.hits).toEqual([]);
    expect(r.result.fresh).toBe(true);
    expect(r.result.message).toContain("没有新的");
  });

  it("fresh=true 保留 7 天内的、丢掉更旧的", async () => {
    const freshHit = hit({ publishedAtMs: NOW - 24 * 60 * 60 * 1000 });
    const oldHit = hit({ url: "https://example.org/old", publishedAtMs: NOW - WEB_TOOL_FRESH_WINDOW_MS - 1 });
    const r = await runWebToolSearch(base({ fresh: true, search: () => Promise.resolve(ok([freshHit, oldHit])) }));
    expect(r.result.hits.map((h) => h.url)).toEqual(["https://example.com/a"]);
    expect(r.result.message).toBeNull();
  });

  it("fresh=false 原样返回（旧闻也保留，由模型自己判断）", async () => {
    const old = hit({ publishedAtMs: NOW - 30 * 24 * 60 * 60 * 1000 });
    const r = await runWebToolSearch(base({ search: () => Promise.resolve(ok([old])) }));
    expect(r.result.hits).toHaveLength(1);
    expect(r.result.fresh).toBe(false);
  });
});

describe("runWebToolSearch：失败映射", () => {
  it.each([
    ["timeout", "WEB_TIMEOUT"],
    ["server", "WEB_SERVER"],
    ["network", "WEB_NETWORK"],
    ["parse", "WEB_PARSE"],
    ["blocked", "WEB_BLOCKED"],
    ["http", "WEB_HTTP"],
  ] as const)("%s → %s（不吞成功计数）", async (failure, code) => {
    const r = await runWebToolSearch(
      base({ usage: usage({ searchCount: 3 }), search: () => Promise.resolve(failed(failure, 500)) }),
    );
    expect(r.result.ok).toBe(false);
    expect(r.result.code).toBe(code);
    expect(r.usage.searchCount).toBe(3);
  });

  it("限流：码 WEB_RATE_LIMIT + 12 分钟退避建议", async () => {
    const r = await runWebToolSearch(base({ search: () => Promise.resolve(failed("rate-limit", 429)) }));
    expect(r.result.code).toBe("WEB_RATE_LIMIT");
    expect(r.result.retryAfterMs).toBe(12 * 60_000);
  });

  it("HTTP 失败信息里带状态码", async () => {
    const r = await runWebToolSearch(base({ search: () => Promise.resolve(failed("http", 500)) }));
    expect(r.result.message).toContain("500");
  });

  it("search 抛异常：码 WEB_INTERNAL，不把异常漏给插件", async () => {
    const r = await runWebToolSearch(
      base({
        search: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r.result.code).toBe("WEB_INTERNAL");
    expect(r.result.message).toContain("boom");
  });

  it("时钟不可用：码 WEB_INTERNAL", async () => {
    const r = await runWebToolSearch(base({ nowMs: Number.NaN }));
    expect(r.result.code).toBe("WEB_INTERNAL");
  });
});
