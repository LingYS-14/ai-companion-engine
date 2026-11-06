/**
 * 意向引擎 P0 —— 能力缺口打分（VISION §11.3 / §11.4 / §11.6.2 的纯函数部分）。
 *
 * 核心是一条**乘积**：
 *   C(g) = affordancePresent × (1−effectivity) × empowermentGain × progressEst × selfEfficacy_eff − learnCost
 * 乘积是刻意的：任何一项为 0（世上没这功能 / 我永远学不会 / 我从不擅长这类事），渴望就是 0。
 * 线性加总做不到这一点——它会因为 empowermentGain 很大，就让她执念于一个物理上不存在的能力。
 *
 * P0 边界：只做数值形式、放弃规则、求助触发条件的**判定函数**；效力探测、能力地图夜更、造具与审核
 * 都是 P4（要 IO、要沙箱、要人审）。这里零 IO、零模型调用。
 */

import type { CapabilityKind } from "./types.js";

/** §11.3 的能力缺口（P0 只落结构；`estimated` 是 v0.3 的"先估后替"标记）。 */
export interface CapabilityGap {
  /** 哪个意图卡住了（没有卡住的意图，就没有能力缺口） */
  blockedIntentionId: string;
  /** "读取 QQ 图片消息" */
  missing: string;
  kind: "knowledge" | "permission" | "api" | "skill" | "physical";
  /** 世界上到底有没有这东西（0/1） */
  affordancePresent: 0 | 1;
  /** 我此刻能不能用（0 / 0.5 / 1） */
  effectivity: number;
  /** 补上之后能多做多少事（解锁意图数 / 现有动作数；冷启动用估计值） */
  empowermentGain: number;
  /** 我能不能学会（不是难不难） */
  progressEst: number;
  /** 这类事我历史上成功过吗（原始估计） */
  selfEfficacy: number;
  /** 按性格调制后的有效值（决定反馈强度；作用域固定为同一 affordance） */
  selfEfficacy_eff: number;
  /** 探测/调用/写代码的成本（归一化） */
  learnCost: number;
  /** empowermentGain 是否还是冷启动估计值（先估后替要留痕） */
  estimated?: boolean;
}

/** 放弃规则：同一缺口尝试到第 5 次就不再产生候选（§11.7 / P4 验收）。 */
export const GIVE_UP_ATTEMPTS = 5;
/** ask_help 的最低尝试次数：没试过两次就求助 = 撒娇（§11.6.2）。 */
export const ASK_HELP_MIN_ATTEMPTS = 2;
/** 同一缺口每天最多 1 次求助；全局每 24h 最多 2 条（§11.6.2）。 */
export const ASK_HELP_PER_GAP_PER_DAY = 1;
export const ASK_HELP_GLOBAL_PER_DAY = 2;
/** progressEst 增速低于这个 ε 视为"学不动了"（可触发求助或放弃）。 */
export const PROGRESS_STALL_EPSILON = 0.02;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`能力缺口参数必须有限：${String(value)}`);
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** progressEst = clamp((1−coverage)/(1+attempts))：每失败一次，预期学习进步衰减一档。 */
export function progressEstimate(coverage: number, attempts: number): number {
  const cov = clamp01(coverage);
  if (!Number.isFinite(attempts) || attempts < 0) {
    throw new RangeError(`progressEstimate: attempts 非法：${String(attempts)}`);
  }
  return clamp01((1 - cov) / (1 + attempts));
}

/** selfEfficacy_eff = clip(raw × traitMod, 0.05, 0.95)：性格调"这次失败有多疼"，不调作用域。 */
export function selfEfficacyEffective(raw: number, traitMod: number): number {
  if (!Number.isFinite(raw) || !Number.isFinite(traitMod) || traitMod < 0) {
    throw new RangeError(`selfEfficacyEffective: 参数非法 raw=${String(raw)} traitMod=${String(traitMod)}`);
  }
  const value = clamp01(raw) * traitMod;
  return Math.min(0.95, Math.max(0.05, value));
}

/** 逐项校验缺口（P0 宁可抛，也不把 NaN 带进排序）。 */
export function validateGap(gap: CapabilityGap): string[] {
  const errors: string[] = [];
  if (gap.affordancePresent !== 0 && gap.affordancePresent !== 1) errors.push("affordancePresent 必须是 0/1");
  for (const [name, value] of [
    ["effectivity", gap.effectivity],
    ["empowermentGain", gap.empowermentGain],
    ["progressEst", gap.progressEst],
    ["selfEfficacy", gap.selfEfficacy],
    ["selfEfficacy_eff", gap.selfEfficacy_eff],
    ["learnCost", gap.learnCost],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) errors.push(`${name} 必须在 [0,1]，收到 ${String(value)}`);
  }
  if (!gap.missing) errors.push("missing 不能为空（说不清缺什么就说不上是缺口）");
  if (!gap.blockedIntentionId) errors.push("blockedIntentionId 必填（没有卡住的意图就没有缺口）");
  return errors;
}

