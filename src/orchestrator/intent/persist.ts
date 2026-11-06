/**
 * P4 落盘胶水：把能力账本、求助历史、监护人请求/应答真正写到 `data/` 下。
 *
 * 这一层是"纯逻辑"与"她的运行时"之间的缝：上面的 `ledger-file.ts` / `guardian.ts` /
 * `ask-help.ts` 都只算不写（所以能在测试里钉死），这一层只写不算（所以不需要模型、不读时钟）。
 *
 * 三条纪律：
 *   1. 所有时间由调用方传入（`nowMs` / `savedAtMs`）——本文件不读系统时钟，才能被重放；
 *   2. 所有写盘走"临时文件 + rename"——断电时宁可丢这一次写入，也不要留下半截 JSON；
 *   3. 读不到 / 读到坏文件时**返回错误、不编默认值**——账本坏了就说坏了，不能悄悄当成空账本。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCapabilityLedger, serializeCapabilityLedger } from "./ledger-file.js";
import {
  guardianReplyFileName,
  parseGuardianReply,
  parseGuardianRequest,
  resolveGuardian,
  serializeGuardianRequest,
  type GuardianReply,
  type GuardianRequest,
  type GuardianResolution,
} from "./guardian.js";
import type { AskHistoryEntry } from "./ask-help.js";
import type { CapabilityRecord } from "./types.js";

/** 与 `QUARANTINE_MS` 保持一致：观察满 24 小时才允许转正。 */
export const PROMOTE_AFTER_MS = 86_400_000;

// ── 路径（全部相对仓库/运行时根；调用方传根，本文件不猜 cwd） ──

export function capabilityLedgerPath(root: string, characterId: string): string {
  return join(root, "data", `capability-${characterId}.json`);
}

export function askHistoryPath(root: string, characterId: string): string {
  return join(root, "data", `ask-history-${characterId}.json`);
}

/** 监护人收件箱：一行一条请求（ndjson），追加写，便于人在外面 tail。 */
export function guardianInboxPath(root: string, characterId: string): string {
  return join(root, "data", `guardian-${characterId}.ndjson`);
}

/** 监护人应答目录：一条应答一个 `<requestId>.json`，Lead/用户写在这里。 */
export function guardianReplyDir(root: string): string {
  return join(root, "data", "guardian-reply");
}

// ── 原子写 ──

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

// ── 能力账本 ──

export interface CapabilityLedgerRead {
  /** 解析失败时为 null（不返回"空账本"——空账本会把"文件坏了"伪装成"还没有能力"） */
  readonly records: readonly CapabilityRecord[] | null;
  readonly errors: readonly string[];
  readonly existed: boolean;
}

export function readCapabilityLedgerFile(path: string): CapabilityLedgerRead {
  if (!existsSync(path)) return { records: [], errors: [], existed: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { records: null, errors: [`读不到能力账本：${err instanceof Error ? err.message : String(err)}`], existed: true };
  }
  const parsed = parseCapabilityLedger(raw);
  return { records: parsed.records, errors: parsed.errors, existed: true };
}

export function writeCapabilityLedgerFile(
  path: string,
  records: readonly CapabilityRecord[],
  savedAtMs: number,
): void {
  writeAtomic(path, serializeCapabilityLedger(records, savedAtMs));
}

export interface PromotionResult {
  readonly records: readonly CapabilityRecord[];
  /** 这次转正的 capId（空数组 = 没有到期的，不是"转正失败"） */
  readonly promoted: readonly string[];
}

/**
 * 把观察期满、且效力确实变好的隔离记录转正。**幂等**：已经 active 的记录不会被再次算进来。
 */
export function promoteDueRecords(records: readonly CapabilityRecord[], nowMs: number): PromotionResult {
  const promoted: string[] = [];
  const next = records.map((record) => {
    if (record.status !== "quarantined") return record;
    if (record.effectivityAfter <= record.effectivityBefore) return record;
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created)) return record;
    if (nowMs - created < PROMOTE_AFTER_MS) return record;
    promoted.push(record.capId);
    return { ...record, status: "active" as const };
  });
  return { records: next, promoted };
}

// ── 求助历史（24 小时窗口由调用方用 pruneAskHistory 裁） ──

export interface AskHistoryRead {
  readonly entries: readonly AskHistoryEntry[];
  readonly errors: readonly string[];
  readonly existed: boolean;
}

