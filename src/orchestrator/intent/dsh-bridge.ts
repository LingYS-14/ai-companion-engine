/**
 * DSH 双向桥（方向二）：她 → DSH。
 *
 * 为什么需要：她现在的求助只能写 `data/guardian-<id>.ndjson`（监护人通道），
 * 那条通道的人是我、写回执的也是我；但用户说的是「DSH 插件不是她的一个工具吗，
 * dsh 可以检测她的情况，她可以调用 DSH，用于 help 等方面」。所以要把 DSH
 * 当成一个**真实的通信对端**：她写请求、DSH 侧读并回执，而不是只能对着空气喊。
 *
 * 与监护人通道的分工（写在 PLAN §2.6）：
 *   DSH inbox = 她随手可用的求助/提醒/观察请求（有 TTL，超时也如实记"暂无回音"）；
 *   guardian   = 超过 2 小时没回应时升级到人这一侧的通道（用户 / Lead 当监护人）。
 *
 * 这一层只做**数据形状**：不读时钟、不读盘、不发消息、不调模型。
 * 装配点决定什么时候写、什么时候读。
 */

import { formatUtc } from "./episode.js";

/** 文件里每一行的版本号，便于以后加字段时 fail-closed。 */
export const DSH_INBOX_VERSION = 1;

/** 请求最多挂多久（2 小时）；超过后解析为 expired，并升级到监护人通道。 */
export const DSH_TIMEOUT_MS = 2 * 60 * 60_000;

/** 一条请求最多说多少字：求助要说清，但不应把整段提示词倒进去。 */
export const MAX_ASK_CHARS = 300;
/** 每条"我试过"最多多少字。 */
export const MAX_TRIED_CHARS = 200;
/** "我试过"最多几条。 */
export const MAX_TRIED_ITEMS = 5;
/** 回执正文上限。 */
export const MAX_ANSWER_CHARS = 500;

export type DshAskKind = "observe" | "help" | "notify";
export const DSH_ASK_KINDS: readonly DshAskKind[] = ["observe", "help", "notify"];

export type DshReplyVerdict = "answered" | "declined" | "later";
export const DSH_REPLY_VERDICTS: readonly DshReplyVerdict[] = ["answered", "declined", "later"];

export type DshAskStatus = "pending" | "answered" | "declined" | "later" | "expired";

export interface DshAsk {
  /** 幂等 id：同一意图同一分钟只写一条 */
  readonly id: string;
  /** 原始意图 id（超时升级到 guardian 时要用它，不能只留派生的 dsh id） */
  readonly intentionId: string;
  /** 秒级 UTC ISO */
  readonly at: string;
  readonly kind: DshAskKind;
  /** 想请对方做什么（第一人称，说清楚） */
  readonly text: string;
  /** 已经试过哪些办法（不编造；空数组表示没试过/不需要） */
  readonly tried: readonly string[];
  /** 超时时间（秒级 UTC ISO） */
  readonly expiresAt: string;
}

export interface DshReply {
  readonly id: string;
  /** 谁回的：owner / lead / dsh */
  readonly by: string;
  readonly at: string;
  readonly verdict: DshReplyVerdict;
  readonly answer: string;
}

/** `<dataDir>/dsh-inbox-<id>.ndjson` */
export function dshInboxPath(dataDir: string, characterId: string): string {
  return `${dataDir}/dsh-inbox-${characterId}.ndjson`;
}

/** `<dataDir>/dsh-reply` */
export function dshReplyDir(dataDir: string): string {
  return `${dataDir}/dsh-reply`;
}

