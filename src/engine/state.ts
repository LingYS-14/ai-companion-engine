/**
 * S 层状态机 —— v5.3.1 §4.5 tick 的唯一实现（单一写入点）。
 *
 * 顺序被冻死（改顺序 = 改契约，必须 bump spec + 同步 tools/audit/verify_v531.py）：
 *   1. energy 门控（A 清醒持续耗能 + B 认知事件耗能；抑制期不回血）
 *   2. 零基线载荷乘法衰减（rumination / entropy / dissonance / jealousy）
 *   3. pressure、suppression_load 的**唯一**衰减 = 一阶松弛到基线（INV-7）
 *   4. pending gains（同 tick 加入；必须在松弛之后，否则被同轮削掉）
 *   5. mask_integrity 派生
 *   6. 载荷增益（LOAD_WEIGHTS × 情绪）
 *   7. 情绪信号 EMA —— 目标值锚在**绝对锚点**上，不是"当前值 + 增量"
 *
 * 第 7 条是 v5.0–v5.3 反复出问题的地方：`v += η(target − v)` 里 target 若含 v 自身，
 * 就是正反馈，joy=0.8 时 20 轮打顶并永久锁定（"永远自信"）。绝对锚点让撤掉输入后能回落。
 */

import { knobNumber, knobObject, tickHours, type EngineConfig } from "./config.js";

export interface TaintEntry {
  state: "trusted" | "tainted";
  since: number;
  sources: string[];
}

/** 与 spec/schema/state.schema.json 一一对应（13 字段） */
export interface SState {
  valence: number;
  arousal: number;
  pressure: number;
  energy: number;
  dissonance: number;
  entropy: number;
  affection: number;
  trust: number;
  jealousy: number;
  maskIntegrity: number;
  suppressionLoad: number;
  rumination: number;
  taintMap: Record<string, TaintEntry>;
}

