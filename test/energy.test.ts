/**
 * P3-2a：能量门控 A（清醒持续耗能）+ B（认知事件耗能）。
 *
 * 规格：DESIGN v2.2 §2.2 / §3.4。数字全部来自 overlay 新注册的 6 个 ENERGY_* 键，
 * 测试只通过 loadConfig() 取（手搓 EngineConfig 会绕开注册表，禁止）。
 */
import { describe, expect, it } from "vitest";
import { loadConfig, type EngineConfig } from "../src/engine/config.js";
import {
  energyCostFor,
  initialSState,
  tick,
  type EnergyCostKind,
  type SState,
} from "../src/engine/state.js";

const cfg = loadConfig();
const TICK = 1 / 12; // 5 分钟

function cloneConfig(): EngineConfig {
  return JSON.parse(JSON.stringify(cfg)) as EngineConfig;
}

function energyAfter(s: SState, ticks: number, input: Parameters<typeof tick>[1]): number {
  for (let i = 0; i < ticks; i++) tick(s, input, cfg);
  return s.energy;
}

describe("A：清醒持续耗能", () => {
  it("清醒 15h 恰好 0.40（净耗 0.04/h），第 181 拍跌破 0.40；16h 时 0.36", () => {
    const s = initialSState(); // energy=1.0
    // ENERGY_WAKE_COST=1.04/h：每拍净变化 = (1−1.04)/12 = −1/300
    for (let i = 0; i < 180; i++) tick(s, { dtHours: TICK }, cfg);
    expect(Math.abs(s.energy - 0.4)).toBeLessThanOrEqual(1e-9);
    tick(s, { dtHours: TICK }, cfg);
    expect(s.energy).toBeLessThan(0.4);
    // 再走 11 拍到 192 拍（16h）：1 − 192/300 = 0.36
    for (let i = 0; i < 11; i++) tick(s, { dtHours: TICK }, cfg);
    expect(Math.abs(s.energy - 0.36)).toBeLessThanOrEqual(1e-9);
  });

  it("si=0 时 192 拍单调不增（A 生效，能量不会回满）", () => {
    const s = initialSState();
    let prev = s.energy;
    for (let i = 0; i < 192; i++) {
      tick(s, { dtHours: TICK }, cfg);
      expect(s.energy).toBeLessThanOrEqual(prev);
      prev = s.energy;
    }
  });

  it("wakeDrain:false 时不扣 A，只剩恢复项", () => {
    const s = initialSState();
    s.energy = 0.5;
    tick(s, { dtHours: TICK, wakeDrain: false }, cfg);
    expect(s.energy).toBeCloseTo(0.5 + 1 / 12, 10); // 0.58333…
  });

  it("dtHours=0 时不扣 A（即时结算不推进真实时间）", () => {
    const s = initialSState();
    s.energy = 0.5;
    tick(s, { dtHours: 0 }, cfg);
    expect(s.energy).toBe(0.5);
  });

  it("ENERGY_WAKE_COST=0 是软关闭：净变化回到恢复项，不是恒 1.0", () => {
    const kill = cloneConfig();
    kill.knobs.ENERGY_WAKE_COST.value = 0;
    const s = initialSState();
    s.energy = 0.5;
    tick(s, { dtHours: TICK }, kill);
    expect(s.energy).toBeCloseTo(0.5 + 1 / 12, 10);
    expect(s.energy).not.toBe(1.0);
  });

  it("A 与 clamp 协同：不会跌破 0", () => {
    const s = initialSState();
    s.energy = 0.01;
    tick(s, { dtHours: 24 }, cfg);
    expect(s.energy).toBe(0);
  });
});

