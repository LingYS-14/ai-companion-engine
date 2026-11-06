/**
 * 意向引擎 P0 —— B4 归因与驱动学习（VISION §4.3(c)）。
 *
 *   agency = σ( α·(−predError) + β·binding )     # 只由两个可独立测量的量构成
 *   driveDelta_k = η · (expected_relief_k − actual_relief_k)
 *
 * 两条纪律：
 *   1. `hasIntentTrace` **不进** agency 连续分数（等于用"我打算做"证明"是我做的"是在同义反复）；
 *      它只作为 `attributedTo='self'` 的分类先验，单独用参数传。
 *   2. `binding` 是"动作与结果的因果贴合度"（0..1，由时间邻近/中介环节数估计），`predError` 是
 *      预期与实际的差（0..1）。两者都可独立测量，所以 P0 能先写公式、P4 再确定测量口径。
 *
 * 时钟纪律：纯函数，不读系统时间。
 */

import type { Attribution, AttributionTarget, DriveVector } from "./types.js";
import { DRIVE_KEYS } from "./types.js";

/** α：预测误差的惩罚力度（先验值，D2 工程先验，不是运行期旋钮）。 */
export const AGENCY_ALPHA = 1.6;
/** β：绑定感的加成力度。 */
export const AGENCY_BETA = 1.2;

/** 归因分类阈值：≥ SELF_MIN 判自己；≤ WORLD_MAX 判非己；中间为 unclear。 */
export const SELF_MIN = 0.6;
export const WORLD_MAX = 0.35;
/** `hasIntentTrace` 时把 SELF_MIN 降到这里（"我确实想过"是分类先验，不是连续分）。 */
export const SELF_MIN_WITH_TRACE = 0.5;

/** 学习率 η：每次行动后逐维回写多少。 */
export const DRIVE_LEARN_ETA = 0.2;
/** 单次回写上限（防止一次异常观测把驱动量推飞）。 */
export const DRIVE_DELTA_CAP = 0.2;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`归因参数必须有限：${String(value)}`);
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * INV7-EXEMPT：这里的指数是 §4.3(c) 归因公式的 σ 形状函数，不是 INV-7 禁止的
 * 「状态衰减常量副本」——它不含任何衰减常数，也不参与状态演化，只把两个可测量折成 0..1 的代理感。
 */
export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`sigmoid: 输入非有限：${String(x)}`);
  return 1 / (1 + Math.exp(-x));
}

/**
 * agency = σ(α·(−predError) + β·binding)。
 * 两个输入都必须是 0..1；超出范围直接抛（不静默夹住——归因错一次，学习就错一路）。
 */
export function agencyScore(predError: number, binding: number, opts: {
  alpha?: number;
  beta?: number;
} = {}): number {
  const alpha = opts.alpha ?? AGENCY_ALPHA;
  const beta = opts.beta ?? AGENCY_BETA;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta)) {
    throw new RangeError("agencyScore: alpha/beta 必须有限");
  }
  const error = clamp01(predError);
  const bind = clamp01(binding);
  return clamp01(sigmoid(alpha * -error + beta * bind));
}

export interface AttributionClassInput {
  predError: number;
  binding: number;
  /** 有没有意图轨迹（分类先验，不是连续分） */
  hasIntentTrace: boolean;
  /** 这次结果是否以"另一个人"为主要中介（交互类意图才为 true） */
  involvesOther?: boolean | undefined;
}

/** 分类：self / other / world / unclear。四类按顺序短路，避免"高 agency 但无中立解释"含糊。 */
export function classifyAttribution(input: AttributionClassInput): AttributionTarget {
  const agency = agencyScore(input.predError, input.binding);
  const selfMin = input.hasIntentTrace ? SELF_MIN_WITH_TRACE : SELF_MIN;
  if (agency >= selfMin) return "self";
  if (agency <= WORLD_MAX) {
    // 结果和我无关，但如果是交互类，"无关"通常意味着对方主导
    return input.involvesOther === true ? "other" : "world";
  }
  return "unclear";
}

/**
 * 逐维驱动回写：driveDelta_k = clamp(η·(expected − actual), ±DRIVE_DELTA_CAP)，只写非零维。
 * 长期 expected > actual 的类别会在 P3 的驱动学习里自动衰减（她学到"这事并不能让我好受"）。
 */
export function driveLearningDelta(
  expectedRelief: Partial<DriveVector>,
  actualRelief: Partial<DriveVector>,
  opts: { eta?: number; cap?: number } = {},
): Partial<DriveVector> {
  const eta = opts.eta ?? DRIVE_LEARN_ETA;
  const cap = opts.cap ?? DRIVE_DELTA_CAP;
  if (!Number.isFinite(eta) || eta < 0) throw new RangeError(`driveLearningDelta: eta 非法：${String(eta)}`);
  if (!Number.isFinite(cap) || cap < 0) throw new RangeError(`driveLearningDelta: cap 非法：${String(cap)}`);

  const out: Partial<DriveVector> = {};
  for (const key of DRIVE_KEYS) {
    const expected = expectedRelief[key] ?? 0;
    const actual = actualRelief[key] ?? 0;
    if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
      throw new RangeError(`driveLearningDelta: ${key} 出现非有限值`);
    }
    const raw = eta * (expected - actual);
    if (raw === 0) continue;
    out[key] = Math.max(-cap, Math.min(cap, raw));
  }
  return out;
}

export interface AttributeOutcomeInput {
  intentId: string;
  predicted: string;
  observed: string;
  predError: number;
  binding: number;
  hasIntentTrace: boolean;
  involvesOther?: boolean;
  expectedRelief?: Partial<DriveVector>;
  actualRelief?: Partial<DriveVector>;
}

/** 一次完整归因：分数 + 分类 + 驱动回写。纯函数。 */
export function attributeOutcome(input: AttributeOutcomeInput): Attribution {
  const predError = clamp01(input.predError);
  const binding = clamp01(input.binding);
  const agency = agencyScore(predError, binding);
  const attributedTo = classifyAttribution({
    predError,
    binding,
    hasIntentTrace: input.hasIntentTrace,
    involvesOther: input.involvesOther,
  });
  const driveDelta = driveLearningDelta(input.expectedRelief ?? {}, input.actualRelief ?? {});
  return {
    intent_id: input.intentId,
    predicted: input.predicted,
    observed: input.observed,
    predError,
    agency,
    attributedTo,
    driveDelta,
  };
}

/**
 * 意图存活率（§9 指标原料）：`survival / (survival + 1)` 的单条折算 + 半衰期拟合所需的样本形状。
 * P0 只给出逐条折算，不在这里拟合（拟合属 P3 指标看板）。
 */
export function survivalScore(survival: number): number {
  if (!Number.isFinite(survival) || survival < 0) {
    throw new RangeError(`survivalScore: survival 非法：${String(survival)}`);
  }
  return survival / (survival + 1);
}
