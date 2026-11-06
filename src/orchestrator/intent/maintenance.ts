/**
 * P4 落盘接线：把"每晚该做的维护"收成一个入口。
 *
 * 为什么要有这一层：`persist.ts` 只会读写单个文件，`review.ts`/`forge.ts`/`probe.ts`
 * 只会算，`guardian.ts` 只会判定状态——但**没有人把它们按顺序接起来**，
 * 于是账本不会转正、求助窗口不会裁、监护人超时的"问过，暂无回音"永远落不了库。
 * 这个文件就是那根线：一次调用，把该做的做完，把做了什么说清楚。
 *
 * 纪律：本层不调模型、不碰运行时状态、不决定"要不要做某件事"（那是编排层的活）；
 * 只做三类幂等维护：能力转正 / 求助窗口裁剪 / 监护人事实落盘。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  askHistoryPath,
  capabilityLedgerPath,
  guardianInboxPath,
  guardianReplyDir,
  promoteDueRecords,
  pruneAskHistory,
  readAskHistory,
  readCapabilityLedgerFile,
  readGuardianReplies,
  readGuardianRequests,
  resolveGuardianRequests,
  writeAskHistory,
  writeCapabilityLedgerFile,
} from "./persist.js";
import { formatUtc } from "./episode.js";

/** 求助窗口：同一缺口的"问过"在 24 小时内算数（与 capability.ts 的日限同量级） */
export const ASK_HISTORY_WINDOW_MS = 86_400_000;

export interface NightlyMaintenanceInput {
  /** 数据根（`<root>/data/...`）；与 persist.ts 的口径一致 */
  readonly root: string;
  readonly characterId: string;
  readonly nowMs: number;
  readonly askWindowMs?: number;
}

export interface GuardianFactLine {
  readonly requestId: string;
  readonly atMs: number;
  readonly fact: string;
}

export interface NightlyMaintenanceResult {
  /** 观察期满、效力真的提升而被转正的能力 id */
  readonly promoted: readonly string[];
  readonly ask: {
    readonly kept: number;
    readonly dropped: number;
    readonly errors: readonly string[];
  };
  readonly guardian: {
    readonly requests: number;
    readonly answered: number;
    readonly pending: number;
    readonly timedOut: number;
    /** 本次新落盘的事实（已写进 guardian-facts 文件的那些） */
    readonly facts: readonly GuardianFactLine[];
    readonly errors: readonly string[];
  };
  /** 给人看的一行行说明（没有变化时也要能说清"没事可做"） */
  readonly notes: readonly string[];
}

export function guardianFactsPath(root: string, characterId: string): string {
  return join(root, "data", `guardian-facts-${characterId}.ndjson`);
}

function iso(ms: number): string {
  return formatUtc(ms);
}

/** 已经落过库的事实不再重复写（按 requestId 去重，幂等）。 */
function readRecordedFactIds(path: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(path)) return seen;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return seen;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as { requestId?: unknown };
      if (typeof parsed.requestId === "string") seen.add(parsed.requestId);
    } catch {
      // 坏行跳过：一行坏了不影响其余事实
    }
  }
  return seen;
}

function appendFactLines(path: string, lines: readonly GuardianFactLine[]): void {
  if (lines.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const body = lines.map((line) => JSON.stringify({ requestId: line.requestId, at: iso(line.atMs), fact: line.fact })).join("\n") + "\n";
  appendFileSync(path, body, "utf8");
}

/**
 * 跑一次夜间维护。幂等：同样的输入第二次跑不会重复转正、不会重复写事实。
 * 任何一段坏掉都只记 errors/notes，不抛出——维护失败不该让常驻进程倒下。
 */
export function runNightlyMaintenance(input: NightlyMaintenanceInput): NightlyMaintenanceResult {
  const nowMs = input.nowMs;
  const askWindowMs = input.askWindowMs ?? ASK_HISTORY_WINDOW_MS;
  const notes: string[] = [];

  // ── 1. 能力账本：观察期满且效力真的提升 → 转正 ──
  const promoted: string[] = [];
  const ledgerPath = capabilityLedgerPath(input.root, input.characterId);
  const ledger = readCapabilityLedgerFile(ledgerPath);
  if (ledger.errors.length > 0) notes.push(`能力账本有 ${ledger.errors.length} 处问题：${ledger.errors.join("；")}`);
  if (ledger.records !== null) {
    const result = promoteDueRecords(ledger.records, nowMs);
    if (result.promoted.length > 0) {
      writeCapabilityLedgerFile(ledgerPath, result.records, nowMs);
      promoted.push(...result.promoted);
      notes.push(`能力转正 ${result.promoted.length} 个：${result.promoted.join("、")}`);
    }
  }

  // ── 2. 求助历史：只留窗口内的，"同缺口问过一次"不会变成永久封口 ──
  const askPath = askHistoryPath(input.root, input.characterId);
  const askRead = readAskHistory(askPath);
  const kept = pruneAskHistory(askRead.entries, nowMs, askWindowMs);
  const dropped = askRead.entries.length - kept.length;
  if (dropped > 0) {
    writeAskHistory(askPath, kept);
    notes.push(`求助历史裁掉 ${dropped} 条（窗口 ${Math.round(askWindowMs / 3_600_000)} 小时）`);
  }

  // ── 3. 监护人：把"超时/拒绝/答应"解成事实，超时只落一次 ──
  const inbox = guardianInboxPath(input.root, input.characterId);
  const replyDir = guardianReplyDir(input.root);
  const requests = readGuardianRequests(inbox);
  const replies = readGuardianReplies(replyDir);
  const resolutions = resolveGuardianRequests(requests.requests, replies.replies, nowMs);
  const factsPath = guardianFactsPath(input.root, input.characterId);
  const recorded = readRecordedFactIds(factsPath);
  const fresh: GuardianFactLine[] = [];
  for (const [index, resolution] of resolutions.entries()) {
    if (resolution.fact === null) continue;
    const request = requests.requests[index];
    const requestId = request === undefined ? "" : request.requestId;
    if (requestId === "" || recorded.has(requestId)) continue;
    fresh.push({ requestId, atMs: nowMs, fact: resolution.fact });
    recorded.add(requestId);
  }
  appendFactLines(factsPath, fresh);
  if (fresh.length > 0) notes.push(`监护人事实落盘 ${fresh.length} 条：${fresh.map((f) => f.fact).join("；")}`);

  const answered = resolutions.filter((r) => r.state === "answered").length;
  const pending = resolutions.filter((r) => r.state === "pending").length;
  const timedOut = resolutions.filter((r) => r.state === "timed-out").length;

  if (notes.length === 0) notes.push("没有需要维护的事（账本无转正、求助窗口无裁剪、监护无新事实）。");

  return {
    promoted,
    ask: { kept: kept.length, dropped, errors: askRead.errors },
    guardian: {
      requests: requests.requests.length,
      answered,
      pending,
      timedOut,
      facts: fresh,
      errors: [...requests.errors, ...replies.errors],
    },
    notes,
  };
}