/** `<dataDir>/dsh-facts-<id>.ndjson`：她读到的回执落成的事实（供记忆/审计） */
export function dshFactsPath(dataDir: string, characterId: string): string {
  return `${dataDir}/dsh-facts-${characterId}.ndjson`;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** 秒级 UTC ISO（复用 episode.ts 的纯算术格式化；时钟纪律：读系统时间只允许在 clock.ts）。 */
function isoSecond(atMs: number): string {
  return formatUtc(Math.floor(atMs / 1000) * 1000);
}

/** 幂等 id：`dsh-<intentionId>-<分钟>`；非法字符清掉，避免路径/文件名出事。 */
export function dshAskId(intentionId: string, atMs: number): string {
  if (!isFiniteNumber(atMs)) throw new RangeError("atMs 必须是有限数");
  const trimmed = intentionId.trim();
  if (trimmed.length === 0) throw new RangeError("intentionId 不能为空");
  // id 会被当成文件名（data/dsh-reply/<id>.json），所以字符集里不能有 Windows 不允许的 `:`（F254）。
  const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return `dsh-${safe}-${String(Math.floor(atMs / 60_000))}`;
}

export interface BuildDshAskInput {
  readonly intentionId: string;
  readonly atMs: number;
  readonly kind: DshAskKind;
  readonly text: string;
  readonly tried?: readonly string[];
}

/** 造一条请求；非法输入抛 RangeError（宁可不写，也不写坏行）。 */
export function buildDshAsk(input: BuildDshAskInput): DshAsk {
  if (!isFiniteNumber(input.atMs)) throw new RangeError("atMs 必须是有限数");
  if (!DSH_ASK_KINDS.includes(input.kind)) throw new RangeError(`未知 kind：${String(input.kind)}`);
  const text = input.text.trim();
  if (text.length === 0) throw new RangeError("text 不能为空");
  if (text.length > MAX_ASK_CHARS) throw new RangeError(`text 超过 ${String(MAX_ASK_CHARS)} 字`);
  const tried = (input.tried ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (tried.length > MAX_TRIED_ITEMS) throw new RangeError(`tried 最多 ${String(MAX_TRIED_ITEMS)} 条`);
  for (const t of tried) {
    if (t.length > MAX_TRIED_CHARS) throw new RangeError(`tried 单条超过 ${String(MAX_TRIED_CHARS)} 字`);
  }
  return {
    id: dshAskId(input.intentionId, input.atMs),
    intentionId: input.intentionId.trim(),
    at: isoSecond(input.atMs),
    kind: input.kind,
    text,
    tried,
    expiresAt: isoSecond(input.atMs + DSH_TIMEOUT_MS),
  };
}

export function serializeDshAsk(ask: DshAsk): string {
  return JSON.stringify({
    version: DSH_INBOX_VERSION,
    id: ask.id,
    intentionId: ask.intentionId,
    at: ask.at,
    kind: ask.kind,
    text: ask.text,
    tried: [...ask.tried],
    expiresAt: ask.expiresAt,
  });
}

function parseIsoSecond(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** 解析一行；形状不对返回 null（调用方计数，不抛错、不吞好行）。 */
export function parseDshAsk(raw: unknown): DshAsk | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.version !== DSH_INBOX_VERSION) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.intentionId !== "string" || v.intentionId.trim().length === 0) return null;
  if (!DSH_ASK_KINDS.includes(v.kind as DshAskKind)) return null;
  if (typeof v.text !== "string" || v.text.length === 0 || v.text.length > MAX_ASK_CHARS) return null;
  const atMs = parseIsoSecond(v.at);
  const expiresMs = parseIsoSecond(v.expiresAt);
  if (atMs === null || expiresMs === null || expiresMs <= atMs) return null;
  if (!Array.isArray(v.tried) || v.tried.length > MAX_TRIED_ITEMS) return null;
  const tried: string[] = [];
  for (const t of v.tried) {
    if (typeof t !== "string" || t.length === 0 || t.length > MAX_TRIED_CHARS) return null;
    tried.push(t);
  }
  return {
    id: v.id,
    intentionId: v.intentionId.trim(),
    at: isoSecond(atMs),
    kind: v.kind as DshAskKind,
    text: v.text,
    tried,
    expiresAt: isoSecond(expiresMs),
  };
}

/** 解析整份 inbox（逐行），坏行计入 errors。 */
export function parseDshInbox(text: string): { asks: DshAsk[]; errors: string[] } {
  const asks: DshAsk[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`第 ${String(index + 1)} 行不是 JSON`);
      return;
    }
    const ask = parseDshAsk(raw);
    if (ask === null) errors.push(`第 ${String(index + 1)} 行形状不对`);
    else asks.push(ask);
  });
  return { asks, errors };
}

export interface BuildDshReplyInput {
  readonly id: string;
  readonly atMs: number;
  readonly by: string;
  readonly verdict: DshReplyVerdict;
  readonly answer?: string;
}

/** 造一条回执（DSH 侧写）；非法输入抛 RangeError。 */
export function buildDshReply(input: BuildDshReplyInput): DshReply {
  if (typeof input.id !== "string" || !input.id.startsWith("dsh-")) throw new RangeError("id 必须是 dsh- 开头");
  if (!isFiniteNumber(input.atMs)) throw new RangeError("atMs 必须是有限数");
  if (!DSH_REPLY_VERDICTS.includes(input.verdict)) throw new RangeError(`未知 verdict：${String(input.verdict)}`);
  const by = input.by.trim();
  if (by.length === 0) throw new RangeError("by 不能为空");
  const answer = (input.answer ?? "").trim();
  if (answer.length > MAX_ANSWER_CHARS) throw new RangeError(`answer 超过 ${String(MAX_ANSWER_CHARS)} 字`);
  return { id: input.id, by, at: isoSecond(input.atMs), verdict: input.verdict, answer };
}

export function serializeDshReply(reply: DshReply): string {
  return JSON.stringify({ id: reply.id, by: reply.by, at: reply.at, verdict: reply.verdict, answer: reply.answer });
}

