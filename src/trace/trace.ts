/**
 * §1.2 INV-2：trace 管线（非阻塞 append → 攒批 flush → NDJSON 段 → 反查）。
 *
 * 为什么要有它：没有 trace，"她为什么这么说"就只能靠猜。规格 §12.1 的第 2 条硬指标是
 * **1 分钟定位一句台词的来龙去脉**（当时什么模式、什么状态、召回了什么、走了哪条策略），
 * V52-GAP M1-03/M12-01 记的是"整套管线不存在，`trace` 布尔只控制一条 bond 日志"。
 *
 * 设计取舍（都是为了"不能因为写日志而卡住她"）：
 * - **攒批**：每条记录先进内存，攒够 `TRACE_BUFFER_SIZE`（200）或定时器到点（5 秒）才落盘。
 *   一次 `appendFileSync` 写完一批，比每轮一次 open/write/close 便宜一个数量级。
 * - **非阻塞的边界**：落盘仍然是同步的（NDJSON + fsync 之外的简单 append），但它发生在
 *   定时器回调里，不在对话路径上；写失败只记错误计数，绝不抛进她的回合。
 * - **崩溃窗口**：进程被强杀时，内存里最多丢"最后 5 秒"的记录——这就是规格说的"最坏丢 5s"。
 *   正常关机走 `flush()`（`main.mjs` 的 shutdown 会调 `runtime.flush()`）。
 * - **追加式**：只 append，不改写；反查靠读整段文件过滤，够小的时候不需要索引。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** 一条 trace：一次回合（或一个子系统事件）的"为什么" */
export interface TraceRecord {
  /** 落盘时刻（epoch ms） */
  readonly at: number;
  /** 反查用的 id：`tr-<now36>-<seq36>` */
  readonly traceId: string;
  /** 记录种类：turn / advance / consolidate / proactive… */
  readonly kind: string;
  /** 其余字段原样进 NDJSON（必须可 JSON 序列化） */
  readonly [key: string]: unknown;
}

export interface TraceLogOptions {
  readonly path: string;
  /** 攒多少条就强制落盘（knob TRACE_BUFFER_SIZE＝200） */
  readonly capacity: number;
  /** 定时落盘间隔毫秒（knob TRACE_FLUSH_INTERVAL_SEC＝5） */
  readonly flushIntervalMs: number;
  /** 出错回调（默认静默：日志坏了不该让她崩） */
  readonly onError?: (err: unknown) => void;
}

export interface TraceStats {
  readonly pending: number;
  readonly flushed: number;
  readonly errors: number;
}

/**
 * 攒批写盘器。
 *
 * 故意不实现"环形缓冲丢旧记录"：容量满就落盘，比覆盖更诚实——她是常驻进程，
 * 丢掉的记录就是"查不到原因的那一段"，没有理由主动丢。
 */
export class TraceLog {
  private buffer: TraceRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushed = 0;
  private errors = 0;

  constructor(private readonly opts: TraceLogOptions) {}

  /** 入队一条；攒满容量立刻落盘。永不抛。 */
  record(rec: TraceRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length >= this.opts.capacity) this.flush();
  }

  /** 把缓冲区写完；返回这次写了几条。永不抛。 */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer;
    this.buffer = [];
    const lines = batch.map((rec) => JSON.stringify(rec)).join("\n");
    try {
      appendFileSync(this.opts.path, `${lines}\n`, "utf8");
      this.flushed += batch.length;
      return batch.length;
    } catch (err) {
      this.errors += 1;
      this.opts.onError?.(err);
      // 写不进去的记录不再放回缓冲区：反复重试只会把内存越堆越大，
      // 而 trace 的用途是"排查"，不是"一个字节都不能丢"。
      return 0;
    }
  }

  /** 起定时器（unref：不因为它把进程留住）；重复调用是幂等的。 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.flush();
    }, this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  stats(): TraceStats {
    return { pending: this.buffer.length, flushed: this.flushed, errors: this.errors };
  }

  get path(): string {
    return this.opts.path;
  }
}

export interface ReadTraceOptions {
  /** 按 traceId 取（精确匹配） */
  readonly id?: string;
  /** 取最后 n 条 */
  readonly last?: number;
  /** 只取某个 kind */
  readonly kind?: string;
}

/**
 * 反查：读整段 NDJSON 过滤。
 *
 * 坏行跳过（不抛）：trace 文件是诊断素材，一行写坏了不该让"查原因"这件事也失败。
 */
export function readTrace(path: string, opts: ReadTraceOptions = {}): TraceRecord[] {
  if (!existsSync(path)) return [];
  const rows: TraceRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as TraceRecord;
      if (typeof rec.traceId !== "string") continue;
      if (opts.id !== undefined && rec.traceId !== opts.id) continue;
      if (opts.kind !== undefined && rec.kind !== opts.kind) continue;
      rows.push(rec);
    } catch {
      // 半行（崩在写盘中间）：跳过
    }
  }
  if (opts.last !== undefined && rows.length > opts.last) return rows.slice(-opts.last);
  return rows;
}
