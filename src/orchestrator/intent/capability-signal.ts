/**
 * P4 能力缺口的第一段：把「她想做、但没有趁手工具」这件事算出来。
 *
 * 为什么需要它：`capability.ts` 能算缺口值、`ask-help.ts` 能编排求助、`guardian.ts` 能管
 * 「没人回怎么办」——但**没有人把「缺什么」交给它们**。候选生成遇到缺失的能力族会静默跳过，
 * 于是「她想要一个工具」这件事在系统里从来没有留下痕迹，求助链条也就永远没有输入。
 *
 * 这里只做三件事（纯函数、零模型调用、不碰检索内核）：
 *   1. 从六维驱动里找出「缺口已经越过浮现阈值」的类别（复用 `KIND_GAP_THRESHOLDS`）；
 *   2. 看这些类别需要的能力族在不在手边，不在就产出一条 `AffordanceGap`；
 *   3. 把缺口翻译成「卡在哪 / 想请对方做什么 / 已经试过什么」三段人话（`ask-help.ts` 的输入形状）。
 *
 * 三条诚实边界：
 *   - 只有四类缺口能从驱动维度直接读出来（reach_out/explore/create/withdraw）；
 *     continue_thread 与 repair 依赖的是「有没有被打断的线头 / 要不要修复」，不是数值缺口，
 *     这里不硬造，免得为了「齐七类」编一个假需求。
 *   - withdraw 不需要任何外部工具（`familiesFor("withdraw")` 为空），因此永远不会是能力缺口。
 *   - `tried` 不是编的：它由调用方按真实检测次数填（第一次是「先看看手边有什么」，
 *     之后才是「又试了一次」），本文件只负责给一句不撒谎的模板。
 */

import type { DriveVector, IntentKind } from "./types.js";
import { INTENT_KINDS } from "./types.js";
import { KIND_GAP_THRESHOLDS, affordanceFamily, familiesFor, type AffordanceFamily } from "./candidates.js";
import type { Affordance } from "./types.js";

/** 类别 → 决定它「该不该浮现」的那一维驱动。没有映射的类别不参与能力缺口判定。 */
const GAP_DRIVE: Readonly<Partial<Record<IntentKind, keyof DriveVector>>> = Object.freeze({
  reach_out: "connection",
  explore: "novelty",
  create: "coherence",
});

/** 一条能力缺口：想做哪类事、缺的是哪种能力族、缺口有多大。 */
export interface AffordanceGap {
  readonly kind: IntentKind;
  readonly missingFamily: AffordanceFamily;
  /** 驱动维度的缺口值（0..1），不是"概率" */
  readonly desire: number;
}

export interface DesiredKind {
  readonly kind: IntentKind;
  readonly gap: number;
}

/** 缺口越过浮现阈值的类别（按 `INTENT_KINDS` 顺序，方便日志稳定）。 */
export function desiredKindsWithGaps(drive: DriveVector): readonly DesiredKind[] {
  const out: DesiredKind[] = [];
  for (const kind of INTENT_KINDS) {
    const dim = GAP_DRIVE[kind];
    if (dim === undefined) continue;
    const threshold = KIND_GAP_THRESHOLDS[kind];
    if (threshold === undefined) continue;
    const gap = drive[dim];
    if (!Number.isFinite(gap)) throw new RangeError(`driving 维度 ${dim} 不是有限数：${String(gap)}`);
    if (gap >= threshold) out.push({ kind, gap });
  }
  return out;
}

/** 手边是否已有该类别要的能力族。空族（withdraw/idle）视为"不需要工具"。 */
export function hasFamilyFor(kind: IntentKind, affordances: readonly Affordance[]): boolean {
  const families = familiesFor(kind);
  if (families.length === 0) return true;
  return affordances.some((affordance) => families.includes(affordanceFamily(affordance.tool)));
}

/**
 * 找出「想做的事已经越过阈值、但缺趁手工具」的缺口。
 *
 * 缺口按类别去重（同一类别只要一条），缺口大的在前；`withdraw` / `continue_thread` / `repair`
 * 不会出现在结果里（原因见文件头）。
 */
