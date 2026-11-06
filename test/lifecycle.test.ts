import { describe, expect, it } from "vitest";
import {
  computeFreshness,
  decayVividness,
  hardDeleteEligible,
  shouldColdArchive,
  updateConfidence,
  updateUnresolved,
} from "../src/memory/lifecycle.js";
import { decayUnresolved, shouldForgetNow, tickVividness } from "../src/memory/lifecycle.js";
import { loadConfig } from "../src/engine/config.js";

const cfg = loadConfig();
const DAY = 86_400_000;

describe("§6.2 confidence", () => {
  it("0.3×vividness + 0.7×accuracy（乘 accuracy，不是自身）", () => {
    expect(updateConfidence({ vividness: 0.8, accuracy: 0.5 })).toBeCloseTo(0.59, 10);
  });

  it("vividness 高但 accuracy 低时不会自我强化", () => {
    let v = 0.9;
    for (let i = 0; i < 20; i++) v = updateConfidence({ vividness: 0.9, accuracy: 0.1 });
    expect(v).toBeCloseTo(0.34, 10);
  });
});

describe("§6.3 L2 freshness", () => {
  const k = (over: Partial<Parameters<typeof computeFreshness>[0]> = {}) => ({
    knowledge_type: "meme",
    ingested_at: 0,
    access_count: 0,
    social_freshness: 1,
    ...over,
  });

  it("meme 半衰期 7 天：7 天后正好 0.5", () => {
    expect(computeFreshness(k(), 7 * DAY, cfg)).toBeCloseTo(0.5, 6);
  });

  it("lore 9999 天几乎不衰减", () => {
    expect(computeFreshness(k({ knowledge_type: "lore" }), 30 * DAY, cfg)).toBeGreaterThan(0.99);
  });

  it("访问次数加成后仍被 clamp 到 1（原稿无 clamp 会算出 1.4615）", () => {
    expect(computeFreshness(k({ access_count: 1000, social_freshness: 5 }), 0, cfg)).toBeLessThanOrEqual(1);
  });

  it("未知 knowledge_type 抛错，不静默给默认半衰期", () => {
    expect(() => computeFreshness(k({ knowledge_type: "rumor" }), 0, cfg)).toThrow(/KNOWLEDGE_HALFLIFE/);
  });
});

describe("§6.9 冷归档 / 硬删除", () => {
  const m = (over: Record<string, unknown> = {}) => ({
    forgotten: true,
    is_obsession: false,
    vividness: 0.05,
    last_accessed: 0,
    ...over,
  });

  it("三个条件同时满足才冷归档", () => {
    expect(shouldColdArchive(m(), 31 * DAY, cfg)).toBe(true);
    expect(shouldColdArchive(m({ forgotten: false }), 31 * DAY, cfg)).toBe(false);
    expect(shouldColdArchive(m({ is_obsession: true }), 31 * DAY, cfg)).toBe(false);
    expect(shouldColdArchive(m({ vividness: 0.5 }), 31 * DAY, cfg)).toBe(false);
    expect(shouldColdArchive(m(), 10 * DAY, cfg)).toBe(false);
  });

  it("字段名是 last_accessed（F16：last_access 会让归档永不触发）", () => {
    expect(shouldColdArchive(m({ last_accessed: 30 * DAY }), 31 * DAY, cfg)).toBe(false);
    expect(shouldColdArchive(m({ last_accessed: 0 }), 31 * DAY, cfg)).toBe(true);
  });

  it("硬删除需要显式标记且过 7 天保留期", () => {
    const d = { hard_deleted: true, hard_delete_at: 0 };
    expect(hardDeleteEligible(d, 6 * DAY, cfg)).toBe(false);
    expect(hardDeleteEligible(d, 8 * DAY, cfg)).toBe(true);
    expect(hardDeleteEligible({}, 8 * DAY, cfg)).toBe(false);
  });
});

describe("§6.4 高唤醒 / §6.8 未解决度", () => {
  it("arousal < 0.7 时不额外衰减", () => {
    expect(decayVividness({ vividness: 0.8 }, 0.5, 3, cfg)).toBeCloseTo(0.8, 10);
  });

  it("arousal ≥ 0.7 时按 0.1^天 衰减", () => {
    expect(decayVividness({ vividness: 0.8 }, 0.9, 1, cfg)).toBeCloseTo(0.08, 10);
    expect(decayVividness({ vividness: 0.8 }, 0.7, 2, cfg)).toBeCloseTo(0.008, 10);
  });

  it("unresolved 只增不减？不：未解决加 gain，解决后按 decay 回落，上界 1", () => {
    expect(updateUnresolved({ unresolved_score: 0.5 }, false, 1, cfg)).toBeCloseTo(0.58, 10);
    expect(updateUnresolved({ unresolved_score: 0.5 }, true, 1, cfg)).toBeCloseTo(0.48, 10);
    expect(updateUnresolved({ unresolved_score: 1 }, false, 1, cfg)).toBe(1);
  });
});

describe("§6.5 鲜明度衰减（G6-①）", () => {
  it("平静时按 DECAY_RATE 衰减：1 天 → v·2^-0.7", () => {
    expect(tickVividness(0.5, 0.2, 1, cfg)).toBeCloseTo(0.5 * Math.pow(2, -0.7), 10);
  });

  it("高唤醒时用 HIGH_AROUSAL_DECAY_FACTOR（0.1）—— 数值上更慢", () => {
    const high = tickVividness(0.5, 0.9, 1, cfg);
    const low = tickVividness(0.5, 0.2, 1, cfg);
    expect(high).toBeCloseTo(0.5 * Math.pow(2, -0.07), 10);
    expect(high).toBeGreaterThan(low);
  });

  it("dt=0 不衰减；负数按 0 处理", () => {
    expect(tickVividness(0.5, 0.2, 0, cfg)).toBe(0.5);
    expect(tickVividness(0.5, 0.2, -3, cfg)).toBe(0.5);
  });

  it("跌破阈值且非执念才遗忘", () => {
    expect(shouldForgetNow(0.09, false, cfg)).toBe(true);
    expect(shouldForgetNow(0.09, true, cfg)).toBe(false);
    expect(shouldForgetNow(0.2, false, cfg)).toBe(false);
  });

  it("unresolved 按 exp(-UNRESOLVED_DECAY·dt) 回落", () => {
    expect(decayUnresolved(0.5, 10, cfg)).toBeCloseTo(0.5 * Math.exp(-0.2), 10);
  });
});
