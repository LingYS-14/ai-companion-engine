import { describe, expect, it } from "vitest";
import {
  AGENCY_ALPHA,
  AGENCY_BETA,
  DRIVE_DELTA_CAP,
  DRIVE_LEARN_ETA,
  agencyScore,
  attributeOutcome,
  classifyAttribution,
  driveLearningDelta,
  sigmoid,
  survivalScore,
} from "../src/orchestrator/intent/attribution.js";

describe("§4.3(c) 代理感：agency = σ(α·(−predError) + β·binding)", () => {
  it("无误差且完全绑定时显著偏高；高误差且不绑定时偏低", () => {
    const perfect = agencyScore(0, 1);
    expect(perfect).toBeCloseTo(sigmoid(AGENCY_BETA), 10);
    expect(perfect).toBeCloseTo(0.7685, 3);
    const chaotic = agencyScore(1, 0);
    expect(chaotic).toBeCloseTo(sigmoid(-AGENCY_ALPHA), 10);
    expect(chaotic).toBeCloseTo(0.1679, 3);
    // 单调：误差越小越像自己做的；绑定越强越像自己做的
    expect(agencyScore(0.2, 0.8)).toBeGreaterThan(agencyScore(0.8, 0.8));
    expect(agencyScore(0.5, 0.9)).toBeGreaterThan(agencyScore(0.5, 0.1));
    // 中位：0 误差 0 绑定 / 1 误差 1 绑定 → σ(0)=0.5 与 σ(−0.4) 之间
    expect(agencyScore(0, 0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(0)).toBe(0.5);
  });

  it("输入越界与非法参数抛错（不静默夹住：归因错一次学习就错一路）", () => {
    expect(() => agencyScore(Number.NaN, 0.5)).toThrow(RangeError);
    expect(() => agencyScore(0.5, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => agencyScore(0.5, 0.5, { alpha: Number.NaN })).toThrow(RangeError);
    expect(() => sigmoid(Number.NaN)).toThrow(RangeError);
    // 0..1 之外的输入被夹到边界，而不是抛（比 NaN 温和：超界是刻度问题，不是缺失）
    expect(agencyScore(-1, 2)).toBeCloseTo(agencyScore(0, 1), 10);
  });
});

describe("归因分类：self / other / world / unclear（trace 只做分类先验）", () => {
  it("高 agency 判自己；低 agency 判世界；交互类且低 agency 判对方", () => {
    expect(classifyAttribution({ predError: 0.1, binding: 0.9, hasIntentTrace: false })).toBe("self");
    expect(classifyAttribution({ predError: 1, binding: 0, hasIntentTrace: false })).toBe("world");
    expect(classifyAttribution({ predError: 1, binding: 0, hasIntentTrace: false, involvesOther: true })).toBe("other");
  });

  it("中间地带没有 trace 时是 unclear；有 trace 时降阈值判自己", () => {
    // binding .8 / predError .5 → σ(−0.8+0.96)=σ(0.16)≈0.5399
    expect(classifyAttribution({ predError: 0.5, binding: 0.8, hasIntentTrace: false })).toBe("unclear");
    expect(classifyAttribution({ predError: 0.5, binding: 0.8, hasIntentTrace: true })).toBe("self");
  });
});

describe("驱动学习：driveDelta = clamp(η·(expected − actual), ±cap)", () => {
  it("预期高于实际 → 正回写（她学到这事没那么好受）；逐维独立", () => {
    const delta = driveLearningDelta({ connection: 0.8, novelty: 0.2 }, { connection: 0.2, novelty: 0.2 });
    expect(delta.connection).toBeCloseTo(DRIVE_LEARN_ETA * 0.6, 10);
    expect(delta.connection).toBeCloseTo(0.12, 10);
    expect(delta.novelty).toBeUndefined(); // 零变化不写
    expect(DRIVE_LEARN_ETA).toBe(0.2);
  });

  it("单次改动被 cap 限幅；非法 eta / 非有限值抛", () => {
    const capped = driveLearningDelta({ integrity: 1 }, { integrity: 0 }, { eta: 5 });
    expect(capped.integrity).toBeCloseTo(DRIVE_DELTA_CAP, 10);
    expect(() => driveLearningDelta({}, {}, { eta: -1 })).toThrow(RangeError);
    expect(() => driveLearningDelta({ energy: Number.NaN }, {})).toThrow(RangeError);
  });
});

describe("attributeOutcome：一次完整归因（纯函数）", () => {
  it("返回完整 Attribution：分数/分类/逐维回写", () => {
    const result = attributeOutcome({
      intentId: "in-1",
      predicted: "他会回我一句",
      observed: "他没回",
      predError: 0.8,
      binding: 0.6,
      hasIntentTrace: true,
      expectedRelief: { connection: 0.8 },
      actualRelief: { connection: 0.3 },
    });
    expect(result.intent_id).toBe("in-1");
    expect(result.agency).toBeGreaterThan(0.35); // σ(−1.28+0.72)=σ(−0.56)≈0.3635，仍属偏差大
    expect(result.agency).toBeLessThan(0.4);
    expect(result.attributedTo).toBe("unclear");
    expect(result.driveDelta.connection).toBeCloseTo(0.1, 10);
    expect(result.predError).toBeCloseTo(0.8, 10);
    // 没有给 relief 时回写是空对象，不是 undefined
    const noRelief = attributeOutcome({
      intentId: "in-2",
      predicted: "p",
      observed: "o",
      predError: 0.2,
      binding: 0.5,
      hasIntentTrace: false,
    });
    expect(noRelief.driveDelta).toEqual({});
  });

  it("survivalScore 单条折算：0→0，3→0.75，-1 抛错", () => {
    expect(survivalScore(0)).toBe(0);
    expect(survivalScore(3)).toBeCloseTo(0.75, 10);
    expect(() => survivalScore(-1)).toThrow(RangeError);
  });
});
