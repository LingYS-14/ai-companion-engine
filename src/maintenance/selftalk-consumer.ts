/**
 * 内部言语日志 → 睡眠巩固的入口（S5 / §4.10）。
 *
 * 设计约束（用户的规定）：
 *   - 内部言语不是另一套记忆系统，它必须**共用同一套记忆基础设施**：
 *     想过的内容以低鲜活度的情节记忆落进 WAL，然后由 consolidate 正常聚类、过四道闸。
 *   - 「只消费一次」：日志本身归自主进程写，开发面只读；这里用游标文件记
 *     `lastConsumedAt`，避免每次睡眠把同样的自言自语重复变成记忆。
 *   - 失败不阻断睡眠：日志读不到/格式坏，就当这次没有可消费的言语。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MemorySeed } from "../memory/types.js";
import { SelftalkJournal, type JournalEntry } from "./selftalk-journal.js";

export const SELFTALK_CONSUMED_VERSION = 1;
/** 一次睡眠最多消费多少条（防止日志积压时把一次巩固撑爆） */
export const SELFTALK_BATCH = 20;

interface ConsumedFile {
  readonly version: number;
  readonly lastConsumedAt: number;
}

/** 日志路径与运行器同一口径：`data/selftalk-<characterId>.json` */
export function journalPathFor(dataDir: string, characterId: string): string {
  return join(dataDir, `selftalk-${characterId}.json`);
}

export function consumedPathFor(dataDir: string, characterId: string): string {
  return join(dataDir, `selftalk-consumed-${characterId}.json`);
}

/** 游标；缺失/损坏都按「一条都没消费过」处理（宁可重写一次，也别让新言语永远进不了巩固） */
export function loadConsumedAt(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ConsumedFile>;
    return typeof raw.lastConsumedAt === "number" && Number.isFinite(raw.lastConsumedAt) ? raw.lastConsumedAt : 0;
  } catch {
    return 0;
  }
}

export function saveConsumedAt(file: string, at: number): void {
  const payload: ConsumedFile = { version: SELFTALK_CONSUMED_VERSION, lastConsumedAt: at };
  const tmp = `${file}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
    renameSync(tmp, file);
  } catch {
    // 游标写不进去只会导致下次重复消费；记忆 id 幂等（st-<entry.id>），不会重复落盘
  }
}

function isEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Partial<JournalEntry>;
  return typeof e.id === "string" && typeof e.at === "number" && typeof e.text === "string";
}

/** 读日志；坏文件返回空（不抛错，睡眠不能因为日志坏了停摆） */
export function readJournal(file: string): readonly JournalEntry[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/**
 * 把「上次消费之后」的言语转成待写入的低鲜活度记忆。
 *
 * 鲜活度给 0.35：她想过的事比听到的事淡，但足够进入巩固的候选池；
 * schema_congruence 给 0.5（中性），不预设"她想的一定符合她的图式"。
 */
export function seedsFromJournal(
  entries: readonly JournalEntry[],
  lastConsumedAt: number,
  opts: { limit?: number } = {},
): MemorySeed[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? SELFTALK_BATCH));
  // 降级模板不是她想出来的话：不进巩固，否则一次没 key 的运行会往人格记忆里塞一堆复读（F74）
  const fresh = entries
    .filter((e) => e.degraded !== true)
    .filter((e) => Number.isFinite(e.at) && e.at > lastConsumedAt && e.text.trim() !== "")
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
  const seen = new Set<string>();
  const out: MemorySeed[] = [];
  for (const e of fresh) {
    const id = `st-${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      content: e.text.trim(),
      source: "selftalk",
      tags: ["selftalk", e.kind],
      vividness: 0.35,
      confidence: 0.45,
      accuracy: 0.75,
      self_relevance: 0.6,
      schema_congruence: 0.5,
      created_at: e.at,
      encode_ctx: { selftalk_kind: e.kind, relation: e.relation },
    });
  }
  return out;
}

/** 落盘方便的自包装：读日志 + 取游标 + 出 seeds（runtime.consolidate 用它） */
export function journalSeeds(dataDir: string, characterId: string, limit?: number): {
  readonly seeds: MemorySeed[];
  readonly lastConsumedAt: number;
  readonly latestAt: number;
} {
  const entries = readJournal(journalPathFor(dataDir, characterId));
  const lastConsumedAt = loadConsumedAt(consumedPathFor(dataDir, characterId));
  const seeds = seedsFromJournal(entries, lastConsumedAt, limit === undefined ? {} : { limit });
  const latestAt = entries.reduce((m, e) => (Number.isFinite(e.at) && e.at > m ? e.at : m), lastConsumedAt);
  return { seeds, lastConsumedAt, latestAt };
}

/** 只读视图：给工具/面板看「她最近想过什么」 */
export function recentSelfTalk(dataDir: string, characterId: string, limit = 10): readonly JournalEntry[] {
  const journal = SelftalkJournal.open(journalPathFor(dataDir, characterId));
  return journal.recent(limit);
}
