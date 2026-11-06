/**
 * 监护人通道（P4 求助协议的纯逻辑部分；不写文件、不读时钟、不调模型）
 *
 * 用户 2026-10-31 的原话（m04764 难点 1）：「求助的真难点不是"能不能说"，而是"说完没人回"——
 * 她给我发 QQ 时我很可能不在电脑旁边，这时就只能由你（Lead）作为其求助的对象，就类似
 * 我不在时的"监护人"。」
 *
 * 所以求助要做成**有去有回、有超时、有降频**的协议，而不是"发出去就完事"：
 *   1. 她写一份结构化请求（谁被卡住、试过什么、需要哪类帮助、希望对方做什么）；
 *   2. 请求落 `data/guardian-<characterId>.ndjson`（append-only，一行一个请求）；
 *   3. 应答方（用户或 Lead）写 `data/guardian-reply/<requestId>.json`；
 *   4. 2 小时没有应答 → 记一条 capability_fact「问过，暂无回音」，**不清零尝试次数**（缺口仍在），
 *      只降频（同缺口当天不再问、全班每天 ≤2 次，由 capability.ts 的 shouldAskHelp 把关）；
 *   5. 请求 id 是确定性的（`grd-<intentionId>-<分钟级时间戳>`），重复写同一条不会产生两条记录。
 *
 * 本文件只做"格式与状态机"，不做 IO：落盘/读盘、定时扫描、发 QQ 都在装配点（P4 接线时做）。
 * 定这样切开，是因为"她会不会在没人回的时候越问越急"是**可测的状态机**问题，不该和网络纠缠在一起。
 */

import type { HelpNeed, HelpRequest } from "./types.js";
import { HELP_NEEDS } from "./types.js";

/** 2 小时没有应答就记 capability_fact（用户原话的"没人回"）。 */
export const GUARDIAN_TIMEOUT_MS = 2 * 60 * 60_000;
/** 全局每天最多求助次数（与 capability.ts 的 ASK_HELP_GLOBAL_PER_DAY 同一条闸的两端）。 */
export const GUARDIAN_MAX_PER_DAY = 2;
/** 请求正文上限：太长会变成一篇报告，监护人读不动。 */
export const MAX_WHAT_CHARS = 200;
export const MAX_ASK_CHARS = 200;
export const MAX_NOTE_CHARS = 400;

export type GuardianTarget = "owner" | "lead";
export type GuardianVerdict = "help" | "decline" | "later";
export type GuardianState = "pending" | "answered" | "timed-out";

export interface GuardianRequest {
  /** 确定性 id：同一意图 + 同一分钟只会有一次请求 */
  readonly requestId: string;
  /** ISO 时间 */
  readonly at: string;
  readonly intentionId: string;
  /** 她卡在哪（她自己的话） */
  readonly what: string;
  /** 已经试过什么（不得为空——没有尝试的求助是撒娇，不是求助） */
  readonly tried: readonly string[];
  readonly need: HelpNeed;
  /** 希望对方做什么 */
  readonly ask: string;
  readonly timeoutMs: number;
}

export interface GuardianReply {
  readonly requestId: string;
  readonly at: string;
  readonly from: GuardianTarget;
  readonly verdict: GuardianVerdict;
  /** 对方的话（可以很短） */
  readonly note: string;
  /** verdict=later 时，最早何时可以再问（毫秒）；null/缺省 = 由调用方按默认降频 */
  readonly retryAfterMs?: number | null;
}

export interface GuardianResolution {
  readonly state: GuardianState;
  /** 有应答时的应答 */
  readonly reply: GuardianReply | null;
  /** 超时/拒绝时要写进能力事实的一句人话（null = 不必写） */
  readonly fact: string | null;
  /** 下次允许问的时间（毫秒时间戳）；null = 现在就允许（但其它闸仍要看） */
  readonly nextAskAtMs: number | null;
  /** 一行说明，给日志 */
  readonly note: string;
}

/** 确定性请求 id：同一意图 + 同一分钟重复调用得到同一个 id（幂等落盘）。 */
export function guardianRequestId(intentionId: string, atMs: number): string {
  const minute = Math.floor(atMs / 60_000);
  return `grd-${intentionId}-${String(minute)}`;
}

function requireText(name: string, value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new RangeError(`guardian: ${name} 不能为空`);
  if (trimmed.length > maxChars) throw new RangeError(`guardian: ${name} 超过 ${String(maxChars)} 字`);
  return trimmed;
}

function requireIsoTime(name: string, value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`guardian: ${name} 不是合法 ISO 时间：${value}`);
  return value;
}

/**
 * 从 `HelpRequest` 造一份可落盘的监护人请求。
 * `tried` 必须非空（§11.6.2：求助必带 tried）；不合法直接抛，不静默降级。
 */
