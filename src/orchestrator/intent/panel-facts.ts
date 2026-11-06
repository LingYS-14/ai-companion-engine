/**
 * 面板的「意图面」（F269，审计附录 C 的 P1-9/P1-10）：
 * 让她此刻**在等什么、想做什么、卡在哪**能被人直接看到，而不是只能开 CLI。
 *
 * 为什么读文件而不是问进程：插件与常驻进程是两个进程，面板只能读它们共同的数据文件。
 * 这些文件是**只读**读取——面板不许写、不许替她推进、不许把"等回音"变成"已处理"；
 * 回答问询仍是人这一侧 CLI 的事（`intent:dsh` / `intent:guardian`），面板只显示。
 *
 * 口径：所有字段都是"人话摘要"，不做判断。读不到就明说读不到（notes），
 * 绝不把"文件不存在"显示成"没有待办"——那是在替她编一个安静。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { openIntentions, parseIntentionFile } from "./intent-file.js";
import { dshInboxPath, dshReplyDir, parseDshInbox, parseDshReply, resolveDshAsk } from "./dsh-bridge.js";
import { guardianInboxPath, guardianReplyDir, readGuardianRequests } from "./persist.js";
import { parseGuardianReply } from "./guardian.js";
import { summarizeGapProbes } from "./capability-signal.js";

import type {
  PanelDshItem,
  PanelGapItem,
  PanelGuardianItem,
  PanelIntentionItem,
  PanelIntentFacts,
} from "../../ports/index.js";

/** 面板数据形状由 `src/ports/index.ts` 定义（工具层只能 import 类型）；这里只做别名，保持既有导入名。 */
export type PanelFacts = PanelIntentFacts;

export interface ReadPanelFactsInput {
  readonly dataDir: string;
  readonly characterId: string;
  readonly nowMs: number;
}

const MAX_ITEMS = 5;
const INTENT_FILE = (dataDir: string, characterId: string): string => join(dataDir, `intent-${characterId}.json`);
const GAPS_FILE = (dataDir: string, characterId: string): string => join(dataDir, `capability-gaps-${characterId}.ndjson`);

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function jsonFiles(dir: string): readonly string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function intentionsFacts(input: ReadPanelFactsInput, notes: string[]): PanelFacts["intentions"] {
  const path = INTENT_FILE(input.dataDir, input.characterId);
  const raw = readText(path);
  if (raw === null) {
    notes.push("意图表还没生成（她还没有真正浮现过意图，或这一版之前没有落盘）");
    return { open: 0, total: 0, items: [] };
  }
  const parsed = parseIntentionFile(raw);
  if (parsed.file === null) {
    notes.push("意图表读不出来（格式不对），不是「没有意图」——可能是写到一半或版本不符");
    return { open: 0, total: 0, items: [] };
  }
  const all = parsed.file.records;
  const open = openIntentions(all);
  return {
    open: open.length,
    total: all.length,
    items: open.slice(0, MAX_ITEMS).map((record) => ({
      id: record.id,
      kind: record.kind,
      goal: record.goal.length > 60 ? `${record.goal.slice(0, 59)}…` : record.goal,
      why: record.why.length > 80 ? `${record.why.slice(0, 79)}…` : record.why,
      blockedBy: record.blocked_by ?? null,
      attempts: record.attempts.length,
      status: record.status,
    })),
  };
}

