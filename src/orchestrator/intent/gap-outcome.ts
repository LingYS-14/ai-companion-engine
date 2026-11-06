/**
 * 求助的「答完之后」：同一个能力缺口问过之后，还该不该再问。
 *
 * 为什么需要它：F209 把缺口推进了监护人收件箱，但**没有人读回执**——于是同一个缺口
 * 每天都会重新排队（F209 的 24h 窗口只能挡一天），而「对方说了帮不了」这件事在系统里
 * 完全不存在。这个文件只做一件事：把「这个缺口上次问的结果」翻译成「下次最早什么时候还能问」。
 *
 * 三条纪律：
 *   1. 不读时钟、不读文件：请求/应答/历史由调用方读好传进来（和 guardian.ts / persist.ts 同口径）。
 *   2. 坏数据不假装没事：历史里有 requestId 但收件箱里找不到原文，按「还在等」处理，不重新问。
 *   3. 拒绝不无限期封死：`decline` 降频 7 天而不是永久——人的拒绝会变，但不变的是一天内别烦两次。
 */

import { resolveGuardian, GUARDIAN_TIMEOUT_MS, type GuardianReply, type GuardianRequest } from "./guardian.js";
import type { AskHistoryEntry } from "./ask-help.js";

const DAY_MS = 86_400_000;
/** 对方明确拒绝后，同一个缺口至少冷却这么久（不是永久，但也不是明天再来）。 */
export const GAP_DECLINED_RETRY_MS = 7 * DAY_MS;
/** 对方答应帮忙后，同一缺口先安静这么久等能力落地（不再追问"我的工具呢"）。 */
export const GAP_HELPED_COOLDOWN_MS = 14 * DAY_MS;

export type GapAskState = "never_asked" | "waiting" | "helped" | "declined" | "later" | "timed_out";

export interface GapAskOutcome {
  readonly intentionId: string;
  /** 最近一次求助的 requestId；从没问过为 null */
  readonly requestId: string | null;
  readonly state: GapAskState;
  /** 最近一次求助的时间；从没问过为 null */
  readonly askedAtMs: number | null;
  /** 下次最早可以再问的时间；null = 没有额外限制（仍要过 ask-help 自己的闸） */
  readonly nextAskAtMs: number | null;
  /** 一行说明（给日志，不写"没事"这种空话） */
  readonly note: string;
}

export interface GapAskInput {
  readonly intentionId: string;
  readonly history: readonly AskHistoryEntry[];
  readonly requests: readonly GuardianRequest[];
  readonly replies: readonly GuardianReply[];
  readonly nowMs: number;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`gapAskOutcome: ${name} 非法：${String(value)}`);
}

/** 找该意图最近一次求助（同意图多次求助时只看最新那条）。 */
function latestHistoryFor(intentionId: string, history: readonly AskHistoryEntry[]): AskHistoryEntry | null {
  let latest: AskHistoryEntry | null = null;
  for (const entry of history) {
    if (entry === null || typeof entry !== "object") continue;
    if (entry.intentionId !== intentionId) continue;
    if (!Number.isFinite(entry.askedAtMs)) continue;
    if (latest === null || entry.askedAtMs > latest.askedAtMs) latest = entry;
  }
  return latest;
}

function latestReplyFor(requestId: string, replies: readonly GuardianReply[]): GuardianReply | null {
  let latest: GuardianReply | null = null;
  for (const reply of replies) {
    if (reply === null || typeof reply !== "object") continue;
    if (reply.requestId !== requestId) continue;
    if (latest === null) {
      latest = reply;
      continue;
    }
    // 同一条请求被回了两次（人手滑）时，取更晚的那次
    const prev = Date.parse(latest.at);
    const next = Date.parse(reply.at);
    if (Number.isFinite(next) && (!Number.isFinite(prev) || next > prev)) latest = reply;
  }
  return latest;
}

