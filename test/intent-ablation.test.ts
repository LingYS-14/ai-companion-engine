import { describe, expect, it } from "vitest";
import type { Stage } from "../src/engine/bonds.js";
import { initialSState, type SState } from "../src/engine/state.js";
import {
  ABLATION_COMPONENTS,
  MIN_ABLATION_SAMPLES,
  ablateIntentInput,
  behaviorOf,
  compareBehavior,
  describeAblation,
  runAblation,
  type AblationSample,
} from "../src/orchestrator/intent/ablation.js";
import { runIntentTick, type IntentTickInput } from "../src/orchestrator/intent/tick.js";
import type { Affordance } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T06:00:00.000Z";
const QQ: Affordance = { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false };
const BILI: Affordance = { tool: "bili.search", risk: 0, requiresLogin: false, rateLimited: false };

function state(overrides: Partial<SState> = {}): SState {
  return { ...initialSState(), energy: 0.6, suppressionLoad: 0.2, ...overrides };
}

function input(overrides: Partial<IntentTickInput> = {}): IntentTickInput {
  return {
    situation: {
      at: AT,
      localHour: 14,
      channel: "qq",
      participants: ["用户"],
      affordances: [QQ, BILI],
      sinceLastContactMin: 30,
      activeIntents: [],
      budget: { rph: 8, peak: false },
      singleWriterConflict: false,
    },
    state: state(),
    stage: "stranger" as Stage,
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 5,
    valueDeviation: 0.1,
    coverageGap: 0.3,
    trust: 0.5,
    trustFloor: 0.2,
    ...overrides,
  };
}

const THREADS = [{ id: "t1", title: "上次说要给她看的东西", staleMin: 120 }];

describe("P3 结构性消融：摘组件", () => {
  it("摘回放线头 / 上一拍驱动 / 知识缺口，各自只摘该字段，且不改原对象", () => {
    const source = input({ threads: THREADS, previousDrive: { energy: 0.1, connection: 0.2, competence: 0.3, novelty: 0.4, coherence: 0.5, integrity: 0.6 } });
    const before = JSON.stringify(source);

    const noThreads = ablateIntentInput(source, "replay_threads");
    expect(noThreads.threads).toBeUndefined();
    expect(noThreads.situation).toBe(source.situation);
    expect(noThreads.previousDrive).toEqual(source.previousDrive);

    const noHistory = ablateIntentInput(source, "drive_history");
    expect(noHistory.previousDrive).toBeUndefined();
    expect(noHistory.threads).toEqual(THREADS);

    const noGap = ablateIntentInput(source, "knowledge_gap");
    expect(noGap.coverageGap).toBeUndefined();
    expect(noGap.threads).toEqual(THREADS);

    expect(JSON.stringify(source)).toBe(before);
    expect(source.threads).toEqual(THREADS);
  });

  it("本来就没有该组件时原样返回（不伪造空值）", () => {
    const bare = input();
    expect(ablateIntentInput(bare, "replay_threads")).toBe(bare);
    expect(ablateIntentInput(bare, "drive_history")).toBe(bare);
    const noGap = ablateIntentInput(bare, "knowledge_gap");
    expect(noGap).not.toBe(bare);
    expect(noGap.coverageGap).toBeUndefined();
  });

  it("组件清单固定三条，改清单必须同时改标签（防止消融集悄悄扩）", () => {
    expect(ABLATION_COMPONENTS).toEqual(["replay_threads", "drive_history", "knowledge_gap"]);
  });
});

describe("P3 结构性消融：比较行为", () => {
  it("行为快照只取 top / emitted / wouldSpeak / 候选种类序列", () => {
    const result = runIntentTick(input());
    const snapshot = behaviorOf(result);
    expect(snapshot.topKind).toBe(result.top?.kind ?? null);
    expect(snapshot.emitted).toEqual(result.emitted);
    expect(snapshot.wouldSpeak).toBe(result.wouldSpeak);
    expect(snapshot.candidateKinds).toEqual(result.candidates.map((candidate) => candidate.kind));
  });

  it("摘掉回放线头：最高分从 continue_thread 掉回 reach_out，判为行为改变", () => {
    const source = input({ threads: THREADS });
    const base = runIntentTick(source);
    const ablated = runIntentTick(ablateIntentInput(source, "replay_threads"));
    expect(base.top?.kind).toBe("continue_thread");
    const diff = compareBehavior(base, ablated);
    expect(diff.changed).toBe(true);
    expect(diff.topKindChanged).toBe(true);
    expect(diff.emittedChanged).toBe(false);
    expect(diff.wouldSpeakChanged).toBe(false);
    expect(diff.reasons.join()).toContain("continue_thread → reach_out");
  });

  it("摘掉知识缺口：本来靠 0.1 的缺口压住 explore，摘掉后默认 0.5 → explore 走到第一", () => {
    const source = input({ coverageGap: 0.1 });
    const base = runIntentTick(source);
    const ablated = runIntentTick(ablateIntentInput(source, "knowledge_gap"));
    expect(base.top?.kind).toBe("reach_out");
    expect(ablated.top?.kind).toBe("explore");
    const diff = compareBehavior(base, ablated);
    expect(diff.changed).toBe(true);
    expect(diff.rankingChanged).toBe(true);
  });

  it("同输入跑两遍：行为完全一样，reasons 为空（否则消融结果不可复算）", () => {
    const source = input({ threads: THREADS, coverageGap: 0.9, previousDrive: runIntentTick(input()).drive });
    const diff = compareBehavior(runIntentTick(source), runIntentTick(source));
    expect(diff).toMatchObject({
      changed: false,
      topKindChanged: false,
      emittedChanged: false,
      wouldSpeakChanged: false,
      rankingChanged: false,
      reasons: [],
    });
  });
});

