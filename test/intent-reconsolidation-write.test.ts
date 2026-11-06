import { describe, expect, it } from "vitest";

import {
  buildReconsolidationPrompt,
  describeReconsolidationPatch,
  parseReconsolidationExplanation,
  recallPairOf,
  toReconsolidationPatch,
} from "../src/orchestrator/intent/reconsolidation-write.js";
import { validatePatch } from "../src/orchestrator/intent/version-chain.js";
import type { ReconsolidationCandidate } from "../src/orchestrator/intent/reconsolidation.js";

const NOW = 1_793_400_000_000;

function candidate(): ReconsolidationCandidate {
  return {
    olderMemoryId: "m-old",
    newerMemoryId: "m-new",
    topicDomain: "聊天",
    reason: "valence_flip",
    olderValence: 0.9,
    newerValence: 0.1,
    valenceGap: 0.8,
    olderBucket: "positive",
    newerBucket: "negative",
    requiresExplanation: true,
  };
}

describe("§5.4 再巩固写入口", () => {
  it("提示要求两行固定格式，并给出两条原话与话题", () => {
    const messages = buildReconsolidationPrompt({
      personaName: "AI助手",
      topicDomain: "聊天",
      pair: {
        older: { id: "m-old", content: "今天真糟糕", createdAtMs: NOW - 86_400_000 },
        newer: { id: "m-new", content: "其实那天也没那么糟", createdAtMs: NOW },
      },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("我现在这么理解：");
    expect(messages[0]!.content).toContain("为什么：");
    expect(messages[0]!.content).toContain("AI助手");
    expect(messages[1]!.content).toContain("话题：聊天");
    expect(messages[1]!.content).toContain("今天真糟糕");
    expect(messages[1]!.content).toContain("其实那天也没那么糟");
  });

  it("解析两行格式", () => {
    const parsed = parseReconsolidationExplanation(
      "我现在这么理解：那天她不是不耐烦，只是太累了。\n为什么：后来她自己也这么说。",
    );
    expect(parsed).toEqual({
      interpretation: "那天她不是不耐烦，只是太累了。",
      reason: "后来她自己也这么说。",
    });
  });

  it("也认 JSON 对象（宽容但不补话）", () => {
    const parsed = parseReconsolidationExplanation(
      '前言\n{"interpretation":"其实他当时在替我挡事。","reason":"之后我问清楚了。"}\n后记',
    );
    expect(parsed?.interpretation).toBe("其实他当时在替我挡事。");
    expect(parsed?.reason).toBe("之后我问清楚了。");
  });

  it("缺一行、或某段太短 → 整条丢弃（返回 null）", () => {
    expect(parseReconsolidationExplanation("我现在这么理解：想通了。")).toBeNull();
    expect(parseReconsolidationExplanation("我现在这么理解：短。\n为什么：短。")).toBeNull();
  });

  it("含元叙述（AI/系统/记忆/引擎）→ 整条丢弃", () => {
    expect(
      parseReconsolidationExplanation(
        "我现在这么理解：作为AI我没有真正的情绪，只是记忆在作怪。\n为什么：因为我是语言模型。",
      ),
    ).toBeNull();
  });

  it("理由太长 → 丢弃；解释太长 → 丢弃", () => {
    const long = "很".repeat(400);
    expect(parseReconsolidationExplanation(`我现在这么理解：${long}`)).toBeNull();
    expect(parseReconsolidationExplanation(`我现在这么理解：${"好".repeat(20)}\n为什么：${long}`)).toBeNull();
  });

  it("空输入 → null", () => {
    expect(parseReconsolidationExplanation("")).toBeNull();
    expect(parseReconsolidationExplanation("   \n  ")).toBeNull();
  });

  it("首条补丁：prevVersion=0、newVersion=1，且通过 validatePatch", () => {
    const patch = toReconsolidationPatch({
      candidate: candidate(),
      current: null,
      explanation: { interpretation: "那天她只是累了。", reason: "后来确认过。" },
    });
    expect(patch.memoryId).toBe("m-old");
    expect(patch.prevVersion).toBe(0);
    expect(patch.newVersion).toBe(1);
    expect(patch.source_ids).toEqual(["m-old", "m-new"]);
    expect(patch.changed).toEqual({ interpretation: "那天她只是累了。" });
    expect(patch.supersededBy).toBeNull();
    expect(validatePatch(patch)).toEqual([]);
  });

  it("已有链时自动接在末端（v2 → v3）", () => {
    const patch = toReconsolidationPatch({
      candidate: candidate(),
      current: { newVersion: 2 },
      explanation: { interpretation: "现在再想，其实没那么严重。", reason: "隔了几天平静了。" },
    });
    expect(patch.prevVersion).toBe(2);
    expect(patch.newVersion).toBe(3);
    expect(validatePatch(patch)).toEqual([]);
  });

  it("只改 interpretation，不碰 valence / salience（状态层的事）", () => {
    const patch = toReconsolidationPatch({
      candidate: candidate(),
      current: null,
      explanation: { interpretation: "那天她只是累了。", reason: "后来确认过。" },
    });
    expect(patch.changed.valence).toBeUndefined();
    expect(patch.changed.salience).toBeUndefined();
  });

  it("解释不合规时 toReconsolidationPatch 抛错（不把废稿写进历史）", () => {
    expect(() =>
      toReconsolidationPatch({
        candidate: candidate(),
        current: null,
        explanation: { interpretation: "好", reason: "行" },
      }),
    ).toThrow(/自我校验失败/);
  });

  it("摘要一行说明从第几版到第几版", () => {
    const patch = toReconsolidationPatch({
      candidate: candidate(),
      current: null,
      explanation: { interpretation: "那天她只是累了。", reason: "后来确认过。" },
    });
    expect(describeReconsolidationPatch(patch)).toBe("再巩固记忆 m-old：v0 → v1（后来确认过。）");
  });

  it("recallPairOf 只投影 id/内容/时间（不把指纹当内容）", () => {
    const pair = recallPairOf(
      { id: "a", content: "旧", created_at: 1, encode_ctx: { channel: "qq" } },
      { id: "b", content: "新", created_at: 2 },
    );
    expect(pair).toEqual({
      older: { id: "a", content: "旧", createdAtMs: 1 },
      newer: { id: "b", content: "新", createdAtMs: 2 },
    });
  });
});
