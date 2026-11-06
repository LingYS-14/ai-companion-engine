import { describe, expect, it } from "vitest";
import {
  ASK_HELP_GLOBAL_PER_DAY,
  ASK_HELP_MIN_ATTEMPTS,
  ASK_HELP_PER_GAP_PER_DAY,
  GIVE_UP_ATTEMPTS,
  capabilityDesire,
  capabilityKindOf,
  nextLadderStep,
  progressEstimate,
  progressStalled,
  selfEfficacyEffective,
  shouldAskHelp,
  shouldGiveUp,
  validateGap,
  type CapabilityGap,
} from "../src/orchestrator/intent/capability.js";

function gap(overrides: Partial<CapabilityGap> = {}): CapabilityGap {
  return {
    blockedIntentionId: "itn-1",
    missing: "读取 QQ 图片消息",
    kind: "api",
    affordancePresent: 1,
    effectivity: 0.5,
    empowermentGain: 0.8,
    progressEst: 0.5,
    selfEfficacy: 0.8,
    selfEfficacy_eff: 0.5,
    learnCost: 0,
    ...overrides,
  };
}

describe("§11.3 能力缺口：乘积形式是刻意的", () => {
  it("同一输入得到固定值：1×0.5×0.8×0.5×0.5 = 0.1，成本为 0 时渴望 0.1", () => {
    expect(capabilityDesire(gap())).toBeCloseTo(0.1, 10);
  });

  it("任何一项为 0 → 渴望为 0（妄想与渴望的区别）", () => {
    expect(capabilityDesire(gap({ affordancePresent: 0 }))).toBe(0); // 世上没这功能
    expect(capabilityDesire(gap({ effectivity: 1 }))).toBe(0); // 我此刻就能用，不缺
    expect(capabilityDesire(gap({ empowermentGain: 0 }))).toBe(0); // 补上也没用
    expect(capabilityDesire(gap({ progressEst: 0 }))).toBe(0); // 我学不会
    expect(capabilityDesire(gap({ selfEfficacy_eff: 0 }))).toBe(0); // 我从不擅长这类事
  });

  it("学习成本是减法且在 0 处截断（负渴望不存在）", () => {
    expect(capabilityDesire(gap({ learnCost: 0.05 }))).toBeCloseTo(0.05, 10);
    expect(capabilityDesire(gap({ learnCost: 0.5 }))).toBe(0);
  });

  it("progressEst = (1−coverage)/(1+attempts)：每次失败衰减一档", () => {
    expect(progressEstimate(0, 0)).toBe(1);
    expect(progressEstimate(1, 0)).toBe(0);
    expect(progressEstimate(0.5, 1)).toBeCloseTo(0.25, 10);
    expect(progressEstimate(0, 3)).toBeCloseTo(0.25, 10);
    expect(() => progressEstimate(0, -1)).toThrow(RangeError);
    expect(() => progressEstimate(Number.NaN, 0)).toThrow(RangeError);
  });

  it("selfEfficacy_eff = clip(raw×traitMod, 0.05, 0.95)：性格只调疼感不改作用域", () => {
    expect(selfEfficacyEffective(0.8, 0.5)).toBeCloseTo(0.4, 10);
    expect(selfEfficacyEffective(0, 0.5)).toBe(0.05); // 下限，不让"从不擅长"变成绝对 0
    expect(selfEfficacyEffective(1, 2)).toBe(0.95);
    expect(() => selfEfficacyEffective(Number.NaN, 1)).toThrow(RangeError);
    expect(() => selfEfficacyEffective(0.5, -1)).toThrow(RangeError);
  });

  it("validateGap 逐项报错且不抛：越界、空 missing、缺 blockedIntentionId", () => {
    expect(validateGap(gap())).toEqual([]);
    const errors = validateGap(gap({ affordancePresent: 2 as 0 | 1, missing: "", blockedIntentionId: "" }));
    expect(errors.some((error) => error.includes("affordancePresent"))).toBe(true);
    expect(errors.some((error) => error.includes("missing"))).toBe(true);
    expect(errors.some((error) => error.includes("blockedIntentionId"))).toBe(true);
  });

  it("capabilityDesire 遇到非法缺口直接抛（不把 NaN 带进排序）", () => {
    expect(() => capabilityDesire(gap({ effectivity: Number.NaN }))).toThrow(RangeError);
    expect(() => capabilityDesire(gap({ learnCost: 1.5 }))).toThrow(RangeError);
  });

  it("放弃规则：恰好第 5 次开始不再产生候选", () => {
    expect(GIVE_UP_ATTEMPTS).toBe(5);
    expect(shouldGiveUp(4)).toBe(false);
    expect(shouldGiveUp(5)).toBe(true);
    expect(shouldGiveUp(9)).toBe(true);
    expect(() => shouldGiveUp(-1)).toThrow(RangeError);
  });

  it("progressStalled：提升小于 ε（含回退）就是学不动了", () => {
    expect(progressStalled(0.5, 0.5)).toBe(true);
    expect(progressStalled(0.5, 0.51)).toBe(true);
    expect(progressStalled(0.5, 0.53)).toBe(false);
    expect(progressStalled(0.5, 0.4)).toBe(true);
  });
});