describe("B：认知事件耗能（energyCost）", () => {
  it("turn 型 tick（双 false + cost=0）energy 不变", () => {
    const s = initialSState();
    s.energy = 0.5;
    tick(s, { dtHours: TICK, wakeDrain: false, energyRecovery: false }, cfg);
    expect(s.energy).toBe(0.5);
  });

  it("turn 型 tick + cost=0.0156 恰好扣 0.0156", () => {
    const s = initialSState();
    s.energy = 0.5;
    tick(s, { dtHours: TICK, wakeDrain: false, energyRecovery: false, energyCost: 0.0156 }, cfg);
    expect(s.energy).toBeCloseTo(0.5 - 0.0156, 12);
  });

  it("asleep tick 只恢复、不扣 A", () => {
    const s = initialSState();
    s.energy = 0.2;
    tick(s, { dtHours: TICK, wakeDrain: false, energyRecovery: true }, cfg);
    expect(s.energy).toBeCloseTo(0.2 + 1 / 12, 10);
  });

  it("dtHours=0 纯事件扣能（B 不依赖时间）", () => {
    const s = initialSState();
    s.energy = 1.0;
    tick(s, { dtHours: 0, energyCost: 0.0156 }, cfg);
    expect(s.energy).toBeCloseTo(1 - 0.0156, 12);
  });

  it("扣到 0 为止（clamp01 下界）", () => {
    const s = initialSState();
    s.energy = 0.05;
    tick(s, { dtHours: 0, wakeDrain: false, energyRecovery: false, energyCost: 0.1 }, cfg);
    expect(s.energy).toBe(0);
  });

  it("非法 energyCost（负数 / NaN）拒绝", () => {
    const s = initialSState();
    expect(() => tick(s, { dtHours: TICK, energyCost: -1 }, cfg)).toThrow(RangeError);
    expect(() => tick(s, { dtHours: TICK, energyCost: Number.NaN }, cfg)).toThrow(RangeError);
  });
});

describe("energyCostFor：5 个已批准事件", () => {
  it("turn/learn/proactive/selftalk/consolidate 读 overlay 注册值", () => {
    expect(energyCostFor(cfg, "turn")).toBe(0.0156);
    expect(energyCostFor(cfg, "learn")).toBe(0.003);
    expect(energyCostFor(cfg, "proactive")).toBe(0.004);
    expect(energyCostFor(cfg, "selftalk")).toBe(0.002);
    expect(energyCostFor(cfg, "consolidate")).toBe(0.005);
  });

  it("事件集合外的名字直接拒绝", () => {
    expect(() => energyCostFor(cfg, "bogus" as EnergyCostKind)).toThrow(RangeError);
  });

  it("kill switch：5 键置 0 后一律返回 0", () => {
    const kill = cloneConfig();
    for (const name of [
      "ENERGY_COST_TURN",
      "ENERGY_COST_LEARN",
      "ENERGY_COST_PROACTIVE",
      "ENERGY_COST_SELFTALK",
      "ENERGY_COST_CONSOLIDATE",
    ]) {
      kill.knobs[name].value = 0;
    }
    for (const kind of ["turn", "learn", "proactive", "selftalk", "consolidate"] as const) {
      expect(energyCostFor(kill, kind)).toBe(0);
    }
  });

  it("负数注册值在读取时拒绝（不在 tick 里静默）", () => {
    const bad = cloneConfig();
    bad.knobs.ENERGY_COST_TURN.value = -0.01;
    expect(() => energyCostFor(bad, "turn")).toThrow(RangeError);
  });

  it("换算守恒：A 16h 后再扣 10 次 turn，可线性相加", () => {
    const s = initialSState();
    for (let i = 0; i < 192; i++) tick(s, { dtHours: TICK }, cfg);
    const afterAwake = s.energy;
    for (let i = 0; i < 10; i++) {
      tick(s, { dtHours: 0, wakeDrain: false, energyRecovery: false, energyCost: energyCostFor(cfg, "turn") }, cfg);
    }
    expect(s.energy).toBeCloseTo(afterAwake - 10 * 0.0156, 12);
  });
});
