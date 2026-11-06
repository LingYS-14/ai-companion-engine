/**
 * 队列执行器（P2）：把落盘队列里的 at-least-once 动作真正跑起来，并负责重试/退避/死信。
 *
 * 为什么单列一个模块而不是塞进 gateway：网关的职责是"一次动作的正确性"（指纹、限速、失败分类、日志）；
 * 重试是"多次动作的策略"，它需要知道队列、退避、次数上限。混在一起会让 at-most-once 的通道也沾上重试语义。
 *
 * 铁律（对应 PLAN-SPINE / AUDIT-EXECUTION-LAYER）：
 * - 只处理**已经进队列**的条目；调用方负责决定"哪些动作允许进队"（只有 at-least-once 才允许）；
 * - 不猜结果：`run` 必须明确返回 ok / 不可重试失败 / 可重试失败；
 * - 到上限就丢弃并留日志（死信），不许无限重试把磁盘写满、把对端刷烦。
 */

import { retryableFor } from "./failure.js";
import type { PendingItem, PendingQueue } from "./queue.js";

export interface QueueRunResult {
  readonly ok: boolean;
  /** 失败是否值得再试（网络类 true；参数错/权限错 false） */
  readonly retryable?: boolean;
  readonly detail?: string;
}

export interface DrainOptions {
  /** 一次最多跑几条（默认 5）：给机器人留出处理消息的时间片 */
  readonly limit?: number;
  /** 第几次之后不再重试（默认 4） */
  readonly maxAttempts?: number;
  /** 退避基数（默认 5 秒）：delay = base * 2^attempts，封顶 10 分钟 */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface DrainDeps {
  readonly queue: PendingQueue;
  readonly now: () => number;
  readonly run: (item: PendingItem) => Promise<QueueRunResult>;
  readonly log?: (line: string) => void;
  readonly options?: DrainOptions;
}

export interface DrainOutcome {
  readonly attempted: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly dropped: number;
  readonly lines: readonly string[];
}

const DEFAULTS = {
  limit: 5,
  maxAttempts: 4,
  baseBackoffMs: 5_000,
  maxBackoffMs: 10 * 60_000,
} as const;

/** 指数退避：5s → 10s → 20s … 封顶 10 分钟。attempts 是"已经失败过几次"。 */
export function backoffFor(attempts: number, baseMs: number, maxMs: number): number {
  const exp = Math.max(0, Math.min(20, Math.trunc(attempts)));
  return Math.min(maxMs, baseMs * 2 ** exp);
}

/**
 * 跑一轮到期的队列条目。
 *
 * 崩溃安全：claim 会先落盘成 running，进程若在 `run` 中途被杀，下次 `PendingQueue.open`
 * 会把它退回 pending 且 attempts+1——所以"重试"不需要额外的恢复代码。
 */
export async function drainPending(deps: DrainDeps): Promise<DrainOutcome> {
  const limit = deps.options?.limit ?? DEFAULTS.limit;
  const maxAttempts = deps.options?.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseBackoffMs = deps.options?.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
  const maxBackoffMs = deps.options?.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const lines: string[] = [];

  const now = deps.now();
  const due = deps.queue
    .due(now)
    .slice()
    .sort((a, b) => (a.enqueuedAt === b.enqueuedAt ? a.id.localeCompare(b.id) : a.enqueuedAt - b.enqueuedAt))
    .slice(0, Math.max(0, limit));

  let succeeded = 0;
  let retried = 0;
  let dropped = 0;
  let attempted = 0;

  for (const item of due) {
    attempted += 1;
    deps.queue.claim(item.id, deps.now());
    let result: QueueRunResult;
    try {
      result = await deps.run(item);
    } catch (err) {
      result = {
        ok: false,
        retryable: retryableFor("TRANSIENT"),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const at = deps.now();
    if (result.ok) {
      deps.queue.ack(item.id, at);
      succeeded += 1;
      lines.push(`[queue] ok id=${item.id} tool=${item.toolId}`);
      continue;
    }
    if (result.retryable === false) {
      deps.queue.cancel(item.id, at);
      dropped += 1;
      lines.push(`[queue] dropped id=${item.id} tool=${item.toolId} reason=不可重试 ${result.detail ?? ""}`.trim());
      continue;
    }
    if (item.attempts + 1 >= maxAttempts) {
      deps.queue.cancel(item.id, at);
      dropped += 1;
      lines.push(`[queue] dead id=${item.id} tool=${item.toolId} attempts=${String(item.attempts + 1)} ${result.detail ?? ""}`.trim());
      continue;
    }
    const delay = backoffFor(item.attempts, baseBackoffMs, maxBackoffMs);
    deps.queue.retryLater(item.id, at, delay);
    retried += 1;
    lines.push(`[queue] retry id=${item.id} tool=${item.toolId} in=${String(delay)}ms ${result.detail ?? ""}`.trim());
  }

  for (const line of lines) deps.log?.(line);
  return { attempted, succeeded, retried, dropped, lines };
}
