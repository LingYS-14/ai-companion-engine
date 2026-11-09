import { describe, expect, it } from "vitest";

import {
  concretenessRatio,
  deriveAffordances,
  deriveQuintuple,
  describeQuintuple,
  formatUtc,
  isConcreteQuintuple,
  looksLikeEpisode,
  validateQuintuple,
  EPISODE_FIELDS,
} from "../src/orchestrator/intent/episode.js";
import {
  CONCRETENESS_FLOOR,
  LOW_CONCRETENESS_STREAK,
  VALUE_FLOOR,
  diagnoseWorkingSelf,
  workingSelfFilter,
  type ValueOrder,
  type WorkingSelfMemory,
} from "../src/orchestrator/intent/working-self.js";
import {
  MAX_VALENCE_DELTA,
  backtrack,
  chainDistance,
  describeChain,
  resolveChain,
  retrievalWeight,
  validatePatch,
  versionId,
  type ReconsolidationPatch,
} from "../src/orchestrator/intent/version-chain.js";
import {
  DORMANT_DAYS,
  DAY_MS,
  REPLAY_MAX,
  echoScore,
  replayContextLine,
  replaySeed,
  replayThreads,
  replayTitle,
  selectReplay,
  unfinishedScore,
  type ReplayMemory,
} from "../src/orchestrator/intent/replay.js";

const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);

const VALUES: ValueOrder = { care: 0.9, truth: 0.6, freedom: 0.5, beauty: 0.7, belonging: 0.8, mastery: 0.4 };

/* ------------------------------------------------------------------ */
/* episode 五元组                                                       */
/* ------------------------------------------------------------------ */

describe("episode 五元组：派生与校验", () => {
  it("字段齐全时 missing 为空、isConcrete 为真", () => {
    const derived = deriveQuintuple({
      created_at: NOW,
      participants: ["用户"],
      tags: ["聊天"],
      encode_ctx: { place: "书房", viewpoint: "等着被回应的那一边", goal_at_time: "想听他说今天怎么样" },
    });
    expect(derived.missing).toEqual([]);
    expect(isConcreteQuintuple(derived)).toBe(true);
    expect(derived.quintuple.participants).toEqual(["用户"]);
    expect(derived.quintuple.place).toBe("书房");
  });

  it("缺 place/viewpoint/goal_at_time 时记进 missing，并用 unknown: 前缀的推断值", () => {
    const derived = deriveQuintuple({ created_at: NOW });
    expect(derived.missing).toEqual(["place", "viewpoint", "goalAtTime"]);
    expect(isConcreteQuintuple(derived)).toBe(false);
    expect(derived.quintuple.place).toBe("unknown:place");
    expect(derived.quintuple.viewpoint).toBe("unknown:viewpoint");
    expect(derived.quintuple.goalAtTime).toBe("unknown:goal");
  });

  it("place 兼容 location 别名，goal_at_time 兼容 goal 别名；空白字符串按缺失处理", () => {
    const derived = deriveQuintuple({
      created_at: NOW,
      encode_ctx: { location: "  客厅  ", goal: "想说句话", viewpoint: "   " },
    });
    expect(derived.quintuple.place).toBe("客厅");
    expect(derived.quintuple.goalAtTime).toBe("想说句话");
    expect(derived.missing).toEqual(["viewpoint"]);
  });

  it("在场者去空白、过滤空串", () => {
    const derived = deriveQuintuple({ created_at: NOW, participants: ["  用户  ", " ", ""] });
    expect(derived.quintuple.participants).toEqual(["用户"]);
  });

  it("validateQuintuple：合法通过、非法逐条报", () => {
    const ok = { t: NOW, place: "书房", participants: ["用户"], viewpoint: "第一人称", goalAtTime: "想说话" };
    expect(validateQuintuple(ok)).toEqual([]);
    const errors = validateQuintuple({ t: 0, place: " ", participants: [""], viewpoint: "", goalAtTime: "" });
    expect(errors.length).toBe(5);
  });

  it("EPISODE_FIELDS 是三个可缺省字段（时间与在场者不在其中）", () => {
    expect([...EPISODE_FIELDS]).toEqual(["place", "viewpoint", "goalAtTime"]);
  });

  it("looksLikeEpisode：有在场者/场景/事件标签即算，纯 fact 不算", () => {
    expect(looksLikeEpisode({ created_at: NOW, participants: ["用户"] })).toBe(true);
    expect(looksLikeEpisode({ created_at: NOW, encode_ctx: { scene: "雨夜的车站" } })).toBe(true);
    expect(looksLikeEpisode({ created_at: NOW, tags: ["事件", "别的"] })).toBe(true);
    expect(looksLikeEpisode({ created_at: NOW, tags: ["事实"] })).toBe(false);
  });

  it("concretenessRatio：空命中返回 null（没检索 ≠ 具体性 0）", () => {
    expect(concretenessRatio([])).toBeNull();
    expect(concretenessRatio([{ created_at: NOW, participants: ["用户"] }, { created_at: NOW, tags: ["事实"] }])).toBe(0.5);
  });

  it("affordance 三元组：读得到就还原文，读不到就是空（不编）", () => {
    const triple = deriveAffordances({
      created_at: NOW,
      encode_ctx: { affordances: { possible: ["发消息", " "], actual: "发了", consequence: "他回了" } },
    });
    expect(triple).toEqual({ possible: ["发消息"], actual: "发了", consequence: "他回了" });
    expect(deriveAffordances({ created_at: NOW })).toEqual({ possible: [], actual: null, consequence: null });
  });

  it("formatUtc 是纯算术换算（固定时间戳得到固定字符串）", () => {
    expect(formatUtc(Date.UTC(1970, 0, 1))).toBe("1970-01-01T00:00:00Z");
    expect(formatUtc(NOW)).toBe("2026-10-31T03:00:00Z");
    expect(formatUtc(Date.UTC(2024, 1, 29, 12, 34, 56))).toBe("2024-02-29T12:34:56Z");
  });

  it("describeQuintuple 一行里带缺失字段", () => {
    const line = describeQuintuple(deriveQuintuple({ created_at: NOW, participants: ["用户"] }));
    expect(line).toContain("unknown:place");
    expect(line).toContain("推断字段=place,viewpoint,goalAtTime");
  });
});

