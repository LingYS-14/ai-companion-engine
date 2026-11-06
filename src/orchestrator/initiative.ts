/**
 * §4.9 阶段 0：主动性门控（v5.4-P1 D4）。
 *
 * 规格把阶段 0 写成「队列空 + energy > 阈值 + trust > 下限 → 生成 → return」，
 * 但真实产品里还叠着静默窗、冷却、日上限三道已有的门（`src/qq/proactive.ts` 用了很久）。
 * 裁决 D4：**门控上移**——本模块只做纯决定，Orchestrator 拿决定去生成；qq 层复用同一套判定。
 *
 * 三个要点：
 *   1. 全部纯函数，不读时钟、不写任何状态（A34 的同族要求：门控不该有副作用）；
 *   2. trust < TRUST_SAFE_MIN 时只能用「安全话术」（initiate_meme），不许推进亲密；
 *   3. 静默窗对 **主动开口** 有效，对「回消息」无效（那是 F54 修过的旧坑，别再搬回来）。
 */

import { inQuietHours } from "../engine/timewindow.js";

export type InitiativeVerdict =
  | "disabled"
  | "quiet"
  | "gap"
  | "daily"
  | "queue"
  | "energy"
  | "distrust"
  /** P1：意向引擎硬闸的两种否决（额度用完 / 单写者冲突） */
  | "quota"
  | "single_writer"
  | "speak";

export interface InitiativeOptions {
  readonly enabled: boolean;
  readonly quietFrom: number;
  readonly quietTo: number;
  /** 距上次主动开口至少多久（毫秒） */
  readonly minGapMs: number;
  readonly maxPerDay: number;
}

export interface InitiativeInput {
  readonly now: number;
  readonly localHour: number;
  /** S 层 energy（13 状态量之一，0..1） */
  readonly energy: number;
  /** S 层 trust */
  readonly trust: number;
  /** 事件队列是否为空：有未处理的事件时不抢先开口（§4.9 第一个条件） */
  readonly eventQueueEmpty: boolean;
  readonly lastAt: number | null;
  readonly todayCount: number;
  readonly opts: InitiativeOptions;
}

export type MechanicalVerdict = "disabled" | "quiet" | "gap" | "daily";

export interface MechanicalGateInput {
  readonly now: number;
  readonly localHour: number;
  readonly lastAt: number | null;
  readonly todayCount: number;
  readonly opts: InitiativeOptions;
}

/**
 * 三道机械门（关闭 / 静默窗 / 冷却 / 日上限），§4.9 阶段 0 与 qq 层 `decideProactive` 共用。
 * 返回 null = 通过；返回字符串 = 被拦下的原因（诊断用）。
 */
export function mechanicalGate(input: MechanicalGateInput): { verdict: MechanicalVerdict; note: string } | null {
  const o = input.opts;
  if (!o.enabled) return { verdict: "disabled", note: "主动开口未开启" };
  if (inQuietHours(input.localHour, o.quietFrom, o.quietTo)) {
    return { verdict: "quiet", note: `静默时段 ${o.quietFrom}:00–${o.quietTo}:00` };
  }
  if (input.lastAt !== null && input.now - input.lastAt < o.minGapMs) {
    return { verdict: "gap", note: `距上次主动开口不足 ${Math.round(o.minGapMs / 60_000)} 分钟` };
  }
  if (input.todayCount >= o.maxPerDay) {
    return { verdict: "daily", note: `今天已主动开口 ${input.todayCount} 次（上限 ${o.maxPerDay}）` };
  }
  return null;
}

export interface StateGateThresholds {
  /** PROACTIVE_ENERGY_THRESHOLD：太累就不主动开口 */
  readonly energyFloor: number;
  /** PROACTIVE_TRUST_FLOOR：不够信任就不主动开口 */
  readonly trustFloor: number;
  /** TRUST_SAFE_MIN：没到安全线只许安全话术 */
  readonly trustSafeMin: number;
}

/**
 * §4.9 阶段 0 的状态门：energy / trust 两条。与机械门分开，因为回消息不该受它约束。
 * 返回 null = 通过。
 */
