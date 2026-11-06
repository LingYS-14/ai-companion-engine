import { describe, expect, it } from "vitest";
import {
  ACC_DECAY,
  ACC_DECAY_PER_HOUR,
  ACC_GAIN,
  ACC_TICK_MS,
  EMIT_THETA,
  decayPerTick,
  driftFromWidening,
  emittedKinds,
  initialAccumulator,
  stepAccumulator,
  type Accumulator,
} from "../src/orchestrator/intent/bus.js";
import type { IntentKind } from "../src/orchestrator/intent/types.js";

/**
 * 审计 §1 P0-1 的回归锁：**阈值必须真的可达**。
 *
 * 旧实现 λ 按"拍"给 0.35（= 每小时忘 99.8%），5 分钟一拍的缺口扩大
 * 完全来不及累积，94 拍 emitted=none。这里把"人不在时 connection 慢慢长高"
 * 这件事喂给真实的累积器，断言 reach_out 会在一段可解释的时间里越阈。
 */

const GAP_PER_TICK = 0.35 * (5 / 180); // CONTACT_WEIGHT × (5 分钟 / 180 分钟满值)

function feedWidening(ticks: number, perTick: number, from = initialAccumulator()): Accumulator {
  let acc = from;
  for (let i = 0; i < ticks; i += 1) {
    acc = stepAccumulator(acc, {
      drift: driftFromWidening({ connection: perTick }),
      dtMs: ACC_TICK_MS,
    });
  }
  return acc;
}

describe("λ 的时间尺度（A2）", () => {
  it("按小时定义：5 分钟拍 ≈ 0.0355，整小时 = 0.35", () => {
    expect(ACC_DECAY_PER_HOUR).toBe(0.35);
    expect(ACC_DECAY).toBeCloseTo(1 - Math.pow(0.65, 1 / 12), 12);
    expect(ACC_DECAY).toBeCloseTo(0.03526, 5);
    expect(decayPerTick(3_600_000)).toBeCloseTo(0.35, 12);
    expect(decayPerTick(ACC_TICK_MS)).toBe(ACC_DECAY);
  });

  it("半步可叠加：两个 5 分钟拍 ≈ 一个 10 分钟拍", () => {
    const two = 1 - Math.pow(1 - decayPerTick(ACC_TICK_MS), 2);
    expect(two).toBeCloseTo(decayPerTick(2 * ACC_TICK_MS), 12);
  });

  it("晚到一小时的拍与十二个 5 分钟拍等价", () => {
    const start = initialAccumulator();
    let many = start;
    for (let i = 0; i < 12; i += 1) many = stepAccumulator(many, { dtMs: ACC_TICK_MS });
    const once = stepAccumulator(start, { dtMs: 3_600_000 });
    expect(once.reach_out).toBeCloseTo(many.reach_out, 12);
  });

  it("非法 dtMs / perHour 抛错", () => {
    expect(() => decayPerTick(0)).toThrow(RangeError);
    expect(() => decayPerTick(Number.NaN)).toThrow(RangeError);
    expect(() => decayPerTick(ACC_TICK_MS, 1.5)).toThrow(RangeError);
    expect(() => stepAccumulator(initialAccumulator(), { dtMs: -1 })).toThrow(RangeError);
  });
});