function dshFacts(input: ReadPanelFactsInput, notes: string[]): PanelFacts["dsh"] {
  const inbox = dshInboxPath(input.dataDir, input.characterId);
  const raw = readText(inbox);
  if (raw === null) return { waiting: 0, items: [] };
  const parsed = parseDshInbox(raw);
  if (parsed.asks.length === 0) return { waiting: 0, items: [] };
  const replies = new Map<string, ReturnType<typeof parseDshReply>>();
  for (const file of jsonFiles(dshReplyDir(input.dataDir))) {
    const replyRaw = readText(file);
    if (replyRaw === null) continue;
    let parsedReply: unknown;
    try {
      parsedReply = JSON.parse(replyRaw);
    } catch {
      continue; // 回执文件坏了按"还没回"处理，不猜
    }
    const reply = parseDshReply(parsedReply);
    if (reply !== null) replies.set(reply.id, reply);
  }
  const waiting = parsed.asks
    .map((ask) => ({ ask, status: resolveDshAsk(ask, replies.get(ask.id) ?? null, input.nowMs).status }))
    .filter((row) => row.status === "pending" || row.status === "expired");
  if (parsed.errors.length > 0) notes.push(`DSH 收件箱有 ${parsed.errors.length} 行读不出来（坏行已跳过）`);
  return {
    waiting: waiting.length,
    items: waiting.slice(-MAX_ITEMS).map((row) => ({
      id: row.ask.id,
      kind: row.ask.kind,
      at: Date.parse(row.ask.at),
      text: row.ask.text.length > 80 ? `${row.ask.text.slice(0, 79)}…` : row.ask.text,
      expired: row.status === "expired",
    })),
  };
}

function guardianFacts(input: ReadPanelFactsInput, notes: string[]): PanelFacts["guardian"] {
  const root = resolve(input.dataDir, "..");
  const inbox = guardianInboxPath(root, input.characterId);
  const read = readGuardianRequests(inbox);
  if (!read.existed) return { waiting: 0, items: [] };
  if (read.errors.length > 0) notes.push(`监护人收件箱有 ${read.errors.length} 行读不出来（坏行已跳过）`);
  const replies = new Set<string>();
  for (const file of jsonFiles(guardianReplyDir(root))) {
    const replyRaw = readText(file);
    if (replyRaw === null) continue;
    const parsed = parseGuardianReply(replyRaw);
    if (parsed.reply === null) continue;
    replies.add(parsed.reply.requestId);
  }
  const waiting = read.requests.filter((request) => {
    if (replies.has(request.requestId)) return false;
    const at = Date.parse(request.at);
    return !Number.isFinite(at) || input.nowMs - at <= request.timeoutMs;
  });
  return {
    waiting: waiting.length,
    items: waiting.slice(-MAX_ITEMS).map((request) => ({
      requestId: request.requestId,
      what: request.what.length > 60 ? `${request.what.slice(0, 59)}…` : request.what,
      ask: request.ask.length > 60 ? `${request.ask.slice(0, 59)}…` : request.ask,
      at: Date.parse(request.at),
      timedOut: input.nowMs - Date.parse(request.at) > request.timeoutMs,
      answered: false,
    })),
  };
}

function gapFacts(input: ReadPanelFactsInput, notes: string[]): readonly PanelGapItem[] {
  const raw = readText(GAPS_FILE(input.dataDir, input.characterId));
  if (raw === null) return [];
  const sightings: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") sightings.push(parsed);
    } catch {
      // 坏行跳过：观测日志不值得让面板 500
    }
  }
  if (sightings.length === 0) return [];
  const probes = summarizeGapProbes(sightings as Parameters<typeof summarizeGapProbes>[0], input.nowMs);
  if (probes.length === 0) return [];
  return [...probes]
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, MAX_ITEMS)
    .map((probe) => ({
      key: `${probe.kind}/${probe.missingFamily}`,
      kind: probe.kind,
      missingFamily: probe.missingFamily,
      attempts: probe.attempts,
    }));
}

/** 只读汇总；任何读取失败都降级成 notes，绝不抛（面板挂掉比少显示更糟）。 */
export function readPanelFacts(input: ReadPanelFactsInput): PanelFacts {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError(`readPanelFacts: nowMs 非法：${String(input.nowMs)}`);
  }
  const notes: string[] = [];
  const intentions = intentionsFacts(input, notes);
  const dsh = dshFacts(input, notes);
  const guardian = guardianFacts(input, notes);
  const gaps = gapFacts(input, notes);
  return { intentions, dsh, guardian, gaps, notes };
}
