/**
 * 落盘待办队列（P1）：执行层"崩溃恢复"的载体。
 *
 * 为什么需要：`at-least-once` 的动作（抓取/入库）允许重发，但不能丢；进程被关机脚本
 * 或崩溃杀掉时，正在跑的那条必须能在下次启动被认出来并重试。`at-most-once` 的动作
 * （发消息）不进这个队列——它们由幂等存储的 failed 记录拦住，宁可失败也不重发。
 *
 * 状态机：pending → running →（ack）done ／（失败）pending（attempts+1，可带退避）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export interface PendingItem {
  readonly id: string;
  readonly toolId: string;
  readonly input: unknown;
  readonly subject: string;
  readonly target?: string;
  readonly enqueuedAt: number;
  readonly attempts: number;
  readonly notBefore: number;
  readonly state: "pending" | "running";
}

interface QueueFile {
  readonly version: number;
  readonly items: PendingItem[];
}

export class PendingQueue {
  private readonly file: string;
  private items: PendingItem[];

  private constructor(file: string, items: PendingItem[]) {
    this.file = file;
    this.items = items;
  }

  /**
   * 打开队列并做崩溃恢复：上次退出时还在 running 的条目，说明结果未知——
   * 对 at-least-once 而言可以重试，于是退回 pending 并把 attempts + 1（保留证据）。
   */
  static open(file: string, now: number): { queue: PendingQueue; recovered: number } {
    let items: PendingItem[] = [];
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as QueueFile;
        items = Array.isArray(raw.items) ? raw.items.filter((item) => typeof item?.id === "string") : [];
      } catch {
        items = [];
      }
    }
    let recovered = 0;
    items = items.map((item) => {
      if (item.state !== "running") return item;
      recovered += 1;
      return {
        ...item,
        state: "pending" as const,
        attempts: item.attempts + 1,
        notBefore: Math.min(item.notBefore, now),
      };
    });
    const queue = new PendingQueue(file, items);
    if (recovered > 0) queue.flush(now);
    return { queue, recovered };
  }

  enqueue(input: {
    readonly id: string;
    readonly toolId: string;
    readonly input: unknown;
    readonly subject: string;
    readonly target?: string;
    readonly now: number;
    readonly notBefore?: number;
  }): PendingItem {
    const item: PendingItem = {
      id: input.id,
      toolId: input.toolId,
      input: input.input,
      subject: input.subject,
      ...(input.target === undefined ? {} : { target: input.target }),
      enqueuedAt: input.now,
      attempts: 0,
      notBefore: input.notBefore ?? input.now,
      state: "pending",
    };
    this.items = [...this.items, item];
    this.flush(input.now);
    return item;
  }

  /** 到点可跑的条目（按入队顺序；不自动出队，由调用方 claim 后标 running）。 */
  due(now: number): readonly PendingItem[] {
    return this.items.filter((item) => item.state === "pending" && item.notBefore <= now);
  }

  /** 标记为执行中（落盘；崩溃后会被 open 恢复成 pending）。 */
  claim(id: string, now: number): void {
    this.items = this.items.map((item) => (item.id === id ? { ...item, state: "running" as const } : item));
    this.flush(now);
  }

  /** 执行成功：出队。 */
  ack(id: string, now: number): void {
    this.items = this.items.filter((item) => item.id !== id);
    this.flush(now);
  }

  /**
   * 人工取消：把条目从队列里拿掉（pending 与 running 都可取消）。
   * 返回是否真的删掉了——取消一个不存在的 id 不写盘，避免无意义的重写。
   */
  cancel(id: string, now: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    this.flush(now);
    return true;
  }

  /** 执行失败：退回 pending，记一次尝试并按退避推迟。 */
  retryLater(id: string, now: number, delayMs: number): void {
    this.items = this.items.map((item) =>
      item.id === id
        ? { ...item, state: "pending" as const, attempts: item.attempts + 1, notBefore: now + Math.max(0, delayMs) }
        : item,
    );
    this.flush(now);
  }

  get size(): number {
    return this.items.length;
  }

  all(): readonly PendingItem[] {
    return this.items;
  }

  private flush(now: number): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = JSON.stringify({ version: 1, savedAt: now, items: this.items }, null, 2);
    const tmp = `${this.file}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, body, "utf8");
    renameWithRetry(tmp, this.file);
  }
}