describe("reach_out 的可达性（审计 P0-1）", () => {
  it("缺口持续扩大约 100 分钟时越阈，而不是永远到不了", () => {
    // stranger 基线 0.8 + 0.35×ramp，ramp=1 时封顶 1.0 → 只有约 21 拍在扩大。
    // 25 拍足够覆盖封顶前后的整段。
    let acc = initialAccumulator();
    let firstEmit: number | null = null;
    let last = 0;
    for (let tick = 1; tick <= 25; tick += 1) {
      acc = stepAccumulator(acc, {
        drift: driftFromWidening({ connection: GAP_PER_TICK }),
        dtMs: ACC_TICK_MS,
      });
      expect(acc.reach_out).toBeGreaterThanOrEqual(last - 1e-12);
      last = acc.reach_out;
      if (firstEmit === null && acc.reach_out > EMIT_THETA.reach_out) firstEmit = tick;
    }
    expect(firstEmit).not.toBeNull();
    // 100 分钟 ≈ 20 拍；给 15–25 的窗口，避免把标定写成"刚好第 20 拍"这种脆断言。
    expect(firstEmit).toBeGreaterThanOrEqual(15);
    expect(firstEmit).toBeLessThanOrEqual(25);
    expect(acc.reach_out).toBeGreaterThan(EMIT_THETA.reach_out);
  });

  it("越阈那拍 emittedKinds 真的报出 reach_out（connection 同时推动同源类别）", () => {
    const acc = feedWidening(21, GAP_PER_TICK);
    expect(acc.reach_out).toBeGreaterThan(EMIT_THETA.reach_out);
    const emitted = emittedKinds(acc, []);
    // connection 扩大同时给 continue_thread / repair 提供"同类缺口"，
    // 它们也是从 connection 读缺口的社会性出口，被一起推高是设计内行为。
    expect(emitted).toContain("reach_out");
    expect(emitted).not.toContain("explore");
    expect(emitted).not.toContain("create");
    expect(emitted).not.toContain("withdraw");
    expect(emitted).not.toContain("idle");
  });

  it("缺口不再扩大时，两小时内会回落到阈值以下（不是只会涨）", () => {
    const hot = stepAccumulator(initialAccumulator(), {
      drift: driftFromWidening({ connection: GAP_PER_TICK * 40 }),
      dtMs: ACC_TICK_MS,
    });
    const base = Math.min(1, hot.reach_out);
    expect(base).toBeGreaterThan(EMIT_THETA.reach_out);
    let acc = hot;
    // 从 1.0 起步，每小时 ×0.65：1.0 → 0.65h 后 0.65…，20 拍（≈1h40m）到 ≈0.49。
    for (let i = 0; i < 20; i += 1) acc = stepAccumulator(acc, { dtMs: ACC_TICK_MS });
    expect(acc.reach_out).toBeLessThan(EMIT_THETA.reach_out);
  });

  it("同一段缺席只浮现一次；分开的三段缺席各浮现一次", () => {
    const windows: Accumulator[] = [];
    for (let day = 0; day < 3; day += 1) {
      let acc = initialAccumulator();
      let emits = 0;
      // 第一次浮现 → 意图表里就有一条 open 的了；同类的后续拍不应再"浮现"。
      let active: IntentKind[] = [];
      for (let tick = 1; tick <= 21; tick += 1) {
        acc = stepAccumulator(acc, {
          drift: driftFromWidening({ connection: GAP_PER_TICK }),
          dtMs: ACC_TICK_MS,
        });
        const emitted = emittedKinds(acc, active);
        if (emitted.includes("reach_out")) {
          emits += 1;
          active = [...emitted];
        }
      }
      expect(emits).toBe(1);
      windows.push(acc);
      // 他回来了：缺口消失（drift 0），累积器几拍内落回阈值下、不再浮现。
      // repair 的 θ 最低（0.5），从 ≈0.626 起大约要 7 拍才彻底落到所有阈值下。
      let cooled = 0;
      while (cooled < 10 && emittedKinds(acc, []).length > 0) {
        acc = stepAccumulator(acc, { dtMs: ACC_TICK_MS });
        cooled += 1;
      }
      expect(emittedKinds(acc, [])).toEqual([]);
      expect(cooled).toBeGreaterThan(0);
      expect(cooled).toBeLessThanOrEqual(10);
    }
    expect(windows).toHaveLength(3);
  });

  it("只有 reach_out 被推高，别的类别不会被误发", () => {
    const acc = feedWidening(25, GAP_PER_TICK);
    expect(acc.explore).toBe(0);
    expect(acc.create).toBe(0);
    expect(acc.withdraw).toBe(0);
    expect(acc.idle).toBe(0);
  });

  it("标定常量自洽：ACC_GAIN 用来说明为什么不是 0.6", () => {
    expect(ACC_GAIN).toBeGreaterThan(1);
    expect(EMIT_THETA.reach_out).toBe(0.6);
  });
});