describe("P3 结构性消融：成批报告", () => {
  function samples(count: number, build: (index: number) => IntentTickInput): AblationSample[] {
    return Array.from({ length: count }, (_unused, index) => ({ label: `样本 ${index + 1}`, input: build(index) }));
  }

  it("样本不足时只报计数、不下因果结论", () => {
    const report = runAblation(samples(2, () => input({ threads: THREADS })));
    expect(report.samples).toBe(2);
    expect(report.minSamples).toBe(MIN_ABLATION_SAMPLES);
    expect(report.verdict).toContain("样本不足");
    for (const row of report.rows) {
      expect(row.verdict).toContain("样本不足");
      expect(row.samples).toBe(2);
    }
    expect(report.rows.find((row) => row.component === "replay_threads")?.changed).toBe(2);
  });

  it("6 个样本都因知识缺口改变行为 → 知识组件判强影响，其余组件照实说无影响", () => {
    const report = runAblation(samples(6, () => input({ coverageGap: 0.1 })));
    const knowledge = report.rows.find((row) => row.component === "knowledge_gap");
    expect(knowledge?.changed).toBe(6);
    expect(knowledge?.changedRate).toBe(1);
    expect(knowledge?.verdict).toContain("强影响");
    expect(report.verdict).toContain("改变了行为");
    expect(report.verdict).toContain("knowledge_gap");

    const threads = report.rows.find((row) => row.component === "replay_threads");
    const history = report.rows.find((row) => row.component === "drive_history");
    expect(threads?.changed).toBe(0);
    expect(threads?.verdict).toContain("无行为影响");
    expect(history?.changed).toBe(0);
  });

  it("样本上没有可摘组件时，结论如实说没观察到（不是'组件无用'）", () => {
    const report = runAblation(samples(5, () => input({ coverageGap: 0.5 })));
    expect(report.verdict).toContain("没有观察到行为改变");
    expect(report.note).toContain("不等于组件无用");
  });

  it("空样本：changedRate 为 null 不填 0，结论不下因果", () => {
    const report = runAblation([]);
    expect(report.samples).toBe(0);
    expect(report.verdict).toContain("样本不足");
    for (const row of report.rows) {
      expect(row.changedRate).toBeNull();
      expect(row.changed).toBe(0);
    }
  });

  it("同批样本跑两次，报告逐字节相同（消融可复算）", () => {
    const batch = samples(6, (index) => input({ coverageGap: index % 2 === 0 ? 0.1 : 0.9, threads: index % 3 === 0 ? THREADS : undefined }));
    expect(JSON.stringify(runAblation(batch))).toBe(JSON.stringify(runAblation(batch)));
  });

  it("支持只跑指定组件（P3 调试用，不改变默认全跑）", () => {
    const report = runAblation(samples(3, () => input()), ["knowledge_gap"]);
    expect(report.rows.map((row) => row.component)).toEqual(["knowledge_gap"]);
    expect(runAblation(samples(1, () => input())).rows).toHaveLength(3);
  });

  it("一页纸：标题 + 每组件一行 + 结论 + 说明，不自评", () => {
    const report = runAblation(samples(6, () => input({ coverageGap: 0.1 })));
    const lines = describeAblation(report);
    expect(lines[0]).toContain("结构性消融");
    expect(lines).toHaveLength(1 + report.rows.length + 2);
    expect(lines[1]).toContain("replay_threads");
    expect(lines.join("\n")).toContain("knowledge_gap");
    expect(lines.join("\n")).not.toContain("她很");
    expect(lines.at(-1)).toContain("说明");
  });
});
