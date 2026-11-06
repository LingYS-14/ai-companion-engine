/**
 * P2：网页聊天与 QQ 共享的对话流水（`data/chat-<characterId>.ndjson`）。
 *
 * 为什么是 NDJSON：一行一条、追加最便宜，出问题时能直接 `tail` 看；
 * 读路径只认最近 200 条（提示词只要 12 条、UI 轮询要 50 条），所以启动时
 * 全量扫一遍只是为了统计行数与轮转，不把整本历史留在内存里。
 *
 * 轮转只发生在启动：运行中重写文件会和正在写的一端赛跑。上限 5000 行
 * 按每 5 分钟一条算 ≈ 17 天，够用；轮转保留最后 1000 行（原子 tmp+rename）。
 *
 * 注入 `now` 而不是自己取时间：writers lint 禁止 spine 里直接读时钟，
 * 也让测试能造任意时间线。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChatHistoryEntry, ChatHistoryStore } from "../ports/chat-history.js";

/** 内存里保留的条数上限（与设计 §6 的 200 一致）。 */
export const CHAT_LOG_TAIL_LIMIT = 200;
/** 启动时超过这个行数就轮转（运行中不轮转）。 */
export const CHAT_LOG_ROTATE_AT = 5_000;
/** 轮转后保留的行数。 */
export const CHAT_LOG_ROTATE_KEEP = 1_000;

export interface ChatLogInput {
  readonly dataDir: string;
  readonly characterId: string;
  readonly now: () => number;
  readonly log?: (line: string) => void;
}

const WHO: readonly string[] = ["peer", "her"];
const CHANNEL: readonly string[] = ["qq", "web"];

function parseEntry(raw: unknown): ChatHistoryEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const atMs = body.atMs;
  const who = body.who;
  const text = body.text;
  const channel = body.channel;
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) return null;
  if (typeof who !== "string" || !WHO.includes(who)) return null;
  if (typeof text !== "string") return null;
  if (typeof channel !== "string" || !CHANNEL.includes(channel)) return null;
  return { atMs, who: who as ChatHistoryEntry["who"], text, channel: channel as ChatHistoryEntry["channel"] };
}

function readLines(path: string): { entries: ChatHistoryEntry[]; lineCount: number; bad: number } {
  if (!existsSync(path)) return { entries: [], lineCount: 0, bad: 0 };
  const text = readFileSync(path, "utf8");
  const entries: ChatHistoryEntry[] = [];
  let lineCount = 0;
  let bad = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    lineCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    const entry = parseEntry(parsed);
    if (entry === null) {
      bad += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, lineCount, bad };
}

/** 原子重写：先写 `.tmp` 再 rename；失败时原文件不动，错误交给调用方决定是否吞掉。 */
function rewriteAtomic(path: string, entries: readonly ChatHistoryEntry[]): void {
  const tmp = `${path}.tmp`;
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(tmp, body === "" ? "" : `${body}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * 共享对话流水。
 *
 * 单进程唯一写者（常驻进程），插件侧只读文件——所以这里不需要文件锁；
 * QQ 桥与网页聊天都走同一个实例（装配层把它同时交给两边）。
 */
export class ChatLog implements ChatHistoryStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private entries: ChatHistoryEntry[];
  private lineCount: number;

  private constructor(
    path: string,
    now: () => number,
    log: ((line: string) => void) | undefined,
    entries: ChatHistoryEntry[],
    lineCount: number,
  ) {
    this.path = path;
    this.now = now;
    this.log = log;
    this.entries = entries;
    this.lineCount = lineCount;
  }

  static open(input: ChatLogInput): ChatLog {
    mkdirSync(input.dataDir, { recursive: true });
    const path = join(input.dataDir, `chat-${input.characterId}.ndjson`);
    const loaded = readLines(path);
    if (loaded.bad > 0) {
      input.log?.(`[chat-log] 跳过 ${String(loaded.bad)} 条坏行（${path}）`);
    }
    if (loaded.lineCount > CHAT_LOG_ROTATE_AT) {
      const kept = loaded.entries.slice(-CHAT_LOG_ROTATE_KEEP);
      rewriteAtomic(path, kept);
      input.log?.(`[chat-log] 轮转：${String(loaded.lineCount)} → ${String(kept.length)} 行`);
      return new ChatLog(path, input.now, input.log, kept.slice(-CHAT_LOG_TAIL_LIMIT), kept.length);
    }
    return new ChatLog(path, input.now, input.log, loaded.entries.slice(-CHAT_LOG_TAIL_LIMIT), loaded.lineCount);
  }

  /** 当前文件路径（测试/诊断用）。 */
  get pathname(): string {
    return this.path;
  }

  /** 磁盘上（启动时统计的）行数，含坏行；运行中 append 会递增。 */
  get count(): number {
    return this.lineCount;
  }

  recent(limit: number): readonly ChatHistoryEntry[] {
    const n = Number.isFinite(limit) ? Math.max(0, Math.min(CHAT_LOG_TAIL_LIMIT, Math.trunc(limit))) : 0;
    if (n === 0) return [];
    return this.entries.slice(-n);
  }

  append(entry: ChatHistoryEntry): void {
    if (parseEntry(entry) === null) {
      throw new RangeError("ChatLog.append: 记录形状不对（atMs/who/text/channel）");
    }
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(this.path, line, "utf8");
    this.entries = [...this.entries, entry].slice(-CHAT_LOG_TAIL_LIMIT);
    this.lineCount += 1;
    void this.now;
  }
}
