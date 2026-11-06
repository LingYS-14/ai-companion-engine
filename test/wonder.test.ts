import { describe, expect, it } from "vitest";

import {
  WONDER_SPEAK,
  wonderOf,
  wonderTopic,
  type Wonder,
  type WonderInput,
} from "../src/psychology/wonder.js";

/** 一个"平静、下午、没刚学东西"的基线：分数落在 0.45–0.65 之间，便于逐个改一个量看变化 */
const BASE: WonderInput = {
  state: { valence: 0.6, arousal: 0.5, energy: 0.8, entropy: 0.2, dissonance: 0 },
  newKnowledge: 0,
  hoursSinceLearn: 0,
  localHour: 15,
};

function input(over: Partial<WonderInput> = {}, state: Partial<WonderInput["state"]> = {}): WonderInput {
  return { ...BASE, ...over, state: { ...BASE.state, ...state } };
}

function wonder(over: Partial<WonderInput> = {}, state: Partial<WonderInput["state"]> = {}): Wonder {
  return wonderOf(input(over, state));
}

describe("wonderOf：规则① 刚学到新东西", () => {
  it("newKnowledge>0 把分值抬到 0.6 以上，方向是 newborn", () => {
    const learned = wonder({ newKnowledge: 2 });
    expect(learned.push).toBe("newborn");
    expect(learned.score).toBeGreaterThanOrEqual(0.6);
    expect(learned.score).toBeGreaterThan(wonder().score);
  });

  it("保底压过深夜/低能量/心乱/久未学习的扣分：刚学到就是 0.6 以上", () => {
    const learned = wonder(
      { newKnowledge: 1, hoursSinceLearn: 400, localHour: 2 },
      { valence: 0.1, arousal: 0.1, energy: 0.1, dissonance: 0.9 },
    );
    expect(learned.push).toBe("newborn");
    expect(learned.score).toBeGreaterThanOrEqual(0.6);
  });
});

describe("wonderOf：规则② 久未学习", () => {
  it("超过 36 小时开始下降，越久越低", () => {
    const fresh = wonder({ hoursSinceLearn: 0 });
    const stale = wonder({ hoursSinceLearn: 48 });
    const staler = wonder({ hoursSinceLearn: 200 });
    expect(stale.score).toBeLessThan(fresh.score);
    expect(staler.score).toBeLessThan(stale.score);
  });

  it("36 小时以内不扣分（边界在 >36 而不是 >=36）", () => {
    expect(wonder({ hoursSinceLearn: 36 }).score).toBe(wonder({ hoursSinceLearn: 0 }).score);
  });
});

describe("wonderOf：规则③ 深夜", () => {
  it("0–6 点下降，越接近 0 点越低", () => {
    const afternoon = wonder({ localHour: 15 });
    const lateNight = wonder({ localHour: 3 });
    const midnight = wonder({ localHour: 0 });
    expect(lateNight.score).toBeLessThan(afternoon.score);
    expect(midnight.score).toBeLessThan(lateNight.score);
  });
});

describe("wonderOf：规则④ energy<0.35", () => {
  it("越累越低，0.35 是边界（不扣分）", () => {
    const rested = wonder({}, { energy: 0.8 });
    const tired = wonder({}, { energy: 0.2 });
    expect(tired.score).toBeLessThan(rested.score);
    expect(wonder({}, { energy: 0.35 }).score).toBe(rested.score);
  });
});

describe("wonderOf：规则⑤ 心乱时方向偏向 effort", () => {
  it("entropy>=0.55 给 effort；平静时给 beauty", () => {
    expect(wonder({}, { entropy: 0.8 }).push).toBe("effort");
    expect(wonder({}, { entropy: 0.2 }).push).toBe("beauty");
  });
});

describe("wonderOf：分值边界与方向", () => {
  it("上界 1：各项都拉满也封顶在 1", () => {
    const max = wonder(
      { newKnowledge: 3, localHour: 12 },
      { valence: 1, arousal: 1, energy: 1, dissonance: 0 },
    );
    expect(max.score).toBe(1);
  });

  it("下界 0：各项都往下也封底在 0，且说不出话", () => {
    const min = wonder(
      { hoursSinceLearn: 1000, localHour: 0 },
      { valence: 0, arousal: 0, energy: 0, dissonance: 1, entropy: 0.5 },
    );
    expect(min.score).toBe(0);
    expect(min.push).toBeNull();
  });

  it("心里发沉（valence 低但有话可说）时方向是 farewell", () => {
    const w = wonder({}, { valence: 0.35, arousal: 0.5 });
    expect(w.score).toBeGreaterThanOrEqual(WONDER_SPEAK);
    expect(w.push).toBe("farewell");
  });

  it("reason 永远是人话（非空、不含数字占位）", () => {
    for (const w of [wonder(), wonder({ newKnowledge: 1 }), wonder({}, { entropy: 0.8 }), wonder({}, { valence: 0.35 })]) {
      expect(w.reason.length).toBeGreaterThan(0);
      expect(w.reason).not.toContain("undefined");
    }
  });
});

describe("wonderOf：确定性", () => {
  it("同输入同输出，且不修改入参", () => {
    const arg = input({ newKnowledge: 1 }, { entropy: 0.7 });
    const before = JSON.stringify(arg);
    const a = wonderOf(arg);
    const b = wonderOf(arg);
    expect(a).toEqual(b);
    expect(JSON.stringify(arg)).toBe(before);
  });
});

describe("wonderTopic：有话题才有话说", () => {
  it("beauty：说一件具体的美", () => {
    const t = wonderTopic({ score: 0.7, push: "beauty", reason: "" });
    expect(t?.topic).toBe("beauty");
    expect(t?.note).toContain("美");
  });

  it("effort：说人努力时的好看", () => {
    const t = wonderTopic({ score: 0.7, push: "effort", reason: "" });
    expect(t?.topic).toBe("effort");
    expect(t?.note).toContain("努力");
  });

  it("newborn：说刚学到的那件事", () => {
    const t = wonderTopic({ score: 0.9, push: "newborn", reason: "" });
    expect(t?.topic).toBe("newborn");
    expect(t?.note).toContain("学到");
  });

  it("farewell：说告别与传承", () => {
    const t = wonderTopic({ score: 0.7, push: "farewell", reason: "" });
    expect(t?.topic).toBe("farewell");
    expect(t?.note).toContain("告别");
  });

  it("score<0.45 返回 null（说不出来就不要硬编）", () => {
    expect(wonderTopic({ score: 0.44, push: "beauty", reason: "" })).toBeNull();
    expect(wonderTopic(wonder({ hoursSinceLearn: 200 }))).toBeNull();
  });
});
