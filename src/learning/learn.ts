/**
 * §7 学习层：预测误差、里程碑捷径、人格漂移判定。全部是**纯数据**（A31 / V_learning_purity）。
 *
 * 它返回 delta，不写任何状态 —— 写入仍只发生在 StateMachine.tick / apply_*。
 */

import { knobNumber, knobStrings, type EngineConfig } from "../engine/config.js";
import { clamp01 } from "../engine/state.js";

/* ------------------------------------------------------------------ *
 * 7.2 预测误差
 * ------------------------------------------------------------------ */

export interface ActionRecord {
  readonly type: string;
  readonly intensity: number;
}

export class ExpectationModel {
  /**
   * 按**事件类型**分开缓存。
   *
   * 规格原稿只有一个 `_cached`/`_last_window_len`，缓存键是"历史总长度"——那会串味：
   * 先问 `care` 再问 `tease`，只要总长度没变多，`tease` 拿到的就是 `care` 的预测。
   * 一个动作类型的预期不该被另一个类型的学习污染，所以这里按 type 存。
   */
  private readonly cached = new Map<string, { value: number; samples: number }>();

  constructor(private readonly cfg: EngineConfig) {}

  predictIntensity(actionType: string, history: readonly ActionRecord[]): number {
    const window = knobNumber(this.cfg, "EXPECTATION_WINDOW");
    const prior = knobNumber(this.cfg, "EXPECTATION_PRIOR_INTENSITY");
    const same = history.slice(-window).filter((a) => a.type === actionType);
    if (same.length === 0) return prior;
    return same.reduce((sum, a) => sum + a.intensity, 0) / same.length;
  }

  /** 增量式：同类新样本不足 EXPECTATION_RECALC_INTERVAL 时复用缓存（性能取舍，见类注释） */
  predictIntensityIncremental(actionType: string, history: readonly ActionRecord[]): number {
    const step = knobNumber(this.cfg, "EXPECTATION_RECALC_INTERVAL");
    const samples = history.filter((a) => a.type === actionType).length;
    const hit = this.cached.get(actionType);
    if (hit === undefined || samples - hit.samples > step) {
      const value = this.predictIntensity(actionType, history);
      this.cached.set(actionType, { value, samples });
      return value;
    }
    return hit.value;
  }
}

/** alpha ≈ 0.3 起步；证据越多、关系越深，学得越慢（防单次事件改人格） */
export function alpha(evidenceCount: number, bondProgress: number, cfg: EngineConfig): number {
  if (evidenceCount < 0) throw new RangeError(`evidenceCount 不能为负：${evidenceCount}`);
  if (bondProgress < 0 || bondProgress > 1) throw new RangeError(`bondProgress 越界：${bondProgress}`);
  const base = knobNumber(cfg, "ALPHA_BASE");
  const eh = knobNumber(cfg, "LEARN_EVIDENCE_HALFLIFE");
  const bh = knobNumber(cfg, "LEARN_BOND_HALFLIFE");
  return base * (1 / (1 + evidenceCount * eh)) * (1 / (1 + bondProgress * bh));
}

/** 一次学习的增量：alpha × 预测误差，再被 LEARN_MAGNITUDE_CAP 截断 */
export function learnDelta(
  actualIntensity: number,
  expectedIntensity: number,
  evidenceCount: number,
  bondProgress: number,
  cfg: EngineConfig,
): number {
  const cap = knobNumber(cfg, "LEARN_MAGNITUDE_CAP");
  const pe = actualIntensity - expectedIntensity;
  return Math.max(-cap, Math.min(cap, alpha(evidenceCount, bondProgress, cfg) * pe));
}

/* ------------------------------------------------------------------ *
 * 7.1 里程碑捷径（B8 / B9 修法）
 * ------------------------------------------------------------------ */

export interface BondLike {
  readonly progress: number;
  readonly trust: number;
  readonly recentRupture: boolean;
}

export interface MilestoneEvent {
  readonly type: string;
  readonly intensity: number;
}

export interface BondRepairResult {
  readonly path: "milestone" | "queue_insight" | "no_op";
  readonly deltaBond: number;
  readonly deltaTrust: number;
  readonly markUsedFor: string | null;
  readonly reason: string;
}

