/**
 * task-169 A：召回素材端的来源过滤（主动开口不再拿自述当素材）。
 *
 * 锁的是「宁缺勿滥」的两级补位：
 *   T1 = 非排除来源，最多 3 条；
 *   T2 = backfillSources（默认只有 proactive）至多 maxBackfill 条，仅补 T1 不足；
 *   selftalk / chat_reply 永不进 T2；全被排除时返回 0 条也不硬凑。
 */

import { describe, expect, it } from "vitest";

import type { BrainPort, KnowledgeReader, RecalledMemory } from "../src/ports/index.js";
import {
  recallForDialogue,
  type RecallFilterOptions,
} from "../src/dialogue/recall.js";
import { SELF_AUTHORED_SOURCES } from "../src/memory/echo-sources.js";

interface Captured {
  readonly query: string;
  readonly limit: number | undefined;
}

function rt(rows: readonly RecalledMemory[], captured: Captured[]): BrainPort & KnowledgeReader {
  const fake = {
    recall: (query: string, limit?: number) => {
      captured.push({ query, limit });
      return rows;
    },
    searchKnowledge: () => [],
    recentKnowledge: () => [],
  };
  return fake as unknown as BrainPort & KnowledgeReader;
}

function row(id: string, content: string, source?: string): RecalledMemory {
  return {
    id,
    content,
    score: 0.5,
    ...(source === undefined ? {} : { source }),
  };
}

function call(
  rows: readonly RecalledMemory[],
  options?: RecallFilterOptions,
  workingSelf?: Parameters<typeof recallForDialogue>[4],
): { memories: readonly string[]; limit: number | undefined } {
  const captured: Captured[] = [];
  const result = recallForDialogue(rt(rows, captured), "今晚想说什么", undefined, undefined, workingSelf, options);
  return { memories: result.memories, limit: captured[0]?.limit };
}

describe("旧调用零改动", () => {
  it("3–5 参、不传 options 时逐位不变：取前 3、limit=3", () => {
    const rows = [row("a", "第一条"), row("b", "第二条"), row("c", "第三条"), row("d", "第四条")];
    const out = call(rows);
    expect(out.memories).toEqual(["第一条", "第二条", "第三条"]);
    expect(out.limit).toBe(3);
  });
});

describe("来源过滤：T1 + T2 补位", () => {
  it("排除自述来源后先取真实互动，再用 1 条 proactive 补位", () => {
    const rows = [
      row("p1", "我主动说过：窗台的花开了", "proactive"),
      row("s1", "我自言自语过：夜里很安静", "selftalk"),
      row("c1", "我网页里说过：今天好累", "chat_reply"),
      row("r1", "他昨天说想去看海", "player"),
      row("r2", "他提过下周三要加班", "player"),
    ];
    const out = call(rows, {
      excludeSources: SELF_AUTHORED_SOURCES,
      backfillSources: ["proactive"],
      maxBackfill: 1,
    });
    expect(out.memories).toEqual(["他昨天说想去看海", "他提过下周三要加班", "我主动说过：窗台的花开了"]);
    expect(out.limit).toBe(12);
  });

  it("真实互动够 3 条时不再补位", () => {
    const rows = [
      row("r1", "真实一", "player"),
      row("r2", "真实二", "player"),
      row("r3", "真实三", "player"),
      row("p1", "主动一句", "proactive"),
    ];
    const out = call(rows, { excludeSources: SELF_AUTHORED_SOURCES, backfillSources: ["proactive"] });
    expect(out.memories).toEqual(["真实一", "真实二", "真实三"]);
  });

  it("selftalk / chat_reply 永不进 T2（即使在 backfillSources 里被误配）", () => {
    const rows = [
      row("s1", "自言自语一句", "selftalk"),
      row("c1", "网页回复一句", "chat_reply"),
    ];
    const out = call(rows, {
      excludeSources: SELF_AUTHORED_SOURCES,
      backfillSources: ["proactive", "selftalk", "chat_reply"],
    });
    expect(out.memories).toEqual([]);
  });

  it("全被排除时返回 0 条，不抛、不硬凑", () => {
    const rows = [row("p1", "主动", "proactive"), row("s1", "自语", "selftalk")];
    const out = call(rows, { excludeSources: SELF_AUTHORED_SOURCES });
    expect(out.memories).toEqual([]);
  });

  it("只给 excludeSources 不给 backfill 时，不补任何东西", () => {
    const rows = [row("r1", "真实", "player"), row("p1", "主动", "proactive")];
    const out = call(rows, { excludeSources: SELF_AUTHORED_SOURCES });
    expect(out.memories).toEqual(["真实"]);
  });

  it("旧快照没有 source 字段：不崩，按「非排除来源」保留", () => {
    const rows = [row("old1", "没有来源的旧记忆"), row("old2", "另一条旧记忆")];
    const out = call(rows, { excludeSources: SELF_AUTHORED_SOURCES });
    expect(out.memories).toEqual(["没有来源的旧记忆", "另一条旧记忆"]);
  });
});
