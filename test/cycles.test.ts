/**
 * 昼夜节律测试（G5-①）。
 *
 * 这里只测"睡点算术"——它决定巩固什么时候自动发生，错一天就会让
 * "隔夜之后她整理前一天的事"变成玄学。日期不进这些函数，全部是可手算的时刻。
 */

import { describe, expect, it } from "vitest";

import { crossedSleeps, nextSleepInHours, sleepHourFor } from "../src/engine/cycles.js";
import { loadConfig } from "../src/engine/config.js";

const cfg = await loadConfig();

describe("sleepHourFor：错峰睡点", () => {
  it("落在 [SLEEP_BASE_HOUR, SLEEP_BASE_HOUR + SLEEP_OFFSET_HOURS) 内", () => {
    for (const id of ["default", "test", "用户", "a", "b", "c", "d", "e", "f", "g"]) {
      const h = sleepHourFor(id, cfg);
      expect(h).toBeGreaterThanOrEqual(3);
      expect(h).toBeLessThan(9);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it("同一角色稳定，不同角色会错开", () => {
    expect(sleepHourFor("test", cfg)).toBe(sleepHourFor("test", cfg));
    const hours = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => sleepHourFor(id, cfg)));
    expect(hours.size).toBeGreaterThan(1);
  });
});

describe("crossedSleeps：跨过几次睡点", () => {
  it("21:30 出发睡 9 小时、03:00 睡 → 正好跨过一次", () => {
    const r = crossedSleeps(21.5, 9, 3);
    expect(r.count).toBe(1);
    expect(r.hoursSinceLast).toBeCloseTo(3.5, 10);
    expect(r.sleepHour).toBe(3);
  });

  it("没跨过就是 0，且 hoursSinceLast 是 Infinity", () => {
    const r = crossedSleeps(9, 4, 3);
    expect(r.count).toBe(0);
    expect(r.hoursSinceLast).toBe(Number.POSITIVE_INFINITY);
  });

  it("恰好从睡点出发时算明天那一次（0 小时推进不算睡过）", () => {
    expect(crossedSleeps(3, 23, 3).count).toBe(0);
    expect(crossedSleeps(3, 24, 3).count).toBe(1);
  });

  it("50 小时跨过两天，last 是最近那次", () => {
    const r = crossedSleeps(21.5, 50, 3);
    expect(r.count).toBe(2);
    expect(r.hoursSinceLast).toBeCloseTo(20.5, 10);
  });

  it("输入越界会抛错（INFINITY / 负数）", () => {
    expect(() => crossedSleeps(Number.NaN, 1, 3)).toThrow(RangeError);
    expect(() => crossedSleeps(1, -1, 3)).toThrow(RangeError);
  });
});

describe("nextSleepInHours：下一次还有几小时", () => {
  it("12:00 出发、03:00 睡 → 15 小时", () => {
    expect(nextSleepInHours(12, 3)).toBe(15);
  });

  it("正好在睡点 → 24 小时（不是 0）", () => {
    expect(nextSleepInHours(3, 3)).toBe(24);
  });

  it("跨小时用小数也成立（21.5 → 3 点还有 5.5 小时）", () => {
    expect(nextSleepInHours(21.5, 3)).toBeCloseTo(5.5, 10);
  });
});
