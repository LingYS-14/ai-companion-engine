/**
 * 意向引擎 P1 前置（**未接线**）—— 前瞻意图表（VISION §4.3 / §4.4：Gollwitzer 1999 的实施意图）。
 *
 * 心理意图分两种：
 *   - **目标意图**（"我想多了解她"）：持续存在，靠缺口累积浮现；
 *   - **实施意图**（"下次她上线时，问一句昨天那件事怎么样了"）：绑定触发条件，**到点才浮现**。
 * 后者就是 `IntentionRecord.trigger` 的用途：`{ type: 'time' | 'event' | 'cue', spec }`。
 *
 * 为什么 P0 先不做：trigger 只是数据结构；"什么时候算到点"是 P1 的前瞻表要回答的。
 * 这里补上的全是纯函数：判定到点、按确定性顺序取出、算出下一次该醒来的时刻。
 *
 * 时间纪律：本文件不调系统时钟（读"现在"只允许发生在 `src/engine/clock.ts`，见 `tools/lint/writers.mjs` 规则 2；
 * 门禁是按字面量匹配的，所以这里连示例都不写那两个写法）。
 * `nowMs` 由调用方用 `Clock.now()` 传进来；`Date.parse` 只用来解析 spec 字符串，不读"现在"。
 * 解析失败**当场抛 RangeError**（fail-closed）：一个坏 spec 不该在半夜让整张表静默失效。
 */

import type { IntentKind, IntentionRecord, IntentionTrigger } from "./types.js";
import { formatUtc } from "./episode.js";

export interface LookaheadContext {
  /** 当前时间（epoch ms），由 `Clock.now()` 提供 */
  nowMs: number;
  /** 本 tick 收到的事件名（event 触发的匹配集） */
  events?: readonly string[];
  /** 本 tick 被命中的线索（cue 触发的匹配集） */
  cues?: readonly string[];
}

/** 校验并返回 trigger；类型/spec 非法直接抛（fail-closed）。 */
export function validateTrigger(trigger: IntentionTrigger): IntentionTrigger {
  if (trigger.type === "time") {
    const ms = Date.parse(trigger.spec);
    if (!Number.isFinite(ms)) throw new RangeError(`validateTrigger: 时间 spec 不可解析：${trigger.spec}`);
    return trigger;
  }
  if (trigger.type === "event" || trigger.type === "cue") {
    if (trigger.spec.trim().length === 0) {
      throw new RangeError(`validateTrigger: ${trigger.type} 的 spec 不能为空`);
    }
    return trigger;
  }
  throw new RangeError(`validateTrigger: 未知 trigger.type：${String((trigger as { type?: unknown }).type)}`);
}

/** 到点判定：time → nowMs ≥ spec；event → events 含 spec；cue → cues 含 spec。无 trigger = 不因触发而浮现。 */
export function triggerDue(trigger: IntentionTrigger | null, ctx: LookaheadContext): boolean {
  if (trigger === null) return false;
  validateTrigger(trigger);
  switch (trigger.type) {
    case "time":
      return ctx.nowMs >= Date.parse(trigger.spec);
    case "event":
      return (ctx.events ?? []).includes(trigger.spec);
    case "cue":
      return (ctx.cues ?? []).includes(trigger.spec);
  }
}