export function parseDshReply(raw: unknown): DshReply | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id.startsWith("dsh-")) return null;
  if (!DSH_REPLY_VERDICTS.includes(v.verdict as DshReplyVerdict)) return null;
  if (typeof v.by !== "string" || v.by.trim().length === 0) return null;
  const atMs = parseIsoSecond(v.at);
  if (atMs === null) return null;
  if (typeof v.answer !== "string" || v.answer.length > MAX_ANSWER_CHARS) return null;
  return { id: v.id, by: v.by.trim(), at: isoSecond(atMs), verdict: v.verdict as DshReplyVerdict, answer: v.answer };
}

export interface DshResolution {
  readonly ask: DshAsk;
  readonly status: DshAskStatus;
  /** 该记住的一句事实；pending 时为 null（还没结果就不编事实） */
  readonly fact: string | null;
}

/**
 * 把请求与回执配对。
 *
 * - 有回执：answered / declined / later；
 * - 没回执且未超时：pending（fact=null）；
 * - 没回执且已超时：expired，fact=「问过，暂无回音」（与监护人通道同一句话，不让两套措辞打架）。
 */
export function resolveDshAsk(ask: DshAsk, reply: DshReply | null, nowMs: number): DshResolution {
  if (!isFiniteNumber(nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (reply !== null) {
    const label = reply.verdict === "answered" ? "回我了" : reply.verdict === "declined" ? "帮不了" : "说稍后";
    const body = reply.answer.length === 0 ? "" : `：${reply.answer}`;
    return { ask, status: reply.verdict, fact: `DSH ${label}${body}` };
  }
  const expiresMs = Date.parse(ask.expiresAt);
  if (nowMs >= expiresMs) return { ask, status: "expired", fact: "问过，暂无回音" };
  return { ask, status: "pending", fact: null };
}

/** 给她看的一行摘要（日志用，不复述全文）。 */
export function describeDshAsk(ask: DshAsk): string {
  return `DSH 请求 ${ask.id}（${ask.kind}）：${ask.text.slice(0, 40)}${ask.text.length > 40 ? "…" : ""}`;
}

/* ------------------------------------------------------------------ *
 * 事实落盘（她"读到"的回执，会进记忆/上下文）
 *
 * 为什么单独一层：回执文件是人写的，可能被覆盖、删除、写坏；她记进记忆的
 * 应该是"当时读到了什么"，而不是"现在文件里是什么"。所以回执解析一次就落一条事实，
 * 之后只读事实文件，且按 id 去重——同一件事不能被重复记住。
 * ------------------------------------------------------------------ */

export const DSH_FACT_VERSION = 1;

export interface DshFactLine {
  readonly id: string;
  /** 请求时间（秒级 UTC ISO） */
  readonly at: string;
  readonly status: DshAskStatus;
  /** 她会记住的那句话（pending 时不会落盘） */
  readonly fact: string;
  readonly recordedAtMs: number;
}

/** 把一次已定的读（非 pending）落成一行事实；pending 不写（没结果不编事实）。 */
export function serializeDshFact(resolution: DshResolution, recordedAtMs: number): string {
  if (!isFiniteNumber(recordedAtMs)) throw new RangeError("recordedAtMs 必须是有限数");
  if (resolution.fact === null) throw new RangeError("pending 状态没有事实可落");
  return JSON.stringify({
    version: DSH_FACT_VERSION,
    id: resolution.ask.id,
    at: resolution.ask.at,
    status: resolution.status,
    fact: resolution.fact,
    recordedAtMs,
  });
}

/** 解析整份事实文件；坏行计入 errors，不吞好行。 */
export function parseDshFactLines(text: string): { facts: DshFactLine[]; errors: string[] } {
  const facts: DshFactLine[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`第 ${String(index + 1)} 行不是 JSON`);
      return;
    }
    if (typeof raw !== "object" || raw === null) {
      errors.push(`第 ${String(index + 1)} 行不是对象`);
      return;
    }
    const v = raw as Record<string, unknown>;
    if (v.version !== DSH_FACT_VERSION) {
      errors.push(`第 ${String(index + 1)} 行版本不对`);
      return;
    }
    if (typeof v.id !== "string" || v.id.length === 0 || typeof v.at !== "string") {
      errors.push(`第 ${String(index + 1)} 行缺 id/at`);
      return;
    }
    if (!["answered", "declined", "later", "expired"].includes(String(v.status))) {
      errors.push(`第 ${String(index + 1)} 行 status 不对`);
      return;
    }
    if (typeof v.fact !== "string" || v.fact.length === 0) {
      errors.push(`第 ${String(index + 1)} 行缺 fact`);
      return;
    }
    if (!isFiniteNumber(v.recordedAtMs)) {
      errors.push(`第 ${String(index + 1)} 行 recordedAtMs 不对`);
      return;
    }
    facts.push({
      id: v.id,
      at: v.at,
      status: v.status as DshAskStatus,
      fact: v.fact,
      recordedAtMs: v.recordedAtMs,
    });
  });
  return { facts, errors };
}

/** 已经落过事实的 id 集合（按 id 去重，避免重复记同一件事）。 */
export function recordedDshIds(text: string): Set<string> {
  return new Set(parseDshFactLines(text).facts.map((f) => f.id));
}
