/**
 * §10.4 知识使用反馈（`on_knowledge_used`）——V52-GAP M10-04 的落地测试。
 *
 * 规格的闭环很小：她讲出去的知识，对方接住了 → `social_freshness +0.2`；
 * 对方不接 → `−0.1`。难点不在公式，而在**判定**：
 *   1) 这一句到底用没用到召回里的那几条（`usedKnowledgeIds`，只认标题命中）；
 *   2) 用到了、但对方这句反应看不懂时**不能猜**（保持 pending，等下一次明确信号）；
 *   3) 超过一小时没反应就不再追认（免得一周后一句无关的冷战去改旧知识）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import {
  SOCIAL_ENGAGED_DELTA,
  SOCIAL_IGNORED_DELTA,
  applySocialDelta,
  classifySocialReaction,
  socialDelta,
} from "../src/learning/knowledge-feedback.js";
import type { KnowledgeRecord } from "../src/memory/knowledge.js";
import { usedKnowledgeIds } from "../src/dialogue/recall.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);
const HOUR = 3_600_000;

/** 一次普普通通的交流（不触发里程碑/高强度路径，避免污染被测状态） */
const MILD = {
  goal_congruence: 0.2,
  goal_relevance: 0.3,
  coping_potential: 0.8,
  novelty: 0.2,
  legitimacy: 0.8,
};

function knowledge(id: string, over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id,
    content: "在 B 站看到《测试标题》：一句摘要",
    knowledge_type: "trend",
    source: "bili",
    freshness: 0.5,
    ingested_at: NOW,
    access_count: 0,
    social_freshness: 0.5,
    ...over,
  };
}

describe("§10.4 常量与映射", () => {
  it("规格给的增减量没被改过：engaged +0.2 / ignored −0.1", () => {
    expect(SOCIAL_ENGAGED_DELTA).toBe(0.2);
    expect(SOCIAL_IGNORED_DELTA).toBe(-0.1);
  });

  it("看得懂的反应才进桶，看不懂返回 null（不猜）", () => {
    expect(classifySocialReaction("升温")).toBe("engaged");
    expect(classifySocialReaction("安抚")).toBe("engaged");
    expect(classifySocialReaction("冷战")).toBe("ignored");
    expect(classifySocialReaction("离开")).toBe("ignored");
    expect(classifySocialReaction("嗯")).toBeNull();
    expect(classifySocialReaction("")).toBeNull();
  });

  it("socialDelta 与 applySocialDelta 都按桶走，并且夹在 0..1", () => {
    expect(socialDelta("engaged")).toBeCloseTo(0.2, 6);
    expect(socialDelta("ignored")).toBeCloseTo(-0.1, 6);
    expect(applySocialDelta(0.5, "engaged")).toBeCloseTo(0.7, 6);
    expect(applySocialDelta(0.5, "ignored")).toBeCloseTo(0.4, 6);
    expect(applySocialDelta(0.95, "engaged")).toBe(1);
    expect(applySocialDelta(0.05, "ignored")).toBe(0);
    expect(Number.isNaN(applySocialDelta(Number.NaN, "engaged"))).toBe(true);
  });
});

describe("usedKnowledgeIds：这一句到底用了哪几条", () => {
  const cards = ["《标题甲》：摘要甲", "《标题乙》：摘要乙"];

  it("标题原样出现才算用上，没提的那条不算", () => {
    const used = usedKnowledgeIds("我今天才知道标题甲那件事真的有意思", cards, ["k1", "k2"]);
    expect(used).toEqual(["k1"]);
  });

  it("没有 id 对齐就不做反馈（老调用方）", () => {
    expect(usedKnowledgeIds("标题甲", cards, undefined)).toEqual([]);
  });

  it("空回复不判", () => {
    expect(usedKnowledgeIds("   ", cards, ["k1", "k2"])).toEqual([]);
  });

  it("太短的探针（单个字）不判，宁可漏判也不瞎判", () => {
    expect(usedKnowledgeIds("我甲", ["《甲》：摘要"], ["k1"])).toEqual([]);
  });
});

describe("SoulRuntime：讲了之后等反应，再按反应结算", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-kfb-"));
    clock = new FakeClock(NOW, 12);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("升温 → social_freshness 涨 0.2，freshness 也跟着重算", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.knowledgeStore().put(knowledge("k1"));
    rt.noteKnowledgeUsed("k1");
    clock.advance(5 * 60_000);
    rt.turn({ text: "嗯", appraisal: MILD }, { eventType: "care", reaction: "升温", skipMemory: true });

    const rec = rt.knowledgeStore().get("k1");
    expect(rec?.social_freshness).toBeCloseTo(0.7, 6);
    // freshness = 客观衰减(刚入库≈1) × social_freshness，所以略小于 0.7（5 分钟的半衰期损耗）
    expect(rec?.freshness).toBeGreaterThan(0.69);
    expect(rec?.freshness).toBeLessThan(0.7);
  });

  it("冷战 → social_freshness 减 0.1", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.knowledgeStore().put(knowledge("k1"));
    rt.noteKnowledgeUsed("k1");
    clock.advance(5 * 60_000);
    rt.turn({ text: "……", appraisal: MILD }, { eventType: "care", reaction: "冷战", skipMemory: true });

    expect(rt.knowledgeStore().get("k1")?.social_freshness).toBeCloseTo(0.4, 6);
  });

  it("看不懂的反应不结算，但 pending 留着——下一次明确的反应仍然算数", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.knowledgeStore().put(knowledge("k1"));
    rt.noteKnowledgeUsed("k1");
    clock.advance(60_000);
    rt.turn({ text: "嗯", appraisal: MILD }, { eventType: "care", reaction: "嗯，知道了", skipMemory: true });
    expect(rt.knowledgeStore().get("k1")?.social_freshness).toBeCloseTo(0.5, 6);

    clock.advance(60_000);
    rt.turn({ text: "再嗯", appraisal: MILD }, { eventType: "care", reaction: "冷战", skipMemory: true });
    expect(rt.knowledgeStore().get("k1")?.social_freshness).toBeCloseTo(0.4, 6);
  });

  it("超过一小时没反应就丢掉，不追认", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.knowledgeStore().put(knowledge("k1"));
    rt.noteKnowledgeUsed("k1");
    clock.advance(2 * HOUR);
    rt.turn({ text: "嗯", appraisal: MILD }, { eventType: "care", reaction: "冷战", skipMemory: true });
    expect(rt.knowledgeStore().get("k1")?.social_freshness).toBeCloseTo(0.5, 6);
  });

  it("库里没有的 id 不占位（拼错的 id 不该改任何东西）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.knowledgeStore().put(knowledge("k1"));
    rt.noteKnowledgeUsed("k-typo");
    clock.advance(60_000);
    rt.turn({ text: "嗯", appraisal: MILD }, { eventType: "care", reaction: "升温", skipMemory: true });
    expect(rt.knowledgeStore().get("k1")?.social_freshness).toBeCloseTo(0.5, 6);
  });
});
