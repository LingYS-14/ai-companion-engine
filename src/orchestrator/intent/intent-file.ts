/**
 * 意图表落盘（P2/P1 的"跨重启还在"）
 *
 * 为什么：`bus.ts` 能造/推进意图记录，`tick.ts` 每拍只在内存里算一次——进程一重启，
 * "我想做什么"就全没了，于是 `openIntentCount`/`activeKinds` 只能写死 0/[]，
 * 同一类意图也会被反复浮现（域内去重只做了当拍）。这一步把意图表写成文件，让下一拍能读到。
 *
 * 纪律：
 *   - 解析 **fail-closed**：版本不符/坏记录/重复 id 一律整体拒绝，不给"半份表"——
 *     半份表会让"想做什么"变成"想做什么但不完整"，比空表更危险。
 *   - 只读写文件，不判定、不调度；时间由调用方传（本文件不读时钟）。
 *   - 有上限与保留期：意图表是账本不是记忆，不能无限长。
 */

import { isIntentKind } from "./types.js";
import type { IntentionRecord } from "./types.js";

export const INTENT_FILE_VERSION = 1 as const;
/** 表最多留多少条（超出时先保开着的，再按 created_at 新→旧留终态，见 `trimIntentions`） */
export const MAX_INTENT_RECORDS = 40;
/** 记录保留期：超过 7 天的不再进表（死掉的意图不该永远占着"活跃"口径） */
export const INTENT_RETENTION_MS = 7 * 86_400_000;

export interface IntentionFile {
  readonly version: 1;
  readonly savedAtMs: number;
  readonly records: readonly IntentionRecord[];
}

export interface IntentionFileParse {
  readonly file: IntentionFile | null;
  readonly errors: readonly string[];
}

const STATUS_SET = new Set(["pending", "active", "blocked", "held", "done", "dropped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 固定键序：便于 diff / golden / 人肉读。 */
export function serializeIntentionFile(records: readonly IntentionRecord[], savedAtMs: number): string {
  if (!Number.isFinite(savedAtMs) || savedAtMs < 0) throw new RangeError("serializeIntentionFile: savedAtMs 非法");
  const sorted = [...records].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? 1 : -1));
  return JSON.stringify(
    {
      version: INTENT_FILE_VERSION,
      savedAtMs,
      records: sorted.map((record) => ({
        id: record.id,
        created_at: record.created_at,
        kind: record.kind,
        goal: record.goal,
        why: record.why,
        trigger: record.trigger,
        deadline: record.deadline,
        status: record.status,
        blocked_by: record.blocked_by ?? null,
        attempts: record.attempts,
        superseded_by: record.superseded_by,
        survival: record.survival,
        source_ids: record.source_ids,
      })),
    },
    null,
    2,
  );
}

function parseOne(value: unknown, index: number): { record: IntentionRecord | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { record: null, errors: [`第 ${index} 条不是对象`] };
  const id = value.id;
  if (typeof id !== "string" || id === "") errors.push(`第 ${index} 条缺少 id`);
  if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    errors.push(`第 ${index} 条 created_at 不是可解析时间`);
  }
  if (!isIntentKind(value.kind)) errors.push(`第 ${index} 条 kind 非法：${String(value.kind)}`);
  if (typeof value.goal !== "string" || value.goal.trim() === "") errors.push(`第 ${index} 条 goal 为空`);
  if (typeof value.why !== "string") errors.push(`第 ${index} 条 why 不是字符串`);
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) {
    errors.push(`第 ${index} 条 status 非法：${String(value.status)}`);
  }
  if (!Array.isArray(value.attempts)) errors.push(`第 ${index} 条 attempts 不是数组`);
  if (typeof value.survival !== "number" || !Number.isFinite(value.survival) || value.survival < 0) {
    errors.push(`第 ${index} 条 survival 非法`);
  }
  if (!Array.isArray(value.source_ids)) errors.push(`第 ${index} 条 source_ids 不是数组`);
  if (errors.length > 0) return { record: null, errors };
  return {
    record: {
      id: value.id as string,
      created_at: value.created_at as string,
      kind: value.kind as IntentionRecord["kind"],
      goal: value.goal as string,
      why: value.why as string,
      trigger: (value.trigger ?? null) as IntentionRecord["trigger"],
      deadline: (value.deadline ?? null) as IntentionRecord["deadline"],
      status: value.status as IntentionRecord["status"],
      blocked_by: typeof value.blocked_by === "string" ? value.blocked_by : null,
      attempts: value.attempts as IntentionRecord["attempts"],
      superseded_by: (value.superseded_by ?? null) as IntentionRecord["superseded_by"],
      survival: value.survival as number,
      source_ids: value.source_ids as IntentionRecord["source_ids"],
    },
    errors: [],
  };
}