export function computeRepairDelta(
  ev: MilestoneEvent,
  bond: BondLike,
  milestoneUsedFor: Readonly<Record<string, boolean>>,
  cfg: EngineConfig,
): BondRepairResult {
  const eligible = knobStrings(cfg, "MILESTONE_ELIGIBLE_TYPES");
  const typeSet = knobStrings(cfg, "MILESTONE_TYPE_SET");
  const no = (reason: string): BondRepairResult => ({ path: "no_op", deltaBond: 0, deltaTrust: 0, markUsedFor: null, reason });

  if (!bond.recentRupture || !eligible.includes(ev.type)) return no("非修复期或类型不在 eligible");
  if (milestoneUsedFor[ev.type] === true) return no(`${ev.type} 的里程碑已用过（每题仅一次）`);
  if (ev.intensity <= knobNumber(cfg, "MILESTONE_TRIGGER_THRESHOLD")) return no("强度不足，转 queue_insight");
  if (!typeSet.includes(ev.type)) return no(`${ev.type} 不在 MILESTONE_TYPE_SET（gift 等补偿性动作不进捷径）`);

  // B8：原式 min(0.15, 0.2) 恒为 0.15，cap 永不 bind。正确写法是"给剩余空间"
  const cap = knobNumber(cfg, "MILESTONE_CAP");
  const raw = knobNumber(cfg, "MILESTONE_BOND_GAIN");
  const deltaBond = Math.max(0, Math.min(raw, cap - bond.progress));

  // B9：trust 一步到 1.0 的来源；单步上限统一由 TRUST_MAX_STEP 兜底
  const step = knobNumber(cfg, "TRUST_MAX_STEP");
  const trustGain = knobNumber(cfg, "MILESTONE_TRUST_GAIN");
  const rawDeltaTrust = trustGain * ev.intensity * (1 - bond.trust);
  const deltaTrust = Math.max(-step, Math.min(step, rawDeltaTrust));

  return { path: "milestone", deltaBond, deltaTrust, markUsedFor: ev.type, reason: "高强度情感修复，走捷径" };
}

/* ------------------------------------------------------------------ *
 * 5.4 人格漂移（双层判据）
 * ------------------------------------------------------------------ */

export interface DriftHistory {
  readonly deltas: readonly number[];
}

export type DriftVerdict = "NOISE" | "OSCILLATION" | "SIGNATURE_DRIFT";

/** 先看幅度（EWMA），再看方向一致性（同号比例）—— 两者都过才算"人格真的在变" */
export function classifyDrift(history: DriftHistory, cfg: EngineConfig): DriftVerdict {
  const deltas = history.deltas.slice(-7);
  if (deltas.length === 0) return "NOISE";
  const ewma = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const positives = deltas.filter((d) => d > 0).length;
  const negatives = deltas.filter((d) => d < 0).length;
  const consistency = Math.max(positives, negatives) / deltas.length;
  if (Math.abs(ewma) < knobNumber(cfg, "DRIFT_EWMA_THRESHOLD")) return "NOISE";
  if (consistency < knobNumber(cfg, "DRIFT_CONSISTENCY_THRESHOLD")) return "OSCILLATION";
  return "SIGNATURE_DRIFT";
}

/** 漂移增量：过双层判据才动，且被 MAGNITUDE_CAP.ocean 限幅；无证据时回落到 baseline */
export function driftDelta(verdict: DriftVerdict, currentDelta: number, cfg: EngineConfig): number {
  const caps = magnitudeCaps(cfg);
  if (verdict !== "SIGNATURE_DRIFT") {
    // 无证据：只做阻尼回 baseline（A20）
    const damp = knobNumber(cfg, "DRIFT_DAMPING_RATE");
    return -currentDelta * damp;
  }
  return Math.max(-caps.ocean, Math.min(caps.ocean, currentDelta));
}

export function magnitudeCaps(cfg: EngineConfig): { value_shifts: number; ocean: number } {
  const cap = cfg.knobs["MAGNITUDE_CAP"];
  if (cap === undefined || cap.kind !== "object") throw new Error("MAGNITUDE_CAP 必须是 object");
  return cap.value as { value_shifts: number; ocean: number };
}

/** 一次 OCEAN 维度的推进：clamp 在 [0,1]（OCEAN 只在这个区间里有意义） */
export function applyOceanDelta(current: number, delta: number, cfg: EngineConfig): number {
  const caps = magnitudeCaps(cfg);
  const bounded = Math.max(-caps.ocean, Math.min(caps.ocean, delta));
  return clamp01(current + bounded);
}
