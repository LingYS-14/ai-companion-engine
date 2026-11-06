/**
 * §4.2 Appraisal → State Delta 的数值层（纯函数）。
 *
 * 这一层只产出**增量/事件**，不写 S 层：
 *   - 信号（valence/arousal）在 tick 内以绝对锚定 EMA 落地（state.ts step 7）
 *   - gain（pressure）走 GainEvent 排队，下一 tick 由 tick 统一写入
 *   - affection / trust 是"带外"通道，但同样只能经这里算出增量，由调用方交给 tick 或 store
 *
 * 规格位置：v5.3.1 §4.2（Step 0 解析三分量 / Step 1 emerge / Step 2 apply_*）
 */

import { knobNumber, knobObject, knobStrings, type EngineConfig } from "./config.js";
import { clamp01, type SState } from "./state.js";

export interface AppraisalRaw {
  readonly goal_congruence: number; // -1..1
  readonly goal_relevance: number; // 0..1
  readonly coping_potential: number; // 0..1
  readonly novelty: number; // 0..1
  readonly legitimacy: number; // 0..1
}

export interface AppraisalContext {
  readonly audience_present: number; // 0..1
  /** 事件来源；只有 RELATION_SOURCES 里的来源能改 affection（§4.2 apply_affection） */
  readonly source: string;
  readonly event_type: string;
  /**
   * v5.4-P1 §4.1：这一轮**之前**同类型事件已经发生过几次（n_t，存在调度层，不进 S 层）。
   * 不传 = 0（首轮，γ=1）。
   */
  readonly event_type_count?: number;
}

export interface AppraisalRecord {
  readonly event_id: string;
  readonly event_type: string;
  readonly liking_component: number;
  readonly commitment_component: number;
  /** 原始分量（v5.3 原稿这里重复了 raw 关键字，B-fix 后只保留一份） */
  readonly raw: AppraisalRaw;
}

export type Emotions = Record<"jealousy" | "shame" | "joy" | "anger" | "fear" | "sadness" | "surprise", number>;

/** Step 0：三分量解析（纯函数，无随机） */
export function parseAppraisal(raw: AppraisalRaw, eventType: string, eventId: string): AppraisalRecord {
  for (const [k, v] of Object.entries(raw)) {
    if (!Number.isFinite(v)) throw new RangeError(`appraisal.${k} 非有限值：${String(v)}`);
  }
  return {
    event_id: eventId,
    event_type: eventType,
    liking_component: raw.goal_congruence * raw.goal_relevance,
    commitment_component: raw.coping_potential * (1 - raw.novelty),
    raw,
  };
}

/** Step 1：情绪涌现（七个通道，全部 clamp 到 [0,1]） */
/** A38a：EMOTION_DYNAMICS 的 onset/peak 作为涌现强度归一化因子（0..1 的淡入曲线） */
export interface EmotionShape {
  readonly onset: number;
  readonly peak: number;
}

const clamp01x = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A38a 归一化：raw 在 [onset, peak] 之间线性淡入；两端各留 60% / 100% 权重。
 * 不把 onset 以下归零——那会让日常 0.2 的嫉妒直接消失（角色性格级回归，见 F 记录）。
 */
export function emotionStrength(raw: number, shape: EmotionShape): number {
  const span = shape.peak - shape.onset;
  if (!(span > 0)) throw new RangeError(`EMOTION_DYNAMICS onset/peak 非法：${String(shape.onset)}/${String(shape.peak)}`);
  const t = clamp01x((raw - shape.onset) / span);
  return clamp01x(raw * (0.6 + 0.4 * t));
}

export function emerge(
  app: AppraisalRecord,
  ctx: { audience_present: number },
  dynamics?: Readonly<Record<string, EmotionShape>>,
): Emotions {
  const r = app.raw;
  const neg = Math.max(0, -r.goal_congruence);
  const pos = Math.max(0, r.goal_congruence);
  const gate = r.goal_relevance;
  const raw: Emotions = {
    jealousy: clamp01(gate * neg * (1 - r.coping_potential) * (1 - r.legitimacy)),
    shame: clamp01(gate * neg * r.legitimacy * clamp01(ctx.audience_present)),
    joy: clamp01(gate * pos * r.coping_potential),
    anger: clamp01(gate * neg * r.legitimacy * (1 - r.coping_potential)),
    fear: clamp01(gate * neg * (1 - r.legitimacy) * (1 - r.coping_potential)),
    sadness: clamp01(gate * neg * (1 - r.coping_potential) * r.novelty),
    surprise: clamp01(r.novelty),
  };
  if (dynamics === undefined) return raw;
  // A38a：只对配置里声明过的情绪做归一化；缺声明直接抛（fail-closed，不静默跳过）
  const shaped: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const shape = dynamics[k];
    if (shape === undefined) throw new RangeError(`EMOTION_DYNAMICS 缺少情绪 ${k} 的 onset/peak`);
    shaped[k] = emotionStrength(v, shape);
  }
  return shaped as unknown as Emotions;
}