/** fail-closed：有任何错误 → file=null（不给半份表）。 */
export function parseIntentionFile(raw: string): IntentionFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file: null, errors: ["不是合法 JSON"] };
  }
  if (!isRecord(parsed)) return { file: null, errors: ["顶层不是对象"] };
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "version" && key !== "savedAtMs" && key !== "records");
  if (unknownKeys.length > 0) return { file: null, errors: [`未知字段：${unknownKeys.join(", ")}`] };
  if (parsed.version !== INTENT_FILE_VERSION) {
    return { file: null, errors: [`版本不符：期望 ${INTENT_FILE_VERSION}，收到 ${String(parsed.version)}`] };
  }
  if (typeof parsed.savedAtMs !== "number" || !Number.isFinite(parsed.savedAtMs)) {
    return { file: null, errors: ["savedAtMs 非法"] };
  }
  if (!Array.isArray(parsed.records)) return { file: null, errors: ["records 不是数组"] };
  const records: IntentionRecord[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of parsed.records.entries()) {
    const one = parseOne(value, index);
    if (one.record === null) {
      errors.push(...one.errors);
      continue;
    }
    if (seen.has(one.record.id)) {
      errors.push(`重复 id：${one.record.id}`);
      continue;
    }
    seen.add(one.record.id);
    records.push(one.record);
  }
  if (errors.length > 0) return { file: null, errors };
  return { file: { version: INTENT_FILE_VERSION, savedAtMs: parsed.savedAtMs, records }, errors: [] };
}

/** 还没了结的意图（pending/active/blocked）——`openIntentCount` 的口径。 */
export function openIntentions(records: readonly IntentionRecord[]): IntentionRecord[] {
  return records.filter(
    (record) =>
      record.status === "pending" ||
      record.status === "active" ||
      record.status === "blocked" ||
      record.status === "held",
  );
}

/**
 * 正在被推进的类别 —— `emittedKinds` 的"同类活跃"口径。
 *
 * 含 `active` 与 `held`：`held`（A5：她判断此刻不宜打扰、先不说）表示这一件**还开着**，
 * 若不算"同类活跃"，下一拍会立刻重新浮现同一条，变成"她说了一遍又一遍（只是没发）"。
 */
export function activeKindsOf(records: readonly IntentionRecord[]): IntentionRecord["kind"][] {
  const kinds = new Set<IntentionRecord["kind"]>();
  for (const record of records) if (record.status === "active" || record.status === "held") kinds.add(record.kind);
  return [...kinds];
}

/**
 * 按 id 覆盖写入（没有就追加）；保持调用方顺序，超出上限时走 `trimIntentions`。
 * F312 复核（supervisor）：上限规则必须只有一处——此前这里是「丢最旧」，trim 是「先保开着的」，
 * 两条规则并存会让同一个文件在两条写入路径上得到不同形状。统一到 trim。
 */
export function upsertIntention(records: readonly IntentionRecord[], record: IntentionRecord): IntentionRecord[] {
  const next = records.filter((existing) => existing.id !== record.id);
  next.push(record);
  if (next.length <= MAX_INTENT_RECORDS) return next;
  return [...trimIntentions(next, MAX_INTENT_RECORDS)];
}

/**
 * F312：把意图表裁到上限。**所有写盘点都该先过这里**——此前只有 `upsertIntention` 裁剪，
 * 其余几处直接 `serializeIntentionFile(records)`，于是 40 条上限形同虚设（7 天可积到 70 条）。
 *
 * 规则：先保全部"还开着"的（pending/active/blocked/held）；仍超上限时按 created_at 新→旧
 * 保留最新的；剩余名额给最近的终态记录。输出保持输入顺序（便于 diff / golden / 人肉读）。
 */
export function trimIntentions(
  records: readonly IntentionRecord[],
  max: number = MAX_INTENT_RECORDS,
): readonly IntentionRecord[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`trimIntentions: max 必须是正整数，收到 ${String(max)}`);
  }
  if (records.length <= max) return records;
  const isOpen = (record: IntentionRecord): boolean =>
    record.status !== "done" && record.status !== "dropped";
  const byAgeDesc = [...records].sort((a, b) => {
    if (a.created_at === b.created_at) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    return a.created_at < b.created_at ? 1 : -1;
  });
  const keep = new Set<string>();
  for (const record of byAgeDesc) {
    if (keep.size >= max) break;
    if (isOpen(record)) keep.add(record.id);
  }
  for (const record of byAgeDesc) {
    if (keep.size >= max) break;
    if (!isOpen(record)) keep.add(record.id);
  }
  return records.filter((record) => keep.has(record.id));
}

/** 清掉超过保留期的记录（按 created_at）。 */
export function pruneIntentions(
  records: readonly IntentionRecord[],
  nowMs: number,
  retentionMs: number = INTENT_RETENTION_MS,
): { readonly records: readonly IntentionRecord[]; readonly dropped: readonly string[] } {
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new RangeError("pruneIntentions: nowMs/retentionMs 非法");
  }
  const dropped: string[] = [];
  const kept = records.filter((record) => {
    const at = Date.parse(record.created_at);
    const expired = Number.isNaN(at) ? true : nowMs - at > retentionMs;
    if (expired) dropped.push(record.id);
    return !expired;
  });
  return { records: kept, dropped };
}

/** 一行摘要，可直接进日志：open=3 active=1 最旧=2.5h */
export function describeIntentionFile(records: readonly IntentionRecord[], nowMs: number): string {
  const open = openIntentions(records);
  const active = records.filter((record) => record.status === "active").length;
  const oldest = open
    .map((record) => {
      const at = Date.parse(record.created_at);
      return Number.isNaN(at) ? 0 : Math.max(0, nowMs - at);
    })
    .sort((a, b) => b - a)[0];
  const age = oldest === undefined ? "无" : `${(oldest / 3_600_000).toFixed(1)}h`;
  return `open=${String(open.length)} active=${String(active)} 最旧=${age}`;
}
