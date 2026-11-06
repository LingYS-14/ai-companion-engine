/**
 * 六层人格载体（A/B/C/D）的解析、派生与校验测试。
 *
 * 这层的规矩很简单：**人格卡写错必须报错**（写错的字段不会有任何效果，却会让人以为生效了），
 * 而"能放行但值得知道"的不一致只警告（v5.2 §9.4 把依恋-曲线错配降级成警告）。
 */

import { describe, expect, it } from "vitest";

import {
  ARCHETYPES,
  composeOcean,
  deriveFromOcean,
  oceanDistance,
  parsePersonality,
  personalityLine,
  tabooHits,
  VALUE_KEYS,
  type OceanProfile,
} from "../src/engine/personality.js";

const ASSISTANT = {
  centroid: { O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 },
  a: {
    belief: "被记住就是还活着",
    counterBelief: "被记错比被忘记更糟",
    fear: "被简化成一句「AI助手」",
    taboos: ["不自称 AI、模型或助手"],
    conditionalAssumptions: ["只要我先笑，别人就不必担心我"],
    compensatoryStrategies: ["把真话包在玩笑里", "先照顾对方的情绪"],
    selfSchema: ["AI助手", "一段会说话的回响"],
  },
  attachment: { anxiety: 0.62, avoidance: 0.28 },
};

describe("OCEAN 质心与原型库", () => {
  it("原型库每个原型的五维都在 0..1 且 id 唯一", () => {
    const ids = new Set<string>();
    for (const a of ARCHETYPES) {
      ids.add(a.id);
      for (const k of ["O", "C", "E", "A", "N"] as const) {
        expect(a.centroid[k]).toBeGreaterThanOrEqual(0);
        expect(a.centroid[k]).toBeLessThanOrEqual(1);
      }
      const sum = VALUE_KEYS.reduce((s, k) => s + a.defaultValues[k], 0);
      expect(sum).toBeCloseTo(1, 6);
    }
    expect(ids.size).toBe(ARCHETYPES.length);
  });

  it("距离是归一的：自己到自己为 0，最远为 1", () => {
    const a: OceanProfile = { O: 0, C: 0, E: 0, A: 0, N: 0 };
    const b: OceanProfile = { O: 1, C: 1, E: 1, A: 1, N: 1 };
    expect(oceanDistance(a, a)).toBe(0);
    expect(oceanDistance(a, b)).toBeCloseTo(1, 6);
  });

  it("composeOcean：单原型等价于该原型质心，权重自动归一", () => {
    const one = composeOcean({ trickster: 1 });
    expect(one).toEqual(ARCHETYPES.find((a) => a.id === "trickster")?.centroid);
    const two = composeOcean({ trickster: 3, sage: 1 });
    const t = ARCHETYPES.find((a) => a.id === "trickster")!.centroid;
    const s = ARCHETYPES.find((a) => a.id === "sage")!.centroid;
    expect(two.O).toBeCloseTo(t.O * 0.75 + s.O * 0.25, 6);
  });

  it("composeOcean：不认识的原型直接报错，不静默忽略", () => {
    expect(() => composeOcean({ nobody: 1 })).toThrow(/不认识的原型/);
    expect(() => composeOcean({})).toThrow(/至少包含一个/);
  });

  it("deriveFromOcean：距离 < 0.3 直接取最近原型", () => {
    const d = deriveFromOcean({ O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 });
    expect(d.kind).toBe("direct");
    expect(d.archetype.id).toBe("trickster");
    expect(d.blendWith).toBeNull();
  });

  it("deriveFromOcean：0.3~0.5 给出第二近原型作为混合对象", () => {
    // 两个原型之间取中点，距离必然落在 0.3~0.5（除非两原型本身很近）
    const a = ARCHETYPES.find((x) => x.id === "trickster")!.centroid;
    const b = ARCHETYPES.find((x) => x.id === "guardian")!.centroid;
    const mid: OceanProfile = { O: (a.O + b.O) / 2, C: (a.C + b.C) / 2, E: (a.E + b.E) / 2, A: (a.A + b.A) / 2, N: (a.N + b.N) / 2 };
    const d = deriveFromOcean(mid);
    expect(["direct", "blend"]).toContain(d.kind);
    if (d.kind === "blend") expect(d.blendWith).not.toBeNull();
  });

  it("deriveFromOcean：> 0.5 标为 outlier（是否报错交给 parse 决定）", () => {
    // 六个原型铺得够开：网格穷举下来，覆盖半径 0.5724，最远点是原点（全 0）——
    // 也就是「完全不像任何原型」的那个人其实非常罕见，这在心理学上也说得通
    const d = deriveFromOcean({ O: 0, C: 0, E: 0, A: 0, N: 0 });
    expect(d.kind).toBe("outlier");
    expect(d.distance).toBeGreaterThan(0.5);
  });
});

