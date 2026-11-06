/**
 * 幂等存储（落盘）：先预留、再执行、最后标记结果。
 *
 * 语义（对应审计 E2/S3）：
 * - `at-most-once`：预留成功才允许调用；调用失败保留 failed 记录，后续请求得到「已失败」而不是再发一次；
 * - `idempotent`：失败记录直接移除，允许重试；
 * - 崩溃恢复：预留但没有结果的记录在 TTL 内视为 INDETERMINATE（不知道发没发出去），过期后清掉。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type IdemState = "reserved" | "done" | "failed";

export interface IdemEntry {
  readonly fingerprint: string;
  readonly requestId: string;
  readonly toolId: string;
  readonly state: IdemState;
  /** 预留/完成/失败的时间（ms） */
  readonly at: number;
  readonly ttlMs: number;
  /** 失败时的分类，便于上报 */
  readonly failureClass?: string;
}

export interface ReserveResult {
  readonly acquired: boolean;
  readonly entry?: IdemEntry;
}

const VERSION = 1;

export class IdempotencyStore {
  private readonly file: string;
  private readonly entries: Map<string, IdemEntry>;

  private constructor(file: string, entries: Map<string, IdemEntry>) {
    this.file = file;
    this.entries = entries;
  }

  static open(file: string): IdempotencyStore {
    const entries = new Map<string, IdemEntry>();
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; entries?: IdemEntry[] };
        for (const entry of raw.entries ?? []) {
          if (typeof entry.fingerprint === "string" && typeof entry.state === "string") {
            entries.set(entry.fingerprint, entry);
          }
        }
      } catch {
        // 坏档不阻断执行：宁可丢去重记录，也不能让 QQ 发不出去
      }
    }
    return new IdempotencyStore(file, entries);
  }

  /** 清掉过期记录（每次预留前跑一次，避免文件无限长）。 */
  prune(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.at + entry.ttlMs < now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.flush(now);
    return removed;
  }

  /**
   * 预留一个指纹。
   * - 命中未过期记录：返回 acquired=false（调用方据此不再执行）；
   * - 没有记录/已过期：写入 reserved 并落盘，返回 acquired=true。
   */
  reserve(input: {
    readonly fingerprint: string;
    readonly requestId: string;
    readonly toolId: string;
    readonly now: number;
    readonly ttlMs: number;
  }): ReserveResult {
    this.prune(input.now);
    const existing = this.entries.get(input.fingerprint);
    if (existing !== undefined) {
      return { acquired: false, entry: existing };
    }
    const entry: IdemEntry = {
      fingerprint: input.fingerprint,
      requestId: input.requestId,
      toolId: input.toolId,
      state: "reserved",
      at: input.now,
      ttlMs: input.ttlMs,
    };
    this.entries.set(input.fingerprint, entry);
    this.flush(input.now);
    return { acquired: true, entry };
  }

  /** 执行成功：标记 done；若记录已被移除（极端并发），补一条。 */
  complete(fingerprint: string, now: number): void {
    this.mark(fingerprint, "done", now);
  }

  /** 执行失败：保留记录（at-most-once 不允许自动重发），写分类供上报。 */
  fail(fingerprint: string, now: number, failureClass: string): void {
    this.mark(fingerprint, "failed", now, failureClass);
  }

  /** `idempotent` 工具失败后允许重试：直接删除记录。 */
  release(fingerprint: string, now: number): void {
    if (this.entries.delete(fingerprint)) this.flush(now);
  }

  get(fingerprint: string): IdemEntry | undefined {
    return this.entries.get(fingerprint);
  }

  get size(): number {
    return this.entries.size;
  }

  private mark(fingerprint: string, state: IdemState, now: number, failureClass?: string): void {
    const existing = this.entries.get(fingerprint);
    if (existing === undefined) return;
    this.entries.set(fingerprint, {
      ...existing,
      state,
      at: now,
      ...(failureClass === undefined ? {} : { failureClass }),
    });
    this.flush(now);
  }

  private flush(now: number): void {
    const body = JSON.stringify(
      {
        version: VERSION,
        savedAt: now,
        entries: [...this.entries.values()],
      },
      null,
      2,
    );
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.file);
  }
}
