/**
 * 意向引擎 P3 —— 归因闭环 / 驱动学习（VISION §4.3(c) 的"长期"那一半）。
 *
 * `attribution.ts` 回答的是**一次**行动的结果归给谁、这一拍驱动该往哪挪；
 * 本文件回答的是**很多次之后**：这类意图反复预期落空时，它在驱动量里的权重该不该降下来。
 * 规格原话：「长期 expected>actual 的类别 drift 自动衰减」——如果不做这一层，
 * 她就会一直对同一类事保持同样的渴望，学不到"这条路上次也没让我好受"。
 *
 * 三条纪律：
 *   1. 只调**可靠度乘子**，不改 `INTENT_WEIGHTS`（D2 工程先验值要等真实轨迹标定，不在这里偷偷改）；
 *   2. 衰减是渐进的、有地板（0.3）：不允许一次失败把一类意图「关掉」——那是另一种僵化；
 *   3. 死区（±0.05）内不动：预期和实际的正常误差不该被当成"落空"来惩罚。
 *
 * 时钟纪律：纯函数，不读系统时间、不写文件（持久化属接线）。
 */

import { attributeOutcome, type AttributeOutcomeInput } from "./attribution.js";
import {
  DRIVE_KEYS,
  INTENT_KINDS,
  type Attribution,
  type AttributionTarget,
  type DriveVector,
  type IntentKind,
} from "./types.js";

export const LEARNING_STATE_VERSION = 1 as const;

/** 少于此样本数不判「长期」——一两次落空说明不了什么。 */
export const MIN_SAMPLES_PER_KIND = 5;
/** 预期与实际的死区：差距在这个范围内不调可靠度。 */
export const EXPECTATION_DEAD_ZONE = 0.05;
/** 长期落空时每次乘的衰减系数（每多一次样本衰减一次）。 */
export const RELIABILITY_DECAY = 0.1;
/** 预期被低估（实际比预期好）时每次回升多少。 */
export const RELIABILITY_RECOVER = 0.05;
/** 可靠度地板：再失望也不把一类意图关掉。 */
export const RELIABILITY_FLOOR = 0.3;

/** 一次行动之后，某一类意图的长期学习状态。 */
export interface KindLearning {
  readonly kind: IntentKind;
  readonly samples: number;
  /** 期望满足度的滚动均值（六维取平均） */
  readonly expectedMean: number;
  /** 实际满足度的滚动均值 */
  readonly actualMean: number;
  /** 可靠度乘子 [RELIABILITY_FLOOR, 1]：长期预期落空 → 下降；实际比预期好 → 回升 */
  readonly reliability: number;
  /** 归因分类累计（self / other / world / unclear） */
  readonly byTarget: Readonly<Record<AttributionTarget, number>>;
}

export interface LearningState {
  readonly version: typeof LEARNING_STATE_VERSION;
  readonly kinds: Readonly<Record<IntentKind, KindLearning>>;
}

const ZERO_TARGETS: Readonly<Record<AttributionTarget, number>> = { self: 0, other: 0, world: 0, unclear: 0 };

function emptyKind(kind: IntentKind): KindLearning {
  return {
    kind,
    samples: 0,
    expectedMean: 0,
    actualMean: 0,
    reliability: 1,
    byTarget: ZERO_TARGETS,
  };
}

export function initialLearningState(): LearningState {
  const kinds = {} as Record<IntentKind, KindLearning>;
  for (const kind of INTENT_KINDS) kinds[kind] = emptyKind(kind);
  return { version: LEARNING_STATE_VERSION, kinds };
}

