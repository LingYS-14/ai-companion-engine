/**
 * 「今天学什么由状态决定」的测试（§10.2 好奇心 → 学习计划）。
 *
 * 三个容易写错的地方，逐条钉住：
 *   1. 状态没偏好时必须返回 `null`（把选择权退回固定轮转），**不能**自己挑一个——
 *      否则日志分不清"她想学"和"排到她了"；
 *   2. 偏好词必须真的在计划里；不在就返回 `null`，不许发明关键词（那会搜到计划外内容）；
 *   3. 同一状态 + 同一 rotation 必须给同一个词（可复现），否则线上行为无法回放。
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { initialSState, type SState } from "../src/engine/state.js";
import { chooseLearningKeyword, type PlanGroup } from "../src/learning/learn-plan.js";

const cfg = await loadConfig();

const state = (over: Partial<SState> = {}): SState => ({ ...initialSState(), ...over });
const SECURE = { anxiety: 0.2, avoidance: 0.2 };

/** 与 `src/bili/topics.ts` 的 LEARNING_PLAN 同形（这里复制而不是 import：大脑层不许摸工具层） */
const PLAN: readonly PlanGroup[] = [
  { topic: "崩坏三", keywords: ["崩坏3", "崩坏三", "AI助手", "逐火十三英桀", "往世乐土"] },
  { topic: "二次元", keywords: ["动画短片", "手书", "剧情解析", "圣地巡礼", "国创"] },
];

describe("好奇心决定学什么", () => {
  it("压力高 → 去学她的世界线（AI助手），而不是计划第一项「崩坏3」", () => {
    const choice = chooseLearningKeyword(
      { plan: PLAN, state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice?.keyword).toBe("AI助手");
    expect(choice?.topic).toBe("崩坏三");
    expect(choice?.reason).toContain("relationship_confirmation");
    expect(choice?.targets).toContain("relationship_confirmation");
  });

  it("同一偏好下有多个候选词时按 rotation 轮着换（不连续十几轮搜同一个词）", () => {
    const pick = (rotation: number): string | undefined =>
      chooseLearningKeyword(
        { plan: PLAN, state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE, rotation },
        cfg,
      )?.keyword;
    expect(pick(0)).toBe("AI助手");
    expect(pick(1)).toBe("逐火十三英桀");
    expect(pick(2)).toBe("往世乐土");
    expect(pick(3)).toBe("AI助手"); // 3 % 3 = 0，绕回来
  });

  it("精力足 → 去学轻的（动画短片/手书），而不是角色剧情", () => {
    const choice = chooseLearningKeyword(
      { plan: PLAN, state: state({ pressure: 0.3, energy: 0.8 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice?.keyword).toBe("动画短片");
    expect(choice?.reason).toContain("funny_memes");
  });

  it("压力高且精力足时，先关系确认（目标顺序与规格一致）", () => {
    const choice = chooseLearningKeyword(
      { plan: PLAN, state: state({ pressure: 0.6, energy: 0.8 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice?.keyword).toBe("AI助手");
  });

  it("状态没给出偏好 → null（退回固定轮转，不替她决定）", () => {
    const choice = chooseLearningKeyword(
      { plan: PLAN, state: state({ pressure: 0.4, energy: 0.5 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice).toBeNull();
  });

  it("计划里没有偏好词 → null，不发明关键词", () => {
    const noCharacter: readonly PlanGroup[] = [{ topic: "二次元", keywords: ["动画短片", "国创"] }];
    const choice = chooseLearningKeyword(
      { plan: noCharacter, state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice).toBeNull();
  });

  it("有空组/空词时不崩，且不把空白当关键词", () => {
    const ragged: readonly PlanGroup[] = [
      { topic: "  ", keywords: ["  ", ""] },
      { topic: "崩坏三", keywords: [" AI助手 "] },
    ];
    const choice = chooseLearningKeyword(
      { plan: ragged, state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE, rotation: 0 },
      cfg,
    );
    expect(choice?.keyword).toBe("AI助手");
    expect(choice?.topic).toBe("崩坏三");
  });

  it("同一输入必然同一输出（可复现，能回放）", () => {
    const input = {
      plan: PLAN,
      state: state({ pressure: 0.7, energy: 0.2 }),
      attachment: SECURE,
      rotation: 2,
    } as const;
    expect(chooseLearningKeyword(input, cfg)).toEqual(chooseLearningKeyword(input, cfg));
  });

  it("rotation 给负数/NaN 也不炸（下游可能从坏文件读回来）", () => {
    for (const rotation of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const choice = chooseLearningKeyword(
        { plan: PLAN, state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE, rotation },
        cfg,
      );
      expect(choice).not.toBeNull();
      expect(PLAN.flatMap((g) => g.keywords)).toContain(choice?.keyword);
    }
  });
});
