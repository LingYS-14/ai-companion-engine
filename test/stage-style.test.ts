import { describe, expect, it } from "vitest";

import { composePrompt, type PromptHints } from "../src/dialogue/render.js";
import type { Stage } from "../src/engine/bonds.js";

const BASE: PromptHints = {
  mode: "NORMAL",
  stage: "stranger",
  valence: 0.5,
  arousal: 0.3,
  maskIntegrity: 0.9,
  suppressionLoad: 0.1,
};

describe("人格卡对 [stage-style] 的覆盖（F35）", () => {
  it("没有覆盖时用引擎内置梯度（保证默认角色行为不变）", () => {
    expect(composePrompt(BASE).stageStyle).toBe("客气、保持距离、用敬称");
  });

  it("覆盖只作用于声明的阶段，其余阶段仍用内置梯度", () => {
    const hints: PromptHints = { ...BASE, stageStyleOverride: { stranger: "热情但不越界" } };
    expect(composePrompt(hints).stageStyle).toBe("热情但不越界");
    const familiar: PromptHints = { ...hints, stage: "familiar" };
    expect(composePrompt(familiar).stageStyle).toBe("放松、有玩笑、开始用简称");
  });

  it("四个阶段都能被覆盖（beloved 也不再是通用文案）", () => {
    const override: Partial<Record<Stage, string>> = {
      stranger: "s",
      familiar: "f",
      close: "c",
      beloved: "b",
    };
    for (const stage of ["stranger", "familiar", "close", "beloved"] as const) {
      expect(composePrompt({ ...BASE, stage, stageStyleOverride: override }).stageStyle).toBe(
        override[stage],
      );
    }
  });

  it("stage 为 null（还没有关系进度）时覆盖不生效，仍走占位文案", () => {
    const hints: PromptHints = { ...BASE, stage: null, stageStyleOverride: { stranger: "x" } };
    expect(composePrompt(hints).stageStyle).toContain("暂无关系进度");
  });

  it("覆盖不改动 mode/suppress 这些与状态绑定的层", () => {
    const hints: PromptHints = {
      ...BASE,
      stage: "beloved",
      maskIntegrity: 0.2,
      stageStyleOverride: { beloved: "亲密、允许脆弱" },
    };
    const out = composePrompt(hints);
    expect(out.stageStyle).toBe("亲密、允许脆弱");
    // mask 0.2 属于「几乎不承认情绪」那一档，覆盖不能把它一起改掉
    expect(out.suppressInstruction).toContain("几乎不承认情绪");
  });
});
