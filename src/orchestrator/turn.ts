/**
 * 单轮编排：把"一次输入"推到"可以交给 LLM 的状态"。
 *
 * 不持有状态、不做 IO、不调 LLM —— 只按固定顺序串起 §4.2/§4.5/§4.6/§4.7：
 *
 *   appraisal（纯） → crisis（可选，immediate） → tick（唯一写 S 层） → resolveMode → 关系通道
 *
 * 为什么顺序不能变：
 *   - tick 必须在 appraisal 之后：gain/emotions 是本轮输入
 *   - resolveMode 必须在 tick 之后：否则"这一轮刚被顶到 0.9"要等下一轮才进 DEFENSE
 *   - 关系通道（affection/trust）必须在 tick 之外补写，且只有 applyRelational 一个入口
 */

import type { Clock } from "../engine/clock.js";
import { tickHours, type EngineConfig } from "../engine/config.js";
import { affectionDelta, emerge, gammaFor, parseAppraisal, pressureGainFrom, trustDelta, type AppraisalRaw } from "../engine/appraisal.js";
import { knobObject } from "../engine/config.js";
import type { LanguageFeatures, RenderHints } from "../dialogue/embodiment.js";
import { crisisEvent, type CrisisEvent, type ImmediateGain } from "../engine/crisis.js";
import { applyRelational, tick, type SState, type TickTrace } from "../engine/state.js";
import { resolveMode, thresholdsFrom, type Mode, type ModeThresholds } from "../engine/modes.js";
import { stageOf, stageBands, type Stage } from "../engine/bonds.js";

export interface TurnContext {
  readonly clock: Clock;
  readonly characterId: string;
  readonly channel: string;
  /** 事件来源：只有 RELATION_SOURCES 里的来源能改 affection/trust */
  readonly source: string;
  readonly eventType: string;
  /**
   * §4.1 n_t：这一轮之前同类型事件的次数。由调度层（runtime）维护，**不进 S 层**（INV-4）。
   * 不传 = 0（首轮，γ=1）。
   */
  readonly eventTypeCount?: number;
  readonly audiencePresent?: number;
  /** bond 进度（0..1），由关系层维护；用于给 LLM 的"距离"提示 */
  readonly bondProgress?: number;
  /** D 层依恋焦虑（0..1）；只给 jealousy 联动衰减用，不写进 S 层 */
  readonly attachmentAnxiety?: number;
}

export interface TurnRequest {
  readonly text: string;
  readonly appraisal: AppraisalRaw;
  /** §4.10：语言特征（停顿/重音/软化）。只传递，不改引擎数值——A39 要求它是纯输入。 */
  readonly language?: LanguageFeatures;
  /** 抑制强度 0..1（§4.7）；与 crisis 的 suppressionAdd 互斥 */
  readonly suppressionIntensity?: number;
  readonly crisis?: CrisisEvent;
}

export interface TurnResult {
  readonly mode: Mode;
  readonly trace: TickTrace;
  readonly pressureGain: number;
  readonly emotionTop: { channel: string; value: number };
  readonly affection: { applied: boolean; delta: number; gamma: number };
  readonly immediate: ImmediateGain | null;
  /** §4.10 渲染参数（未来 TTS 用；本阶段原样回传） */
  readonly renderHints: RenderHints | undefined;
  /** 交给 DialogueGenerator 的结构化提示（不是台词） */
  readonly hints: {
    readonly mode: Mode;
    readonly stage: Stage | null;
    readonly valence: number;
    readonly arousal: number;
    readonly maskIntegrity: number;
    readonly suppressionLoad: number;
  };
}

export function runTurn(req: TurnRequest, s: SState, ctx: TurnContext, cfg: EngineConfig): TurnResult {
  const now = ctx.clock.now();
  if (!Number.isFinite(now)) throw new RangeError("Clock.now() 返回非有限值");

  const immediate = req.crisis ? crisisEvent(req.crisis, cfg) : null;
  if (immediate !== null && (req.suppressionIntensity ?? 0) > 0) {
    throw new Error("同一轮不得同时给 crisis 的 suppressionAdd 与 suppressionIntensity（会双计）");
  }

  const record = parseAppraisal(req.appraisal, ctx.eventType, `${ctx.characterId}:${req.text.length}:${now}`);
  const emotions = emerge(record, { audience_present: ctx.audiencePresent ?? 0 }, emotionDynamics(cfg));
  const gain = immediate !== null ? immediate.pressureGain : pressureGainFrom(emotions, cfg);

  const trace = tick(
    s,
    {
      dtHours: tickHours(cfg),
      // P3-2b：这一轮的 A/B 通道由 runtime 显式算——回合内置 tick 不扣时间耗散，
      // 否则每轮会和每 5 分钟一拍的 advance 重复扣掉同一段时间。
      wakeDrain: false,
      energyRecovery: false,
      pressureGain: gain,
      suppressionIntensity: immediate !== null ? 0 : (req.suppressionIntensity ?? 0),
      suppressionAdd: immediate !== null ? immediate.suppressionAdd : 0,
      attachmentAnxiety: ctx.attachmentAnxiety ?? 0,
      emotions: {
        joy: emotions.joy,
        anger: emotions.anger,
        fear: emotions.fear,
        sadness: emotions.sadness,
        shame: emotions.shame,
        surprise: emotions.surprise,
        jealousy: emotions.jealousy,
      },
    },
    cfg,
  );

  const th: ModeThresholds = thresholdsFrom(cfg);
  const mode = resolveMode(s, th);

  // 关系通道：只算增量，写入仍然只经 applyRelational
  const priorCount = ctx.eventTypeCount ?? 0;
  const aff = affectionDelta(
    record,
    { audience_present: ctx.audiencePresent ?? 0, source: ctx.source, event_type: ctx.eventType, event_type_count: priorCount },
    cfg,
  );
  // §4.1：γ 同时调制 trust（apply_trust_update），但 pressure/signal/load 不施加
  const gamma = gammaFor(ctx.eventType, priorCount, cfg);
  const tDelta = trustDelta(req.appraisal.goal_congruence >= 0 ? 1 : -1, req.appraisal.goal_relevance, 0.5, cfg, s.trust, gamma);
  applyRelational(s, aff.delta, tDelta);

  const bands = stageBands(cfg);
  const stage = ctx.bondProgress === undefined ? null : stageOf(ctx.bondProgress, bands);

  const top = (Object.entries(emotions) as [string, number][]).reduce((a, b) => (b[1] > a[1] ? b : a));

  return {
    mode,
    renderHints: req.language?.render_hints,
    trace,
    pressureGain: gain,
    emotionTop: { channel: top[0], value: top[1] },
    affection: { applied: aff.applied, delta: aff.delta, gamma: aff.gamma ?? 1 },
    immediate,
    hints: {
      mode,
      stage,
      valence: s.valence,
      arousal: s.arousal,
      maskIntegrity: s.maskIntegrity,
      suppressionLoad: s.suppressionLoad,
    },
  };
}

/** 用于测试：单轮 impulse 后第 2 轮是否落回 */
export function nextIdle(s: SState, cfg: EngineConfig): TickTrace {
  return tick(s, { dtHours: tickHours(cfg) }, cfg);
}

/** A38a：把配置里的 EMOTION_DYNAMICS 交给 emerge（onset/peak 归一化） */
function emotionDynamics(cfg: EngineConfig): Readonly<Record<string, { onset: number; peak: number }>> {
  return knobObject(cfg, "EMOTION_DYNAMICS");
}