/* ------------------------------------------------------------------ */
/* working self 闸门                                                    */
/* ------------------------------------------------------------------ */

const mem = (id: string, over: Partial<WorkingSelfMemory> = {}): WorkingSelfMemory => ({ id, ...over });

describe("§5.2 working self 闸门", () => {
  it("意图没有标签时不按目标拦（fail-open）", () => {
    const result = workingSelfFilter([mem("a"), mem("b")], { id: "i1", goal: "想说话" }, VALUES);
    expect(result.kept.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.filterRate).toBe(0);
  });

  it("意图有标签时只留标签相交的记忆", () => {
    const intent = { id: "i1", goal: "想接上次的话题", tags: ["未完成", "工作"] };
    const result = workingSelfFilter(
      [mem("a", { tags: ["未完成"] }), mem("b", { tags: ["闲聊"] }), mem("c", { tags: ["工作", "同事"] })],
      intent,
      VALUES,
    );
    expect(result.kept.map((m) => m.id)).toEqual(["a", "c"]);
    expect(result.filtered).toEqual([{ memoryId: "b", reason: "goal_mismatch" }]);
    expect(result.filterRate).toBeCloseTo(1 / 3, 6);
  });

  it("价值标注低于 VALUE_FLOOR 才拦；没有价值标注放行", () => {
    const low = mem("low", { encode_ctx: { value: "mastery" } }); // mastery 0.4 ≥ 0.2 → 放行
    const conflict = mem("conflict", { tags: ["value:freedom"] }); // 0.5 → 放行
    const noSignal = mem("none");
    const weak: ValueOrder = { ...VALUES, mastery: VALUE_FLOOR - 0.01 };
    const result = workingSelfFilter([low, conflict, noSignal], null, weak);
    expect(result.kept.map((m) => m.id)).toEqual(["conflict", "none"]);
    expect(result.filtered).toEqual([{ memoryId: "low", reason: "value_incompatible" }]);
  });

  it("空输入时过滤率是 null 不是 0，note 里写 n/a", () => {
    const result = workingSelfFilter([], { id: "i", goal: "x", tags: ["y"] }, VALUES);
    expect(result.filterRate).toBeNull();
    expect(result.note).toContain("n/a");
  });

  it("不修改输入数组", () => {
    const input = [mem("a", { tags: ["x"] })];
    workingSelfFilter(input, { id: "i", goal: "g", tags: ["x"] }, VALUES);
    expect(input).toHaveLength(1);
  });

  it("过滤率 >90% 且检索 ≥20 条才报 filter-rate-high", () => {
    const trace = (kept: number) => diagnoseWorkingSelf({ retrieved: 25, kept, concreteness: 0.7, lowConcretenessStreak: 0 });
    expect(trace(1).alarms).toContain("filter-rate-high");
    expect(trace(5).alarms).not.toContain("filter-rate-high");
    expect(diagnoseWorkingSelf({ retrieved: 5, kept: 0, concreteness: 0.7, lowConcretenessStreak: 0 }).alarms).not.toContain(
      "filter-rate-high",
    );
  });

  it("具体性 <0.5 连续 20 次 → 出 self_note 并给放宽系数 1.2", () => {
    const before = diagnoseWorkingSelf({ retrieved: 10, kept: 8, concreteness: 0.4, lowConcretenessStreak: 5 });
    expect(before.alarms).toContain("concreteness-low");
    expect(before.selfNote).toBeNull();
    const hit = diagnoseWorkingSelf({
      retrieved: 10,
      kept: 8,
      concreteness: CONCRETENESS_FLOOR - 0.1,
      lowConcretenessStreak: LOW_CONCRETENESS_STREAK - 1,
    });
    expect(hit.selfNote).toBe("我最近只记得结论，不记得事情了。");
    expect(hit.suggestedThreshold).toBe(1.2);
  });

  it("具体性长期 >0.95 留一个可观测标记（fact 轨可能空转）", () => {
    const diag = diagnoseWorkingSelf({ retrieved: 30, kept: 30, concreteness: 0.99, lowConcretenessStreak: 0 });
    expect(diag.alarms).toContain("concreteness-flat-high");
  });

  it("没有检索（retrieved 0）时过滤率 null、不报任何频率类报警", () => {
    const diag = diagnoseWorkingSelf({ retrieved: 0, kept: 0, concreteness: null, lowConcretenessStreak: 0 });
    expect(diag.filterRate).toBeNull();
    expect(diag.alarms).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 再巩固版本链                                                         */
/* ------------------------------------------------------------------ */

const patch = (over: Partial<ReconsolidationPatch> = {}): ReconsolidationPatch => ({
  memoryId: "m1",
  newVersion: 1,
  changed: { valence: 0.1 },
  reason: "今天聊完觉得没那么糟",
  source_ids: ["src-1"],
  prevVersion: 0,
  supersededBy: null,
  ...over,
});

describe("§5.4 再巩固版本链", () => {
  it("versionId 稳定", () => {
    expect(versionId("m1", 3)).toBe("m1@3");
  });

  it("validatePatch：合法通过；自指/版本倒退/理由太短/无源头/幅度超限逐条报", () => {
    expect(validatePatch(patch())).toEqual([]);
    expect(validatePatch(patch({ supersededBy: 1 }))).toContain("supersededBy 不能指向自己（自指非法）");
    expect(validatePatch(patch({ prevVersion: 1 }))).toContain("patch.newVersion 必须大于 prevVersion（版本号只能往前）");
    expect(validatePatch(patch({ reason: "短" })).some((e) => e.includes("reason"))).toBe(true);
    expect(validatePatch(patch({ source_ids: [] })).some((e) => e.includes("source_ids"))).toBe(true);
    expect(
      validatePatch(patch({ changed: { valence: MAX_VALENCE_DELTA + 0.01 } })).some((e) => e.includes("单次变化不能超过")),
    ).toBe(true);
  });

  it("resolveChain：三版链解析出末端为当前版本", () => {
    const p1 = patch({ newVersion: 1, prevVersion: 0, supersededBy: 2 });
    const p2 = patch({ newVersion: 2, prevVersion: 1, supersededBy: 3 });
    const p3 = patch({ newVersion: 3, prevVersion: 2, supersededBy: null });
    const chain = resolveChain("m1", [p3, p1, p2]);
    expect(chain.corrupt).toBe(false);
    expect(chain.current?.newVersion).toBe(3);
    expect(chain.versions.map((p) => p.newVersion)).toEqual([1, 2, 3]);
  });

  it("断链（prevVersion 指向不存在的版本）→ corrupt 且 current 为 null", () => {
    const chain = resolveChain("m1", [patch({ newVersion: 2, prevVersion: 9, supersededBy: null })]);
    expect(chain.corrupt).toBe(true);
    expect(chain.current).toBeNull();
    expect(chain.errors.join("|")).toContain("断链或分叉");
  });

  it("两条 patch 抢同一个父版本 → 分叉被记为 corrupt", () => {
    const a = patch({ newVersion: 1, prevVersion: 0 });
    const b = patch({ newVersion: 2, prevVersion: 0, source_ids: ["src-2"] });
    const chain = resolveChain("m1", [a, b]);
    expect(chain.corrupt).toBe(true);
  });

  it("supersededBy 与链上下一条不一致 → corrupt", () => {
    const chain = resolveChain("m1", [
      patch({ newVersion: 1, prevVersion: 0, supersededBy: 9 }),
      patch({ newVersion: 2, prevVersion: 1, supersededBy: null }),
    ]);
    expect(chain.corrupt).toBe(true);
    expect(chain.errors.join("|")).toContain("不一致");
  });

  it("没有 patch 的记忆返回空链且不判损坏", () => {
    const chain = resolveChain("m9", []);
    expect(chain.current).toBeNull();
    expect(chain.corrupt).toBe(false);
    expect(chain.versions).toEqual([]);
  });

  it("链距与检索权重：当前版本 1.0，旧版按 1/(1+距离) 降权但不为 0", () => {
    const chain = resolveChain("m1", [
      patch({ newVersion: 1, prevVersion: 0 }),
      patch({ newVersion: 2, prevVersion: 1 }),
      patch({ newVersion: 3, prevVersion: 2 }),
    ]);
    expect(chainDistance(chain, 3)).toBe(0);
    expect(chainDistance(chain, 1)).toBe(2);
    expect(retrievalWeight(chain, 3)).toBe(1);
    expect(retrievalWeight(chain, 2)).toBeCloseTo(0.5, 6);
    expect(retrievalWeight(chain, 1)).toBeCloseTo(1 / 3, 6);
    expect(retrievalWeight(chain, 99)).toBe(0);
  });

  it("backtrack 从当前版本往回列（显式回溯用）", () => {
    const chain = resolveChain("m1", [
      patch({ newVersion: 1, prevVersion: 0 }),
      patch({ newVersion: 2, prevVersion: 1 }),
    ]);
    expect(backtrack(chain).map((p) => p.newVersion)).toEqual([2, 1]);
  });

  it("describeChain：正常一条、损坏一条", () => {
    const ok = resolveChain("m1", [patch({ newVersion: 1, prevVersion: 0 })]);
    expect(describeChain(ok)).toContain("版本链 m1：v1（当前 v1，共 1 版）");
    const bad = resolveChain("m1", [patch({ newVersion: 2, prevVersion: 7 })]);
    expect(describeChain(bad)).toContain("版本链损坏");
  });
});

/* ------------------------------------------------------------------ */
/* 记忆回放                                                             */
/* ------------------------------------------------------------------ */

const rec = (id: string, over: Partial<ReplayMemory> = {}): ReplayMemory => ({
  id,
  created_at: NOW - 2 * DAY_MS,
  content: `记忆内容 ${id}`,
  tags: ["聊天"],
  vividness: 0.7,
  self_relevance: 0.6,
  unresolved_score: 0,
  last_accessed: NOW - DAY_MS,
  access_count: 3,
  ...over,
});

describe("P2 记忆回放：三类各取所需", () => {
  it("未闭合的事进 unfinished（unresolved ≥0.4）", () => {
    const out = selectReplay({ memories: [rec("a", { unresolved_score: 0.9, content: "那句没说完的话" })], nowMs: NOW });
    expect(out.items[0]?.kind).toBe("unfinished");
    expect(out.items[0]?.title).toBe("那句没说完的话");
    expect(out.byKind.unfinished).toBe(1);
  });

  it("鲜明 + 有关 + 被想起过的进 echo；三项都很低的进不了", () => {
    const out = selectReplay({
      memories: [
        rec("warm", { vividness: 0.9, self_relevance: 0.9, access_count: 8 }),
        rec("cold", { vividness: 0.1, self_relevance: 0.1, access_count: 0, tags: [] }),
      ],
      nowMs: NOW,
    });
    expect(out.items.map((i) => i.memoryId)).toEqual(["warm"]);
  });

  it("14 天以上没想起的旧事进 dormant，且只翻还鲜明的", () => {
    const old = NOW - 20 * DAY_MS;
    const out = selectReplay({
      memories: [
        rec("old-vivid", { created_at: old, last_accessed: old, vividness: 0.8 }),
        rec("old-faded", { created_at: old, last_accessed: old, vividness: 0.1 }),
      ],
      nowMs: NOW,
    });
    const kinds = out.items.filter((i) => i.memoryId === "old-vivid").map((i) => i.kind);
    expect(kinds).toContain("dormant");
    expect(out.items.some((i) => i.memoryId === "old-faded" && i.kind === "dormant")).toBe(false);
  });

  it("每类最多 2 条、总数最多 5 条；分数高者优先，同分按 id 稳定排序", () => {
    const memories = [
      ...Array.from({ length: 4 }, (_, i) => rec(`u${String(i)}`, { unresolved_score: 0.9 - i * 0.05 })),
      ...Array.from({ length: 4 }, (_, i) => rec(`e${String(i)}`, { vividness: 0.95, self_relevance: 0.9 })),
    ];
    const out = selectReplay({ memories, nowMs: NOW });
    expect(out.items.length).toBeLessThanOrEqual(REPLAY_MAX);
    expect(out.byKind.unfinished).toBe(2);
    expect(out.byKind.echo).toBe(2);
  });

  it("allowNewCandidates=false 时 note 明确写只消化不生成（§4.5 #4）", () => {
    const out = selectReplay({ memories: [rec("a", { unresolved_score: 0.9 })], nowMs: NOW, allowNewCandidates: false });
    expect(out.note).toContain("只消化，不生成新候选");
  });

  it("她自己说出去的话不参与回放，也不生成 continue_thread 线头（单话题根因）", () => {
    const memories = [
      rec("own", { source: "proactive", unresolved_score: 0.9, vividness: 0.95, self_relevance: 0.9 }),
      rec("real", { unresolved_score: 0.9 }),
    ];
    const out = selectReplay({ memories, nowMs: NOW });
    expect(out.items.some((i) => i.memoryId === "own")).toBe(false);
    expect(out.items.some((i) => i.memoryId === "real")).toBe(true);
    expect(replayThreads(out.items, memories, NOW).some((t) => t.id === "replay:own")).toBe(false);
  });

  it("回放项 → continue_thread 线头（dormant 不转成线头），staleMin 从最近被想起算", () => {
    const memories = [rec("a", { unresolved_score: 0.9, last_accessed: NOW - 90 * 60_000 })];
    const out = selectReplay({ memories, nowMs: NOW });
    const threads = replayThreads(out.items, memories, NOW);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("replay:a");
    expect(threads[0]?.staleMin).toBe(90);

    const dormant = selectReplay({ memories: [rec("d", { created_at: NOW - 30 * DAY_MS, last_accessed: NOW - 30 * DAY_MS, unresolved_score: 0, vividness: 0.9 })], nowMs: NOW });
    const dormantItems = dormant.items.filter((i) => i.kind === "dormant");
    expect(replayThreads(dormantItems, [rec("d")], NOW)).toEqual([]);
  });

  it("replaySeed 与 replayTitle：内容过长截断、没有内容退 tags、最后退 id", () => {
    expect(replayTitle(rec("x", { content: "一二三四五六七八九十一二三四五六七八九十再多一点" }))).toBe(
      "一二三四五六七八九十一二三四五六七八九十…",
    );
    expect(replayTitle(rec("x", { content: "", tags: ["a", "b", "c", "d"] }))).toBe("a/b/c");
    expect(replayTitle(rec("x", { content: "", tags: [] }))).toBe("x");
    expect(replaySeed({ memoryId: "x", kind: "echo", salience: 0.7, why: "鲜明", title: "某件事" })).toBe(
      "回放记忆「某件事」——鲜明",
    );
  });

  it("评分函数边界：最近度线性衰减、天数过大归零", () => {
    expect(unfinishedScore(rec("a", { unresolved_score: 1 }), 0)).toBeCloseTo(1, 6);
    expect(unfinishedScore(rec("a", { unresolved_score: 0 }), 30)).toBe(0);
    expect(echoScore(rec("a", { vividness: 1, self_relevance: 1, access_count: 10 }), 0)).toBeGreaterThan(0.9);
  });

  it("replayContextLine：有记录时给五元组完整度，没有记录返回 null", () => {
    const memories = [rec("a", { encode_ctx: { place: "书房", viewpoint: "第一人称", goal_at_time: "想说话" } })];
    const out = selectReplay({ memories, nowMs: NOW });
    const line = replayContextLine(out.items[0]!, memories);
    expect(line).toContain("五元组完整");
    expect(replayContextLine({ memoryId: "nope", kind: "echo", salience: 0, why: "", title: "" }, memories)).toBeNull();
  });

  it("DORMANT_DAYS 与 DAY_MS 常量自洽", () => {
    expect(DORMANT_DAYS * DAY_MS).toBe(14 * 86_400_000);
  });
});