/** §4.2 apply_pressure_gain：pressure 的 gain 只由三个情绪通道加权，rumination 不直接进公式 */
export function pressureGainFrom(em: Emotions, cfg: EngineConfig): number {
  const w = knobObject<{ jealousy: number; shame: number; fear: number }>(cfg, "PRESSURE_GAIN_WEIGHTS");
  return w.jealousy * em.jealousy + w.shame * em.shame + w.fear * em.fear;
}

export interface AffectionResult {
  readonly applied: boolean;
  readonly delta: number;
  readonly cappedAt: number;
  /** §4.1 的饱和度乘子 γ_t（1 = 未饱和） */
  readonly gamma?: number;
}

/**
 * §4.1 v5.4-P1 事件类型累计 cap：γ_t(n_t) = max(GAMMA_FLOOR, min(1, 1/(1+λ_t·n_t)))。
 *
 * 裁决 D6：γ **只缩小**静态上限（effectiveCap = cap × γ），静态 cap 不退役。
 * λ 缺省走表里的 `default`；事件类型不认识也用 default，绝不静默按 0 处理（A33 曾因此恒真）。
 */
export function gammaFor(eventType: string, priorCount: number, cfg: EngineConfig): number {
  const table = knobObject<Record<string, number>>(cfg, "EVENT_TYPE_SATURATION_LAMBDA");
  const fallback = table["default"];
  if (fallback === undefined) throw new Error("EVENT_TYPE_SATURATION_LAMBDA 缺 default 键");
  const lambda = table[eventType] ?? fallback;
  if (!(lambda >= 0)) throw new Error(`EVENT_TYPE_SATURATION_LAMBDA[${eventType}] 必须 ≥ 0，实际 ${lambda}`);
  const raw = 1 / (1 + lambda * Math.max(0, priorCount));
  return Math.max(knobNumber(cfg, "GAMMA_FLOOR"), Math.min(1, raw));
}

/**
 * §4.2 apply_affection：只有 RELATION_SOURCES 能改 affection，且单事件增量被
 * AFFECTION_EVENT_CAP[event_type]（缺省 AFFECTION_EVENT_CAP_DEFAULT）截断。
 */
export function affectionDelta(record: AppraisalRecord, ctx: AppraisalContext, cfg: EngineConfig): AffectionResult {
  const allowed = knobStrings(cfg, "RELATION_SOURCES");
  if (!allowed.includes(ctx.source)) return { applied: false, delta: 0, cappedAt: 0 };
  const scale = knobNumber(cfg, "AFFECTION_SCALE");
  const caps = knobObject<Record<string, number>>(cfg, "AFFECTION_EVENT_CAP");
  const cap = caps[ctx.event_type] ?? knobNumber(cfg, "AFFECTION_EVENT_CAP_DEFAULT");
  const gamma = gammaFor(ctx.event_type, ctx.event_type_count ?? 0, cfg);
  const effectiveCap = cap * gamma;
  const delta = Math.max(-effectiveCap, Math.min(scale * record.liking_component, effectiveCap));
  return { applied: true, delta, cappedAt: effectiveCap, gamma };
}

/**
 * §4.2 apply_trust_update：系数按符号取 TRUST_GAIN_POS / TRUST_GAIN_NEG。
 * 单步上限由 TRUST_MAX_STEP 兜底 —— 否则 weight=intensity=1 时一步就能把 0.2 推到 1.0（B9）。
 */
export function trustDelta(
  sign: 1 | -1,
  weight: number,
  intensity: number,
  cfg: EngineConfig,
  currentTrust = 0,
  gamma = 1,
): number {
  const coef = sign > 0 ? knobNumber(cfg, "TRUST_GAIN_POS") : knobNumber(cfg, "TRUST_GAIN_NEG");
  const maxStep = knobNumber(cfg, "TRUST_MAX_STEP");
  // 正向增量按「还剩多少余量」缩放：trust 越接近 1，同样一句好话能带来的信任越少。
  // 动机是实测出来的：不加这条，8 次满分正向就把 trust 从 0.2 顶到 1.0 并永久钉死，
  // 之后无论对方做什么（包括冷落）都不再有"更信任"的余地——那不是稳定，是僵死。
  // 负向不缩放：受伤害就是受伤害，不该因为有信任底子而打折（这也让"崩掉"仍可能发生）。
  const headroom = sign > 0 ? Math.max(0, Math.min(1, 1 - currentTrust)) : 1;
  const raw = coef * weight * intensity * headroom * gamma;
  return Math.max(-maxStep, Math.min(maxStep, raw));
}

/** 一次 appraisal 的完整推导结果（tick 之前拿到，tick 时喂给 TickInput） */
export interface AppraisalOutcome {
  readonly record: AppraisalRecord;
  readonly emotions: Emotions;
  readonly pressureGain: number;
  readonly affection: AffectionResult;
}

export function appraise(
  raw: AppraisalRaw,
  eventType: string,
  eventId: string,
  ctx: AppraisalContext,
  s: SState,
  cfg: EngineConfig,
): AppraisalOutcome {
  void s;
  const record = parseAppraisal(raw, eventType, eventId);
  const emotions = emerge(record, { audience_present: ctx.audience_present }, knobObject(cfg, "EMOTION_DYNAMICS"));
  const affection = affectionDelta(record, ctx, cfg);
  return { record, emotions, pressureGain: pressureGainFrom(emotions, cfg), affection };
}
