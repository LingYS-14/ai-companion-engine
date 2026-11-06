/**
 * 执行事件日志：追加式、可重放（审计 S4：日志必须带输入/结果摘要与尝试次数）。
 *
 * 一行一个事件，`data/execution/events.ndjson`。只记摘要，不记正文（避免把聊天内容写进工程日志）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ExecutionEvent {
  readonly at: number;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly toolId: string;
  readonly subject: string;
  readonly target?: string;
  readonly status: "start" | "succeeded" | "deduplicated" | "failed" | "rate-limited";
  readonly attempt: number;
  readonly durationMs: number;
  readonly failureClass?: string;
  /** 输入摘要（只留长度与前 32 字符，足够定位，不足以泄漏隐私） */
  readonly inputDigest?: string;
  readonly resultDigest?: string;
}

/** 输入摘要：不看语义，只留形状。 */
export function digestInput(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  const head = text.length <= 32 ? text : `${text.slice(0, 32)}…`;
  return `${String(text.length)}:${head}`;
}

export function appendExecutionEvent(file: string, event: ExecutionEvent): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}