export function stateGate(
  input: { readonly energy: number; readonly trust: number },
  thresholds: StateGateThresholds,
): { verdict: "energy" | "distrust"; note: string } | null {
  if (input.energy <= thresholds.energyFloor) {
    return { verdict: "energy", note: `energy ${round3(input.energy)} ≤ 阈值 ${thresholds.energyFloor}，太累不主动开口` };
  }
  if (input.trust <= thresholds.trustFloor) {
    return { verdict: "distrust", note: `trust ${round3(input.trust)} ≤ 下限 ${thresholds.trustFloor}，不主动开口` };
  }
  return null;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export interface InitiativeDecision {
  readonly act: boolean;
  readonly verdict: InitiativeVerdict;
  /** act 时用：trust 安全态只许安全话术，否则走策略选择 */
  readonly strategy?: "initiate_meme" | "select";
  readonly note: string;
}

/**
 * 阶段 0 的策略选择（§4.9）。
 *
 * trust 在 [FLOOR, SAFE_MIN) 之间 = 「刚够开口但还没到敢推进」，只能发表情包/安全话术；
 * 过了 SAFE_MIN 才允许 `select_strategy(ctx="proactive")`。
 */
export function initiativeStrategy(trust: number, thresholds: StateGateThresholds): "initiate_meme" | "select" {
  return trust < thresholds.trustSafeMin ? "initiate_meme" : "select";
}

/**
 * 意向引擎硬闸的形状（`src/orchestrator/intent/gate.ts` 的 `GateDecision`）。
 *
 * 这里只声明结构、不 import：门控模块不该因为类型依赖就把 bus/WAL 一并拉进依赖图。
 */
export interface IntentGateLike {
  readonly allowed: boolean;
  readonly verdict: string;
  readonly note: string;
}

export interface PrepareInitiateOptions {
  /**
   * P1：把四否决硬闸接进来（额度 / 静默 / 单写者 / 关系信任）。
   *
   * 给了它 = 走「降级后的硬闸」：energy 阈值与事件队列不再看（那两道由 gate.ts 在上游判，
   * 判完只把结论交过来）；但**冷却（gap）与日上限（daily）保留**为温和兜底
   * （用户 2026-11-01 裁决：30 分钟间隔 / 每天 10 条），静默窗仍**不**作为否决门（A6）。
   * 不给它 = 完全回到 D4 的旧行为（默认，所有现有调用方都不受影响）。
   */
  readonly intentGate?: IntentGateLike;
}

/** 硬闸结论 → 门控结论。未知结论 fail-closed 成 distrust（宁可少说，不可说错）。 */
function verdictFromIntentGate(verdict: string): InitiativeVerdict {
  switch (verdict) {
    case "quota":
      return "quota";
    case "quiet":
      return "quiet";
    case "single_writer":
      return "single_writer";
    case "distrust":
      return "distrust";
    default:
      return "distrust";
  }
}

export function shouldInitiate(
  input: InitiativeInput,
  thresholds: StateGateThresholds,
  options: PrepareInitiateOptions = {},
): InitiativeDecision {
  const intentGate = options.intentGate;
  if (intentGate !== undefined) {
    // 总开关先于一切：主动开口关着，就算硬闸放行也不开口
    if (!input.opts.enabled) return { act: false, verdict: "disabled", note: "主动开口未开启" };
    if (!intentGate.allowed) {
      return {
        act: false,
        verdict: verdictFromIntentGate(intentGate.verdict),
        note: intentGate.note,
      };
    }
    // 温和兜底（用户 2026-11-01 裁决）：硬闸放行后仍要过 gap / daily 两道刹车。
    // 不调 mechanicalGate：它含静默窗否决，而 A6 裁决要求夜间安静只作为事实、不得当门。
    const o = input.opts;
    if (input.lastAt !== null && input.now - input.lastAt < o.minGapMs) {
      return { act: false, verdict: "gap", note: `距上次主动开口不足 ${Math.round(o.minGapMs / 60_000)} 分钟` };
    }
    if (input.todayCount >= o.maxPerDay) {
      return { act: false, verdict: "daily", note: `今天已主动开口 ${input.todayCount} 次（上限 ${o.maxPerDay}）` };
    }
    const strategy = initiativeStrategy(input.trust, thresholds);
    return {
      act: true,
      verdict: "speak",
      strategy,
      note: intentGate.note === "" ? "硬闸放行，按策略挑一个说法" : `硬闸放行：${intentGate.note}`,
    };
  }
  const blocked = mechanicalGate(input);
  if (blocked !== null) return { act: false, verdict: blocked.verdict, note: blocked.note };
  const state = stateGate({ energy: input.energy, trust: input.trust }, thresholds);
  if (state !== null) return { act: false, verdict: state.verdict, note: state.note };
  if (!input.eventQueueEmpty) {
    return { act: false, verdict: "queue", note: "还有对方的事件没处理完，先不抢话" };
  }
  const strategy = initiativeStrategy(input.trust, thresholds);
  return {
    act: true,
    verdict: "speak",
    strategy,
    note: strategy === "initiate_meme" ? "想说话，但还不敢推进——安全话术" : "想说话，按策略挑一个说法",
  };
}