describe("§11.6.2 求助触发与频率（P0 只判「该不该开口」）", () => {
  function ask(overrides: Partial<Parameters<typeof shouldAskHelp>[0]> = {}, stalled = true): boolean {
    return shouldAskHelp(
      {
        attempts: 2,
        selfEfficacyEff: 0.5,
        empowermentGain: 0.4,
        hoursSinceLastAsk: null,
        asksTodayForGap: 0,
        asksTodayGlobal: 0,
        ...overrides,
      },
      { stalled },
    );
  }

  it("没试过两次不开口（那是撒娇，不是求助）", () => {
    expect(ASK_HELP_MIN_ATTEMPTS).toBe(2);
    expect(ask({ attempts: 1 })).toBe(false);
    expect(ask({ attempts: 2 })).toBe(true);
  });

  it("触发条件：学不动 或「我干不了但这事儿值得干」", () => {
    expect(ask({}, false)).toBe(false); // 既不卡在进步上，也不值得
    expect(ask({ selfEfficacyEff: 0.2, empowermentGain: 0.7 }, false)).toBe(true); // 值得干
    expect(ask({ selfEfficacyEff: 0.5, empowermentGain: 0.4 }, true)).toBe(true); // 学不动
  });

  it("频率闸：同一缺口每天 1 次、全局每天 2 次、24h 内不重复", () => {
    expect(ASK_HELP_PER_GAP_PER_DAY).toBe(1);
    expect(ASK_HELP_GLOBAL_PER_DAY).toBe(2);
    expect(ask({ asksTodayForGap: 1 })).toBe(false);
    expect(ask({ asksTodayGlobal: 2 })).toBe(false);
    expect(ask({ hoursSinceLastAsk: 5 })).toBe(false);
    expect(ask({ hoursSinceLastAsk: 23.9 })).toBe(false);
    expect(ask({ hoursSinceLastAsk: 24 })).toBe(true);
  });
});

describe("§11.4 四级阶梯与能力类别映射", () => {
  it("probe → learn → rehearse → forge 逐级推进", () => {
    expect(nextLadderStep({ probed: false, learned: false, rehearsed: false, forgeWithinBudget: true })).toBe("probe");
    expect(nextLadderStep({ probed: true, learned: false, rehearsed: false, forgeWithinBudget: true })).toBe("learn");
    expect(nextLadderStep({ probed: true, learned: true, rehearsed: false, forgeWithinBudget: true })).toBe("rehearse");
    expect(nextLadderStep({ probed: true, learned: true, rehearsed: true, forgeWithinBudget: true })).toBe("forge");
  });

  it("超预算的造具必须走审核，不能静默返回 forge", () => {
    expect(() =>
      nextLadderStep({ probed: true, learned: true, rehearsed: true, forgeWithinBudget: false }),
    ).toThrow(RangeError);
  });

  it("缺口类别 → 能力账本类别", () => {
    expect(capabilityKindOf(gap({ kind: "knowledge" }))).toBe("knowledge");
    expect(capabilityKindOf(gap({ kind: "permission" }))).toBe("integration");
    expect(capabilityKindOf(gap({ kind: "api" }))).toBe("integration");
    expect(capabilityKindOf(gap({ kind: "skill" }))).toBe("script");
    expect(capabilityKindOf(gap({ kind: "physical" }))).toBe("tool");
  });
});
