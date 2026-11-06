/**
 * task-169 C：overlay A.15 三键 → EchoPolicy。
 *
 * 这里锁两件事：① 三键真的被读取（不是死旋钮）；② 缺键/坏值回落默认，
 * 不让配置错误把闸门变成「永远命中」或「永远不命中」。
 */

import { describe, expect, it } from "vitest";

import type { KnobReader } from "../src/ports/index.js";
import { ECHO_POLICY_DEFAULTS, loadEchoPolicy } from "../src/maintenance/echo-policy.js";

function knobs(values: Record<string, number>, throwOnMissing = false): KnobReader {
  return {
    read(name: string): number {
      const value = values[name];
      if (value === undefined) {
        if (throwOnMissing) throw new Error(`missing knob ${name}`);
        return 0;
      }
      return value;
    },
  } as KnobReader;
}

describe("loadEchoPolicy", () => {
  it("读 ECHO_DICE_THRESHOLD / ECHO_LOOKBACK / ECHO_WINDOW_HOURS 并换算 windowMs", () => {
    const policy = loadEchoPolicy(
      knobs({ ECHO_DICE_THRESHOLD: 0.7, ECHO_LOOKBACK: 12, ECHO_WINDOW_HOURS: 48 }),
    );
    expect(policy).toEqual({ threshold: 0.7, lookback: 12, windowHours: 48, windowMs: 48 * 3_600_000 });
  });

  it("缺键（read 抛）时回落到默认 0.65 / 20 / 24h", () => {
    const policy = loadEchoPolicy(knobs({}, true));
    expect(policy).toEqual({
      ...ECHO_POLICY_DEFAULTS,
      windowMs: ECHO_POLICY_DEFAULTS.windowHours * 3_600_000,
    });
  });

  it("越界值被夹紧：阈值 0.1–1、lookback/windowHours ≥1", () => {
    expect(loadEchoPolicy(knobs({ ECHO_DICE_THRESHOLD: 2, ECHO_LOOKBACK: 0, ECHO_WINDOW_HOURS: 0 }))).toMatchObject({
      threshold: 1,
      lookback: 1,
      windowHours: 1,
    });
    expect(loadEchoPolicy(knobs({ ECHO_DICE_THRESHOLD: -3, ECHO_LOOKBACK: -5, ECHO_WINDOW_HOURS: -1 }))).toMatchObject({
      threshold: 0.1,
      lookback: 1,
      windowHours: 1,
    });
  });

  it("非数字（NaN）回落默认值", () => {
    const policy = loadEchoPolicy(
      knobs({ ECHO_DICE_THRESHOLD: Number.NaN, ECHO_LOOKBACK: Number.NaN, ECHO_WINDOW_HOURS: Number.NaN }),
    );
    expect(policy.threshold).toBe(ECHO_POLICY_DEFAULTS.threshold);
    expect(policy.lookback).toBe(ECHO_POLICY_DEFAULTS.lookback);
    expect(policy.windowHours).toBe(ECHO_POLICY_DEFAULTS.windowHours);
  });
});