export function detectAffordanceGaps(input: {
  readonly drive: DriveVector;
  readonly affordances: readonly Affordance[];
}): readonly AffordanceGap[] {
  const gaps: AffordanceGap[] = [];
  for (const desired of desiredKindsWithGaps(input.drive)) {
    if (hasFamilyFor(desired.kind, input.affordances)) continue;
    const family = familiesFor(desired.kind)[0];
    if (family === undefined) continue;
    gaps.push({ kind: desired.kind, missingFamily: family, desire: desired.gap });
  }
  return gaps.sort((a, b) => b.desire - a.desire || INTENT_KINDS.indexOf(a.kind) - INTENT_KINDS.indexOf(b.kind));
}

/** 稳定键：同一类别 + 同一缺失能力族算同一个缺口（跨拍累计 attempts 用）。 */
export function gapKey(gap: Pick<AffordanceGap, "kind" | "missingFamily">): string {
  return `${gap.kind}:${gap.missingFamily}`;
}

/** 一行日志。 */
export function describeAffordanceGap(gap: AffordanceGap): string {
  return `${gap.kind} 缺 ${gap.missingFamily} 能力（缺口 ${gap.desire.toFixed(2)}）`;
}

/** 缺失能力族的人话。用于求助正文，避免把内部枚举名泄给用户。 */
const FAMILY_ZH: Readonly<Record<AffordanceFamily, string>> = Object.freeze({
  message: "发消息",
  read: "读取资料",
  write: "写文件",
  desktop: "操作桌面",
  other: "别的工具",
});

export interface HelpText {
  /** 她卡在哪（第一人称、短句） */
  readonly what: string;
  /** 希望监护人做什么 */
  readonly ask: string;
  /** 已经试过什么（至少一条） */
  readonly tried: readonly string[];
}

/**
 * 把缺口翻译成求助正文。
 *
 * `attempts` 是同一个缺口被真实检测到的次数（由调用方数，不由本文件编）：
 * 第 1 次只写"先看看手边有什么"，第 2 次起才写"已经想了几次都没下手"。
 */
export function helpTextFor(gap: AffordanceGap, attempts: number): HelpText {
  if (!Number.isFinite(attempts) || attempts < 1) {
    throw new RangeError(`attempts 必须是 ≥1 的整数，收到 ${String(attempts)}`);
  }
  const n = Math.floor(attempts);
  const what =
    gap.kind === "create"
      ? `我想做点东西，可手边没有能${FAMILY_ZH[gap.missingFamily]}的能力。`
      : gap.kind === "explore"
        ? `我想去看看新东西，可手边没有能${FAMILY_ZH[gap.missingFamily]}的能力。`
        : `我想找人说话，可手边没有能${FAMILY_ZH[gap.missingFamily]}的通道。`;
  const ask =
    gap.missingFamily === "write"
      ? "能给我一个可以写文件的能力吗？我只在自己的目录里动，不碰系统。"
      : gap.missingFamily === "desktop"
        ? "能给我操作桌面的授权吗？我会先只读观察，不点不输入。"
        : gap.missingFamily === "message"
          ? "能确认一下发消息的通道吗？我这边好像没有接上。"
          : "能给我一个能读资料的工具吗？我想自己查一查。";
  const tried =
    n <= 1
      ? ["先看看手边有什么能用的"]
      : n === 2
        ? ["先看看手边有什么能用的", "想了想有没有别的办法绕开"]
        : ["先看看手边有什么能用的", "想了想有没有别的办法绕开", `已经想过 ${String(n)} 次了`];
  return { what, ask, tried };
}

/** 一条真实的缺口观测（main.mjs 每拍 append 一行，这里只读、不写文件）。 */
export interface GapSighting {
  readonly kind: IntentKind;
  readonly missingFamily: AffordanceFamily;
  readonly at: number;
  /** 这一拍看到的缺口大小；缺省按 0 计（只用来排序，不参与"该不该问"） */
  readonly desire?: number;
}

