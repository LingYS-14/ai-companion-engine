/**
 * §5.2 working self 闸门接进真实召回路径（调用侧）——F200。
 *
 * 守三件事：
 *   1. 过滤只发生在调用侧：不传 workingSelf 时行为与以前逐字节一致（取 3 条、无诊断）；
 *   2. 传了才多取行、才过滤，且返回值仍是"给人看的短句"，诊断单独挂在 workingSelf 上；
 *   3. 诊断的口径是实的：过滤率高要报警，具体性按"像一回事"的命中比例算，没命中是 null 不是 0。
 */

import { describe, expect, it } from "vitest";

import type { BrainPort, KnowledgeReader } from "../src/ports/index.js";
import type { RecallRow } from "../src/dialogue/turn-result.js";
import { recallForDialogue } from "../src/dialogue/recall.js";
import type { Personality } from "../src/engine/personality.js";
import {
  NO_RANKING_VALUES,
  WORKING_SELF_RETRIEVE,
  concretenessOfRows,
  describeWorkingSelfAlarm,
  filterRecallRows,
  workingSelfValuesFrom,
} from "../src/orchestrator/intent/working-self-recall.js";

function row(id: string, tags: readonly string[], content = `记忆 ${id}`): RecallRow {
  return { id, score: 0.5, semantic: 0.1, content, tags, underTaint: false };
}

function values(overrides: Partial<Record<"care" | "truth" | "freedom" | "beauty" | "belonging" | "mastery", number>> = {}) {
  return { ...NO_RANKING_VALUES, ...overrides };
}

interface FakeOptions {
  readonly rows: readonly RecallRow[];
  readonly limitSeen?: number[];
}

function fakeRuntime(opts: FakeOptions): BrainPort & KnowledgeReader {
  return {
    recall(_query: string, limit?: number) {
      if (opts.limitSeen !== undefined) opts.limitSeen.push(limit ?? 0);
      return opts.rows.slice(0, limit ?? opts.rows.length);
    },
    searchKnowledge() {
      return [];
    },
    recentKnowledge() {
      return [];
    },
  } as unknown as BrainPort & KnowledgeReader;
}

describe("filterRecallRows：调用侧过滤，不改分数", () => {
  it("没有价值标注、没有目标时全部保留（fail-open）", () => {
    const rows = [row("a", ["日常"]), row("b", [])];
    const out = filterRecallRows(rows);
    expect(out.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.report.filterRate).toBe(0);
    expect(out.report.kept).toBe(2);
  });

  it("价值标注与 B 层冲突时拦下，且不给拦下的行改分数", () => {
    const rows = [row("keep", ["value:care"]), row("drop", ["value:care"])];
    const out = filterRecallRows(rows, { values: values({ care: 0 }) });
    expect(out.rows).toHaveLength(0);
    expect(out.dropped).toEqual(["keep", "drop"]);
    expect(rows[0]?.score).toBe(0.5);
  });

  it("意图有标签但记忆没有交集时按目标不一致拦下", () => {
    const rows = [row("work", ["工作"]), row("family", ["家人"])];
    const out = filterRecallRows(rows, {
      intent: { id: "itn-1", goal: "陪家人", tags: ["家人"] },
    });
    expect(out.rows.map((r) => r.id)).toEqual(["family"]);
    expect(out.report.filterRate).toBe(0.5);
  });

  it("具体性按「像一回事」的命中比例算；一条都没命中时是 null 而不是 0", () => {
    expect(concretenessOfRows([])).toBeNull();
    expect(concretenessOfRows([row("a", ["episode"]), row("b", ["episode"]), row("c", [])])).toBeCloseTo(2 / 3, 6);
  });

  it("一行摘要里同时有过滤结果与具体性", () => {
    const out = filterRecallRows([row("a", ["episode"])]);
    expect(out.report.note).toContain("working self");
    expect(out.report.note).toContain("具体性 100%");
  });
});

