/**
 * 失败分类（P2 从 gateway 内联抽出）：错误 → 四类之一 → 能不能重试。
 *
 * 为什么要单独一个模块：分类是**唯一**决定"要不要再发一次"的地方。
 * 发消息这类动作一旦分类错了，后果是重复打扰；所以这里只暴露一个 `retryableFor()`，
 * 其余代码不许自己写 `retryable: true`（H3 门禁会查）。
 */

import type { FailureClass, Idempotency } from "./types.js";

/** 这些字样的失败多半是"再试一次可能就好"（网络抖动、限流、上游 5xx） */
export const TRANSIENT_MARKERS = [
  "timeout",
  "timed out",
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "fetch failed",
  "network",
  "socket",
  "rate limit",
  "too many requests",
  "429",
  "502",
  "503",
  "504",
] as const;

export function isTransientError(err: unknown): boolean {
  const text = (err instanceof Error ? `${err.name} ${err.message}` : String(err)).toLowerCase();
  return TRANSIENT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 四类判定（顺序不可换）：
 * 1. 明显可重试的错误 → TRANSIENT；
 * 2. 发出去了但不可查询、又只能发一次 → INDETERMINATE（不猜、不重发、上报）；
 * 3. 其余 → PERMANENT。
 */
export function classifyFailure(
  err: unknown,
  semantics: { readonly idempotency: Idempotency; readonly queryable: boolean },
): FailureClass {
  if (isTransientError(err)) return "TRANSIENT";
  if (semantics.idempotency === "at-most-once" && !semantics.queryable) return "INDETERMINATE";
  return "PERMANENT";
}

/** 只有 TRANSIENT 允许重试；PARTIAL / INDETERMINATE 一律不重试（H3） */
const RETRYABLE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>(["TRANSIENT"]);

export function retryableFor(failureClass: FailureClass): boolean {
  return RETRYABLE_CLASSES.has(failureClass);
}