/** 同一缺口跨多次观测的汇总：`attempts` = 它被真实检测到的**天数**（不是拍数）。 */
export interface GapProbe {
  readonly kind: IntentKind;
  readonly missingFamily: AffordanceFamily;
  /** 被检测到的天数（同一 UTC 日多次只算一次）——"试了一天没成"算一次尝试 */
  readonly attempts: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  /** 见过的最大缺口值 */
  readonly desire: number;
}

const DAY_MS = 86_400_000;

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/** 只看最近 7 天的观测：更早的缺口算"早就过去了"，不该翻旧账。 */
export const GAP_SIGHTING_WINDOW_MS = 7 * DAY_MS;

/**
 * 把缺口观测行汇总成「同一缺口试过几天」。
 *
 * 为什么按天而不是按拍：tick 每 5 分钟一拍，按拍算的话 25 分钟就从"第一次"跳到"试满 5 次放弃"——
 * 那不是在试，那是定时器在计数。按天算更接近"她今天又想做、还是没工具"的真实节奏。
 * `nowMs` 之后（时钟回拨/未来时间）的行直接忽略；窗口外的行也忽略。
 */
export function summarizeGapProbes(
  sightings: readonly GapSighting[],
  nowMs: number,
  windowMs: number = GAP_SIGHTING_WINDOW_MS,
): readonly GapProbe[] {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError(`summarizeGapProbes: nowMs 非法：${String(nowMs)}`);
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError(`summarizeGapProbes: windowMs 非法：${String(windowMs)}`);
  const since = nowMs - windowMs;
  const grouped = new Map<string, { kind: IntentKind; missingFamily: AffordanceFamily; days: Set<number>; first: number; last: number; desire: number }>();
  for (const sighting of sightings) {
    if (sighting === null || typeof sighting !== "object") continue;
    if (!Number.isFinite(sighting.at)) continue;
    if (sighting.at < since || sighting.at > nowMs) continue;
    const key = gapKey({ kind: sighting.kind, missingFamily: sighting.missingFamily });
    const cur = grouped.get(key) ?? { kind: sighting.kind, missingFamily: sighting.missingFamily, days: new Set<number>(), first: sighting.at, last: sighting.at, desire: 0 };
    cur.days.add(Math.floor(sighting.at / DAY_MS));
    cur.first = Math.min(cur.first, sighting.at);
    cur.last = Math.max(cur.last, sighting.at);
    cur.desire = Math.max(cur.desire, numberOrZero(sighting.desire));
    grouped.set(key, cur);
  }
  const probes: GapProbe[] = [];
  for (const cur of grouped.values()) {
    probes.push({
      kind: cur.kind,
      missingFamily: cur.missingFamily,
      attempts: cur.days.size,
      firstAtMs: cur.first,
      lastAtMs: cur.last,
      desire: cur.desire,
    });
  }
  // 想得久的先问；同样久就问缺口大的；再同样就问缺口键（稳定）
  return probes.sort((a, b) => b.attempts - a.attempts || b.lastAtMs - a.lastAtMs || gapKey(a).localeCompare(gapKey(b)));
}

/** 缺口 → `capability.ts` 的缺口类别（求助编排只用 `missing`/`kind` 两个字段）。 */
export function capabilityGapKindOf(gap: Pick<AffordanceGap, "missingFamily">): "knowledge" | "permission" | "api" | "skill" | "physical" {
  switch (gap.missingFamily) {
    case "read":
      return "knowledge";
    case "message":
      return "api";
    case "write":
    case "desktop":
      return "permission";
    case "other":
      return "skill";
  }
}

/** 缺口 → 一句「缺的是什么能力」（求助正文里"卡在哪"那段的宾语）。 */
export function capabilityMissingOf(gap: Pick<AffordanceGap, "missingFamily">): string {
  return `${FAMILY_ZH[gap.missingFamily]}的能力`;
}