function dueOrder(a: IntentionRecord, b: IntentionRecord): number {
  const ta = a.trigger?.type === "time" ? Date.parse(a.trigger.spec) : Number.POSITIVE_INFINITY;
  const tb = b.trigger?.type === "time" ? Date.parse(b.trigger.spec) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * D11-2：读侧共用谓词——pending 与带 trigger 的 held 都算候选。
 * 只在这里判一次，dueIntentions 与 dueIntentionsSafe 才不会口径分叉（spec §2.2 B1）。
 * `trigger === null` 的 held 仍不 due（triggerDue(null) 兜底 false）。
 */
function isDueNow(record: IntentionRecord, ctx: LookaheadContext): boolean {
  return (record.status === "pending" || record.status === "held") && triggerDue(record.trigger, ctx);
}

/**
 * 本 tick 到点的实施意图：`status === "pending"` 或带 trigger 的 `held`，且 trigger 到点。
 * 返回**新数组**，按"时间触发的到点时刻升序 → id"排序（确定性，golden 可对拍）。
 */
export function dueIntentions(records: readonly IntentionRecord[], ctx: LookaheadContext): IntentionRecord[] {
  return records.filter((record) => isDueNow(record, ctx)).sort(dueOrder);
}

export interface LookaheadTable {
  total: number;
  /** 有 trigger 的（真正的实施意图） */
  withTrigger: number;
  byType: { time: number; event: number; cue: number };
  /** 最近的未来时间触发（epoch ms，没有则为 null） */
  nextAtMs: number | null;
}

/**
 * 前瞻表摘要：给 P1 的 loop 决定"要不要为下次触发醒一次"用，也给人看。
 * D11-2：`byType`/`nextAtMs` 从「只数 pending」扩到「pending + 带 trigger 的 held」，
 * 与 due 读取面一致；`total`/`withTrigger` 口径不变（spec §2.3 B2）。
 */
export function lookaheadTable(records: readonly IntentionRecord[], nowMs: number): LookaheadTable {
  const withTrigger = records.filter((record) => record.trigger !== null);
  const byType = { time: 0, event: 0, cue: 0 };
  let nextAtMs: number | null = null;
  for (const record of records) {
    if (record.trigger === null) continue;
    if (record.status !== "pending" && record.status !== "held") continue;
    byType[record.trigger.type] += 1;
    if (record.trigger.type === "time") {
      const ms = Date.parse(record.trigger.spec);
      if (!Number.isFinite(ms)) throw new RangeError(`lookaheadTable: 时间 spec 不可解析：${record.trigger.spec}`);
      if (ms >= nowMs && (nextAtMs === null || ms < nextAtMs)) nextAtMs = ms;
    }
  }
  return { total: records.length, withTrigger: withTrigger.length, byType, nextAtMs };
}

export interface DueResult {
  /** 本 tick 到点、应被激活的记录（未改状态） */
  due: IntentionRecord[];
  /** 其余记录（原顺序不变） */
  remaining: IntentionRecord[];
}

/** 把到点记录从表里摘出来（纯函数；激活动作由调用方用 `bus.activate` 做，便于审计）。 */
export function splitDue(records: readonly IntentionRecord[], ctx: LookaheadContext): DueResult {
  const due = dueIntentions(records, ctx);
  const dueIds = new Set(due.map((record) => record.id));
  return { due, remaining: records.filter((record) => !dueIds.has(record.id)) };
}

/* ------------------------------------------------------------------ *
 * P1 接线（design v3）：写侧生成 trigger、读侧逐条隔离、出口覆盖。
 * 全部纯函数；「现在」只从参数进，本文件不读系统时钟。
 * ------------------------------------------------------------------ */

/** 写侧保守默认：这几类想做的事，过一阵再提起才自然（单位：小时）。 */
export const TRIGGER_OFFSET_HOURS: Readonly<Partial<Record<IntentKind, number>>> = Object.freeze({
  reach_out: 6,
  continue_thread: 12,
  repair: 24,
});

/**
 * 毫秒 → `toISOString()` 同口径的 UTC 串（含毫秒）。
 * 纯算术：复用 `episode.formatUtc` 的 civil_from_days，不 new Date、不读系统时钟
 * （writers lint 规则 2 只允许 `src/engine/clock.ts` 出现时间构造）。
 */
function formatUtcMs(ms: number): string {
  const floored = Math.floor(ms);
  const millis = ((floored % 1000) + 1000) % 1000;
  return `${formatUtc(floored).slice(0, -1)}.${String(millis).padStart(3, "0")}Z`;
}

/**
 * 按意图类别生成 time trigger（`nowMs + 固定延迟`）。
 * 没有明确时间语义的类别返回 null；生成后立刻 `validateTrigger` fail-closed，
 * 坏值不让它进入意图表。
 */
export function deriveTrigger(kind: IntentKind, nowMs: number): IntentionTrigger | null {
  if (!Number.isFinite(nowMs)) throw new RangeError("deriveTrigger: nowMs 非法");
  const hours = TRIGGER_OFFSET_HOURS[kind];
  if (hours === undefined) return null;
  const spec = formatUtcMs(nowMs + hours * 3_600_000);
  return validateTrigger({ type: "time", spec });
}

export interface DueSkipped {
  readonly id: string;
  readonly error: string;
}

export interface DueSafeResult {
  readonly due: IntentionRecord[];
  readonly skipped: readonly DueSkipped[];
}

/**
 * 逐条隔离版 `dueIntentions`：一条坏 trigger 只跳过该条，不让整张表的到点判断失效。
 * 排序语义与 `dueIntentions` 一致（time 到点时刻升序 → id）；
 * D11-2：与 `dueIntentions` 共用 `isDueNow`（pending + 带 trigger 的 held）。
 */
export function dueIntentionsSafe(
  records: readonly IntentionRecord[],
  ctx: LookaheadContext,
): DueSafeResult {
  const due: IntentionRecord[] = [];
  const skipped: DueSkipped[] = [];
  for (const record of records) {
    if (record.status !== "pending" && record.status !== "held") continue;
    try {
      if (isDueNow(record, ctx)) due.push(record);
    } catch (err) {
      skipped.push({ id: record.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  due.sort(dueOrder);
  return { due, skipped };
}

export interface DuePickInput {
  readonly gateAllowed: boolean;
  /** 这一拍本来就有更急的 speak 冲动 → 到点的旧意图留到下一拍 */
  readonly currentOutletIsSpeak: boolean;
  readonly suppressedKinds: readonly string[];
  /** null = 还没主动开口过 → 不阻止；数字 0 = 刚开过口 → 在 quiet 内跳过 */
  readonly minutesSinceLastProactive: number | null;
  readonly reRaiseQuietMin: number;
}

/** 从到点记录里挑本拍真的要浮现的那一条；每条都过既有刹车，最多 1 条。 */
export function pickDueIntention(
  due: readonly IntentionRecord[],
  input: DuePickInput,
): IntentionRecord | null {
  if (!input.gateAllowed) return null;
  if (input.currentOutletIsSpeak) return null;
  for (const record of due) {
    if (input.suppressedKinds.includes(record.kind)) continue;
    const minutes = input.minutesSinceLastProactive;
    // B4：null 是「从未主动开口」，不能当 0 用；只有明确的数字且小于静默窗才跳过。
    if (typeof minutes === "number" && minutes < input.reRaiseQuietMin) continue;
    return record;
  }
  return null;
}

export interface OutletLike {
  readonly target: "speak" | "journal" | "idle";
  readonly kind: IntentKind | null;
  readonly line: string | null;
  readonly whyLine: string | null;
  readonly note: string;
}

export interface EffectiveOutletResult {
  readonly effective: OutletLike;
  /** true = 本拍出口被 due 覆盖（日志/锁断言用） */
  readonly dueOverridden: boolean;
}

/**
 * 出口覆盖：due > speakable > 原 outlet。
 * 覆盖只改「这一拍说什么」，不绕过硬闸/F312 刹车——那些已在 `pickDueIntention` 里过完。
 */
export function resolveEffectiveOutlet(input: {
  readonly due: IntentionRecord | null;
  readonly speakable: IntentionRecord | null;
  readonly outlet: OutletLike;
}): EffectiveOutletResult {
  if (input.due !== null) {
    return {
      effective: {
        target: "speak",
        kind: input.due.kind,
        line: input.due.goal,
        whyLine: input.due.why,
        note: "这是你之前定下的，到点了。",
      },
      dueOverridden: true,
    };
  }
  if (input.speakable !== null) {
    return {
      effective: {
        target: "speak",
        kind: input.speakable.kind,
        line: input.speakable.goal,
        whyLine: input.speakable.why,
        note: "接着上次被额度拦住的那句话",
      },
      dueOverridden: false,
    };
  }
  return { effective: input.outlet, dueOverridden: false };
}
