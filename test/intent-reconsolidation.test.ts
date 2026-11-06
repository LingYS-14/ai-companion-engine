import { describe, expect, it } from "vitest";

import {
  MAX_RECONSOLIDATION_CANDIDATES,
  VALENCE_GAP_MIN,
  describeReconsolidationPlan,
  planReconsolidation,
  type ReconsolidationMemory,
} from "../src/orchestrator/intent/reconsolidation.js";

interface FixtureOptions {
  readonly id?: string;
  readonly createdAt?: number;
  readonly valence?: number;
  readonly topicDomain?: string;
  readonly participants?: readonly string[];
  readonly withFingerprint?: boolean;
}

function memory(options: FixtureOptions = {}): ReconsolidationMemory {
  const id = options.id ?? "m-1";
  const valence = options.valence ?? 0.5;
  const withFingerprint = options.withFingerprint ?? true;
  const cue: Record<string, unknown> = {
    topicDomain: options.topicDomain ?? "聊天",
    participants: options.participants ?? ["用户"],
    place: "QQ",
    affect: "neutral",
    goalId: null,
  };
  const base: ReconsolidationMemory = {
    id,
    created_at: options.createdAt ?? 1000,
    participants: options.participants ?? ["用户"],
    encode_state: { valence },
    ...(withFingerprint ? { encode_ctx: { cue_fingerprint: cue } } : {}),
  };
  return base;
}

describe("§5.4 再巩固候选发现", () => {
  it("没有情境指纹的记忆不进候选（记 skipped，不猜）", () => {
    const plan = planReconsolidation([memory({ id: "a", withFingerprint: false })]);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.noFingerprint).toBe(1);
    expect(plan.note).toContain("没有需要重新解释");
  });

  it("有指纹但没有情绪数值的记忆算 noValence", () => {
    const plan = planReconsolidation([
      { id: "a", created_at: 1, participants: ["用户"], encode_ctx: { cue_fingerprint: { topicDomain: "聊天" } } },
    ]);
    expect(plan.skipped.noValence).toBe(1);
    expect(plan.candidates).toEqual([]);
  });

  it("同一话题、情绪翻面、差够大 → 一条候选，字段齐全且要求解释", () => {
    const plan = planReconsolidation([
      memory({ id: "old", createdAt: 1000, valence: 0.9 }),
      memory({ id: "new", createdAt: 2000, valence: 0.1 }),
    ]);
    expect(plan.candidates).toHaveLength(1);
    const [candidate] = plan.candidates;
    expect(candidate).toMatchObject({
      olderMemoryId: "old",
      newerMemoryId: "new",
      topicDomain: "聊天",
      reason: "valence_flip",
      olderBucket: "positive",
      newerBucket: "negative",
      requiresExplanation: true,
    });
    expect(candidate!.valenceGap).toBeCloseTo(0.8, 10);
  });

  it("情绪没翻面（同底色）不提名", () => {
    const plan = planReconsolidation([
      memory({ id: "old", createdAt: 1000, valence: 0.8 }),
      memory({ id: "new", createdAt: 2000, valence: 0.7 }),
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.sameBucket).toBe(1);
  });

  it("翻面了但差得不够（低于阈值）不提名", () => {
    const plan = planReconsolidation([
      memory({ id: "old", createdAt: 1000, valence: 0.65 }),
      memory({ id: "new", createdAt: 2000, valence: 0.35 }),
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.smallGap).toBe(1);
  });

  it("在场者明显不同不提名（换了一个人说的话不能当同一次重新解释）", () => {
    const plan = planReconsolidation([
      memory({ id: "old", createdAt: 1000, valence: 0.9, participants: ["用户"] }),
      memory({ id: "new", createdAt: 2000, valence: 0.1, participants: ["路人"] }),
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped.participantsDiffer).toBe(1);
  });

  it("一边没有在场者信息时放行（没有信号不乱拦）", () => {
    const plan = planReconsolidation([
      memory({ id: "old", createdAt: 1000, valence: 0.9, participants: [] }),
      memory({ id: "new", createdAt: 2000, valence: 0.1, participants: ["用户"] }),
    ]);
    expect(plan.candidates).toHaveLength(1);
  });

  it("不同话题域各自成组，互不配对", () => {
    const plan = planReconsolidation([
      memory({ id: "a", createdAt: 1000, valence: 0.9, topicDomain: "聊天" }),
      memory({ id: "b", createdAt: 2000, valence: 0.1, topicDomain: "游戏" }),
    ]);
    expect(plan.candidates).toEqual([]);
  });

  it("上限生效：候选按旧的 created_at 升序取前 N，其余记 truncated", () => {
    const plan = planReconsolidation(
      [
        memory({ id: "o1", createdAt: 1000, valence: 0.9 }),
        memory({ id: "n1", createdAt: 2000, valence: 0.1 }),
        memory({ id: "o2", createdAt: 3000, valence: 0.9 }),
        memory({ id: "n2", createdAt: 4000, valence: 0.1 }),
      ],
      { maxCandidates: 2 },
    );
    // 相邻两两比较会得到 3 条（o1→n1、n1→o2、o2→n2），上限 2 截掉 1 条。
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates[0]!.olderMemoryId).toBe("o1");
    expect(plan.skipped.truncated).toBe(1);
  });

  it("同输入两次结果一致，且不改动入参", () => {
    const rows = [
      memory({ id: "old", createdAt: 1000, valence: 0.9 }),
      memory({ id: "new", createdAt: 2000, valence: 0.1 }),
    ];
    const snapshot = JSON.stringify(rows);
    const first = planReconsolidation(rows);
    const second = planReconsolidation(rows);
    expect(first).toEqual(second);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("unknown: 开头的话题域当作没有指纹", () => {
    const plan = planReconsolidation([
      memory({ id: "a", topicDomain: "unknown:no-goal" }),
      memory({ id: "b", createdAt: 2000, valence: 0.1, topicDomain: "unknown:no-goal" }),
    ]);
    expect(plan.skipped.noFingerprint).toBe(2);
    expect(plan.candidates).toEqual([]);
  });

  it("非法参数抛 RangeError（不静默用默认值）", () => {
    expect(() => planReconsolidation([], { maxCandidates: 0 })).toThrow(RangeError);
    expect(() => planReconsolidation([], { valenceGapMin: 2 })).toThrow(RangeError);
  });

  it("摘要一行把计数说清（默认阈值的常量对外可见）", () => {
    const plan = planReconsolidation([memory({ id: "a" })]);
    const line = describeReconsolidationPlan(plan);
    expect(line).toContain("再巩固候选：0 条");
    expect(line).toContain("无指纹 0");
    expect(VALENCE_GAP_MIN).toBe(0.5);
    expect(MAX_RECONSOLIDATION_CANDIDATES).toBe(5);
  });
});