/**
 * 渴望强度：乘积 − 学习成本，负数截到 0（负渴望 = 不想，不是"反向渴望"）。
 * 返回 0..1；任何一项为 0 → 0（妄想与渴望的区别就是第一项是 0 还是 1）。
 */
export function capabilityDesire(gap: CapabilityGap): number {
  const errors = validateGap(gap);
  if (errors.length > 0) throw new RangeError(`capabilityDesire: ${errors.join("；")}`);
  const product =
    gap.affordancePresent *
    (1 - gap.effectivity) *
    gap.empowermentGain *
    gap.progressEst *
    gap.selfEfficacy_eff;
  return clamp01(product - gap.learnCost);
}

/** 放弃规则：`attempts ≥ 5` 后该缺口不再产生候选（而是落 capability_fact，见 §11.7）。 */
export function shouldGiveUp(attempts: number): boolean {
  if (!Number.isFinite(attempts) || attempts < 0) {
    throw new RangeError(`shouldGiveUp: attempts 非法：${String(attempts)}`);
  }
  return attempts >= GIVE_UP_ATTEMPTS;
}

/** 是否"学不动了"：本次 progressEst 相对上次的提升 < ε（含回退）。 */
export function progressStalled(previous: number, current: number, epsilon = PROGRESS_STALL_EPSILON): boolean {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(epsilon)) {
    throw new RangeError("progressStalled: 参数必须有限");
  }
  return current - previous < epsilon;
}

export interface AskHelpInput {
  attempts: number;
  selfEfficacyEff: number;
  empowermentGain: number;
  /** 自上次求助过了多少小时；从没求助过传 null */
  hoursSinceLastAsk: number | null;
  /** 今天这个缺口已经求助过几次 */
  asksTodayForGap: number;
  /** 今天全局已经求助过几次 */
  asksTodayGlobal: number;
}

/**
 * §11.6.2 的求助触发判定（P0 只判"该不该开口"，不发送、不占额度——发送与额度在 P4/P1 的出口）。
 * 触发条件：`attempts ≥ 2` 且（学不动 **或** "我干不了但这事值得干"）。
 * 频率：同一缺口每天 ≤1、全局每天 ≤2。硬闸（静默/单写者/额度）不在这里，它照常拦。
 */
export function shouldAskHelp(input: AskHelpInput, opts: { stalled?: boolean } = {}): boolean {
  if (!Number.isFinite(input.attempts) || input.attempts < 0) {
    throw new RangeError(`shouldAskHelp: attempts 非法：${String(input.attempts)}`);
  }
  if (input.asksTodayForGap >= ASK_HELP_PER_GAP_PER_DAY) return false;
  if (input.asksTodayGlobal >= ASK_HELP_GLOBAL_PER_DAY) return false;
  if (input.attempts < ASK_HELP_MIN_ATTEMPTS) return false;
  const worthDoing = input.selfEfficacyEff < 0.3 && input.empowermentGain >= 0.6;
  const stalled = opts.stalled === true;
  if (!stalled && !worthDoing) return false;
  // 同一天已经问过同一缺口就不再问（哪怕 hours 很大也只是"昨天问过"）
  return input.hoursSinceLastAsk === null || input.hoursSinceLastAsk >= 24;
}

/** 四级阶梯的下一步建议（§11.4）：probe → learn → rehearse → forge。 */
export type LadderStep = "probe" | "learn" | "rehearse" | "forge";

export function nextLadderStep(progress: {
  probed: boolean;
  learned: boolean;
  rehearsed: boolean;
  /** 组合/脚本级造具是否还在变更预算内（预算判定在 P4 的 review.ts，这里只接结论） */
  forgeWithinBudget: boolean;
}): LadderStep {
  if (!progress.probed) return "probe";
  if (!progress.learned) return "learn";
  if (!progress.rehearsed) return "rehearse";
  if (!progress.forgeWithinBudget) {
    // 超预算 → 走审核，不是自己造；P0 把它显式标出来而不是静默返回 forge
    throw new RangeError("nextLadderStep: 造具超出变更预算，必须先走审核（§11.6.1）");
  }
  return "forge";
}

/** 能力记录对应的能力类别（P4 造具产物用；P0 只做映射，不写账本）。 */
export function capabilityKindOf(gap: CapabilityGap): CapabilityKind {
  switch (gap.kind) {
    case "knowledge":
      return "knowledge";
    case "permission":
    case "api":
      return "integration";
    case "skill":
      return "script";
    case "physical":
      return "tool";
  }
}