export function buildGuardianRequest(help: HelpRequest, atIso: string, atMs: number): GuardianRequest {
  if (help.tried.length === 0) throw new RangeError("guardian: 求助必须带 tried（没有尝试过就不算求助）");
  const key = guardianRequestId(help.blockedIntentionId, atMs);
  return {
    requestId: key,
    at: requireIsoTime("at", atIso),
    intentionId: help.blockedIntentionId,
    what: requireText("what", help.what, MAX_WHAT_CHARS),
    tried: help.tried.map((item, index) => requireText(`tried[${String(index)}]`, item, MAX_WHAT_CHARS)),
    need: requireHelpNeed(help.need),
    ask: requireText("ask", help.ask, MAX_ASK_CHARS),
    timeoutMs: GUARDIAN_TIMEOUT_MS,
  };
}

function requireHelpNeed(value: string): HelpNeed {
  if (!(HELP_NEEDS as readonly string[]).includes(value)) throw new RangeError(`guardian: 不认识的 need：${value}`);
  return value as HelpNeed;
}

/** 序列化请求（键序固定，便于 diff 与人工阅读）。 */
export function serializeGuardianRequest(request: GuardianRequest): string {
  return JSON.stringify({
    requestId: request.requestId,
    at: request.at,
    intentionId: request.intentionId,
    what: request.what,
    tried: request.tried,
    need: request.need,
    ask: request.ask,
    timeoutMs: request.timeoutMs,
  });
}

