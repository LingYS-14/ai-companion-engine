/**
 * NDJSON WAL —— 记忆的唯一落盘形态（决策 D3：零原生依赖）。
 *
 * 为什么不 sqlite：Electron 下原生模块要按 ABI 重建，任何一次 DSH/Electron 升级都会把玩家数据锁死；
 * NDJSON 是纯文本，坏一行不影响其余行，崩溃后能人工读、能 grep、能 diff。
 *
 * 三条硬约束：
 *   1. 只追加（append-only）：任何"修改"都是一条新的 upsert 行，回放时后者覆盖前者。
 *   2. 每行带 `op`：`{op:"put"|"del", rec|id}`，回放不依赖行序之外的语义。
 *   3. 坏行不致命：计数并把行号留在 stats 里，绝不因为一行 JSON 断了整个存档。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryRecord } from "./types.js";

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

export type WalOp = { op: "put"; rec: MemoryRecord } | { op: "del"; id: string };

export interface WalStats {
  appended: number;
  replayed: number;
  corrupt: number;
  deleted: number;
}

export class Wal {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly stat: WalStats = { appended: 0, replayed: 0, corrupt: 0, deleted: 0 };

  constructor(
    readonly path: string,
    /** 回放上限：超过则先 compact，防止启动时 O(n) 全部读入（默认 5 万行） */
    readonly compactAt = 50_000,
  ) {}

  /** 打开并回放；文件不存在视为空存档 */
  open(): this {
    if (!existsSync(this.path)) return this;
    const text = readFileSync(this.path, "utf8");
    const lines = text.split("\n");
    this.linesOnDisk = lines.filter((l) => l.trim() !== "").length;
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: WalOp;
      try {
        parsed = JSON.parse(line) as WalOp;
      } catch {
        this.stat.corrupt++;
        continue;
      }
      this.apply(parsed);
      this.stat.replayed++;
    }
    // 打开时也压实一次：上次运行可能已经把文件写涨（进程被杀时来不及压实）
    this.maybeCompact();
    return this;
  }

  private apply(op: WalOp): void {
    if (!op || typeof op !== "object") {
      this.stat.corrupt++;
      return;
    }
    if (op.op === "put" && op.rec?.id) this.records.set(op.rec.id, op.rec);
    else if (op.op === "del" && op.id) {
      this.records.delete(op.id);
      this.stat.deleted++;
    } else this.stat.corrupt++;
  }

  /** 追加并立即反映到内存（写穿；先落盘再改内存，避免"记得有的其实没写"） */
  put(rec: MemoryRecord): void {
    this.appendLine({ op: "put", rec });
    this.records.set(rec.id, rec);
    // 压实必须等内存里也有这条：compact() 写的是 snapshot()，先压实会把这行写丢
    this.maybeCompact();
  }

  remove(id: string): void {
    this.appendLine({ op: "del", id });
    this.records.delete(id);
    this.maybeCompact();
  }

  private appendLine(op: WalOp): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(op) + "\n", "utf8");
    this.stat.appended++;
    this.bumpLine();
  }

  private bumpLine(): void {
    this.linesOnDisk++;
  }

  /**
   * 压实阈值：记忆是「每读一次抬一次激活」的写放大场景，一条记录会被反复 put。
   * 不压实的话 20 条记忆也能长成 1 MB，启动回放越来越慢。阈值给「记录数的 6 倍」，最少 400 行。
   */
  private maybeCompact(): void {
    if (this.linesOnDisk > Math.max(400, this.records.size * 6)) this.compact();
  }

  /** 磁盘上的行数（用于压实判据；compact 后同步） */
  private linesOnDisk = 0;

  /** 回放后的全量快照（按 id 升序，稳定输出，便于 diff 与测试） */
  snapshot(): MemoryRecord[] {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  size(): number {
    return this.records.size;
  }

  stats(): Readonly<WalStats> {
    return { ...this.stat };
  }

  /**
   * 压实：把当前快照写成临时文件再 rename 覆盖。
   * rename 是原子的，断电最多丢最后几条 append，不会留下半个存档。
   */
  compact(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.compact-${process.pid}.tmp`;
    const body = this.snapshot().map((rec) => JSON.stringify({ op: "put", rec })).join("\n");
    writeFileSync(tmp, body + (body ? "\n" : ""), "utf8");
    renameWithRetry(tmp, this.path);
  }
}
