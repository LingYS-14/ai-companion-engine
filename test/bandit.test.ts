import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import {
  OUTCOMES,
  banditKey,
  classifyReaction,
  emptyBandit,
  recordOutcome,
  selectStrategy,
  splitKey,
  totalN,
  type BanditState,
} from "../src/learning/bandit.js";

const cfg = loadConfig();

describe("§7.4 玩家反应分类", () => {
  it("五个标准结局名原样返回", () => {
    for (const o of OUTCOMES) expect(classifyReaction(o)).toBe(o);
  });

  it("自然语言按关键词归类", () => {
    expect(classifyReaction("他抱了我一下")).toBe("安抚");
    expect(classifyReaction("好开心，今天真甜")).toBe("升温");
    expect(classifyReaction("他完全不理会我")).toBe("冷战");
    expect(classifyReaction("我先走了")).toBe("离开");
  });

  it("认不出的反应落『无视』——这是唯一安全的默认值", () => {
    expect(classifyReaction("嗯")).toBe("无视");
    expect(classifyReaction("   ")).toBe("无视");
  });
});

describe("§7.4 键与倒排索引", () => {
  it("键形状是 语境␟动作，可逆", () => {
    const key = banditKey("conversation", "安抚");
    expect(key).toBe("conversation␟安抚");
    expect(splitKey(key)).toEqual({ contextTag: "conversation", actionTag: "安抚" });
  });

  it("空语境/空动作直接抛错（否则会造出无法回退的孤儿键）", () => {
    expect(() => banditKey("", "安抚")).toThrow(/不能为空/);
    expect(() => banditKey("c", "")).toThrow(/不能为空/);
    expect(() => splitKey("no-separator")).toThrow(/非法/);
  });
});

describe("§7.4 记一次结果", () => {
  it("安抚 = +0.8，n 与 reward 都累加", () => {
    const r1 = recordOutcome(emptyBandit(), { contextTag: "c", actionTag: "安抚", reaction: "安抚" }, cfg);
    expect(r1.result.outcome).toBe("安抚");
    expect(r1.result.delta).toBeCloseTo(0.8, 10);
    expect(r1.result.n).toBe(1);
    expect(r1.result.reward).toBeCloseTo(0.8, 10);
    const key = banditKey("c", "安抚");
    expect(r1.state.table[key]).toEqual({ n: 1, reward: 0.8 });
    expect(r1.state.index["c"]).toEqual([key]);

    const r2 = recordOutcome(r1.state, { contextTag: "c", actionTag: "安抚", reaction: "安抚" }, cfg);
    expect(r2.state.table[key]).toEqual({ n: 2, reward: 1.6 });
    // 倒排索引不重复登记同一个键
    expect(r2.state.index["c"]).toEqual([key]);
  });

  it("原状态不被就地修改（学习层是纯函数）", () => {
    const base = emptyBandit();
    recordOutcome(base, { contextTag: "c", actionTag: "安抚", reaction: "升温" }, cfg);
    expect(Object.keys(base.table)).toHaveLength(0);
  });

  it("升温 = +1.0，冷战/离开 = −0.5，无视 = −0.2", () => {
    const d = (reaction: string): number =>
      recordOutcome(emptyBandit(), { contextTag: "c", actionTag: "a", reaction }, cfg).result.delta;
    expect(d("升温")).toBeCloseTo(1.0, 10);
    expect(d("冷战")).toBeCloseTo(-0.5, 10);
    expect(d("离开")).toBeCloseTo(-0.5, 10);
    expect(d("无视")).toBeCloseTo(-0.2, 10);
  });

  it("totalN 是全局轮数（UCB 的 N）", () => {
    const s1 = recordOutcome(emptyBandit(), { contextTag: "c", actionTag: "a", reaction: "安抚" }, cfg);
    const s2 = recordOutcome(s1.state, { contextTag: "d", actionTag: "b", reaction: "安抚" }, cfg);
    expect(totalN(s2.state)).toBe(2);
  });
});

describe("§7.4 UCB1 选策略", () => {
  it("候选为空 → 回退默认策略（A22 空集回退）", () => {
    const c = selectStrategy(emptyBandit(), "conversation", "自然");
    expect(c).toMatchObject({ actionTag: "自然", ucb: null, source: "fallback" });
    expect(c.candidates).toHaveLength(0);
  });

  it("当前语境没记录过（但别处有）→ 同样回退", () => {
    const s = recordOutcome(emptyBandit(), { contextTag: "praise", actionTag: "调侃", reaction: "升温" }, cfg).state;
    const c = selectStrategy(s, "cold_war", "自然");
    expect(c).toMatchObject({ actionTag: "自然", source: "fallback", ucb: null });
  });

  it("有记录时按 UCB 选，均分与探索项都可算", () => {
    const s = recordOutcome(emptyBandit(), { contextTag: "c", actionTag: "安抚", reaction: "安抚" }, cfg).state;
    const c = selectStrategy(s, "c", "自然");
    expect(c.source).toBe("bandit");
    expect(c.actionTag).toBe("安抚");
    expect(c.candidates).toHaveLength(1);
    const row = c.candidates[0];
    expect(row?.mean).toBeCloseTo(0.8, 10);
    // n=1、N=1 时探索项为 0，ucb 就等于均分
    expect(row?.ucb).toBeCloseTo(0.8, 10);
    expect(c.ucb).toBeCloseTo(0.8, 10);
  });

  it("同分取字典序最小的键——同一输入永远同一答案（可复现）", () => {
    const state: BanditState = {
      table: { "c␟B": { n: 1, reward: 0.5 }, "c␟A": { n: 1, reward: 0.5 } },
      index: { c: ["c␟B", "c␟A"] },
    };
    const first = selectStrategy(state, "c", "自然");
    const second = selectStrategy(state, "c", "自然");
    expect(first.actionTag).toBe("A");
    expect(second.actionTag).toBe(first.actionTag);
  });

  it("被冷落的候选因为探索项更大而翻上来（这是 bandit 而不是 argmax）", () => {
    const state: BanditState = {
      table: { "c␟A": { n: 100, reward: 60 }, "c␟B": { n: 1, reward: 0.8 } },
      index: { c: ["c␟A", "c␟B"] },
    };
    const c = selectStrategy(state, "c", "自然");
    // A 均值 0.6 + sqrt(2 ln 101/100) ≈ 0.6+0.096=0.696；B 0.8 + sqrt(2 ln 101/1) ≈ 0.8+3.04
    expect(c.actionTag).toBe("B");
  });

  it("fallback 为空串直接抛错（不允许返回空策略）", () => {
    expect(() => selectStrategy(emptyBandit(), "c", "")).toThrow(/不能为空/);
  });
});
