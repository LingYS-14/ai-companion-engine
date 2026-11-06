/**
 * 冷储存（§6.9 的落地）
 *
 * 规格把"冷归档"描述成一个状态，却没给它的物理形态：`memory_layer` 不在 §6.2 的 27 字段里
 * （F22），`hard_deleted` / `hard_delete_at` 同样不在。所以这里**不加字段**，把层级放进
 * 存储位置本身：热档 = 记忆 WAL，冷档 = 另一个 NDJSON 文件。一条记忆要么在热档、要么在冷档，
 * 不会同时存在两处，也就不存在"哪个才是我"的问题。见 F29。
 *
 * 自拟的三条规则（用户已授权自拟，并且这里全部显式写在类型里）：
 *   1. 冷归档只搬不删：进入冷档后仍可 `restore` 回热档。
 *   2. 硬删除只对**已进冷档**且过了 `HARD_DELETE_RETENTION_DAYS` 的条目生效，且**只能显式触发**
 *      ——自动销毁是不可逆的，不值得为"整洁"冒险。
 *   3. 归档时记下 `archived_at`；保留期从这一刻起算，而不是从 last_accessed 起算，
 *      否则一条被遗忘很久的记忆会在归档当天就被判可删。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { knobNumber, type EngineConfig } from "../engine/config.js";
import type { MemoryRecord } from "./types.js";

const DAY_MS = 86_400_000;

export interface ArchivedEntry {
  readonly record: MemoryRecord;
  /** 进入冷档的时刻：硬删除保留期从这里起算（见文件头第 3 条） */
  readonly archived_at: number;
  /** 为什么被归档，用于"为什么想不起来"的回溯 */
  readonly reason: string;
}

export interface ArchiveStats {
  readonly size: number;
  /** 已过保留期、可被硬删的条数 */
  readonly purgeable: number;
  readonly corrupt: number;
}

/**
 * 冷档。NDJSON，一行一条 `ArchivedEntry`。
 * 与 `Wal` 一样：坏行不致命，只计数；写入先落盘再改内存。
 */
export class ArchiveStore {
  private entries = new Map<string, ArchivedEntry>();
  private corrupt = 0;

  constructor(readonly path: string) {}

  open(): this {
    this.entries = new Map();
    this.corrupt = 0;
    if (!existsSync(this.path)) return this;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      try {
        const entry = JSON.parse(text) as ArchivedEntry;
        if (entry.record?.id === undefined) {
          this.corrupt += 1;
          continue;
        }
        this.entries.set(entry.record.id, entry);
      } catch {
        this.corrupt += 1;
      }
    }
    return this;
  }

  put(entry: ArchivedEntry): void {
    this.append(entry);
    this.entries.set(entry.record.id, entry);
  }

  get(id: string): ArchivedEntry | undefined {
    return this.entries.get(id);
  }

  all(): ArchivedEntry[] {
    return [...this.entries.values()].sort((a, b) => a.record.id.localeCompare(b.record.id));
  }

  size(): number {
    return this.entries.size;
  }

  /** 取出并从冷档移除（restore 用）；不写 tombstone，因为它在热档里是新增 */
  take(id: string): ArchivedEntry | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    this.entries.delete(id);
    this.rewrite();
    return entry;
  }

  /** 硬删除：只从冷档移除，不碰热档 */
  purge(ids: readonly string[]): string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (this.entries.delete(id)) removed.push(id);
    }
    if (removed.length > 0) this.rewrite();
    return removed;
  }

  stats(now: number, cfg: EngineConfig): ArchiveStats {
    const retention = knobNumber(cfg, "HARD_DELETE_RETENTION_DAYS") * DAY_MS;
    let purgeable = 0;
    for (const entry of this.entries.values()) {
      if (now - entry.archived_at >= retention) purgeable += 1;
    }
    return { size: this.entries.size, purgeable, corrupt: this.corrupt };
  }

  private append(entry: ArchivedEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(entry)}\n`, { flag: "a" });
  }

  /** 压缩/删除后整文件重写（先写临时文件再 rename，避免半个文件） */
  private rewrite(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.compact-${process.pid}.tmp`;
    const body = this.all().map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(tmp, body === "" ? "" : `${body}\n`);
    renameSync(tmp, this.path);
  }
}
