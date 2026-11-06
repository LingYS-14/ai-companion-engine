/**
 * F350 I1 装配接线锁：同题 24h 去重必须在 due 激活之前判定；
 * 命中时只把出口降为 journal（不开口、不写盘）。
 *
 * 这是源码/顺序锁，不跑真实 tick：实现挪位置或改条件时这里必须红。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(root, "scripts", "autonomy", "main.mjs"), "utf8");

function indexOrFail(needle: string): number {
  const at = main.indexOf(needle);
  expect(at, `main.mjs 里找不到：${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

function repeatBlock(): string {
  const start = indexOrFail("const repeatHit =");
  const end = main.indexOf("// 批次1B", start);
  expect(end, "找不到 repeat 块之后的「批次1B」标记").toBeGreaterThan(start);
  return main.slice(start, end);
}

describe("F350 I1：同题去重的装配顺序与副作用（源码锁）", () => {
  it("顺序锁：findRecentRepeat 判定在 due 激活之前、ensure 之前", () => {
    const sourcesAt = indexOrFail("const outletSources = sourcesForOutlet(");
    const repeatAt = indexOrFail("const repeatHit =");
    const dueAt = indexOrFail("upsertIntention(speakRecords, activate(dueHit))");
    const ensureAt = indexOrFail("ensureSpokenRecord({");
    expect(repeatAt).toBeGreaterThan(sourcesAt);
    expect(dueAt).toBeGreaterThan(repeatAt);
    expect(ensureAt).toBeGreaterThan(dueAt);
  });

  it("条件锁：dueHit === null 短路，且只在 speak 出口判定", () => {
    const block = repeatBlock();
    expect(block).toContain('dueHit === null && effectiveOutlet.target === "speak"');
    expect(block).toContain("findRecentRepeat({");
    expect(block).toContain("goal: effectiveOutlet.line ?? top?.goal ?? null");
  });

  it("常量锁：窗口写死 24h，判定确实用 REPEAT_SPEAK_WINDOW_MS", () => {
    expect(main).toContain("const REPEAT_SPEAK_WINDOW_MS = 24 * 60 * 60 * 1000;");
    expect(repeatBlock()).toContain("windowMs: REPEAT_SPEAK_WINDOW_MS,");
  });

  it("副作用锁：命中只改 journal，且块内不写盘", () => {
    const block = repeatBlock();
    expect(block).toContain("effectiveOutlet = {");
    expect(block).toContain('target: "journal"');
    expect(block).toContain("重复：");
    expect(block).not.toContain("writeIntentionsFile(");
  });
});
