/**
 * F1 `soul_web_fetch` 的 daemon 侧纯编排测试（task-166）。
 *
 * 只测 `runWebFetch` 的闸序/记账/错误码；不联网、不写盘（usage 由调用方落盘）。
 */
import { describe, expect, it } from "vitest";

import { emptyWebUsage, type WebUsage } from "../src/web/budget.js";
import { WEB_CONFIG_DEFAULTS, type WebConfig } from "../src/web/config.js";
import { runWebFetch, WEB_FETCH_TOTAL_BUDGET_MS } from "../src/web/fetch-run.js";
import type { WebFetchResult2 } from "../src/web/types.js";
import type { WebFetchResult } from "../src/autonomy/write-protocol.js";

const NOW = 1_700_000_000_000;
const TZ = 480;

function cfgOf(patch: Partial<WebConfig> = {}): WebConfig {
  return { ...WEB_CONFIG_DEFAULTS, enabled: true, minIntervalMs: 60_000, fetchDailyCap: 2, ...patch };
}

function usageOf(): WebUsage {
  return emptyWebUsage(NOW, TZ);
}

function okPage(text = "正文", extra: Partial<WebFetchResult2["page"] & object> = {}): WebFetchResult2 {
  return {
    ok: true,
    page: {
      url: "https://example.com/a",
      finalUrl: "https://example.com/a",
      title: "标题",
      text,
      truncated: false,
      bytes: 12,
      fetchedAtMs: NOW,
      ...extra,
    },
    failure: null,
    status: 200,
  };
}

function failPage(failure: NonNullable<WebFetchResult2["failure"]>): WebFetchResult2 {
  return { ok: false, page: null, failure, status: 500 };
}

interface FetchRecord {
  readonly url: string;
  readonly maxChars: number;
  readonly deadlineAtMs: number;
}

function fetchOf(
  impl: (url: string, opts: { maxChars: number; deadlineAtMs: number }) => Promise<WebFetchResult2>,
  calls: FetchRecord[],
): (url: string, opts: { maxChars: number; deadlineAtMs: number }) => Promise<WebFetchResult2> {
  return (url, opts) => {
    calls.push({ url, maxChars: opts.maxChars, deadlineAtMs: opts.deadlineAtMs });
    return impl(url, opts);
  };
}

describe("runWebFetch：闸序", () => {
  it("开关关掉 → WEB_DISABLED，不发起抓取", async () => {
    const usage = usageOf();
    const calls: FetchRecord[] = [];
    const out = await runWebFetch({
      url: "https://example.com/",
      nowMs: NOW,
      cfg: cfgOf({ enabled: false }),
      usage,
      hasKey: true,
      fetch: fetchOf(() => Promise.resolve(okPage()), calls),
    });
    expect(out.result.ok).toBe(false);
    expect(out.result.code).toBe("WEB_DISABLED");
    expect(calls).toHaveLength(0);
    expect(out.usage).toEqual(usage);
  });

  it("没有凭据 → WEB_NO_KEY", async () => {
    const out = await runWebFetch({
      url: "https://example.com/",
      nowMs: NOW,
      cfg: cfgOf(),
      usage: usageOf(),
      hasKey: false,
      fetch: () => Promise.reject(new Error("不该被调用")),
    });
    expect(out.result.code).toBe("WEB_NO_KEY");
  });

  it("日额度用完 → WEB_BUDGET_DAILY", async () => {
    const usage: WebUsage = { ...usageOf(), fetchCount: 2 };
    const out = await runWebFetch({
      url: "https://example.com/",
      nowMs: NOW,
      cfg: cfgOf(),
      usage,
      hasKey: true,
      fetch: () => Promise.reject(new Error("不该被调用")),
    });
    expect(out.result.code).toBe("WEB_BUDGET_DAILY");
    expect(out.result.stats).toEqual({ fetchCount: 2, dailyCap: 2 });
  });

  it("最小间隔内 → WEB_BUDGET_INTERVAL 且带 retryAfterMs", async () => {
    const usage: WebUsage = { ...usageOf(), lastFetchAtMs: NOW - 1_000 };
    const out = await runWebFetch({
      url: "https://example.com/",
      nowMs: NOW,
      cfg: cfgOf(),
      usage,
      hasKey: true,
      fetch: () => Promise.reject(new Error("不该被调用")),
    });
    expect(out.result.code).toBe("WEB_BUDGET_INTERVAL");
    expect(out.result.retryAfterMs).toBe(59_000);
  });

  it("参数非法 → WEB_BAD_REQUEST，且不记尝试", async () => {
    for (const patch of [
      { url: "短" },
      { url: "https://example.com/\n第二行" },
      { url: "https://example.com/", maxChars: 499 },
      { url: "https://example.com/", maxChars: 4_001 },
      { url: "https://example.com/", maxChars: 1.5 },
    ]) {
      const usage = usageOf();
      const calls: FetchRecord[] = [];
      const out = await runWebFetch({
        url: patch.url,
        ...(patch.maxChars === undefined ? {} : { maxChars: patch.maxChars }),
        nowMs: NOW,
        cfg: cfgOf(),
        usage,
        hasKey: true,
        fetch: fetchOf(() => Promise.resolve(okPage()), calls),
      });
      expect(out.result.code, JSON.stringify(patch)).toBe("WEB_BAD_REQUEST");
      expect(calls, JSON.stringify(patch)).toHaveLength(0);
      expect(out.usage.lastFetchAtMs).toBeNull();
    }
  });
});

