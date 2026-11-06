/**
 * 单写者锁。
 *
 * 她的进程与开发会话（DSH Host 里的插件）都可能写同一批状态文件。`docs/OPERATIONS.md` 的约定是：
 * 同一时刻只有拿到锁的一方写状态；另一方只读，或等锁过期。
 *
 * 锁是**建议性**的：进程被 SIGKILL 时不会自己释放，所以写入心跳（`heartbeatAt`），
 * 超过 `lockStaleMs` 没有心跳的锁视为陈旧，可以被接管。接管要写审计日志（由调用方打）。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** 锁文件格式版本：老版本（宿主残留的长心跳定时器）没有 version 字段，直接视为陈旧 */
export const WRITER_LOCK_VERSION = 2;

export interface WriterLockRecord {
  readonly version: number;
  readonly pid: number;
  readonly owner: string;
  /** 最近一次心跳（毫秒时间戳） */
  readonly heartbeatAt: number;
  readonly note: string;
}

export interface WriterLock {
  readonly path: string;
  readonly pid: number;
  readonly owner: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 进程是否还活着（持有者被强杀时，锁会停在最后一跳心跳上） */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但不是我们能碰的（照样算活着）；ESRCH：确实没了
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读锁文件；不存在或坏档返回 null（坏档不应阻止启动，调用方会直接覆盖） */
export function readWriterLock(path: string): WriterLockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const { version, pid, owner, heartbeatAt, note } = parsed;
    // 没有 version 或版本不符：不是这一代代码写的锁，一律当没有锁（否则旧定时器的心跳会永久霸占）
    if (version !== WRITER_LOCK_VERSION) return null;
    if (typeof pid !== "number" || typeof owner !== "string" || typeof heartbeatAt !== "number") return null;
    return { version, pid, owner, heartbeatAt, note: typeof note === "string" ? note : "" };
  } catch {
    return null;
  }
}

/**
 * 尝试拿锁：
 * - 没有锁 → 拿；
 * - 锁是本进程的 → 续心跳，视为成功；
 * - 别的进程、但心跳已超过 staleMs → 接管；
 * - 别的进程、心跳还新 → 返回 null（让调用方跳过这一轮，别硬写）。
 */
export function acquireWriterLock(input: {
  readonly path: string;
  readonly pid: number;
  readonly owner: string;
  readonly now: number;
  readonly staleMs: number;
  readonly note?: string;
}): WriterLock | null {
  const existing = readWriterLock(input.path);
  // 两个"陈旧"判据：心跳超时，或持有者进程已经不在了（后者比心跳更可靠——被强杀时不会写最后一跳）
  const stale =
    existing !== null &&
    (input.now - existing.heartbeatAt > input.staleMs || !pidAlive(existing.pid));
  const takeover = existing !== null && existing.pid !== input.pid && stale;
  if (existing !== null && existing.pid !== input.pid && !stale) return null;
  const record: WriterLockRecord = {
    version: WRITER_LOCK_VERSION,
    pid: input.pid,
    owner: input.owner,
    heartbeatAt: input.now,
    note: input.note ?? (takeover ? `takeover from ${String(existing?.pid)}` : ""),
  };
  const tmp = `${input.path}.tmp-${String(input.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, input.path);
  return { path: input.path, pid: input.pid, owner: input.owner };
}

/** 续心跳（只在自己持锁时写；不检查归属，调用方应先 acquire） */
export function heartbeatWriterLock(lock: WriterLock, now: number, note = ""): void {
  const record: WriterLockRecord = { version: WRITER_LOCK_VERSION, pid: lock.pid, owner: lock.owner, heartbeatAt: now, note };
  const tmp = `${lock.path}.tmp-${String(lock.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, lock.path);
}

/** 释放锁：只删自己 pid 的锁文件，避免把别人的锁删掉 */
export function releaseWriterLock(lock: WriterLock): void {
  const existing = readWriterLock(lock.path);
  if (existing === null || existing.pid !== lock.pid) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // 已经被别人删掉/接管：不算错误
  }
}
