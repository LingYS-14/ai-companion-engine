/**
 * 意向引擎 P0 —— B2 候选打分（VISION §4.3 (a)）。
 *
 * 全文唯一的三处数学之一，P0 只实现这一处（累积器/veto 与归因学习分别在 P0 的 bus.ts / attribution.ts）：
 *
 *   U(c) =   w_d · Σ_k gap_k · impact_k(c)
 *          + w_e · epistemic(c)
 *          + w_p · empowerment(c)
 *          + w_i · identityFit(c)
 *          − w_c · risk_norm(c.cost.risk)
 *          − w_s · c.cost.socialRisk
 *          − w_b · budget_penalty(now)
 *
 * 权重约定（§4.3）：`INTENT_WEIGHTS` 是**一张表**，默认值由 P0 golden 轨迹离线标定、运行期不可调。
 * 仓库现在没有标注集，所以 P0 用**工程先验值**（D2 裁决）：可解释、可手算、可审计；P1 有真实轨迹后标定，
 * 并把"权重是否合理"作为 P1 的验收项。**这里不是新的运行期旋钮**——没有读配置、没有环境变量。
 *
 * `epistemic` / `empowerment` 在规格里是候选的属性；P0 的 `Candidate` 结构里没有这两个字段（严格照 §4.2），
 * 因此按**类别先验**取值，并在文件里写明这是近似——不假装它是精确测量。
 */

import { clamp01 } from "../../engine/state.js";
import {
  DRIVE_KEYS,
  INTENT_KINDS,
  type Candidate,
  type DriveVector,
  type IntentKind,
  type RiskLevel,
  type SituationFrame,
} from "./types.js";

// ── 权重表（离线标定，运行期不可调；P0 用工程先验） ─────────────────────
export interface IntentWeights {
  /** 缺口缓解（主项） */
  drive: number;
  /** 信息增益：做完这件事能不能减少不确定 */
  epistemic: number;
  /** 影响通道：做完之后能影响的世界是否变大 */
  empowerment: number;
  /** 与"我是谁"的匹配度 */
  identityFit: number;
  /** 风险惩罚（经验风险归一后） */
  risk: number;
  /** 社会风险：被看见的代价 ≠ 被拒绝的代价 */
  socialRisk: number;
  /** 额度紧张时整体压低"要花 token"的候选 */
  budget: number;
}

export const INTENT_WEIGHTS: Readonly<IntentWeights> = Object.freeze({
  drive: 1.0,
  epistemic: 0.6,
  empowerment: 0.5,
  identityFit: 0.7,
  risk: 0.8,
  socialRisk: 0.6,
  budget: 0.5,
});

/** 类别 → 信息增益先验（探索类最高，退开/待着为零）。 */
export const EPISTEMIC_BY_KIND: Readonly<Record<IntentKind, number>> = Object.freeze({
  reach_out: 0.2,
  continue_thread: 0.3,
  explore: 0.9,
  create: 0.3,
  repair: 0.2,
  withdraw: 0,
  idle: 0,
});

/** 类别 → 影响通道先验（创造类最高：做出东西会扩大她能影响的世界）。 */
export const EMPOWERMENT_BY_KIND: Readonly<Record<IntentKind, number>> = Object.freeze({
  reach_out: 0.3,
  continue_thread: 0.4,
  explore: 0.5,
  create: 0.8,
  repair: 0.5,
  withdraw: 0,
  idle: 0,
});

/** 额度基线：12 次/小时（与 `pricing` 的运行期上限同值；P0 只是先验常数，不另立旋钮）。 */
export const RPH_BASELINE = 12;

/** token 成本的归一尺度：超过 200 token 的候选按"很贵"计（P0 估计值）。 */
export const TOKEN_NORM = 200;

/** 风险级 0..3 归一到 [0,1]。 */
export function riskNorm(risk: RiskLevel): number {
  return risk / 3;
}

// ── 7×6 类别基表（§4.3：写死，不进运行期配置） ─────────────────────────
export type DrivePolarity = "pos" | "neg" | "both";

/**
 * 类别 × 缺口的**极性基表**：候选只能在允许的维度上赋值，且符号不能反。
 * 依据：一个类别在心理学上"能不能声称缓解这一维"，例如"退开"不能声称缓解"想说话"。
 */
export const KIND_DRIVE_POLARITY: Readonly<
  Record<IntentKind, Readonly<Partial<Record<keyof DriveVector, DrivePolarity>>>>
> = Object.freeze({
  reach_out: { connection: "pos", novelty: "pos", integrity: "neg" },
  continue_thread: { connection: "pos", coherence: "pos", competence: "pos" },
  explore: { novelty: "pos", competence: "pos", energy: "neg" },
  create: { coherence: "pos", competence: "pos", novelty: "pos", energy: "neg" },
  repair: { connection: "pos", coherence: "pos", competence: "pos", integrity: "neg" },
  withdraw: { integrity: "pos", energy: "pos", novelty: "neg", connection: "neg" },
  idle: {},
});

/** 影响幅度的上限：`impact` 是"这件事对该维的影响"，一律 [-1,1]，防止一个候选声称救世。 */
export const MAX_IMPACT = 1;

/**
 * 校验一个候选的 `drive_impact` 是否满足基表（§4.3：极性约束）。
 * 返回错误列表（空 = 合法）；**不抛错**，由调用方决定是丢弃候选还是 fail-closed。
 */