describe("编排层地址校验（task-172）", () => {
  it("http / 非 443 / 带凭据 / 非法 URL → WEB_BLOCKED，不 touch、不调 fetch", async () => {
    for (const url of [
      "http://example.com/a",
      "https://example.com:8443/a",
      "https://user:pass@example.com/a",
      "not a url",
    ]) {
      const usage = usageOf();
      const calls: FetchRecord[] = [];
      const out = await runWebFetch({
        url,
        nowMs: NOW,
        cfg: cfgOf(),
        usage,
        hasKey: true,
        fetch: fetchOf(() => Promise.resolve(okPage()), calls),
      });
      expect(out.result.code, url).toBe("WEB_BLOCKED");
      expect(out.result.failure, url).toBe("blocked");
      expect(calls, url).toHaveLength(0);
      expect(out.usage.lastFetchAtMs, url).toBeNull();
      expect(out.usage, url).toEqual(usage);
    }
  });

  it("调用注入 fetch 时传 deadlineAtMs = nowMs + 总预算", async () => {
    const calls: FetchRecord[] = [];
    const out = await runWebFetch({
      url: "https://example.com/a",
      nowMs: NOW,
      cfg: cfgOf(),
      usage: usageOf(),
      hasKey: true,
      fetch: fetchOf(() => Promise.resolve(okPage()), calls),
    });
    expect(out.result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.deadlineAtMs).toBe(NOW + WEB_FETCH_TOTAL_BUDGET_MS);
    expect(WEB_FETCH_TOTAL_BUDGET_MS).toBe(24_000);
  });
});

describe("runWebFetch：记账顺序", () => {
  it("先 touch 再 fetch（失败也占最小间隔），成功才 consume", async () => {
    const usage = usageOf();
    const calls: FetchRecord[] = [];
    const out = await runWebFetch({
      url: "  https://example.com/a  ",
      nowMs: NOW,
      cfg: cfgOf(),
      usage,
      hasKey: true,
      fetch: fetchOf(() => Promise.resolve(okPage("你好")), calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.com/a");
    expect(calls[0]?.maxChars).toBe(2_000);
    expect(out.result.ok).toBe(true);
    expect(out.result.text).toBe("你好");
    expect(out.result.stats).toEqual({ fetchCount: 1, dailyCap: 2 });
    expect(out.usage.fetchCount).toBe(1);
    // 纯函数：不改传入的 usage 对象。
    expect(usage.fetchCount).toBe(0);
    expect(usage.lastFetchAtMs).toBeNull();
  });

  it("抓取失败只 touch 不 consume", async () => {
    const usage = usageOf();
    const calls: FetchRecord[] = [];
    const out = await runWebFetch({
      url: "https://example.com/blocked",
      nowMs: NOW,
      cfg: cfgOf(),
      usage,
      hasKey: true,
      fetch: fetchOf(() => Promise.resolve(failPage("blocked")), calls),
    });
    expect(out.result.ok).toBe(false);
    expect(out.result.code).toBe("WEB_BLOCKED");
    expect(out.result.failure).toBe("blocked");
    expect(out.result.message ?? "").toContain("不允许");
    expect(out.usage.fetchCount).toBe(0);
    expect(out.usage.lastFetchAtMs).toBe(NOW);
  });

  it("成功但正文为空不 consume（避免空页偷跑日额度）", async () => {
    const out = await runWebFetch({
      url: "https://example.com/empty",
      nowMs: NOW,
      cfg: cfgOf(),
      usage: usageOf(),
      hasKey: true,
      fetch: () => Promise.resolve(okPage("")),
    });
    expect(out.result.ok).toBe(true);
    expect(out.result.text).toBe("");
    expect(out.result.stats.fetchCount).toBe(0);
    expect(out.usage.fetchCount).toBe(0);
    expect(out.usage.lastFetchAtMs).toBe(NOW);
  });

  it("自定义 maxChars 透传给 fetch", async () => {
    const calls: FetchRecord[] = [];
    await runWebFetch({
      url: "https://example.com/a",
      maxChars: 800,
      nowMs: NOW,
      cfg: cfgOf(),
      usage: usageOf(),
      hasKey: true,
      fetch: fetchOf(() => Promise.resolve(okPage()), calls),
    });
    expect(calls[0]?.maxChars).toBe(800);
  });

  it("fetch 抛异常 → WEB_INTERNAL（touched 仍保留间隔）", async () => {
    const usage = usageOf();
    const out = await runWebFetch({
      url: "https://example.com/a",
      nowMs: NOW,
      cfg: cfgOf(),
      usage,
      hasKey: true,
      fetch: () => Promise.reject(new Error("boom")),
    });
    expect(out.result.code).toBe("WEB_INTERNAL");
    expect(out.result.message).toContain("boom");
    expect(out.usage.lastFetchAtMs).toBe(NOW);
  });

  it("空 title 回 null，交付形状与协议一致", async () => {
    const out = await runWebFetch({
      url: "https://example.com/a",
      nowMs: NOW,
      cfg: cfgOf(),
      usage: usageOf(),
      hasKey: true,
      fetch: () => Promise.resolve(okPage("x", { title: "" })),
    });
    const result: WebFetchResult = out.result;
    expect(result.title).toBeNull();
    expect(result.url).toBe("https://example.com/a");
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(12);
    expect(result.fetchedAtMs).toBe(NOW);
  });
});
