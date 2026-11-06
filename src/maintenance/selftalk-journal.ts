/**
 * 内部言语日志（§4.10 / S5）。
 *
 * 它同时是两件事：
 *   1. 「她想过什么」的审计面（不看不知道她在脑子里干了什么）；
 *   2. 睡眠巩固的输入（schema_gap / 未解决簇的证据量）。
 *
 * 存储：JSON 数组落盘，append 后按 SELFTALK_JOURNAL_CAP 截断；原子写（.tmp-<pid> + rename）。
 * 写入方：自主运行器（唯一写者）。开发面/QQ 桥只读。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { knobNumber } from "../engine/config.js";
import type { EngineConfig } from "../engine/config.js";
import type { SelfTalkEffects, SelfTalkKind } from "./selftalk.js";

/**
 * rename 落盘重试（批次0）：仓库子树里高频 writeFileSync + renameSync 时，Windows 上偶发
 * EPERM「operation not permitted」——不是权限/磁盘问题（单次 rename 正常），而是外部句柄
 * （文件监视器 / 杀毒实时扫描）短暂占着临时文件或目标文件；实测同目录连续 505 次 rename
 * 约 200 次后开始出现，加 10ms 间隔就不复现，属速率相关的抢占。
 * 退避重试几次即可；只对占用类错误重试，仍然失败照旧抛，不吃掉真正的权限错误。
 */
function renameWithRetry(from: string, to: string, attempts = 5): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt >= attempts) throw err;
      // 同步落盘路径不能用 async 等待：Atomics.wait 阻塞当前线程 5/10/15/20ms，不引依赖。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5);
    }
  }
}

/**
 * 写口去重的时间窗：与 `tools/audit/check-voice.mjs` 的扫描窗一致（默认 24 小时）。
 *
 * 为什么必须是时间窗而不是「最近 N 条」：审计按 24h 扫日记，而旧的抑制只看最近 6 条——
 * 在 ~40 分钟一轮的节奏下那只覆盖约 4 小时。实测同一句「你看我今天拍的花，像不像你？」
 * 在 07:18:40 与 21:38:52 各写了一条（中间隔着约 20 条别的念头），于是审计判 repeat。
 */
export const VOICE_DEDUP_WINDOW_MS = 24 * 3_600_000;

/**
 * 近重复阈值（二元组 Dice）。审计用 0.9 判「高度相似」，写入口用 0.65：
 * 旧值 0.8 在真实数据里从未触发（20 条 selftalk 记忆两两 Dice max 0.683、45 条日记 max 0.756），
 * 而正常两句话之间 mean 0.292。0.65 能拦住「只改了几个字」的近重复，又远高于正常句间相似度。
 * 入口必须比审计更严，否则「入口放过去的」会在审计里变成红。
 */
const VOICE_DEDUP_SIMILARITY = 0.65;

export interface JournalEntry {
  id: string;
  at: number;
  kind: SelfTalkKind;
  seeds: readonly string[];
  /** 内部言语原文（第一人称） */
  text: string;
  relation: SelfTalkEffects["relation"];
  vividness: readonly (readonly [string, number])[];
  unresolvedRelief: number;
  rewrite: { id: string; valenceShift: number } | undefined;
  source: "autonomy" | "manual";
  /**
   * 降级模板产物（没有模型 / 生成失败）。
   *
   * 它不是"她想出来的话"，只是脚手架：既不进巩固（避免把模板重复写成人格记忆），
   * 也不该被当成她说过的内容展示。
   */
  degraded?: boolean;
  /** 这条内部言语真的说出口了（过了 humanize/shouldSpeak 与发送）；报表与审计用 */
  spoken?: boolean;
}

export class SelftalkJournal {
  private entries: JournalEntry[];

  private constructor(
    private readonly path: string,
    entries: JournalEntry[],
  ) {
    this.entries = entries;
  }

