/**
 * §5 关系层 —— bond progress 与 stage（块 2 收口后的形状）。
 *
 * 三条被实测钉死的规则：
 *   1. stage 的判定输入是 **progress**，不是依恋曲线的深度（P0-3：四条曲线 secure 上限 0.632、
 *      fearful 0.56，按曲线判 stage 会让两类依恋永远到不了 beloved）。
 *   2. 依恋（anxiety/avoidance）降级为**表达层**：只影响怎么说话，不影响能走多远。
 *   3. pacing 是线性速率 + 分档：每档速率 = (下一档门槛 − 当前档门槛) / 该档轮数，
 *      于是 pacing_table {15,40,80} 与 pacing_rate {0.0167,0.012,0.00625} 互相自洽（F4 修法）。
 *      用 (1−progress) 饱和因子反而会在 15/37/62 处对不上 —— 已实测否掉。
 */

import { knobNumber, knobObject, knobText, type EngineConfig } from "./config.js";
import { clamp01 } from "./state.js";

export const STAGES = ["stranger", "familiar", "close", "beloved"] as const;
export type Stage = (typeof STAGES)[number];

export type StageBands = Readonly<Record<Stage, readonly [number, number]>>;
export type PacingRates = Readonly<Record<"shallow" | "mid" | "deep", number>>;

/**
 * STAGE_THRESHOLD 在附录 A 里是 literal（`{stranger:[0,0.25), familiar:[0.25,0.55), ...}`），
 * 因为区间是半开半闭、无法表达成 JSON 数字。这里做唯一一次解析，格式不符立刻抛错。
 */
export function parseStageBands(text: string): StageBands {
  const out = {} as Record<Stage, readonly [number, number]>;
  const re = /(stranger|familiar|close|beloved)\s*:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g;
  for (const m of text.matchAll(re)) {
    const stage = m[1] as Stage;
    const lo = Number(m[2]);
    const hi = Number(m[3]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      throw new RangeError(`STAGE_THRESHOLD.${stage} 区间非法：[${String(m[2])}, ${String(m[3])})`);
    }
    out[stage] = [lo, hi];
  }
  for (const stage of STAGES) {
    if (out[stage] === undefined) throw new Error(`STAGE_THRESHOLD 缺 ${stage} 档：${text}`);
  }
  return out;
}

/** 从注册表取分区（§5.2 STAGE_THRESHOLD，右开区间，最后一档含 1.0） */
export function stageBands(cfg: EngineConfig): StageBands {
  return parseStageBands(knobText(cfg, "STAGE_THRESHOLD"));
}

export function pacingRates(cfg: EngineConfig): PacingRates {
  return knobObject<PacingRates>(cfg, "PACING_RATE");
}

/** progress → stage；越界按两端夹取，不做静默默认 */
export function stageOf(progress: number, bands: StageBands): Stage {
  if (!Number.isFinite(progress)) throw new RangeError(`progress 非有限值：${progress}`);
  const p = clamp01(progress);
  for (const stage of STAGES) {
    const [lo, hi] = bands[stage];
    const isLast = stage === "beloved";
    if (p >= lo && (p < hi || (isLast && p <= hi))) return stage;
  }
  return "stranger";
}

/** 朝下一档推进时使用的速率：stranger→shallow，familiar→mid，close→deep，beloved 维持 deep */
export function rateForNextStage(stage: Stage, rates: PacingRates): number {
  switch (stage) {
    case "stranger":
      return rates.shallow;
    case "familiar":
      return rates.mid;
    case "close":
      return rates.deep;
    case "beloved":
      return rates.deep;
  }
}

/** 关系推进的零点 Z：valence 低于它才算"明显负向"、停止推进甚至倒退（A2，注册表 BOND_DRIVE_ZERO） */
export function bondDriveZero(cfg: EngineConfig): number {
  return knobNumber(cfg, "BOND_DRIVE_ZERO");
}

/** 情绪基线 A（EMA 回落点）：锚点处 drive=1，使 15/40/80 轮与 §5.2 对齐（A2，注册表 VALENCE_ANCHOR） */
export function valenceAnchor(cfg: EngineConfig): number {
  return knobNumber(cfg, "VALENCE_ANCHOR");
}

/** drive 有符号，夹取到 [−1, 1]（不能用 clamp01） */
function clampSigned(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/**
 * valence → 关系推进 drive ∈ [−1, 1]。
 *
 * A2「归一化零点分离」（2026-11-01 规格评审，用户裁决「拆开锚点与零点」）：
 * 锚点 A 是情绪基线，零点 Z 是关系推进门槛。
 *   drive = clamp((valence − Z) / (A − Z), −1, 1)
 * 于是 valence=A → 1（与旧公式 valence=1 逐位一致，15/40/80 恒等恢复）；
 * valence=Z → 0（停）；valence<Z → 负向（倒退，半速）。
 * 旧公式 drive=(valence−0.5)×2 在锚点处恰为 0 → 「平静=关系永不前进」（死锁 A）。
 */
export function bondDrive(valence: number, anchor: number, zero: number): number {
  if (!Number.isFinite(valence)) throw new RangeError(`valence 非有限值：${valence}`);
  if (!Number.isFinite(anchor)) throw new RangeError(`anchor 非有限值：${anchor}`);
  if (!Number.isFinite(zero)) throw new RangeError(`zero 非有限值：${zero}`);
  if (!(zero < anchor)) throw new RangeError(`关系推进零点必须小于锚点：zero=${zero}, anchor=${anchor}`);
  return clampSigned((valence - zero) / (anchor - zero));
}

/**
 * 一轮推进后的 progress。
 *   - valence 是唯一驱动（§5.2 关系进度的输入；A2 归一化零点分离，2026-11-01 规格评审）
 *   - 正向：+rate×drive；负向：−rate×drive×0.5（"回退比推进慢"，防止一次吵架归零）
 */
export function updateBondProgress(progress: number, valence: number, rate: number, anchor: number, zero: number): number {
  const drive = bondDrive(valence, anchor, zero);
  if (drive > 0) return clamp01(progress + rate * drive);
  if (drive < 0) return clamp01(progress + rate * drive * 0.5);
  return clamp01(progress);
}

/** 依恋四象限 → 曲线名（§5.1，仅表达层使用；不参与 stage 判定） */
export function deriveBondCurve(anxiety: number, avoidance: number): "secure" | "preoccupied" | "dismissive" | "fearful" {
  const highAnxiety = anxiety >= 0.5;
  const highAvoidance = avoidance >= 0.5;
  if (!highAnxiety && !highAvoidance) return "secure";
  if (highAnxiety && !highAvoidance) return "preoccupied";
  if (!highAnxiety && highAvoidance) return "dismissive";
  return "fearful";
}

export interface RuptureResult {
  readonly progress: number;
  readonly stage: Stage;
  /** 是否掉了档，供 trace 记录 */
  readonly regressed: boolean;
}

/**
 * 关系破裂：progress ×0.6，且**一次最多掉一档**（棘轮）。
 * 直接按新 progress 判 stage 会从 beloved 一步掉回 stranger，使"破裂"与"从没认识过"不可区分。
 */
export function onRupture(progress: number, stage: Stage, bands: StageBands): RuptureResult {
  const next = clamp01(progress * 0.6);
  const target = stageOf(next, bands);
  const from = STAGES.indexOf(stage);
  const to = STAGES.indexOf(target);
  if (to >= from || from - to <= 1) {
    return { progress: next, stage: target, regressed: to < from };
  }
  const capped = STAGES[from - 1]!;
  return { progress: next, stage: capped, regressed: true };
}