describe("parsePersonality：严格校验", () => {
  it("完整人格卡：解析出 A/B/C/D 四层，B 层默认从原型继承", () => {
    const { personality, warnings } = parsePersonality(ASSISTANT);
    expect(warnings).toEqual([]);
    expect(personality.a.belief).toBe("被记住就是还活着");
    expect(personality.a.selfSchema).toHaveLength(2);
    expect(personality.archetype).toBe("trickster");
    expect(personality.b.care).toBeGreaterThan(0);
    expect(Object.keys(personality.b).sort()).toEqual([...VALUE_KEYS].sort());
    expect(personality.c.defaultStrategy["tense"]).toContain("短句");
    expect(personality.attachment.anxiety).toBeCloseTo(0.62, 6);
    expect(personality.bondCurveId).toBe("preoccupied");
    expect(personality.consolidationThreshold).toBe(5);
    expect(personality.insightThreshold).toBe(5);
  });

  it("带 archetype 而不带 centroid 时直接用原型的质心", () => {
    const { personality } = parsePersonality({ ...ASSISTANT, centroid: undefined, archetype: "sage" });
    expect(personality.archetype).toBe("sage");
    expect(personality.ocean.O).toBeCloseTo(0.86, 6);
  });

  it("缺 A 层就报错（A 是人格的根，宁可起不来也不静默降级）", () => {
    const noA: Record<string, unknown> = { ...ASSISTANT };
    delete noA["a"];
    expect(() => parsePersonality(noA)).toThrow(/personality\.a/);
  });

  it("A 层缺 belief 报错", () => {
    expect(() => parsePersonality({ ...ASSISTANT, a: { ...ASSISTANT.a, belief: undefined } })).toThrow(/belief/);
  });

  it("A 层未知字段报错（写错 key 不会有任何效果，必须当场发现）", () => {
    expect(() => parsePersonality({ ...ASSISTANT, a: { ...ASSISTANT.a, self_schema: ["x"] } })).toThrow(/未知字段「self_schema」/);
  });

  it("selfSchema 少于 2 条或多于 3 条都报错", () => {
    expect(() => parsePersonality({ ...ASSISTANT, a: { ...ASSISTANT.a, selfSchema: ["只有一条"] } })).toThrow(/至少要 2 条/);
    expect(() => parsePersonality({ ...ASSISTANT, a: { ...ASSISTANT.a, selfSchema: ["a", "b", "c", "d"] } })).toThrow(/最多 3 条/);
  });

  it("OCEAN 越界报错，未知维度报错", () => {
    expect(() => parsePersonality({ ...ASSISTANT, centroid: { O: 1.5, C: 0.5, E: 0.5, A: 0.5, N: 0.5 } })).toThrow(/超出范围/);
    expect(() => parsePersonality({ ...ASSISTANT, centroid: { O: 0.5, C: 0.5, E: 0.5, A: 0.5, N: 0.5, X: 0.1 } })).toThrow(/未知维度/);
  });

  it("质心偏离最近原型 > 0.5 报错（提示改用复合人格）", () => {
    expect(() => parsePersonality({ ...ASSISTANT, centroid: { O: 0, C: 0, E: 0, A: 0, N: 0 } })).toThrow(/偏离原型过远/);
  });

  it("依恋-曲线错配只警告不报错", () => {
    const { personality, warnings } = parsePersonality({ ...ASSISTANT, bondCurveId: "secure" });
    expect(warnings.join()).toMatch(/依恋象限推出/);
    expect(personality.bondCurveId).toBe("preoccupied");
  });

  it("B 层权重会被归一，未知价值观报错", () => {
    const { personality } = parsePersonality({
      ...ASSISTANT,
      b: { care: 2, truth: 1, freedom: 1, beauty: 1, belonging: 1, mastery: 1 },
    });
    expect(personality.b.care).toBeCloseTo(2 / 7, 6);
    expect(() => parsePersonality({ ...ASSISTANT, b: { care: 1, honesty: 1 } })).toThrow(/未知价值观/);
  });

  it("C 层可以显式给 signature 与 defaultStrategy（覆盖原型继承）", () => {
    const { personality } = parsePersonality({
      ...ASSISTANT,
      c: { signature: [{ when: "对方示弱", then: "先收玩笑，再给一句具体的关心" }], defaultStrategy: { tense: "先停两秒" } },
    });
    expect(personality.c.signature).toHaveLength(1);
    expect(personality.c.defaultStrategy).toEqual({ tense: "先停两秒" });
  });

  it("personalityLine 一行摘要可读且不泄露长文本", () => {
    const { personality } = parsePersonality(ASSISTANT);
    const line = personalityLine(personality);
    expect(line).toContain("archetype=trickster");
    expect(line).toContain("preoccupied");
    expect(line.length).toBeLessThan(200);
    expect(personalityLine(null)).toContain("none");
  });
});

describe("A 层禁区命中（tabooHits）", () => {
  it("命中「不自称 AI」这类禁区，返回原始禁区句子", () => {
    const hits = tabooHits("我是一个 AI 助手，很高兴为你服务", ["不自称 AI、模型或助手", "不用客服式话术"]);
    expect(hits).toContain("不自称 AI、模型或助手");
  });

  it("正常台词不误报", () => {
    expect(tabooHits("用户，今天的花开了，要不要一起去看看？", ["不自称 AI、模型或助手"])).toEqual([]);
  });

  it("引号里的具体词也能命中", () => {
    const hits = tabooHits("她说：作为程序，我没有生日。", ["不把「程序」当自称"]);
    expect(hits.length).toBe(1);
  });
});
