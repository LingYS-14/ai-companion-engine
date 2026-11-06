/**
 * W1（task-94）：日额度与本地说（纯函数）。
 *
 * 覆盖 spec v2.3 §7.3：本地日按 UTC+8 切；跨日重置计数与 last*AtMs；
 * 损坏文件按空额度；最小间隔与日上限各自独立生效。
 */

import { describe, expect, it } from "vitest";

import {
  WEB_DEFAULT_TZ_OFFSET_MINUTES,
  canFetch,
  canSearch,
  consumeFetch,
  consumeSearch,
  emptyWebUsage,
  localDateOf,
  normalizeWebUsage,
  touchFetchAttempt,
  touchSearchAttempt,
} from "../src/web/budget.js";

const cfg = { searchDailyCap: 20, fetchDailyCap: 10, minIntervalMs: 1_800_000 };
const NOW = Date.parse("2026-11-01T12:00:00+08:00");

describe("localDateOf：本地说固定 UTC+8", () => {
  it("UTC 16:00 = 本地次日 00:00；UTC 15:59 还是前一天", () => {
    expect(localDateOf(Date.parse("2026-10-31T16:00:00Z"), WEB_DEFAULT_TZ_OFFSET_MINUTES)).toBe("2026-11-01");
    expect(localDateOf(Date.parse("2026-10-31T15:59:00Z"), WEB_DEFAULT_TZ_OFFSET_MINUTES)).toBe("2026-10-31");
  });

  it("tz=0 时就是 UTC 日期", () => {
    expect(localDateOf(Date.parse("2026-11-01T23:59:00Z"), 0)).toBe("2026-11-01");
    expect(localDateOf(Date.parse("2026-11-02T00:00:00Z"), 0)).toBe("2026-11-02");
  });
});

describe("normalizeWebUsage", () => {
  it("空/损坏/缺字段 → 空额度（按当前本地日）", () => {
    const fresh = emptyWebUsage(NOW, WEB_DEFAULT_TZ_OFFSET_MINUTES);
    expect(fresh.date).toBe("2026-11-01");
    expect(normalizeWebUsage(undefined, NOW, 480)).toEqual(fresh);
    expect(normalizeWebUsage("garbage", NOW, 480)).toEqual(fresh);
    expect(normalizeWebUsage({ date: "2026-11-01", searchCount: "3" }, NOW, 480)).toEqual(fresh);
  });

  it("跨日 → 计数与 last*AtMs 清零，date 换成今天", () => {
    const stale = {
      v: 1,
      date: "2026-10-01",
      tzOffsetMinutes: 480,
      searchCount: 9,
      fetchCount: 4,
      lastSearchAtMs: NOW - 600_000,
      lastFetchAtMs: NOW - 600_000,
    };
    expect(normalizeWebUsage(stale, NOW, 480)).toEqual(emptyWebUsage(NOW, 480));
  });

  it("同日合法值原样保留", () => {
    const usage = {
      v: 1,
      date: "2026-11-01",
      tzOffsetMinutes: 480,
      searchCount: 3,
      fetchCount: 1,
      lastSearchAtMs: NOW - 60_000,
      lastFetchAtMs: null,
    };
    expect(normalizeWebUsage(usage, NOW, 480)).toEqual(usage);
  });
});

describe("canSearch / canFetch", () => {
  it("日上限与最小间隔各自独立生效", () => {
    const usage = emptyWebUsage(NOW, 480);
    expect(canSearch(NOW, usage, cfg)).toEqual({ allowed: true, reason: "" });
    expect(canSearch(NOW, { ...usage, searchCount: 20 }, cfg)).toEqual({ allowed: false, reason: "daily-cap" });
    const recent = touchSearchAttempt(usage, NOW - 60_000);
    expect(canSearch(NOW, recent, cfg)).toEqual({ allowed: false, reason: "min-interval" });
    expect(canSearch(NOW, touchSearchAttempt(usage, NOW - cfg.minIntervalMs), cfg)).toEqual({ allowed: true, reason: "" });
    expect(canFetch(NOW, { ...usage, fetchCount: 10 }, cfg)).toEqual({ allowed: false, reason: "daily-cap" });
    expect(canFetch(NOW, touchFetchAttempt(usage, NOW - 1_000), cfg)).toEqual({ allowed: false, reason: "min-interval" });
  });
});

describe("attempt/success 记账", () => {
  it("touch 只记尝试时刻、不动日计数；consume 计数 +1", () => {
    const usage = emptyWebUsage(NOW, 480);
    const touched = touchSearchAttempt(usage, NOW);
    expect(touched.searchCount).toBe(0);
    expect(touched.lastSearchAtMs).toBe(NOW);
    const consumed = consumeSearch(touched, NOW);
    expect(consumed.searchCount).toBe(1);
    expect(consumed.lastSearchAtMs).toBe(NOW);
    expect(consumeFetch(usage, NOW).fetchCount).toBe(1);
  });
});
