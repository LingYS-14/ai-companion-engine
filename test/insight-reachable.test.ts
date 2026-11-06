import { describe, expect, it } from "vitest";

import { insightReachable, medianOf } from "../src/learning/insight.js";

/**
 * §9.4 的 insight 可达性判据（F155）。
 *
 * 它守的是一个很安静的失败：人格卡把 `insightThreshold` 写成 50，
 * 而她的簇证据量永远只有三五条 —— 于是 A/B 层（信念、价值观）**永远不会更新**，
 * 日志里也不会有任何报错。这里把"不可达"提前算成布尔值，让她自己的进程能说"跳过，别烧钱"。
 */

describe("medianOf", () => {
  it("空数组是 0（没有历史，不编造）", () => {
    expect(medianOf([])).toBe(0);
  });

  it("奇数取中间，偶数取两个中间的平均", () => {
    expect(medianOf([3])).toBe(3);
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  it("不改动入参（排序在副本上）", () => {
    const xs = [3, 1, 2];
    medianOf(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("insightReachable", () => {
  it("没有历史时视为可达（没聊过不等于不可达，不能挡住第一次）", () => {
    expect(insightReachable(5, [])).toEqual({ reachable: true, median: 0 });
  });

  it("阈值 ≤ 中位数 × 3 时可达", () => {
    expect(insightReachable(5, [5, 5, 6])).toEqual({ reachable: true, median: 5 });
    expect(insightReachable(15, [5])).toEqual({ reachable: true, median: 5 });
  });

  it("阈值 > 中位数 × 3 时不可达（并回传中位数供日志解释）", () => {
    expect(insightReachable(16, [5])).toEqual({ reachable: false, median: 5 });
    const r = insightReachable(50, [1, 2, 3]);
    expect(r.reachable).toBe(false);
    expect(r.median).toBe(2);
  });
});
