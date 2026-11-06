import { describe, expect, it } from "vitest";
import {
  LEARN_TIER_FULL_MIN_ENERGY,
  LEARN_TIER_HOT_MIN_ENERGY,
  LEARN_TIER_SEARCH_MIN_ENERGY,
  deepReadLimitOf,
  learnTierOf,
  learnTierReasonOf,
  shouldFetchHotOf,
  shouldSearchOf,
} from "../src/learning/energy-budget.js";

describe("learnTierOf：能量四档（边界按 > 判，正好卡在阈值上视为已降档）", () => {
  it("full：> 0.6", () => {
    expect(learnTierOf(1)).toBe("full");
    expect(learnTierOf(0.8)).toBe("full");
    expect(learnTierOf(0.6001)).toBe("full");
  });

  it("search：0.4 < e ≤ 0.6", () => {
    expect(learnTierOf(LEARN_TIER_FULL_MIN_ENERGY)).toBe("search");
    expect(learnTierOf(0.5)).toBe("search");
    expect(learnTierOf(0.4001)).toBe("search");
  });

  it("hot：0.25 < e ≤ 0.4", () => {
    expect(learnTierOf(LEARN_TIER_SEARCH_MIN_ENERGY)).toBe("hot");
    expect(learnTierOf(0.3)).toBe("hot");
    expect(learnTierOf(0.2501)).toBe("hot");
  });

  it("skip：e ≤ 0.25", () => {
    expect(learnTierOf(LEARN_TIER_HOT_MIN_ENERGY)).toBe("skip");
    expect(learnTierOf(0.2)).toBe("skip");
    expect(learnTierOf(0)).toBe("skip");
  });

  it("非法能量直接抛 RangeError（不静默回退 full）", () => {
    expect(() => learnTierOf(Number.NaN)).toThrow(RangeError);
    expect(() => learnTierOf(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => learnTierOf(-0.01)).toThrow(RangeError);
    expect(() => learnTierOf(-1)).toThrow(RangeError);
  });
});

describe("deepReadLimitOf：只有 full 深读，且不改变既有上限 1", () => {
  it("full 上限 = min(enrich, 1)", () => {
    expect(deepReadLimitOf("full", 1)).toBe(1);
    expect(deepReadLimitOf("full", 2)).toBe(1);
    expect(deepReadLimitOf("full", 5)).toBe(1);
    expect(deepReadLimitOf("full", 0)).toBe(0);
  });

  it("search/hot/skip 不深读", () => {
    expect(deepReadLimitOf("search", 1)).toBe(0);
    expect(deepReadLimitOf("hot", 1)).toBe(0);
    expect(deepReadLimitOf("skip", 1)).toBe(0);
  });

  it("非法入参抛 RangeError", () => {
    expect(() => deepReadLimitOf("full", -1)).toThrow(RangeError);
    expect(() => deepReadLimitOf("full", Number.NaN)).toThrow(RangeError);
    // 运行时绕过类型：未注册档位必须显式拒绝
    expect(() => deepReadLimitOf("deep" as never, 1)).toThrow(RangeError);
  });
});

describe("shouldSearchOf / shouldFetchHotOf：搜索与热榜是两条独立的出口", () => {
  it("搜索：只有 full/search", () => {
    expect(shouldSearchOf("full")).toBe(true);
    expect(shouldSearchOf("search")).toBe(true);
    expect(shouldSearchOf("hot")).toBe(false);
    expect(shouldSearchOf("skip")).toBe(false);
  });

  it("热榜：只有 skip 连热榜也停", () => {
    expect(shouldFetchHotOf("full")).toBe(true);
    expect(shouldFetchHotOf("search")).toBe(true);
    expect(shouldFetchHotOf("hot")).toBe(true);
    expect(shouldFetchHotOf("skip")).toBe(false);
  });

  it("未注册档位抛 RangeError", () => {
    expect(() => shouldSearchOf("lazy" as never)).toThrow(RangeError);
    expect(() => shouldFetchHotOf("lazy" as never)).toThrow(RangeError);
  });
});

describe("learnTierReasonOf：给日志的半行，可复现", () => {
  it("两位小数 + 档位", () => {
    expect(learnTierReasonOf(0.72, "full")).toBe("energy=0.72 tier=full");
    expect(learnTierReasonOf(0.6, "search")).toBe("energy=0.60 tier=search");
    expect(learnTierReasonOf(0.25, "skip")).toBe("energy=0.25 tier=skip");
  });

  it("非法入参抛 RangeError", () => {
    expect(() => learnTierReasonOf(Number.NaN, "full")).toThrow(RangeError);
    expect(() => learnTierReasonOf(0.5, "bad" as never)).toThrow(RangeError);
  });
});