/** 一个缺口上次求助的结局。 */
export function gapAskOutcome(input: GapAskInput): GapAskOutcome {
  requireFinite("nowMs", input.nowMs);
  const entry = latestHistoryFor(input.intentionId, input.history);
  if (entry === null) {
    return {
      intentionId: input.intentionId,
      requestId: null,
      state: "never_asked",
      askedAtMs: null,
      nextAskAtMs: null,
      note: "还没问过",
    };
  }
  const request = input.requests.find((item) => item.requestId === entry.requestId) ?? null;
  if (request === null) {
    // 历史在、原文不在（可能被清理）：不重新问，按「还在等」处理，避免把同一件事再喊一遍
    return {
      intentionId: input.intentionId,
      requestId: entry.requestId,
      state: "waiting",
      askedAtMs: entry.askedAtMs,
      nextAskAtMs: null,
      note: "求助记录还在，但找不到请求原文；按还在等处理，不重复问",
    };
  }
  const reply = latestReplyFor(entry.requestId, input.replies);
  const resolution = resolveGuardian(request, reply, input.nowMs);
  if (resolution.state === "pending") {
    return {
      intentionId: input.intentionId,
      requestId: entry.requestId,
      state: "waiting",
      askedAtMs: entry.askedAtMs,
      nextAskAtMs: null,
      note: "已投递，等回音（超时后会自动降频）",
    };
  }
  if (resolution.state === "timed-out") {
    return {
      intentionId: input.intentionId,
      requestId: entry.requestId,
      state: "timed_out",
      askedAtMs: entry.askedAtMs,
      nextAskAtMs: resolution.nextAskAtMs ?? entry.askedAtMs + GUARDIAN_TIMEOUT_MS + 24 * 60 * 60_000,
      note: resolution.note,
    };
  }
  const verdict = reply?.verdict ?? null;
  if (verdict === "help") {
    return {
      intentionId: input.intentionId,
      requestId: entry.requestId,
      state: "helped",
      askedAtMs: entry.askedAtMs,
      nextAskAtMs: (Number.isFinite(Date.parse(reply?.at ?? "")) ? Date.parse(reply?.at ?? "") : input.nowMs) + GAP_HELPED_COOLDOWN_MS,
      note: "对方答应帮忙：先安静等能力落地，不再追问",
    };
  }
  if (verdict === "decline") {
    const replyAtMs = Date.parse(reply?.at ?? "");
    const base = Number.isFinite(replyAtMs) ? replyAtMs : entry.askedAtMs;
    return {
      intentionId: input.intentionId,
      requestId: entry.requestId,
      state: "declined",
      askedAtMs: entry.askedAtMs,
      nextAskAtMs: Math.max(base + GAP_DECLINED_RETRY_MS, resolution.nextAskAtMs ?? 0),
      note: "对方明确拒绝：冷却 7 天，不反复问",
    };
  }
  // later：按对方给的时间等
  return {
    intentionId: input.intentionId,
    requestId: entry.requestId,
    state: "later",
    askedAtMs: entry.askedAtMs,
    nextAskAtMs: resolution.nextAskAtMs ?? entry.askedAtMs + GUARDIAN_TIMEOUT_MS,
    note: resolution.note,
  };
}

/** 这个结局允许现在再问吗（只回答"回执这一侧"的问题，额度/静默等硬闸不在这里）。 */
export function canAskAgain(outcome: GapAskOutcome, nowMs: number): { allowed: boolean; reason: string } {
  requireFinite("nowMs", nowMs);
  if (outcome.state === "never_asked") return { allowed: true, reason: "还没问过" };
  if (outcome.state === "waiting") return { allowed: false, reason: outcome.note };
  const next = outcome.nextAskAtMs;
  if (next !== null && nowMs < next) {
    const minutes = Math.ceil((next - nowMs) / 60_000);
    return { allowed: false, reason: `${outcome.note}（还要等约 ${String(minutes)} 分钟）` };
  }
  return { allowed: true, reason: `${outcome.note}；已过冷却，可以再问` };
}
