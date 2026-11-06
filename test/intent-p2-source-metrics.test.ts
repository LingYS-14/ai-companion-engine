import { describe, expect, it } from "vitest";
import type { CandidateContext } from "../src/orchestrator/intent/candidates.js";
import { generateCandidates } from "../src/orchestrator/intent/candidates.js";
import { initialSState } from "../src/engine/state.js";
import type { IntentionRecord } from "../src/orchestrator/intent/types.js";
import type { Affordance, IntentKind, SituationFrame } from "../src/orchestrator/intent/types.js";
import type { ReplayMemory } from "../src/orchestrator/intent/replay.js";
import { replaySource, withReplayThreads, describeReplaySource, MAX_MERGED_THREADS, MAX_REPLAY_THREADS } from "../src/orchestrator/intent/replay-source.js";
import {
  capabilityUnlockMetrics,
  consistencyMetrics,
  initiativeMetrics,
  metricsReport,
  priorSuppression,
  type MetricTickRecord,
} from "../src/orchestrator/intent/metrics.js";
import { projectDrive } from "../src/orchestrator/intent/drive.js";

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

const QQ: Affordance = { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false };

function memory(overrides: Partial<ReplayMemory> = {}): ReplayMemory {
  return {
    id: "mem-1",
    content: "昨天晚上她说想去看海",
    created_at: NOW - 2 * DAY,
    tags: ["聊天"],
    vividness: 0.8,
    self_relevance: 0.7,
    unresolved_score: 0,
    last_accessed: NOW - DAY,
    access_count: 3,
    participants: ["用户"],
    ...overrides,
  };
}

function frame(overrides: Partial<SituationFrame> = {}): SituationFrame {
  return {
    at: "2026-10-31T14:00:00.000Z",
    channel: "qq",
    participants: ["用户"],
    affordances: [QQ],
    sinceLastContactMin: 30,
    activeIntents: [],
    budget: { rph: 8, peak: false },
    hardBlocks: [],
    ...overrides,
  };
}

function context(): CandidateContext {
  return {
    frame: frame(),
    drive: projectDrive({
      state: initialSState(),
      stage: "stranger",
      sinceLastContactMin: 30,
      recentFailureRate: 0,
      openIntentCount: 0,
      maxOpenIntents: 5,
      coverageGap: 0.3,
      valueDeviation: 0.1,
    }),
  };
}

function tick(overrides: Partial<MetricTickRecord> = {}): MetricTickRecord {
  return { at: "2026-10-31T14:00:00.000Z", emitted: [], gateAllowed: true, wouldSpeak: false, ...overrides };
}

function intention(survival: number, status: IntentionRecord["status"]): IntentionRecord {
  return {
    id: `itn-${survival}`,
    created_at: "2026-10-31T00:00:00.000Z",
    kind: "reach_out",
    goal: "想找人说句话",
    why: "connection 缺口",
    trigger: null,
    deadline: null,
    status,
    attempts: [],
    superseded_by: null,
    survival,
    source_ids: [],
  };
}

describe("P2 记忆回放 → 候选源（replay-source.ts）", () => {
  it("未闭合的记忆变成 continue_thread 线头，标题与 staleMin 都有", () => {
    const source = replaySource([memory({ unresolved_score: 0.8 })], NOW);
    expect(source.items.length).toBeGreaterThan(0);
    expect(source.items[0]?.kind).toBe("unfinished");
    expect(source.threads.length).toBe(1);
    expect(source.threads[0]?.id).toBe("replay:mem-1");
    expect(source.threads[0]?.title).toContain("海");
    expect(source.threads[0]?.staleMin).toBeGreaterThan(0);
  });

  it("没有记忆时如实返回空线头，不伪造", () => {
    const source = replaySource([], NOW);
    expect(source.items).toEqual([]);
    expect(source.threads).toEqual([]);
    expect(source.note).toContain("回放");
    const merged = withReplayThreads(context(), source);
    expect(merged.added).toBe(0);
    expect(merged.note).toContain("没有可接的话头");
  });

  it("回放线程合进上下文后，候选生成真的产出 continue_thread 候选", () => {
    const source = replaySource([memory({ unresolved_score: 0.8 })], NOW);
    const { context: merged } = withReplayThreads(context(), source);
    const candidates = generateCandidates(merged);
    const threadCandidates = candidates.filter((cand) => cand.kind === "continue_thread");
    expect(threadCandidates.length).toBeGreaterThan(0);
    expect(threadCandidates[0]?.goal).toContain("接上");
    expect(threadCandidates[0]?.because.some((cause) => cause.memoryId === "replay:mem-1")).toBe(true);
  });

  it("与已有线程按 id 去重：已有优先、顺序不变、不重复加", () => {
    const existing = { id: "replay:mem-1", title: "已有标题", staleMin: 10 };
    const source = replaySource([memory({ unresolved_score: 0.8 })], NOW);
    const base = { ...context(), threads: [existing] };
    const merged = withReplayThreads(base, source);
    expect(merged.added).toBe(0); // 回放线程 id 与 existing 相同 → 去重后不新增
    expect(merged.context.threads?.[0]).toEqual(existing);
  });

  it("线程总数有上限，回放不会淹没已有线程", () => {
    const memories = Array.from({ length: 6 }, (_, i) =>
      memory({ id: `mem-${String(i)}`, created_at: NOW - (20 + i) * DAY, last_accessed: NOW - (20 + i) * DAY, unresolved_score: 0.9 }),
    );
    const source = replaySource(memories, NOW);
    expect(source.threads.length).toBeLessThanOrEqual(MAX_REPLAY_THREADS);
    const existing = Array.from({ length: 3 }, (_, i) => ({ id: `old-${String(i)}`, title: `旧事${String(i)}`, staleMin: 100 }));
    const merged = withReplayThreads({ ...context(), threads: existing }, source);
    expect(merged.context.threads?.length).toBeLessThanOrEqual(MAX_MERGED_THREADS);
  });

  it("日志摘要说明回放了几条、什么类型，空回放也说明", () => {
    const source = replaySource([memory({ unresolved_score: 0.8 })], NOW);
    expect(describeReplaySource(source, frame())).toContain("线头");
    expect(describeReplaySource(replaySource([], NOW), frame())).toContain("没有想起什么");
  });
});