function isAskHistoryEntry(value: unknown): value is AskHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.requestId === "string" &&
    entry.requestId !== "" &&
    typeof entry.intentionId === "string" &&
    entry.intentionId !== "" &&
    typeof entry.askedAtMs === "number" &&
    Number.isFinite(entry.askedAtMs) &&
    entry.askedAtMs >= 0
  );
}

export function readAskHistory(path: string): AskHistoryRead {
  if (!existsSync(path)) return { entries: [], errors: [], existed: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { entries: [], errors: [`读不到求助历史：${err instanceof Error ? err.message : String(err)}`], existed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], errors: ["求助历史不是合法 JSON"], existed: true };
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return { entries: [], errors: ["求助历史缺少 entries 数组"], existed: true };
  const entries: AskHistoryEntry[] = [];
  const errors: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (isAskHistoryEntry(item)) entries.push(item);
    else errors.push(`第 ${index + 1} 条求助记录形状不合法`);
  }
  return { entries, errors, existed: true };
}

export function writeAskHistory(path: string, entries: readonly AskHistoryEntry[]): void {
  writeAtomic(path, `${JSON.stringify({ version: 1, entries: entries.map(toPlainEntry) }, null, 2)}\n`);
}

function toPlainEntry(entry: AskHistoryEntry): AskHistoryEntry {
  return { requestId: entry.requestId, intentionId: entry.intentionId, askedAtMs: entry.askedAtMs };
}

/** 只保留窗口内的记录：老记录不删会让"同缺口只问一次"变成永久封口。 */
export function pruneAskHistory(
  entries: readonly AskHistoryEntry[],
  nowMs: number,
  windowMs: number,
): readonly AskHistoryEntry[] {
  return entries.filter((entry) => nowMs - entry.askedAtMs < windowMs);
}

// ── 监护人：请求追加写、应答按文件收 ──

export function appendGuardianRequest(path: string, request: GuardianRequest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${serializeGuardianRequest(request)}\n`, { encoding: "utf8", flag: "a" });
}

export interface GuardianRequestsRead {
  readonly requests: readonly GuardianRequest[];
  readonly errors: readonly string[];
  readonly existed: boolean;
}

export function readGuardianRequests(path: string): GuardianRequestsRead {
  if (!existsSync(path)) return { requests: [], errors: [], existed: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { requests: [], errors: [`读不到监护人收件箱：${err instanceof Error ? err.message : String(err)}`], existed: true };
  }
  const requests: GuardianRequest[] = [];
  const errors: string[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") continue;
    const parsed = parseGuardianRequest(line);
    if (parsed.request === null) errors.push(`第 ${index + 1} 行：${parsed.errors.join("；") || "形状不合法"}`);
    else requests.push(parsed.request);
  }
  return { requests, errors, existed: true };
}

export function writeGuardianReply(replyDir: string, reply: GuardianReply): string {
  const path = join(replyDir, `${guardianReplyFileName(reply.requestId)}.json`);
  writeAtomic(path, `${JSON.stringify(reply, null, 2)}\n`);
  return path;
}

export interface GuardianRepliesRead {
  readonly replies: readonly GuardianReply[];
  readonly errors: readonly string[];
}

export function readGuardianReplies(replyDir: string): GuardianRepliesRead {
  if (!existsSync(replyDir)) return { replies: [], errors: [] };
  const replies: GuardianReply[] = [];
  const errors: string[] = [];
  for (const name of readdirSync(replyDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(replyDir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      errors.push(`${name}：读不到（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    const parsed = parseGuardianReply(raw);
    if (parsed.reply === null) errors.push(`${name}：${parsed.errors.join("；") || "形状不合法"}`);
    else replies.push(parsed.reply);
  }
  return { replies, errors };
}

/** 把收件箱里的请求逐条对到应答（没有应答的走 pending/超时判定）。 */
export function resolveGuardianRequests(
  requests: readonly GuardianRequest[],
  replies: readonly GuardianReply[],
  nowMs: number,
): readonly GuardianResolution[] {
  const byId = new Map(replies.map((reply) => [reply.requestId, reply]));
  return requests.map((request) => resolveGuardian(request, byId.get(request.requestId) ?? null, nowMs));
}

export function removeGuardianReply(replyDir: string, requestId: string): void {
  const path = join(replyDir, `${guardianReplyFileName(requestId)}.json`);
  if (existsSync(path)) rmSync(path, { force: true });
}