  static open(path: string): SelftalkJournal {
    if (!existsSync(path)) return new SelftalkJournal(path, []);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) return new SelftalkJournal(path, []);
      return new SelftalkJournal(path, raw.filter(isEntry));
    } catch {
      // 坏文件不阻断她：从空日志继续，磁盘上的原文件保留给人看
      return new SelftalkJournal(path, []);
    }
  }

  /**
   * 写一条内部言语。返回 false 表示被写口去重挡下（没进日记）。
   *
   * 去重放在这里、而不是只放在调用方：日记是她的记忆，任何路径（自主轮次、手工补写）
   * 都不该把「同一句/高度相似的一句」再写第二遍。
   */
  append(entry: JournalEntry, cfg: EngineConfig): boolean {
    // 写口第一道闸：24h 内已经说过同一句（或高度相似的一句）→ 不写、不落盘
    if (this.wouldRepeat(entry.text, entry.at)) return false;
    const cap = Math.max(10, Math.floor(knobNumber(cfg, "SELFTALK_JOURNAL_CAP")));
    this.entries = [...this.entries, entry];
    if (this.entries.length > cap) this.entries = this.entries.slice(this.entries.length - cap);
    this.flush();
    return true;
  }

  /** at 时刻之前 VOICE_DEDUP_WINDOW_MS 内，是否已经有同一句（或高度相似的一句） */
  wouldRepeat(text: string, at: number): boolean {
    return isRepeatText(text, this.textsSince(at - VOICE_DEDUP_WINDOW_MS, at));
  }

  /** 某个时间点之后写过的条目（按写入顺序）。种子轮换要用「最近想过什么」的全窗视野 */
  entriesSince(since: number): readonly JournalEntry[] {
    return this.entries.filter((e) => e.at >= since);
  }

  /** 只取时间窗内的文本，给去重比对用（上界挡掉时钟回拨写进来的未来条目） */
  private textsSince(since: number, until: number): string[] {
    const out: string[] = [];
    for (const e of this.entries) if (e.at >= since && e.at <= until) out.push(e.text);
    return out;
  }

  /** 刚写的那条说出口了：回填标记并落盘（不改内容，只补一个事实） */
  markLastSpoken(): boolean {
    const last = this.entries[this.entries.length - 1];
    if (last === undefined) return false;
    this.entries[this.entries.length - 1] = { ...last, spoken: true };
    this.flush();
    return true;
  }

  recent(limit: number): readonly JournalEntry[] {
    if (limit <= 0) return [];
    return this.entries.slice(Math.max(0, this.entries.length - limit));
  }

  all(): readonly JournalEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  private flush(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.entries)}\n`, "utf8");
    renameWithRetry(tmp, this.path);
  }
}

function isEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Partial<JournalEntry>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    typeof e.text === "string" &&
    (e.kind === "replay" || e.kind === "wander" || e.kind === "reflect")
  );
}

/**
 * 归一化：与 `tools/audit/check-voice.mjs` 的 `normalize()` 同一口径（小写、只留字母数字）。
 * 入口和审计必须对同一批句子说「一样」，否则会出现「审计红、入口却以为不重复」的裂缝。
 */
function normalizeVoice(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text: string): ReadonlySet<string> {
  const chars = Array.from(text);
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const a = chars[i];
    const b = chars[i + 1];
    if (a !== undefined && b !== undefined) grams.add(a + b);
  }
  return grams;
}

/**
 * 这一句是不是在重复最近想过的话。
 *
 * 判据：归一化后完全相同，或二元组 Dice ≥ 0.65（换标点/改几个字不算新念头）。
 * 短句（归一化后 < 8 字）不做相似度判定：几个字的句子天然容易撞车，
 * 按相似度拦会把「在吗」这类正常短句也挡掉。
 */
export function isRepeatText(text: string, recent: readonly string[]): boolean {
  const mine = normalizeVoice(text);
  if (mine === "") return true;
  const mineGrams = bigrams(mine);
  for (const line of recent) {
    const other = normalizeVoice(line);
    if (other === "") continue;
    if (other === mine) return true;
    if (mine.length < 8 || other.length < 8) continue;
    const otherGrams = bigrams(other);
    let shared = 0;
    for (const gram of mineGrams) if (otherGrams.has(gram)) shared += 1;
    const total = mineGrams.size + otherGrams.size;
    if (total > 0 && (2 * shared) / total >= VOICE_DEDUP_SIMILARITY) return true;
  }
  return false;
}