describe("§9 六指标纯计算（metrics.ts）", () => {
  it("空输入一律 null + 原因，不填 0 假装测过", () => {
    const report = metricsReport({ intentions: [], ticks: [] });
    expect(report.initiative.initiativeRate).toBeNull();
    expect(report.initiative.behaviorEntropy).toBeNull();
    expect(report.suppression.ratio).toBeNull();
    expect(report.consistency.rate).toBeNull();
    expect(report.capability.rate).toBeNull();
    expect(report.causality.value).toBeNull();
    expect(report.causality.note).toContain("未测");
    expect(report.lines.join("\n")).toContain("未测");
  });

  it("自发发起率：有意图浮现的拍 / 总拍", () => {
    const metrics = initiativeMetrics([
      tick({ emitted: ["reach_out"] }),
      tick({ emitted: ["reach_out", "explore"] }),
      tick({ emitted: [] }),
      tick({ emitted: [] }),
    ]);
    expect(metrics.ticks).toBe(4);
    expect(metrics.initiativeRate).toBeCloseTo(0.5, 12);
  });

  it("行为熵手算：reach_out×2 + explore×1 → H = -(2/3·log2(2/3) + 1/3·log2(1/3))，并归一化", () => {
    const metrics = initiativeMetrics([
      tick({ emitted: ["reach_out"] }),
      tick({ emitted: ["reach_out", "explore"] }),
    ]);
    const expected = -(2 / 3) * Math.log2(2 / 3) - (1 / 3) * Math.log2(1 / 3);
    expect(metrics.behaviorEntropy).toBeCloseTo(expected, 10);
    expect(metrics.normalizedEntropy).toBeCloseTo(expected / Math.log2(7), 10);
  });

  it("先验压制比：想动但被硬闸拦住的拍算进分子，没浮现的拍不参与", () => {
    const metrics = priorSuppression([
      tick({ emitted: ["reach_out"], gateAllowed: false, wouldSpeak: false }),
      tick({ emitted: ["reach_out"], gateAllowed: true, wouldSpeak: true }),
      tick({ emitted: [], gateAllowed: true, wouldSpeak: false }),
      tick({ emitted: ["explore"], gateAllowed: false, wouldSpeak: false }),
    ]);
    expect(metrics.emittableTicks).toBe(3);
    expect(metrics.suppressedTicks).toBe(2);
    expect(metrics.ratio).toBeCloseTo(2 / 3, 12);
  });

  it("跨会话一致性：通过率；没测过是 null 不是 100%", () => {
    expect(consistencyMetrics([]).rate).toBeNull();
    expect(consistencyMetrics([true, true, false]).rate).toBeCloseTo(2 / 3, 12);
  });

  it("能力解锁率：没有缺口时 null，有缺口才给比例", () => {
    expect(capabilityUnlockMetrics(0, 0).rate).toBeNull();
    expect(capabilityUnlockMetrics(1, 4).rate).toBeCloseTo(0.25, 12);
  });

  it("汇总报告把半衰期/一致性/压制比排在几行里，且不写自评结论", () => {
    const report = metricsReport({
      intentions: [1, 2, 3, 4, 5, 6].map((n) => intention(n, "done")),
      ticks: [tick({ emitted: ["reach_out"], gateAllowed: false })],
      consistencyResults: [true],
      capabilityUnlocked: 0,
      capabilityGaps: 0,
    });
    expect(report.survival.medianTicks).toBe(3);
    expect(report.lines.length).toBe(6);
    expect(report.lines.join("\n")).toContain("3 拍");
    expect(report.lines.join("\n")).not.toContain("她很主动");
  });

  it("指标只吃记录：不读时钟、不看现在几点（同输入两次结果相同）", () => {
    const input = { intentions: [intention(1, "done")], ticks: [tick({ emitted: ["reach_out"] })] };
    expect(JSON.stringify(metricsReport(input))).toBe(JSON.stringify(metricsReport(input)));
  });
});