/** §9.3 初值表（v5.3.1：13 项，含 rumination 与 taint_map） */
export function initialSState(): SState {
  return {
    valence: 0.5,
    arousal: 0.3,
    pressure: 0.2,
    energy: 1.0,
    dissonance: 0.1,
    entropy: 0.2,
    affection: 0.3,
    trust: 0.2,
    jealousy: 0.0,
    maskIntegrity: 1.0,
    suppressionLoad: 0.1,
    rumination: 0.0,
    taintMap: {},
  };
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 向 baseline 做一阶松弛，并把 dt 合并进去：k(dt) = 1 − (1 − κ_tick)^(dt/τ)。
 * v < baseline 时不放大，只按 base_reset 线性回升（§4.5 的不对称）。
 */
export function relaxDt(
  v: number,
  baseline: number,
  kappaPerTick: number,
  dtHours: number,
  baseReset: number,
  tauHours: number,
): number {
  if (!Number.isFinite(dtHours) || dtHours < 0) throw new RangeError(`dt 不能为负：${dtHours}`);
  if (tauHours <= 0) throw new RangeError(`tau 必须为正：${tauHours}`);
  if (v > baseline) {
    const k = 1 - Math.pow(1 - kappaPerTick, dtHours / tauHours);
    return Math.max(baseline, v - k * (v - baseline));
  }
  return Math.min(baseline, v + baseReset * (dtHours / tauHours));
}

/** INV7-EXEMPT：零基线载荷唯一的衰减路径，被 lint 显式豁免 */
function decayLoad(v: number, lambdaPerHour: number, dtHours: number): number {
  return clamp01(v * Math.exp(-lambdaPerHour * dtHours));
}

/** D8：jealousy 联动衰减的输入视图（全是只读当前量，不写状态） */
export interface JealousyDecayView {
  readonly trust: number;
  readonly valence: number;
  readonly rumination: number;
  readonly pressure: number;
  /** D 层依恋焦虑；调用方没有 D 层时传 0 */
  readonly anxiety: number;
}

/**
 * D8：消气速度联动系数 `k = clamp(1 + 0.6(trust−.5) + 0.4(valence−.5) − 0.8·rumination − 0.5·pressure − 0.5·anxiety, floor, ceil)`。
 *
 * 读数方向：信任高 / 心情好 → k>1 → 半衰期变短（消气快）；
 * 反刍多 / 压着 / 依恋焦虑 → k<1 → 半衰期变长（记仇久）。
 * 这是"她为什么有时候很快就不气了"的可调解释，不再是死常数。
 */
export function jealousyDecayK(view: JealousyDecayView, cfg: EngineConfig): number {
  const m = knobObject<{ trust: number; valence: number; rumination: number; pressure: number; anxiety: number; floor: number; ceil: number }>(
    cfg,
    "JEALOUSY_DECAY_MODULATION",
  );
  const raw = 1 + m.trust * (view.trust - 0.5) + m.valence * (view.valence - 0.5)
    + m.rumination * view.rumination + m.pressure * view.pressure + m.anxiety * view.anxiety;
  if (!Number.isFinite(raw)) throw new RangeError(`jealousy 联动系数非有限值：${String(raw)}`);
  if (!(m.floor > 0) || !(m.ceil >= m.floor)) throw new RangeError("JEALOUSY_DECAY_MODULATION floor/ceil 非法");
  return Math.min(m.ceil, Math.max(m.floor, raw));
}

/** 实际半衰期（小时）= 基线 / k；基线取 `JEALOUSY_BASE_HALF_LIFE_HOURS`（默认 720h = 30 天） */
export function jealousyHalfLifeHours(view: JealousyDecayView, cfg: EngineConfig): number {
  const base = knobNumber(cfg, "JEALOUSY_BASE_HALF_LIFE_HOURS");
  if (!(base > 0)) throw new RangeError(`JEALOUSY_BASE_HALF_LIFE_HOURS 必须为正：${String(base)}`);
  return base / jealousyDecayK(view, cfg);
}

/** 衰减率（每小时）= ln2 / 实际半衰期；tick 只用它，不直接读 recovery（A38b-2） */
export function jealousyDecayPerHour(view: JealousyDecayView, cfg: EngineConfig): number {
  return Math.LN2 / jealousyHalfLifeHours(view, cfg);
}

/** 一轮 tick 的情绪输入（emergent 之后的连续强度 0..1，缺省 = 0） */
export interface Emotions {
  readonly joy?: number;
  readonly anger?: number;
  readonly sadness?: number;
  readonly fear?: number;
  readonly shame?: number;
  readonly surprise?: number;
  readonly jealousy?: number;
}

/**
 * 关系通道（affection / trust）**唯一写入点**在这里。
 * appraisal.ts 只算增量（纯函数），由 tick 编排层把增量交过来 —— 否则 affection/trust 就有两个 writer。
 */
export function applyRelational(s: SState, affectionDelta: number, trustDelta: number): void {
  if (!Number.isFinite(affectionDelta) || !Number.isFinite(trustDelta)) {
    throw new RangeError("关系增量必须是有限数");
  }
  s.affection = clamp01(s.affection + affectionDelta);
  s.trust = clamp01(s.trust + trustDelta);
}

export interface TickInput {
  /** 距上次 tick 的小时数（由 Clock 提供，测试里是 FakeClock） */
  readonly dtHours: number;
  /** §4.2 apply_pressure 的返回值：本轮落入 pressure 的 gain（不是 state.pressure） */
  readonly pressureGain?: number;
  /** §4.7 apply_suppression 的返回值：抑制强度 0..1 */
  readonly suppressionIntensity?: number;
  /** §4.7 crisis_event 的 immediate 增量（与 si 互斥：同一轮只能用一条路径加压制） */
  readonly suppressionAdd?: number;
  /** §4.5 反刍增量（OBSESSION 驱动） */
  readonly ruminationAdd?: number;
  /** 本轮情绪向量；缺省视为全 0（于是信号回落到锚点） */
  readonly emotions?: Emotions;
  /** D 层依恋焦虑（0..1）；只用于 jealousy 的联动衰减系数（D8），不写进 S 层 */
  readonly attachmentAnxiety?: number;
  /**
   * 门控 A：清醒期持续耗能（默认 true，按真实 dtHours 扣 ENERGY_WAKE_COST）。
   * turn 的内置 tick 与 dt=0 的即时结算显式传 false——它们不推进真实时间，否则会与
   * runtime.advance 的被动推进重复扣电。睡眠期也传 false（由 B 之外的恢复项单独负责）。
   */
  readonly wakeDrain?: boolean;
  /** 门控能量恢复项（默认 true）。turn 的内置 tick 显式 false；睡眠 tick 保持 true。 */
  readonly energyRecovery?: boolean;
  /** B 通道：本次认知事件的额外耗能（energy，默认 0），由调用方用 energyCostFor 算好传入 */
  readonly energyCost?: number;
}

export interface TickTrace {
  readonly energy: number;
  readonly pressure: number;
  readonly suppressionLoad: number;
  readonly maskIntegrity: number;
  readonly entropy: number;
  readonly dissonance: number;
  readonly jealousy: number;
  readonly rumination: number;
  readonly valence: number;
  readonly arousal: number;
}

interface LoadWeights {
  readonly entropy_shame: number;
  readonly entropy_surprise: number;
  readonly dissonance: number;
  readonly jealousy: number;
}

/** §4.5 tick：唯一允许写 S 层的地方 */
export function tick(s: SState, input: TickInput, cfg: EngineConfig): TickTrace {
  const { dtHours, ruminationAdd = 0, suppressionAdd = 0 } = input;
  const gain = input.pressureGain ?? 0;
  const si = input.suppressionIntensity ?? 0;
  const em = input.emotions ?? {};
  if (!Number.isFinite(dtHours) || dtHours < 0) throw new RangeError(`非法 dt：${dtHours}`);
  if (gain < 0) throw new RangeError(`pressureGain 不能为负：${gain}`);
  if (si < 0 || si > 1) throw new RangeError(`suppressionIntensity 越界：${si}`);
  if (suppressionAdd < 0) throw new RangeError(`suppressionAdd 不能为负：${suppressionAdd}`);
  if (suppressionAdd > 0 && si > 0) throw new RangeError("同一轮不得同时用 si 与 suppressionAdd 加压制（会双计）");

  const tau = tickHours(cfg);
  const rate = knobNumber(cfg, "ENERGY_RECOVERY_RATE");
  const cost = knobNumber(cfg, "ENERGY_SUPPRESS_COST");
  const wake = knobNumber(cfg, "ENERGY_WAKE_COST");
  const wakeDrain = input.wakeDrain ?? true;
  const energyRecovery = input.energyRecovery ?? true;
  const energyCost = input.energyCost ?? 0;
  if (!Number.isFinite(energyCost) || energyCost < 0) {
    throw new RangeError(`energyCost 必须是非负有限数：${energyCost}`);
  }
  const pBase = knobNumber(cfg, "PRESSURE_BASELINE");
  const pKappa = knobNumber(cfg, "KAPPA_PRESSURE");
  const sBase = knobNumber(cfg, "SUPPRESSION_BASELINE");
  const sKappa = knobNumber(cfg, "KAPPA_SUPPRESSION");
  const baseReset = knobNumber(cfg, "TICK_BASE_RESET");
  const sGain = knobNumber(cfg, "SUPPRESS_LOAD_GAIN");
  const threshold = knobNumber(cfg, "MASK_LEAK_THRESHOLD");
  const rumLambda = knobNumber(cfg, "RUMINATION_LAMBDA");
  const loadLambda = knobNumber(cfg, "LOAD_GAIN_LAMBDA");
  const weights = knobObject<LoadWeights>(cfg, "LOAD_WEIGHTS");

  // 1) energy：A 清醒耗能（毛值，不乘 1−si）+ B 事件耗能 + 抑制期不回血
  s.energy = clamp01(
    s.energy +
      rate * dtHours * (1 - si) * (energyRecovery ? 1 : 0) -
      (wakeDrain ? wake * dtHours : 0) -
      cost * si * (dtHours / tau) -
      energyCost,
  );

  // 2) 零基线载荷：乘法时间衰减
  s.rumination = decayLoad(s.rumination, rumLambda, dtHours);
  s.entropy = decayLoad(s.entropy, loadLambda, dtHours);
  s.dissonance = decayLoad(s.dissonance, loadLambda, dtHours);
  // D8：jealousy 不再跟 LOAD_GAIN_LAMBDA 走，而是按当前关系/情绪联动出的半衰期衰减
  const jView: JealousyDecayView = {
    trust: s.trust,
    valence: s.valence,
    rumination: s.rumination,
    pressure: s.pressure,
    anxiety: input.attachmentAnxiety ?? 0,
  };
  s.jealousy = decayLoad(s.jealousy, jealousyDecayPerHour(jView, cfg), dtHours);

  // 3) pressure / suppression：唯一衰减路径 = 一阶松弛（INV-7），且两者同序
  s.pressure = relaxDt(s.pressure, pBase, pKappa, dtHours, baseReset, tau);
  s.suppressionLoad = relaxDt(s.suppressionLoad, sBase, sKappa, dtHours, baseReset, tau);

  // 4) pending gains：加在松弛之后
  s.pressure = clamp01(s.pressure + gain);
  s.suppressionLoad = clamp01(s.suppressionLoad + sGain * si + suppressionAdd);
  s.rumination = clamp01(s.rumination + ruminationAdd);

  // 5) mask_integrity 是派生量
  s.maskIntegrity = clamp01(1 - s.suppressionLoad / threshold);

  // 6) 载荷增益（LOAD_WEIGHTS × 情绪）
  const shame = em.shame ?? 0;
  const surprise = em.surprise ?? 0;
  const joy = em.joy ?? 0;
  s.entropy = clamp01(s.entropy + weights.entropy_shame * shame + weights.entropy_surprise * surprise);
  s.dissonance = clamp01(s.dissonance + weights.dissonance * Math.abs(shame - joy));
  s.jealousy = clamp01(s.jealousy + weights.jealousy * (em.jealousy ?? 0));

  // 7) 情绪信号：绝对锚定 EMA（E=0 时目标就是锚点，所以能回落）
  const netV = joy - (em.anger ?? 0) - (em.sadness ?? 0) - (em.fear ?? 0) - shame;
  const netA = (em.anger ?? 0) + (em.fear ?? 0) + joy + surprise + shame;
  const vAnchor = knobNumber(cfg, "VALENCE_ANCHOR");
  const aAnchor = knobNumber(cfg, "AROUSAL_ANCHOR");
  const scale = knobNumber(cfg, "SIGNAL_SCALE");
  const eta = knobNumber(cfg, "EMA_ETA");
  const targetV = clamp01(vAnchor + scale * netV);
  const targetA = clamp01(aAnchor + scale * netA);
  s.valence = clamp01(s.valence + eta * (targetV - s.valence));
  s.arousal = clamp01(s.arousal + eta * (targetA - s.arousal));

  return {
    energy: s.energy,
    pressure: s.pressure,
    suppressionLoad: s.suppressionLoad,
    maskIntegrity: s.maskIntegrity,
    entropy: s.entropy,
    dissonance: s.dissonance,
    jealousy: s.jealousy,
    rumination: s.rumination,
    valence: s.valence,
    arousal: s.arousal,
  };
}

/** 只推进被动松弛（无新刺激），供离线补算使用 */
export function idleTick(s: SState, dtHours: number, cfg: EngineConfig): TickTrace {
  return tick(s, { dtHours }, cfg);
}

/**
 * B 通道（认知事件耗能）的事件集合——已批准的 7 类，不允许调用方自定义名字。
 *
 * 第 6 类 `learn_deep` 由 P3-3 能量↔学习耦合评审扩展：深读一条视频笔记
 * （补字幕/画面、可复盘）比普通"学了一轮"更贵，单独计价；0 = 关闭该成本。
 * 第 7 类 `social` 由 2026-11 社交主动性改造加入：一次真的落到 B 站的互动
 * （点赞/弹幕/评论）包含刷视频与组织一句短话，和 proactive 同价；只看不写不计费。
 */
export type EnergyCostKind = "turn" | "learn" | "proactive" | "selftalk" | "consolidate" | "learn_deep" | "social";

const ENERGY_COST_KNOBS: Readonly<Record<EnergyCostKind, string>> = {
  turn: "ENERGY_COST_TURN",
  learn: "ENERGY_COST_LEARN",
  proactive: "ENERGY_COST_PROACTIVE",
  selftalk: "ENERGY_COST_SELFTALK",
  consolidate: "ENERGY_COST_CONSOLIDATE",
  learn_deep: "ENERGY_COST_LEARN_DEEP",
  social: "ENERGY_COST_SOCIAL",
};

/**
 * §2.3 B 通道：把「一次认知事件」折算成 energy 消耗，集中在这里读配置。
 * 调用方把结果传进 `tick({ energyCost })`，不要自己重复读旋钮。
 */
export function energyCostFor(cfg: EngineConfig, kind: EnergyCostKind): number {
  const knob = ENERGY_COST_KNOBS[kind];
  if (knob === undefined) throw new RangeError(`未知的耗能事件：${String(kind)}`);
  const value = knobNumber(cfg, knob);
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${knob} 必须是非负有限数：${String(value)}`);
  }
  return value;
}
