import { describe, expect, it } from "vitest";
import {
  EXPECTATION_DEAD_ZONE,
  MIN_SAMPLES_PER_KIND,
  RELIABILITY_FLOOR,
  effectiveRelief,
  initialLearningState,
  learnFromOutcome,
  learningSummary,
  meanRelief,
  type LearnInput,
  type LearningState,
} from "../src/orchestrator/intent/learning-loop.js";
import type { AttributeOutcomeInput } from "../src/orchestrator/intent/attribution.js";

function outcome(predError = 0.2, binding = 0.6): AttributeOutcomeInput {
  return {
    intentId: "itn-1",
    predicted: "说一句话",
    observed: "她回了一句",
    predError,
    binding,
    hasIntentTrace: true,
    expectedRelief: { connection: 0.6, novelty: 0.2 },
    actualRelief: { connection: 0.2, novelty: 0.1 },
  };
}

function learn(state: LearningState, input: LearnInput = { kind: "reach_out", outcome: outcome() }) {
  return learnFromOutcome(state, input);
}

function repeat(state: LearningState, times: number, input?: LearnInput) {
  let current = state;
  for (let i = 0; i < times; i += 1) current = learn(current, input).state;
  return current;
}

describe("P3 归因闭环：初始状态", () => {
  it("七类意图各有一条空记录，样本 0、可靠度 1、归因计数全 0", () => {
    const state = initialLearningState();
    const kinds = Object.keys(state.kinds);
    expect(kinds).toHaveLength(7);
    for (const kind of kinds) {
      const learning = state.kinds[kind as keyof typeof state.kinds];
      expect(learning.samples).toBe(0);
      expect(learning.reliability).toBe(1);
      expect(learning.byTarget).toEqual({ self: 0, other: 0, world: 0, unclear: 0 });
    }
  });
});

describe("P3 归因闭环：一次学习", () => {
  it("返回归因结果与这一拍的驱动回写（不另算一套公式）", () => {
    const result = learn(initialLearningState());
    expect(result.attribution.intent_id).toBe("itn-1");
    expect(result.attribution.agency).toBeGreaterThan(0);
    expect(result.delta.connection).toBeCloseTo(0.2 * (0.6 - 0.2), 10);
    expect(result.delta.novelty).toBeCloseTo(0.2 * (0.2 - 0.1), 10);
    expect(result.note).toContain("样本不足");
  });

  it("滚动均值：第二次会按样本数加权，不是简单覆盖", () => {
    let state = learn(initialLearningState()).state;
    const first = state.kinds.reach_out;
    expect(first.expectedMean).toBeCloseTo(meanRelief({ connection: 0.6, novelty: 0.2 }), 10);

    state = learn(state).state;
    const second = state.kinds.reach_out;
    expect(second.samples).toBe(2);
    expect(second.expectedMean).toBeCloseTo(first.expectedMean, 10);
  });

  it("样本不足 MIN 时可靠度不动（一两次落空不算长期）", () => {
    let state = initialLearningState();
    for (let i = 0; i < MIN_SAMPLES_PER_KIND - 1; i += 1) {
      state = learn(state).state;
      expect(state.kinds.reach_out.reliability).toBe(1);
    }
  });
});

describe("P3 归因闭环：长期预期落空 → 可靠度衰减", () => {
  it("满样本后且预期高于实际超出死区：每次乘 0.9，有地板", () => {
    let state = repeat(initialLearningState(), MIN_SAMPLES_PER_KIND - 1);
    // 第 5 个样本到手才开始判「长期」：第 5 次衰减到 0.9，第 6 次 0.81
    state = learn(state).state;
    expect(state.kinds.reach_out.samples).toBe(MIN_SAMPLES_PER_KIND);
    expect(state.kinds.reach_out.reliability).toBeCloseTo(0.9, 10);
    state = learn(state).state;
    expect(state.kinds.reach_out.reliability).toBeCloseTo(0.81, 10);

    for (let i = 0; i < 40; i += 1) state = learn(state).state;
    expect(state.kinds.reach_out.reliability).toBe(RELIABILITY_FLOOR);
  });

  it("预期与实际差在死区内：即使样本够也不衰减", () => {
    const flat: AttributeOutcomeInput = {
      ...outcome(),
      expectedRelief: { connection: 0.5 },
      actualRelief: { connection: 0.5 - EXPECTATION_DEAD_ZONE / 2 },
    };
    const state = repeat(initialLearningState(), MIN_SAMPLES_PER_KIND + 3, { kind: "explore", outcome: flat });
    expect(state.kinds.explore.reliability).toBe(1);
  });

  it("实际比预期好：可靠度回升但不超过 1", () => {
    const lowExpected = { energy: 0.1, integrity: 0.1, connection: 0.1, competence: 0.1, novelty: 0.1, coherence: 0.1 };
    const highActual = { energy: 0.9, integrity: 0.9, connection: 0.9, competence: 0.9, novelty: 0.9, coherence: 0.9 };
    const good: AttributeOutcomeInput = { ...outcome(), expectedRelief: lowExpected, actualRelief: highActual };
    let state: LearningState = {
      ...initialLearningState(),
      kinds: {
        ...initialLearningState().kinds,
        reach_out: { ...initialLearningState().kinds.reach_out, reliability: 0.5, samples: MIN_SAMPLES_PER_KIND },
      },
    };
    state = learn(state, { kind: "reach_out", outcome: good }).state;
    expect(state.kinds.reach_out.reliability).toBeCloseTo(Math.min(1, 0.5 * 1.05), 10);
    state = repeat(state, 30, { kind: "reach_out", outcome: good });
    expect(state.kinds.reach_out.reliability).toBe(1);
  });
});

