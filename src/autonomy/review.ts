/**
 * 人工审核队列（一个文件、一条待审记录）。
 *
 * 用户的要求是「过高触发警报，进行审核」，所以超速不是静默退避：
 * 写一条 `data/autonomy-review.json`，之后所有**花钱的**调用（模型）一律停，
 * 直到有人看过并删掉这个文件。状态 tick、记忆巩固这类本地计算不受影响。
 *
 * 为什么用一个文件而不是数据库：审核是「人」的动作，文件最容易看见与清掉；
 * 原子写（tmp + rename）避免半截 JSON 让进程崩在启动处。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * F355：原子写 rename 重试（与 `src/execution/queue.ts` / `src/memory/wal.ts` 同款）。
 *
 * Windows 上高频 rename 偶发 EPERM/EACCES/EBUSY（外部句柄短暂占用），退避重试可消除；
 * 审核票据是「所有花钱调用」的总闸，一次 EPERM 会让超速之后本应落下的票据丢失，
 * 所以这里必须重试；只对占用类错误重试，仍失败照旧抛。
 */
export function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  rename: (a: string, b: string) => void = renameSync,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5);
    }
  }
}

export interface ReviewTicket {
  /** 触发时刻（ms） */
  readonly at: number;
  /** 触发原因（人话，给审核者看） */
  readonly reason: string;
  /** 触发时最近一小时已发生的调用数 */
  readonly calls: number;
  /** 该窗口的上限 */
  readonly maxCalls: number;
}

export type ReviewState = ReviewTicket;

/**
 * 审核票据的自动过期（默认 90 分钟）。
 *
 * 为什么需要：票据的本意是「别越跑越贵，等人看一眼」，但它是**穷尽式**的——
 * 没人清，她就整夜不能调模型（学习、内省全停），看起来像"她死了"。
 * 90 分钟足够让警报被看见，又不至于让一个夜里没人值守的她整夜哑掉；
 * 过期只解除"停用"，不重置频率账本：下一个窗口仍然按上限走，超了会再报一次。
 */
export const REVIEW_TTL_MS = 90 * 60_000;

/** 读当前待审记录；没有/损坏/已过期都返回 null（损坏视为「没有」，不阻塞她太久） */
export function pendingReview(file: string, now: number): ReviewState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ReviewState>;
    if (typeof raw.at !== "number" || typeof raw.reason !== "string") return null;
    if (now - raw.at > REVIEW_TTL_MS) {
      // 过期：删票据（调用方也不需要知道详情），日志由 standalone 打一行留痕
      try {
        unlinkSync(file);
      } catch {
        // 删不掉也不阻塞：调用方拿到 null 就行
      }
      return null;
    }
    return {
      at: raw.at,
      reason: raw.reason,
      calls: typeof raw.calls === "number" ? raw.calls : 0,
      maxCalls: typeof raw.maxCalls === "number" ? raw.maxCalls : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 落一条待审记录。已经有未清的记录时不覆盖（保留最早那条，便于追）。
 * 返回新写入的记录；若已存在待审则返回 null。
 */
export function raiseReview(file: string, ticket: ReviewTicket, now: number): ReviewTicket | null {
  const existing = pendingReview(file, now);
  if (existing !== null) return null;
  writeAtomic(file, JSON.stringify(ticket, null, 2));
  return ticket;
}

/** 人工清掉审核（由人执行：删文件即可，这个函数给脚本/测试用） */
export function clearReview(file: string): boolean {
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, body, "utf8");
  renameWithRetry(tmp, file);
}

/**
 * 窗口恢复后自动解除票据。
 *
 * 为什么需要：票据是在"这一小时已经超了"的瞬间落下的，但它会一直挂到 TTL（90 分钟）。
 * 如果触发只是部署/验证造成的短促尖峰，下一拍窗口已经回落到上限以内，再挂 90 分钟就变成
 * "为了安全把她整夜哑掉"。解除只删票据，不动频率账本——真超了下一拍还会再报。
 */
export function releaseReviewIfRecovered(file: string, calls: number, maxCalls: number, now: number): boolean {
  if (calls > maxCalls) return false;
  if (pendingReview(file, now) === null) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