export function validateDriveImpact(
  kind: IntentKind,
  impact: Readonly<Partial<Record<keyof DriveVector, number>>>,
): string[] {
  const errors: string[] = [];
  const allowed = KIND_DRIVE_POLARITY[kind];
  for (const key of DRIVE_KEYS) {
    const value = impact[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      errors.push(`${kind}.${key} 不是有限数：${String(value)}`);
      continue;
    }
    if (Math.abs(value) > MAX_IMPACT) {
      errors.push(`${kind}.${key} 幅度超过 ${MAX_IMPACT}：${value}`);
      continue;
    }
    if (value === 0) continue; // 显式写 0 = 不声称任何影响，允许
    const polarity = allowed[key];
    if (polarity === undefined) {
      errors.push(`${kind} 不允许声称影响 ${key}（基表没有这一维）`);
      continue;
    }
    if (polarity === "pos" && value < 0) errors.push(`${kind}.${key} 只允许正向，收到 ${value}`);
    if (polarity === "neg" && value > 0) errors.push(`${kind}.${key} 只允许负向，收到 ${value}`);
  }
  return errors;
}

function requireFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`scoreCandidate: ${name} 必须是有限数字，收到 ${String(value)}`);
  }
  return value;
}

/** 额度压力 [0,1]：`rph` 是本小时剩余名额，越少压力越大；≥ 基线时为 0。 */
export function budgetPressure(frame: SituationFrame): number {
  const rph = requireFinite("frame.budget.rph", frame.budget.rph);
  return clamp01(1 - rph / RPH_BASELINE);
}

/** 缺口缓解项：Σ gap_k · impact_k（impact 有符号，线性加总，§4.3）。 */
export function reliefOf(
  candidate: Candidate,
  drive: DriveVector,
): { relief: number; perDrive: Partial<Record<keyof DriveVector, number>> } {
  const perDrive: Partial<Record<keyof DriveVector, number>> = {};
  let relief = 0;
  for (const key of DRIVE_KEYS) {
    const impact = candidate.drive_impact[key];
    if (impact === undefined) continue;
    const gap = requireFinite(`drive.${key}`, drive[key]);
    const contribution = gap * impact;
    perDrive[key] = contribution;
    relief += contribution;
  }
  return { relief, perDrive };
}

/**
 * 候选打分（§4.3 (a)）。非法输入 fail-closed：极性违规 / NaN / 负成本都抛 `RangeError`，
 * 而不是返回一个看起来正常的数——P0 宁可当场炸。
 */
export function scoreCandidate(candidate: Candidate, drive: DriveVector, frame: SituationFrame): number {
  const errors = validateDriveImpact(candidate.kind, candidate.drive_impact);
  if (errors.length > 0) {
    throw new RangeError(`scoreCandidate: ${candidate.kind} 的 drive_impact 违反基表：${errors.join("；")}`);
  }

  requireFinite("cost.tokens", candidate.cost.tokens);
  if (candidate.cost.tokens < 0) throw new RangeError(`scoreCandidate: cost.tokens 不能为负：${candidate.cost.tokens}`);
  requireFinite("cost.socialRisk", candidate.cost.socialRisk);
  requireFinite("identityFit", candidate.identityFit);

  const { relief } = reliefOf(candidate, drive);
  const tokenNorm = Math.min(1, candidate.cost.tokens / TOKEN_NORM);
  const penalty = budgetPressure(frame) * tokenNorm;

  return (
    INTENT_WEIGHTS.drive * relief +
    INTENT_WEIGHTS.epistemic * EPISTEMIC_BY_KIND[candidate.kind] +
    INTENT_WEIGHTS.empowerment * EMPOWERMENT_BY_KIND[candidate.kind] +
    INTENT_WEIGHTS.identityFit * clamp01(candidate.identityFit) -
    INTENT_WEIGHTS.risk * riskNorm(candidate.cost.risk) -
    INTENT_WEIGHTS.socialRisk * clamp01(candidate.cost.socialRisk) -
    INTENT_WEIGHTS.budget * penalty
  );
}

function kindIndex(kind: IntentKind): number {
  return INTENT_KINDS.indexOf(kind);
}

/**
 * 稳定排序：分数降序 → 类别固定顺序 → goal 字典序。
 * `Array.prototype.sort` 在 V8 已稳定，但显式给全序键才能在 golden replay 里断言"逐位相同"。
 */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byKind = kindIndex(a.kind) - kindIndex(b.kind);
    if (byKind !== 0) return byKind;
    return a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0;
  });
}

/** 人类可读的一行解释（调试 / 台账 / golden replay 对拍用，不参与判定）。 */
export function explainScore(candidate: Candidate, drive: DriveVector, frame: SituationFrame): string {
  const { relief, perDrive } = reliefOf(candidate, drive);
  const parts = DRIVE_KEYS.filter((key) => perDrive[key] !== undefined).map(
    (key) => `${key} ${(perDrive[key] ?? 0) >= 0 ? "+" : ""}${(perDrive[key] ?? 0).toFixed(3)}`,
  );
  return (
    `${candidate.kind} U=${candidate.score.toFixed(3)} ` +
    `relief=${relief.toFixed(3)}(${parts.join(",") || "无"}) ` +
    `epi=${EPISTEMIC_BY_KIND[candidate.kind].toFixed(2)} ` +
    `emp=${EMPOWERMENT_BY_KIND[candidate.kind].toFixed(2)} ` +
    `fit=${candidate.identityFit.toFixed(2)} ` +
    `risk=${candidate.cost.risk} social=${candidate.cost.socialRisk.toFixed(2)} ` +
    `budget=${budgetPressure(frame).toFixed(2)}`
  );
}
