/**
 * P4 能力账本落盘形状（纯序列化 / 解析；不读时钟、不写文件）
 *
 * 为什么单独一个文件：`forge.ts` 的 `CapabilityLedger` 管的是"账本语义"（增删、观察期、转正建议），
 * 但"账本存到磁盘上长什么样、读回来能不能还原"是另一件事。混在一起的话，测试要么只能测内存账本、
 * 要么必须真写文件——两者都不该发生。
 *
 * 纪律（与 `state-file.ts` 同一套）：
 *   - 版本不符直接拒，**不静默兼容旧格式**（否则"字段丢了"会变成"值变默认"）；
 *   - 记录不合规（`validateCapabilityRecord` 报错）逐条列出，不吞；
 *   - 同 capId 出现两次算坏文件（账本按 capId 唯一，历史在 WAL，不在这个文件里）；
 *   - 序列化键序固定、按 capId 排序，保证同一份账本逐字节相同（可 diff、可 golden）。
 */

import { validateCapabilityRecord } from "./forge.js";
import type { CapabilityRecord } from "./types.js";

export const CAPABILITY_LEDGER_VERSION = 1 as const;

export interface CapabilityLedgerFile {
  readonly version: typeof CAPABILITY_LEDGER_VERSION;
  readonly savedAtMs: number;
  readonly records: readonly CapabilityRecord[];
}

export interface CapabilityLedgerParseResult {
  /** 解析成功时的记录（按 capId 升序）；失败时 null */
  readonly records: readonly CapabilityRecord[] | null;
  /** 文件里记下的保存时刻；失败时 null */
  readonly savedAtMs: number | null;
  readonly errors: readonly string[];
}

/** 序列化：键序固定、记录按 capId 排序（同输入 → 逐字节相同）。 */
export function serializeCapabilityLedger(records: readonly CapabilityRecord[], savedAtMs: number): string {
  if (!Number.isFinite(savedAtMs) || savedAtMs < 0) {
    throw new RangeError(`serializeCapabilityLedger: savedAtMs 非法：${String(savedAtMs)}`);
  }
  const sorted = [...records].sort((a, b) => (a.capId < b.capId ? -1 : a.capId > b.capId ? 1 : 0));
  const file: CapabilityLedgerFile = { version: CAPABILITY_LEDGER_VERSION, savedAtMs, records: sorted };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["version", "savedAtMs", "records"]);

/**
 * 解析：fail-closed。
 *
 * 返回 `errors` 非空时 `records` 一定是 null——调用方要么用坏文件里的半份账本（会丢能力），
 * 要么拒绝启动相关功能（正确做法）。这两种都不该靠"返回值凑合"，所以这里不给半份。
 */
export function parseCapabilityLedger(raw: string): CapabilityLedgerParseResult {
  const fail = (errors: readonly string[]): CapabilityLedgerParseResult => ({ records: null, savedAtMs: null, errors });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return fail([`不是合法 JSON：${(error as Error).message}`]);
  }
  if (!isRecord(value)) return fail(["顶层必须是对象"]);
  const unknownKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) return fail([`未知字段：${unknownKeys.join("、")}（schema 变了要升版本，不静默兼容）`]);
  if (value.version !== CAPABILITY_LEDGER_VERSION) {
    return fail([`版本不符：文件 ${String(value.version)}，本代码只认 ${CAPABILITY_LEDGER_VERSION}`]);
  }
  if (!Number.isFinite(value.savedAtMs) || (value.savedAtMs as number) < 0) {
    return fail([`savedAtMs 非法：${String(value.savedAtMs)}`]);
  }
  if (!Array.isArray(value.records)) return fail(["records 必须是数组"]);

  const errors: string[] = [];
  const records: CapabilityRecord[] = [];
  const seen = new Set<string>();
  value.records.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`第 ${index + 1} 条不是对象`);
      return;
    }
    const recordErrors = validateCapabilityRecord(item as unknown as CapabilityRecord);
    if (recordErrors.length > 0) {
      errors.push(`第 ${index + 1} 条（${String(item.capId)}）：${recordErrors.join("；")}`);
      return;
    }
    const record = item as unknown as CapabilityRecord;
    if (seen.has(record.capId)) {
      errors.push(`第 ${index + 1} 条：capId 重复（${record.capId}）——账本按 capId 唯一，历史在 WAL`);
      return;
    }
    seen.add(record.capId);
    records.push(record);
  });
  if (errors.length > 0) return fail(errors);
  return { records, savedAtMs: value.savedAtMs as number, errors: [] };
}

/** 合并新旧记录（新覆盖旧；不增不减的 capId 保留旧对象），返回按 capId 升序的新数组。 */
export function mergeCapabilityRecords(
  existing: readonly CapabilityRecord[],
  next: readonly CapabilityRecord[],
): CapabilityRecord[] {
  const map = new Map<string, CapabilityRecord>();
  for (const record of existing) map.set(record.capId, record);
  for (const record of next) map.set(record.capId, record);
  return [...map.values()].sort((a, b) => (a.capId < b.capId ? -1 : a.capId > b.capId ? 1 : 0));
}

export interface LedgerDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly promoted: readonly string[];
  readonly retired: readonly string[];
  readonly changed: readonly string[];
}

/** 两份账本的差异（审计/台账用；只报 capId，不报全字段，避免日志里滚出整份记录）。 */
export function diffCapabilityLedgers(
  before: readonly CapabilityRecord[],
  after: readonly CapabilityRecord[],
): LedgerDiff {
  const oldMap = new Map(before.map((record) => [record.capId, record]));
  const newMap = new Map(after.map((record) => [record.capId, record]));
  const added: string[] = [];
  const removed: string[] = [];
  const promoted: string[] = [];
  const retired: string[] = [];
  const changed: string[] = [];
  for (const capId of newMap.keys()) if (!oldMap.has(capId)) added.push(capId);
  for (const capId of oldMap.keys()) if (!newMap.has(capId)) removed.push(capId);
  for (const [capId, afterRecord] of newMap) {
    const beforeRecord = oldMap.get(capId);
    if (beforeRecord === undefined) continue;
    if (beforeRecord.status !== afterRecord.status) {
      if (afterRecord.status === "active") promoted.push(capId);
      if (afterRecord.status === "retired") retired.push(capId);
    }
    if (
      beforeRecord.status !== afterRecord.status ||
      beforeRecord.effectivityAfter !== afterRecord.effectivityAfter ||
      beforeRecord.riskCeiling !== afterRecord.riskCeiling
    ) {
      changed.push(capId);
    }
  }
  const sorted = (list: string[]): string[] => list.sort();
  return {
    added: sorted(added),
    removed: sorted(removed),
    promoted: sorted(promoted),
    retired: sorted(retired),
    changed: sorted(changed),
  };
}

/** 一行审计摘要（空差异返回 null，不伪造"有变化"）。 */
export function describeLedgerDiff(diff: LedgerDiff): string | null {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.length}`);
  if (diff.removed.length > 0) parts.push(`移除 ${diff.removed.length}`);
  if (diff.promoted.length > 0) parts.push(`转正 ${diff.promoted.length}`);
  if (diff.retired.length > 0) parts.push(`退役 ${diff.retired.length}`);
  if (diff.changed.length > 0) parts.push(`变更 ${diff.changed.length}`);
  return parts.length === 0 ? null : `能力账本变化：${parts.join(" / ")}`;
}
