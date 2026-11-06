/**
 * 回退策略测试（G5-②）。
 *
 * 规格 §7.4 的回退是 `archetype.default_strategy[context_tag]`，但规格没有 archetype 表（F19）。
 * 这组测试锁住"替身"的两条底线：
 *   1) 回退值必须是 §A.2 的 ACTION_TYPES 之一（G4 曾回退成"自然"，根本不是动作）；
 *   2) 归一化必须确定，同一个 event_type 每次得到同一个情境。
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { CONTEXT_TAGS, DEFAULT_BY_CONTEXT, defaultStrategyFor, normalizeContext } from "../src/learning/strategy.js";

const cfg = await loadConfig();

describe("normalizeContext：事件标签 → 情境", () => {
  it("中文与英文关键词都能认出（冲突/夸奖/疏远/亲密）", () => {
    expect(normalizeContext("争吵")).toBe("conflict");
    expect(normalizeContext("冷战中")).toBe("conflict");
    expect(normalizeContext("夸我")).toBe("praise");
    expect(normalizeContext("他要离开")).toBe("distance");
    expect(normalizeContext("hug")).toBe("intimacy");
  });

  it("认不出就是 neutral，不做模糊猜测", () => {
    expect(normalizeContext("conversation")).toBe("neutral");
    expect(normalizeContext("")).toBe("neutral");
    expect(normalizeContext("随便聊聊")).toBe("neutral");
  });

  it("同一输入稳定（确定性）", () => {
    for (let i = 0; i < 3; i += 1) expect(normalizeContext("冷战")).toBe(normalizeContext("冷战"));
  });

  it("冲突优先于其它关键词（顺序即优先级）", () => {
    // 同时含「争吵」与「离开」，按表顺序冲突先命中
    expect(normalizeContext("争吵后他要离开")).toBe("conflict");
  });
});

describe("defaultStrategyFor：回退动作必须是合法动作", () => {
  it("五个情境的默认动作都落在 ACTION_TYPES 里", () => {
    const actions = ["care", "ignore", "tease", "praise", "hurt", "promise"];
    for (const tag of CONTEXT_TAGS) {
      expect(actions).toContain(DEFAULT_BY_CONTEXT[tag]);
    }
  });

  it("按情境返回，且对 event_type 归一化后再查表", () => {
    expect(defaultStrategyFor("争吵", cfg)).toBe("care");
    expect(defaultStrategyFor("夸我", cfg)).toBe("praise");
    expect(defaultStrategyFor("他要离开", cfg)).toBe("promise");
    expect(defaultStrategyFor("没有关键词", cfg)).toBe("care");
  });

  it("回退值来自注册表而不是硬编码副本（改注册表就会变）", () => {
    const fake = {
      ...cfg,
      knobs: {
        ...cfg.knobs,
        ACTION_TYPES: { ...(cfg.knobs["ACTION_TYPES"] as object), value: ["care", "ignore", "tease", "praise", "hurt", "promise"] },
      },
    } as typeof cfg;
    const broken = {
      ...cfg,
      knobs: {
        ...cfg.knobs,
        ACTION_TYPES: { ...(cfg.knobs["ACTION_TYPES"] as object), value: ["ignore", "tease"] },
      },
    } as typeof cfg;
    expect(defaultStrategyFor("没有关键词", fake)).toBe("care");
    // 注册表里没有 care 时必须抛错，而不是悄悄返回一个非法动作
    expect(() => defaultStrategyFor("没有关键词", broken)).toThrow(/不在 ACTION_TYPES/);
  });
});
