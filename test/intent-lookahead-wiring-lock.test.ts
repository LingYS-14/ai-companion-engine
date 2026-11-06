/**
 * lookahead 接线锁（task-193 / design v3）。
 *
 * 为什么用源码锁：整段接线在 main.mjs 的 tick 作用域里，任何一处顺序写反
 * （比如先 ensureSpokenRecord 再覆盖 outlet、失败分支只改内存不写盘）
 * 都不会让测试变红，却会让「到点的旧意图」永远浮不出来或永远重复浮现。
 * 这里锁的是顺序与字面量，行为测试见 intent-lookahead.test.ts。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseIntentionFile,
  serializeIntentionFile,
} from "../src/orchestrator/intent/intent-file.js";
import { recordSurfacedFailure } from "../src/orchestrator/intent/close-loop.js";
import { pickSpeakableIntention } from "../src/orchestrator/intent/intent-lifecycle.js";
import { newIntention } from "../src/orchestrator/intent/bus.js";
import type { IntentionRecord } from "../src/orchestrator/intent/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");
const NOW = Date.UTC(2026, 9, 31, 2, 0, 0);
const AT = new Date(NOW).toISOString();

function indexOrFail(needle: string): number {
  const index = main.indexOf(needle);
  expect(index, `main.mjs 里找不到：${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

function rec(overrides: Partial<IntentionRecord> = {}): IntentionRecord {
  return {
    ...newIntention({
      id: "itn-reach_out-1",
      at: AT,
      kind: "reach_out",
      goal: "想找用户说句话",
      why: "因为想有人陪",
    }),
    ...overrides,
  };
}

describe("task-193 接线顺序锁（main.mjs）", () => {
  it("dueIntentionsSafe 在 pickSpeakableIntention 之前（先算到点，再考虑 F240 重提）", () => {
    expect(indexOrFail("dueIntentionsSafe(pruned.records")).toBeLessThan(
      indexOrFail("pickSpeakableIntention(pruned.records)"),
    );
  });

  it("写侧：newIntention 入参带 deriveTrigger(kind, nowMs)", () => {
    expect(main).toContain("trigger: deriveTrigger(kind, nowMs),");
  });

  it("resolveEffectiveOutlet 在 ensureSpokenRecord 之前（覆盖出口再补建记录）", () => {
    expect(indexOrFail("resolveEffectiveOutlet({ due: dueHit, speakable, outlet })")).toBeLessThan(
      indexOrFail("ensureSpokenRecord({"),
    );
  });

  it("due 先激活+落盘：upsertIntention(speakRecords, activate(dueHit)) 之后紧跟 writeIntentionsFile", () => {
    const activateIndex = indexOrFail("upsertIntention(speakRecords, activate(dueHit))");
    const writeIndex = main.indexOf("writeIntentionsFile(speakRecords)", activateIndex);
    expect(writeIndex).toBeGreaterThan(activateIndex);
    // 先落盘再走 ensureSpokenRecord（顺序保证）
    expect(writeIndex).toBeLessThan(indexOrFail("ensureSpokenRecord({"));
  });

  it("topRecord 是 let，且 due 胜出时被 dueHit 覆盖", () => {
    const letIndex = indexOrFail("let topRecord =");
    const overrideIndex = main.indexOf("topRecord = dueHit", letIndex);
    expect(overrideIndex).toBeGreaterThan(letIndex);
  });

  it("lastIntentContext 构造里带 lookaheadSurfacedId（B1-b）", () => {
    // P2a/T2：形状与 goal 的汇聚搬进 close-loop.intentContextOf（main 只调用）
    const start = indexOrFail("lastIntentContext = intentContextOf({");
    const end = main.indexOf("});", start);
    const block = main.slice(start, end);
    expect(block).toContain("lookaheadSurfacedId");
  });

  it("失败分支是「重新读表 → 记账 → 写回」三步（B1-a），且不重试", () => {
    const start = indexOrFail("else if (intentCtx?.lookaheadSurfacedId !== undefined && r.verdict !== \"held\")");
    const end = main.indexOf("// 批次1B", start);
    const block = main.slice(start, end);
    const readIndex = block.indexOf("readIntentionsFile()");
    const recordIndex = block.indexOf("recordSurfacedFailure({");
    const writeIndex = block.indexOf("writeIntentionsFile(failed.records)");
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(readIndex);
    expect(writeIndex).toBeGreaterThan(recordIndex);
    expect(block).toContain("不自动重提");
  });

  it("ACE_LOOKAHEAD=0 只关读侧：写侧 deriveTrigger 不在 lookaheadEnabled 分支里", () => {
    expect(main).toContain('const lookaheadEnabled = process.env.ACE_LOOKAHEAD !== "0";');
    const deriveIndex = indexOrFail("trigger: deriveTrigger(kind, nowMs),");
    const guardIndex = indexOrFail("if (lookaheadEnabled) {");
    expect(deriveIndex).toBeLessThan(guardIndex);
    const guarded = main.slice(guardIndex, main.indexOf("const lookaheadSurfacedId", guardIndex));
    expect(guarded).toContain("dueIntentionsSafe");
  });
});

describe("recordSurfacedFailure：到点浮现后没发出去 → held，不自动重提", () => {
  it("pending → held，attempts +1、act=lookahead_surface、outcome=noop", () => {
    const records = [rec()];
    const result = recordSurfacedFailure({ records, intentionId: records[0]?.id, nowMs: NOW });
    expect(result.failed).not.toBeNull();
    const failed = result.failed as IntentionRecord;
    expect(failed.status).toBe("held");
    expect(failed.attempts).toHaveLength(1);
    expect(failed.attempts[0]?.act).toBe("lookahead_surface");
    expect(failed.attempts[0]?.outcome).toBe("noop");
    expect(failed.survival).toBe(1);
    expect(result.note).toContain("不自动重提");
    // 核心：held 不在 pending/active 集合里 → 下一拍不会被重提
    expect(pickSpeakableIntention(result.records)).toBeNull();
  });

  it("从文件重读后仍不会被重提（B1-a：必须真的写回）", () => {
    const result = recordSurfacedFailure({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    const raw = serializeIntentionFile(result.records, NOW);
    const parsed = parseIntentionFile(raw);
    expect(parsed.errors).toEqual([]);
    expect(pickSpeakableIntention(parsed.file?.records ?? [])).toBeNull();
  });

  it("done/dropped 不动；没 id / 表里没有 / 非法参数都不记", () => {
    for (const status of ["done", "dropped"] as const) {
      const records = [rec({ status })];
      const result = recordSurfacedFailure({ records, intentionId: records[0]?.id, nowMs: NOW });
      expect(result.records).toBe(records);
      expect(result.failed).toBeNull();
      expect(result.note).toContain("已了结");
    }
    const records = [rec()];
    expect(recordSurfacedFailure({ records, intentionId: null, nowMs: NOW }).failed).toBeNull();
    expect(recordSurfacedFailure({ records, intentionId: "itn-nope", nowMs: NOW }).failed).toBeNull();
    expect(() =>
      recordSurfacedFailure({ records: [], intentionId: null, nowMs: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      recordSurfacedFailure({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW, agency: 1.5 }),
    ).toThrow(RangeError);
  });
});
