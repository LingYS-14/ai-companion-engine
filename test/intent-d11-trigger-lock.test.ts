/**
 * D11-2 源码锁：held 到点也会回来 + 开口失败也补 trigger。
 *
 * 行为已由 intent-lookahead.test.ts / intent-close-loop.test.ts 覆盖；
 * 这里只钉住"接线不许被悄悄改回去"，尤其是读侧两处共用 isDueNow、写侧三处都补 trigger、
 * main 的两路失败都由 allowlist 守门。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const lookahead = read("src/orchestrator/intent/lookahead.ts");
const closeLoop = read("src/orchestrator/intent/close-loop.ts");
const main = read("scripts/autonomy/main.mjs");

function indexOrFail(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `找不到源码片段：${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("D11-2 源码锁：held 到点 + 失败补 trigger", () => {
  it("isDueNow 同时认 pending 与 held；dueIntentions 与 dueIntentionsSafe 都经过它", () => {
    const start = indexOrFail(lookahead, "function isDueNow(");
    const end = lookahead.indexOf("\n}\n", start);
    const body = lookahead.slice(start, end);
    expect(body).toContain('record.status === "pending"');
    expect(body).toContain('record.status === "held"');
    expect(body).toContain("triggerDue(record.trigger, ctx)");

    const dueStart = indexOrFail(lookahead, "export function dueIntentions(");
    const dueEnd = indexOrFail(lookahead, "export interface LookaheadTable");
    expect(lookahead.slice(dueStart, dueEnd)).toContain("isDueNow(record, ctx)");

    const safeStart = indexOrFail(lookahead, "export function dueIntentionsSafe(");
    const safeEnd = indexOrFail(lookahead, "export function pickDueIntention(");
    const safeBody = lookahead.slice(safeStart, safeEnd);
    expect(safeBody).toContain("isDueNow(record, ctx)");
    // 逐条隔离语义仍在（坏 trigger 只进 skipped）
    expect(safeBody).toContain("skipped.push");
  });

  it("lookaheadTable 的 byType/nextAtMs 纳入带 trigger 的 held；total/withTrigger 口径不变", () => {
    const start = indexOrFail(lookahead, "export function lookaheadTable(");
    const end = indexOrFail(lookahead, "export interface DueResult");
    const body = lookahead.slice(start, end);
    expect(body).toContain('record.status !== "pending" && record.status !== "held"');
    expect(body).toContain("records.length");
    expect(body).toContain("records.filter((record) => record.trigger !== null)");
  });

  it("close-loop：ensure 重开清 trigger；三种失败记账都写 deriveTrigger", () => {
    expect(closeLoop).toContain(
      'const reopened: IntentionRecord = { ...record, status: "pending", blocked_by: null, trigger: null };',
    );
    const sites = closeLoop.split("trigger: deriveTrigger(record.kind, input.nowMs)").length - 1;
    // recordHeldAttempt / recordSurfacedFailure / recordSpeakFailure
    expect(sites).toBe(3);
  });

  it("main：两路失败都由 isFailedSpeakVerdict 守门，普通开口失败记账在 lookahead 之后", () => {
    expect(main.split("isFailedSpeakVerdict(r.verdict)").length - 1).toBe(2);
    const surfaced = indexOrFail(main, "recordSurfacedFailure({");
    const speakFailed = indexOrFail(main, "recordSpeakFailure({");
    expect(speakFailed).toBeGreaterThan(surfaced);
    // 旧 lookahead 外层字面量保持不变（既有 wiring lock 依赖），allowlist 放在块内
    const start = indexOrFail(
      main,
      'else if (intentCtx?.lookaheadSurfacedId !== undefined && r.verdict !== "held")',
    );
    const speakFailedElse = indexOrFail(main, "else if (isFailedSpeakVerdict(r.verdict)");
    const block = main.slice(start, speakFailedElse);
    expect(block).toContain("isFailedSpeakVerdict(r.verdict)");
    expect(block).toContain("不自动重提");
  });

  it("main：普通开口失败分支三步齐全，并打「+N 小时后再试」日志", () => {
    const start = indexOrFail(main, "else if (isFailedSpeakVerdict(r.verdict)");
    const end = main.indexOf("// 批次1B", start);
    expect(end).toBeGreaterThan(start);
    const block = main.slice(start, end);
    expect(block).toContain("readIntentionsFile()");
    expect(block).toContain("recordSpeakFailure({");
    expect(block).toContain("writeIntentionsFile(failed.records)");
    expect(block).toContain("小时后再试");
  });
});
