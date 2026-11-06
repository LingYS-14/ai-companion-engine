import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import {
  ExpectationModel,
  alpha,
  applyOceanDelta,
  classifyDrift,
  computeRepairDelta,
  driftDelta,
  learnDelta,
} from "../src/learning/learn.js";

const cfg = loadConfig();

describe("§7.2 alpha", () => {
  it("无证据、浅关系时 = ALPHA_BASE", () => {
    expect(alpha(0, 0, cfg)).toBeCloseTo(0.3, 10);
  });

  it("证据越多学得越慢；关系越深学得越慢", () => {
    expect(alpha(2, 0, cfg)).toBeCloseTo(0.15, 10);
    expect(alpha(0, 1, cfg)).toBeCloseTo(0.2, 10);
    expect(alpha(2, 1, cfg)).toBeCloseTo(0.1, 10);
  });

  it("非法输入抛错（不许负证据/越界 bond）", () => {
    expect(() => alpha(-1, 0, cfg)).toThrow(/不能为负/);
    expect(() => alpha(0, 1.2, cfg)).toThrow(/越界/);
  });
});

describe("§7.2 预测误差驱动", () => {
  it("learnDelta 被 LEARN_MAGNITUDE_CAP 截断", () => {
    // 0.3 × (1.0 − 0.3) = 0.21 → cap 0.05
    expect(learnDelta(1.0, 0.3, 0, 0, cfg)).toBeCloseTo(0.05, 10);
    expect(learnDelta(0.3, 1.0, 0, 0, cfg)).toBeCloseTo(-0.05, 10);
    // 小误差不触顶：0.3 × 0.1 = 0.03
    expect(learnDelta(0.4, 0.3, 0, 0, cfg)).toBeCloseTo(0.03, 10);
  });

  it("ExpectationModel：无历史用先验，有历史用窗口均值", () => {
    const m = new ExpectationModel(cfg);
    expect(m.predictIntensity("approach", [])).toBeCloseTo(0.3, 10);
    const history = [
      { type: "approach", intensity: 0.5 },
      { type: "approach", intensity: 0.7 },
      { type: "comfort", intensity: 0.1 },
    ];
    expect(m.predictIntensity("approach", history)).toBeCloseTo(0.6, 10);
  });

  it("增量预测在窗口未变时复用缓存（语义不变）", () => {
    const m = new ExpectationModel(cfg);
    const history = [{ type: "approach", intensity: 0.5 }];
    const first = m.predictIntensityIncremental("approach", history);
    const second = m.predictIntensityIncremental("approach", [...history, { type: "approach", intensity: 0.9 }]);
    expect(first).toBeCloseTo(0.5, 10);
    expect(second).toBeCloseTo(0.5, 10); // 新增 1 个 < 重算间隔 5，走缓存
  });
});

describe("§7.1 里程碑捷径（B8 / B9）", () => {
  const bond = (over: Partial<{ progress: number; trust: number; recentRupture: boolean }> = {}) => ({
    progress: 0,
    trust: 0.2,
    recentRupture: true,
    ...over,
  });
  const ev = (over: Partial<{ type: string; intensity: number }> = {}) => ({ type: "comfort", intensity: 0.95, ...over });

  it("非修复期 / 类型不在 eligible → no_op", () => {
    expect(computeRepairDelta(ev(), bond({ recentRupture: false }), {}, cfg).path).toBe("no_op");
    expect(computeRepairDelta(ev({ type: "insult" }), bond(), {}, cfg).path).toBe("no_op");
  });

  it("强度不足 → 转 queue_insight（不丢弃事件）", () => {
    const r = computeRepairDelta(ev({ intensity: 0.5 }), bond(), {}, cfg);
    expect(r.path).toBe("no_op");
    expect(r.reason).toMatch(/强度不足/);
  });

  it("gift 在 eligible 但不在 TYPE_SET → 不进捷径", () => {
    expect(computeRepairDelta(ev({ type: "gift" }), bond(), {}, cfg).path).toBe("no_op");
  });

  it("里程碑只生效一次", () => {
    expect(computeRepairDelta(ev(), bond(), { comfort: true }, cfg).path).toBe("no_op");
  });

  it("delta_bond 受剩余空间约束（cap 不再永不 bind）", () => {
    expect(computeRepairDelta(ev(), bond({ progress: 0 }), {}, cfg).deltaBond).toBeCloseTo(0.15, 10);
    expect(computeRepairDelta(ev(), bond({ progress: 0.15 }), {}, cfg).deltaBond).toBeCloseTo(0.05, 10);
    expect(computeRepairDelta(ev(), bond({ progress: 0.2 }), {}, cfg).deltaBond).toBe(0);
  });

  it("delta_trust 被 TRUST_MAX_STEP 封顶（不再一步到 1.0）", () => {
    const r = computeRepairDelta(ev(), bond(), {}, cfg);
    expect(r.deltaTrust).toBeCloseTo(0.1, 10); // 原式 3×0.95×0.8 = 2.28
    expect(bond().trust + r.deltaTrust).toBeLessThan(1);
  });
});

describe("§5.4 人格漂移", () => {
  it("幅度不足 → NOISE", () => {
    expect(classifyDrift({ deltas: [0.01, 0.02, 0.01, 0.0, 0.01, 0.02, 0.01] }, cfg)).toBe("NOISE");
  });

  it("幅度够但方向反复 → OSCILLATION（净值 0.157 过幅度闸，同号比例 3/7 未过一致性闸）", () => {
    expect(classifyDrift({ deltas: [0.5, 0.5, 0.5, -0.1, -0.1, -0.1, -0.1] }, cfg)).toBe("OSCILLATION");
  });

  it("完全对称的往复会先撞 NOISE（规格先判幅度，这条分支要留痕）", () => {
    expect(classifyDrift({ deltas: [0.2, -0.2, 0.2, -0.2, 0.2, -0.2, 0.2] }, cfg)).toBe("NOISE");
  });

  it("幅度够且同号 → SIGNATURE_DRIFT", () => {
    expect(classifyDrift({ deltas: [0.2, 0.21, 0.19, 0.2, 0.22, 0.2, 0.21] }, cfg)).toBe("SIGNATURE_DRIFT");
  });

  it("只有 SIGNATURE 才动人格，且被 MAGNITUDE_CAP.ocean 限幅", () => {
    expect(driftDelta("SIGNATURE_DRIFT", 0.5, cfg)).toBeCloseTo(0.02, 10);
    expect(driftDelta("NOISE", 0.1, cfg)).toBeCloseTo(-0.002, 10);
    expect(driftDelta("OSCILLATION", 0.1, cfg)).toBeCloseTo(-0.002, 10);
  });

  it("applyOceanDelta 双向限幅并 clamp 到 [0,1]", () => {
    expect(applyOceanDelta(0.5, 0.5, cfg)).toBeCloseTo(0.52, 10);
    expect(applyOceanDelta(0.01, -0.5, cfg)).toBeCloseTo(0, 10);
  });
});
