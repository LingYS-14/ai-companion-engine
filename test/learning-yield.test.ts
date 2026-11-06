import { describe, expect, it } from "vitest";
import { describeLearningYield, learningYield, noveltyGap, YIELD_WINDOW } from "../src/learning/learning-yield.js";

describe("学习产出率 → 好奇缺口（A8）", () => {
  it("没有学习样本时不伪造 0：rate 与 gap 都是 null", () => {
    const y = learningYield([]);
    expect(y).toEqual({ rounds: 0, productive: 0, rate: null, gap: null });
  });

  it("每轮都没学到新东西 → 缺口 1（这块地挖空了）", () => {
    const y = learningYield([0, 0, 0, 0]);
    expect(y.rounds).toBe(4);
    expect(y.productive).toBe(0);
    expect(y.rate).toBe(0);
    expect(y.gap).toBe(1);
  });

  it("每轮都有新东西 → 缺口 0（不必当成缺口）", () => {
    const y = learningYield([1, 2, 3]);
    expect(y.rate).toBe(1);
    expect(y.gap).toBe(0);
  });

  it("混合产出率：一半有入库 → 缺口 0.5", () => {
    const y = learningYield([2, 0, 1, 0]);
    expect(y.rounds).toBe(4);
    expect(y.productive).toBe(2);
    expect(y.rate).toBe(0.5);
    expect(y.gap).toBe(0.5);
  });

  it("只看最近 window 轮（更早的历史不影响判断）", () => {
    const y = learningYield([0, 0, 9, 9], 2);
    expect(y.rounds).toBe(2);
    expect(y.rate).toBe(1);
    expect(y.gap).toBe(0);
  });

  it("window 默认是 YIELD_WINDOW；非法 window 抛 RangeError", () => {
    expect(YIELD_WINDOW).toBe(12);
    expect(learningYield(new Array(20).fill(1)).rounds).toBe(12);
    expect(() => learningYield([1], 0)).toThrow(RangeError);
    expect(() => learningYield([1], 1.5)).toThrow(RangeError);
    expect(() => learningYield([1], Number.NaN)).toThrow(RangeError);
  });

  it("非有限数被忽略（不把 NaN 当成「没学到」）", () => {
    const y = learningYield([1, Number.NaN, 2]);
    expect(y.rounds).toBe(2);
    expect(y.rate).toBe(1);
  });

  it("合成 novelty：产出率为主 0.7、freshness 为次 0.3", () => {
    // 产出率缺口 1（一直没学到）+ 新鲜度缺口 0 → 0.7
    expect(noveltyGap({ yieldGap: 1, freshnessGap: 0 })).toBeCloseTo(0.7, 6);
    // 反过来：0.3
    expect(noveltyGap({ yieldGap: 0, freshnessGap: 1 })).toBeCloseTo(0.3, 6);
    // 可调权重
    expect(noveltyGap({ yieldGap: 1, freshnessGap: 0, yieldWeight: 0.9 })).toBeCloseTo(0.9, 6);
  });

  it("只有一边有信号时直接用那一边；两边都没有返回 undefined（交给中性值）", () => {
    expect(noveltyGap({ yieldGap: 0.4, freshnessGap: null })).toBe(0.4);
    expect(noveltyGap({ yieldGap: null, freshnessGap: 0.2 })).toBe(0.2);
    expect(noveltyGap({ yieldGap: null, freshnessGap: null })).toBeUndefined();
  });

  it("合成值是 [0,1]，权重越界抛 RangeError", () => {
    expect(noveltyGap({ yieldGap: 2, freshnessGap: -1 })).toBeCloseTo(0.7, 6);
    expect(() => noveltyGap({ yieldGap: 0, freshnessGap: 0, yieldWeight: 1.5 })).toThrow(RangeError);
    expect(() => noveltyGap({ yieldGap: 0, freshnessGap: 0, yieldWeight: Number.NaN })).toThrow(RangeError);
  });

  it("摘要说人话：没有样本明说没有样本，有样本给轮数与产出率", () => {
    expect(describeLearningYield(learningYield([]))).toContain("还没有学习样本");
    const text = describeLearningYield(learningYield([0, 1, 0, 0]));
    expect(text).toContain("最近 4 轮");
    expect(text).toContain("1 次");
    expect(text).toContain("25%");
  });
});