function clamp01(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} 必须有限：${String(value)}`);
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 六维满足度的平均（缺省维按 0 计；与 `driveLearningDelta` 同一口径：没填=没满足）。 */
export function meanRelief(relief: Partial<DriveVector>): number {
  let sum = 0;
  for (const key of DRIVE_KEYS) {
    const value = relief[key] ?? 0;
    if (!Number.isFinite(value)) throw new RangeError(`meanRelief: ${key} 出现非有限值`);
    if (value < 0 || value > 1) throw new RangeError(`meanRelief: ${key} 越界（应为 0..1）：${String(value)}`);
    sum += value;
  }
  return sum / DRIVE_KEYS.length;
}

export interface LearnInput {
  readonly kind: IntentKind;
  readonly outcome: AttributeOutcomeInput;
}

export interface LearnResult {
  readonly state: LearningState;
  readonly attribution: Attribution;
  /** 这一拍的驱动回写（与 `attribution.ts` 同一公式，不另算一套） */
  readonly delta: Partial<DriveVector>;
  readonly kindLearning: KindLearning;
  /** 一行说明这次学习是否调了可靠度、为什么 */
  readonly note: string;
}

function isLearningState(value: LearningState): boolean {
  return value.version === LEARNING_STATE_VERSION && typeof value.kinds === "object" && value.kinds !== null;
}

/**
 * 吃一次"行动 + 结果"，返回新的学习状态（不改入参）。
 *
 * 可靠度只在 `samples >= MIN_SAMPLES_PER_KIND` 且平均预期与实际差超出死区时才动：
 *   - 预期 > 实际（长期落空）→ × (1 − 0.1)，地板 0.3；
 *   - 预期 < 实际（低估了自己）→ 往 1 回升 × 1.05，上限 1。
 */
export function learnFromOutcome(state: LearningState, input: LearnInput): LearnResult {
  if (!isLearningState(state)) throw new RangeError(`learnFromOutcome: 学习状态版本不符（应 ${String(LEARNING_STATE_VERSION)}）`);
  if (!(INTENT_KINDS as readonly string[]).includes(input.kind)) {
    throw new RangeError(`learnFromOutcome: 未知意图类别：${String(input.kind)}`);
  }
  const previous = state.kinds[input.kind];
  if (previous === undefined) throw new RangeError(`learnFromOutcome: 状态里缺 ${input.kind} 的学习记录`);

  const attribution = attributeOutcome(input.outcome);
  const expected = meanRelief(input.outcome.expectedRelief ?? {});
  const actual = meanRelief(input.outcome.actualRelief ?? {});

  const samples = previous.samples + 1;
  const expectedMean = (previous.expectedMean * previous.samples + expected) / samples;
  const actualMean = (previous.actualMean * previous.samples + actual) / samples;
  const gap = expectedMean - actualMean;

  let reliability = previous.reliability;
  let note: string;
  if (samples < MIN_SAMPLES_PER_KIND) {
    note = `${input.kind}：第 ${String(samples)} 次，样本不足 ${String(MIN_SAMPLES_PER_KIND)}，可靠度不动`;
  } else if (Math.abs(gap) <= EXPECTATION_DEAD_ZONE) {
    note = `${input.kind}：预期与实际差 ${gap.toFixed(2)} 在死区内，可靠度不动`;
  } else if (gap > 0) {
    reliability = Math.max(RELIABILITY_FLOOR, previous.reliability * (1 - RELIABILITY_DECAY));
    note = `${input.kind}：预期比实际高 ${gap.toFixed(2)}，可靠度降到 ${reliability.toFixed(2)}（这类事没想象中有用）`;
  } else {
    reliability = Math.min(1, previous.reliability * (1 + RELIABILITY_RECOVER));
    note = `${input.kind}：实际比预期好 ${Math.abs(gap).toFixed(2)}，可靠度回到 ${reliability.toFixed(2)}`;
  }

  const byTarget: Record<AttributionTarget, number> = { ...previous.byTarget };
  byTarget[attribution.attributedTo] += 1;

  const kindLearning: KindLearning = {
    kind: input.kind,
    samples,
    expectedMean,
    actualMean,
    reliability: clamp01(reliability, "learnFromOutcome: reliability"),
    byTarget,
  };
  const kinds: Record<IntentKind, KindLearning> = { ...state.kinds, [input.kind]: kindLearning };
  return {
    state: { version: LEARNING_STATE_VERSION, kinds },
    attribution,
    delta: attribution.driveDelta,
    kindLearning,
    note,
  };
}

/** 这类意图现在的"有效满足预期"：期望 × 可靠度（供出口层/看板读，不直接改候选打分）。 */
export function effectiveRelief(kind: IntentKind, state: LearningState): number {
  const learning = state.kinds[kind];
  if (learning === undefined) throw new RangeError(`effectiveRelief: 未知类别：${String(kind)}`);
  return clamp01(learning.expectedMean * learning.reliability, "effectiveRelief");
}

/** 一行一个类别（只写有样本的），没样本时明说——「没有数据」不是「学得很好」。 */
export function learningSummary(state: LearningState): string[] {
  if (!isLearningState(state)) throw new RangeError("learningSummary: 学习状态版本不符");
  const lines: string[] = [];
  for (const kind of INTENT_KINDS) {
    const learning = state.kinds[kind];
    if (learning === undefined) throw new RangeError(`learningSummary: 状态里缺 ${kind}`);
    if (learning.samples === 0) continue;
    const gap = learning.expectedMean - learning.actualMean;
    const sign = gap >= 0 ? "+" : "−";
    lines.push(
      `${kind}：${String(learning.samples)} 次，预期 ${learning.expectedMean.toFixed(2)} 实际 ${learning.actualMean.toFixed(2)}` +
        `（差 ${sign}${Math.abs(gap).toFixed(2)}）→ 可靠度 ${learning.reliability.toFixed(2)}，` +
        `归因 自己 ${String(learning.byTarget.self)} / 对方 ${String(learning.byTarget.other)} / ` +
        `世界 ${String(learning.byTarget.world)} / 说不清 ${String(learning.byTarget.unclear)}`,
    );
  }
  return lines.length === 0 ? ["还没有可供学习的行为结果（不把「没有数据」写成「学得很好」）"] : lines;
}