describe("P3 归因闭环：归因累计与读法", () => {
  it("归因分类按 self/other/world/unclear 累加", () => {
    const selfCase = outcome(0.05, 0.9); // 高绑定、低误差 → self
    const worldCase = outcome(0.95, 0.05); // 低绑定、高误差 → world
    let state = learn(initialLearningState(), { kind: "reach_out", outcome: selfCase }).state;
    state = learn(state, { kind: "reach_out", outcome: worldCase }).state;
    expect(state.kinds.reach_out.byTarget.self).toBe(1);
    expect(state.kinds.reach_out.byTarget.world).toBe(1);
    expect(state.kinds.reach_out.byTarget.other).toBe(0);
  });

  it("effectiveRelief = 期望均值 × 可靠度，且不会越界", () => {
    const state = repeat(initialLearningState(), MIN_SAMPLES_PER_KIND + 2);
    const learning = state.kinds.reach_out;
    expect(effectiveRelief("reach_out", state)).toBeCloseTo(learning.expectedMean * learning.reliability, 10);
    expect(effectiveRelief("reach_out", state)).toBeGreaterThanOrEqual(0);
    expect(effectiveRelief("reach_out", state)).toBeLessThanOrEqual(1);
  });

  it("摘要只写有样本的类别；没样本时明说「没有数据」而不是「学得很好」", () => {
    expect(learningSummary(initialLearningState())).toEqual([
      "还没有可供学习的行为结果（不把「没有数据」写成「学得很好」）",
    ]);
    const state = repeat(initialLearningState(), 2);
    const lines = learningSummary(state);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reach_out");
    expect(lines[0]).toContain("2 次");
    expect(lines[0]).toContain("可靠度");
    expect(lines[0]).toContain("自己");
  });
});

describe("P3 归因闭环：不改入参 / 非法输入", () => {
  it("返回新状态，原状态一个字段都不变", () => {
    const before = initialLearningState();
    const snapshot = JSON.stringify(before);
    learn(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("未知类别、版本不符、非有限/越界满足度都抛 RangeError", () => {
    const state = initialLearningState();
    expect(() => learn(state, { kind: "daydream" as never, outcome: outcome() })).toThrow(RangeError);
    expect(() => learn({ ...state, version: 2 as never })).toThrow(RangeError);
    expect(() => learn(state, { kind: "reach_out", outcome: { ...outcome(), expectedRelief: { connection: Number.NaN } } })).toThrow(RangeError);
    expect(() => learn(state, { kind: "reach_out", outcome: { ...outcome(), actualRelief: { connection: 1.5 } } })).toThrow(RangeError);
    expect(() => meanRelief({ connection: -0.1 })).toThrow(RangeError);
    expect(() => effectiveRelief("daydream" as never, state)).toThrow(RangeError);
  });

  it("批量顺序学习与逐个调用等价（可重放）", () => {
    const inputs: LearnInput[] = [
      { kind: "reach_out", outcome: outcome(0.2, 0.6) },
      { kind: "explore", outcome: outcome(0.3, 0.5) },
      { kind: "reach_out", outcome: outcome(0.4, 0.4) },
    ];
    let sequential = initialLearningState();
    for (const input of inputs) sequential = learn(sequential, input).state;
    expect(sequential.kinds.reach_out.samples).toBe(2);
    expect(sequential.kinds.explore.samples).toBe(1);
    const firstMean = meanRelief({ connection: 0.6, novelty: 0.2 });
    const secondMean = meanRelief({ connection: 0.6, novelty: 0.2 });
    expect(sequential.kinds.reach_out.expectedMean).toBeCloseTo((firstMean + secondMean) / 2, 10);
  });
});