/** 解析一行请求；坏行返回 errors（调用方跳过该行，不中断整个扫描）。 */
export function parseGuardianRequest(raw: string): { request: GuardianRequest | null; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { request: null, errors: ["不是合法 JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { request: null, errors: ["顶层必须是对象"] };
  }
  const record = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : "";
  const at = typeof record["at"] === "string" ? record["at"] : "";
  const intentionId = typeof record["intentionId"] === "string" ? record["intentionId"] : "";
  const what = typeof record["what"] === "string" ? record["what"] : "";
  const ask = typeof record["ask"] === "string" ? record["ask"] : "";
  const need = typeof record["need"] === "string" ? record["need"] : "";
  const tried = Array.isArray(record["tried"]) ? record["tried"].filter((item): item is string => typeof item === "string") : [];
  const timeoutMs = typeof record["timeoutMs"] === "number" ? record["timeoutMs"] : GUARDIAN_TIMEOUT_MS;

  if (requestId === "") errors.push("缺 requestId");
  if (!Number.isFinite(Date.parse(at))) errors.push("at 不是合法 ISO 时间");
  if (intentionId === "") errors.push("缺 intentionId");
  if (what === "") errors.push("缺 what");
  if (ask === "") errors.push("缺 ask");
  if (tried.length === 0) errors.push("缺 tried");
  if (!(HELP_NEEDS as readonly string[]).includes(need)) errors.push(`need 不认识：${need}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) errors.push("timeoutMs 必须是正数");
  if (errors.length > 0) return { request: null, errors };

  return {
    request: {
      requestId,
      at,
      intentionId,
      what: what.trim(),
      tried: tried.map((item) => item.trim()).filter((item) => item !== ""),
      need: need as HelpNeed,
      ask: ask.trim(),
      timeoutMs,
    },
    errors: [],
  };
}

/**
 * 回执文件名（F269）：requestId 里带 `:` 和 `/`（`grd-cap-gap:knowledge/api-29890798`），
 * 直接当文件名在 Windows 上会被当成"盘符/数据流"——写进去的内容读不回来。
 * 实测：`writeFileSync("…/grd-cap-gap:y-29891758.json")` 在 NTFS 上生成的是
 * 名为 `grd-cap-gap` 的文件 + 一个名叫 `y-29891758.json` 的备用数据流，
 * 默认流是空的 → 她永远等不到回音（与 F254 的 dshAskId 同一类坑）。
 *
 * 所以文件名只留 `[A-Za-z0-9_-]`，再拼 8 位哈希防撞（两个 id 只差标点时不会落到同一文件）。
 * 文件内容里仍保留原始 requestId，读取方按内容配对，不看文件名。
 */
export function guardianReplyFileName(requestId: string): string {
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new RangeError("guardianReplyFileName: requestId 不能为空");
  }
  const safe = requestId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return `${safe}-${hash8(requestId)}`;
}

/** FNV-1a 32 位（8 位十六进制）：只用来防文件名撞，不做安全用途。 */
function hash8(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 解析应答方写出的 JSON；坏文件返回 errors（调用方当作"还没回"）。 */
export function parseGuardianReply(raw: string): { reply: GuardianReply | null; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: null, errors: ["不是合法 JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reply: null, errors: ["顶层必须是对象"] };
  }
  const record = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : "";
  const at = typeof record["at"] === "string" ? record["at"] : "";
  const from = record["from"];
  const verdict = record["verdict"];
  const note = typeof record["note"] === "string" ? record["note"] : "";
  const retryAfterMsRaw = record["retryAfterMs"];

  if (requestId === "") errors.push("缺 requestId");
  if (!Number.isFinite(Date.parse(at))) errors.push("at 不是合法 ISO 时间");
  if (from !== "owner" && from !== "lead") errors.push("from 必须是 owner | lead");
  if (verdict !== "help" && verdict !== "decline" && verdict !== "later") errors.push("verdict 必须是 help | decline | later");
  if (note.trim() === "") errors.push("note 不能为空（哪怕只写一句「现在不行」）");
  if (note.length > MAX_NOTE_CHARS) errors.push(`note 超过 ${String(MAX_NOTE_CHARS)} 字`);
  let retryAfterMs: number | null = null;
  if (retryAfterMsRaw !== undefined && retryAfterMsRaw !== null) {
    if (typeof retryAfterMsRaw !== "number" || !Number.isFinite(retryAfterMsRaw) || retryAfterMsRaw < 0) {
      errors.push("retryAfterMs 必须是非负有限数或 null");
    } else {
      retryAfterMs = retryAfterMsRaw;
    }
  }
  if (errors.length > 0) return { reply: null, errors };

  return {
    reply: {
      requestId,
      at,
      from: from as GuardianTarget,
      verdict: verdict as GuardianVerdict,
      note: note.trim(),
      retryAfterMs,
    },
    errors: [],
  };
}

/**
 * 把"请求 + 应答（可能没有）+ 现在几点"归约成状态。
 * 规则：
 *   - 有应答且 requestId 对得上 → answered；verdict=help 时不再限制；decline/later 都降频；
 *   - 没有应答且未超时 → pending；nextAskAtMs=created+timeout（等这一轮结束再问，不连环催）；
 *   - 超时 → timed-out，写 capability_fact「问过，暂无回音」，不把 attempts 清零（缺口没消失），
 *     nextAskAtMs = created+timeout+24h（降频，但明天还可以问）。
 */
export function resolveGuardian(
  request: GuardianRequest,
  reply: GuardianReply | null,
  nowMs: number,
): GuardianResolution {
  const requestAtMs = Date.parse(request.at);
  if (!Number.isFinite(requestAtMs)) throw new RangeError(`guardian: 请求时间非法：${request.at}`);

  if (reply !== null) {
    if (reply.requestId !== request.requestId) {
      throw new RangeError(`guardian: 应答 requestId 不匹配（期望 ${request.requestId}，收到 ${reply.requestId}）`);
    }
    if (reply.verdict === "help") {
      return { state: "answered", reply, fact: null, nextAskAtMs: null, note: "监护人已回应：可以继续" };
    }
    const replyAtMs = Date.parse(reply.at);
    const retryAfter = reply.retryAfterMs ?? GUARDIAN_TIMEOUT_MS;
    const nextAskAtMs = (Number.isFinite(replyAtMs) ? replyAtMs : nowMs) + retryAfter;
    return {
      state: "answered",
      reply,
      fact: reply.verdict === "decline" ? `问过「${request.ask}」，对方暂时帮不了：${reply.note}` : null,
      nextAskAtMs,
      note: reply.verdict === "decline" ? "监护人明确拒绝：记一句事实，别反复问" : "监护人让等一等：按 retryAfter 降频",
    };
  }

  const deadline = requestAtMs + request.timeoutMs;
  if (nowMs < deadline) {
    return { state: "pending", reply: null, fact: null, nextAskAtMs: deadline, note: "还在等回应" };
  }
  return {
    state: "timed-out",
    reply: null,
    fact: "问过，暂无回音",
    nextAskAtMs: deadline + 24 * 60 * 60_000,
    note: "超时没人回：写 capability_fact，不清零尝试次数，只降频",
  };
}

/**
 * 该把求助发给谁：用户（owner）最近活跃 → 发给他；否则交给 Lead 当监护人。
 * `ownerIdleThresholdMs` 缺省 30 分钟——他多半不在电脑旁时，请求不该躺在 QQ 里等两小时。
 */
export function chooseGuardianTarget(input: {
  readonly nowMs: number;
  /** 用户最后一次真实活动（发消息/回复）的毫秒时间；null = 从未互动 */
  readonly ownerLastActiveMs: number | null;
  readonly ownerIdleThresholdMs?: number;
}): GuardianTarget {
  if (input.ownerLastActiveMs === null) return "lead";
  const threshold = input.ownerIdleThresholdMs ?? 30 * 60_000;
  if (!Number.isFinite(input.ownerLastActiveMs)) return "lead";
  return input.nowMs - input.ownerLastActiveMs <= threshold ? "owner" : "lead";
}

/** 一条给人看的请求摘要（用于写进 QQ / 日志；不含内部 id 细节）。 */
export function describeGuardianRequest(request: GuardianRequest): string {
  return `【求助】${request.what}｜试过：${request.tried.join("、")}｜需要：${request.need}｜希望你：${request.ask}`;
}