describe("describeWorkingSelfAlarm：只在真的报警时说话", () => {
  it("没有报警返回 null（命中全是情景记忆时）", () => {
    const out = filterRecallRows([row("a", ["episode"])]);
    expect(out.report.concreteness).toBe(1);
    expect(describeWorkingSelfAlarm(out.report)).toBeNull();
  });

  it("命中都不像情景记忆时给 concreteness-low：诊断里有，但不单独刷日志（摘要里可见）", () => {
    const out = filterRecallRows([row("a", []), row("b", [])]);
    expect(out.report.alarms).toContain("concreteness-low");
    expect(describeWorkingSelfAlarm(out.report)).toBeNull();
    expect(out.report.note).toContain("具体性 0%");
  });

  it("检索 ≥20 条且过滤率 >90% 时给出 filter-rate-high", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`m${String(i)}`, ["value:beauty"]));
    const out = filterRecallRows(rows, { values: values({ beauty: 0 }) });
    const line = describeWorkingSelfAlarm(out.report);
    expect(out.report.alarms).toContain("filter-rate-high");
    expect(line).not.toBeNull();
    expect(line ?? "").toContain("filter-rate-high");
  });
});

describe("workingSelfValuesFrom：人格卡没给排序时不过滤", () => {
  it("没有人格卡 = 全 1（fail-open）", () => {
    expect(workingSelfValuesFrom(null)).toEqual(NO_RANKING_VALUES);
    expect(workingSelfValuesFrom(undefined)).toEqual(NO_RANKING_VALUES);
  });

  it("有人格卡时用 B 层权重", () => {
    const p = { b: { care: 0.28, truth: 0.16, freedom: 0.16, beauty: 0.22, belonging: 0.12, mastery: 0.06 } } as unknown as Personality;
    expect(workingSelfValuesFrom(p).beauty).toBeCloseTo(0.22, 6);
  });
});

describe("recallForDialogue 接线：不传就是旧行为", () => {
  it("不传 workingSelf：只取 3 条、不带诊断", () => {
    const limitSeen: number[] = [];
    const rows = [row("a", []), row("b", []), row("c", []), row("d", []), row("e", [])];
    const r = recallForDialogue(fakeRuntime({ rows, limitSeen }), "在吗", undefined, "gui");
    expect(limitSeen).toEqual([3]);
    expect(r.memories).toHaveLength(3);
    expect(r.workingSelf).toBeUndefined();
  });

  it("传了 workingSelf：多取行、按闸门过滤、短句仍最多 3 条", () => {
    const limitSeen: number[] = [];
    const rows = [
      row("drop1", ["value:beauty"]),
      row("drop2", ["value:beauty"]),
      row("keep1", ["日常"]),
      row("keep2", ["日常"]),
      row("keep3", ["日常"]),
    ];
    const r = recallForDialogue(fakeRuntime({ rows, limitSeen }), "在吗", undefined, "gui", {
      values: values({ beauty: 0 }),
    });
    expect(limitSeen).toEqual([WORKING_SELF_RETRIEVE]);
    expect(r.memories).toEqual(["记忆 keep1", "记忆 keep2", "记忆 keep3"]);
    expect(r.workingSelf?.retrieved).toBe(5);
    expect(r.workingSelf?.kept).toBe(3);
    expect(r.workingSelf?.filterRate).toBeCloseTo(0.4, 6);
  });

  it("放宽系数 1.2 把价值门槛降到 1/1.2：原本压线的记忆被放过；不传则照旧拦", () => {
    const rows = [{ id: "border", tags: ["value:beauty"] as const }];
    const base = filterRecallRows(rows, { values: values({ beauty: 0.18 }) });
    expect(base.rows.map((r) => r.id)).toEqual([]);
    expect(base.dropped).toEqual(["border"]);
    const relaxed = filterRecallRows(rows, { values: values({ beauty: 0.18 }), relaxFactor: 1.2 });
    expect(relaxed.rows.map((r) => r.id)).toEqual(["border"]);
    expect(relaxed.report.note).toContain("门槛降为");
    // 1.0 与不传等价
    expect(filterRecallRows(rows, { values: values({ beauty: 0.18 }), relaxFactor: 1 }).dropped).toEqual(["border"]);
  });

});
