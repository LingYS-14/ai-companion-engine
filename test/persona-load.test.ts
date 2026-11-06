import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validatePersonalityLoad } from "../src/engine/personality.js";
import { resolvePersonaPath } from "../src/plugin/persona.js";

/**
 * §9.4 加载期校验 + 人格卡路径解析（F155）。
 *
 * 这两个函数守的是同一件事的两半：
 * 1. **她自己的进程到底有没有加载人格卡** —— 以前只找 data/persona-<id>.json，
 *    而那个文件从来不存在，于是 A 层否决 / 人格漂移 / OCEAN 防护在线上全是死代码；
 * 2. 加载时**坏卡必须说出坏在哪**（parsePersonality 抛错只说"哪一步失败"，
 *    校验器要说"哪一处不对"），而"本仓库没有载体"的那条必须显式标记跳过，
 *    不能把"没查"伪装成"通过"（F117/F138 同一根缺陷）。
 */

const GOOD = {
  centroid: { O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 },
  a: {
    belief: "被记住就是还活着",
    counterBelief: "没有人会一直记得",
    fear: "被当成理所当然",
    taboos: ["自称人工智能"],
    conditionalAssumptions: ["如果对方先示弱，我就可以更靠近"],
    compensatoryStrategies: ["用玩笑拆掉沉重"],
    selfSchema: ["我是把人放在前头的那种人", "我不擅长被照顾"],
  },
  b: { care: 28, beauty: 22, truth: 16, freedom: 16, belonging: 12, mastery: 6 },
  c: { signature: [{ when: "对方低落", then: "先陪着，不急着解决" }] },
  attachment: { anxiety: 0.62, avoidance: 0.28 },
  consolidationThreshold: 5,
  insightThreshold: 5,
};

describe("resolvePersonaPath：先看 data/ 覆盖，再退回 persona/<id>.json", () => {
  const opts = (existing: readonly string[]) => ({
    dataDir: "C:/d",
    repoRoot: "C:/r",
    characterId: "assistant",
    exists: (p: string) => existing.includes(p),
  });

  it("两个候选都不存在时返回 null（人格层不生效，但要能说清为什么）", () => {
    expect(resolvePersonaPath(opts([]))).toBeNull();
  });

  it("只有 persona/<id>.json 时用它", () => {
    const p = resolvePersonaPath(opts([join("C:\\r", "persona", "assistant.json")]));
    expect(p).toBe(join("C:\\r", "persona", "assistant.json"));
  });

  it("data/ 里的角色覆盖优先于仓库里的通用卡", () => {
    const data = join("C:\\d", "persona-assistant.json");
    const repo = join("C:\\r", "persona", "assistant.json");
    expect(resolvePersonaPath(opts([data, repo]))).toBe(data);
  });
});

describe("validatePersonalityLoad：合成卡全绿", () => {
  it("F326：随包人格卡已删除；合成卡通过全部七条检查", () => {
    // F326 后仓库里不再有 persona/assistant.json，但校验器仍是回退 B 的守门员：
    // 用 GOOD 合成卡保证"合法输入 → 全绿、七条检查都有结论"这条契约还在。
    const raw = { personality: GOOD } as Record<string, unknown>;
    const report = validatePersonalityLoad(raw["personality"]);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      "unknown_fields",
      "numeric_ranges",
      "self_schema",
      "centroid_distance",
      "attachment_curve",
      "insight_reachable",
      "schema_attention",
    ]);
    // 没有 attention_tags 载体 → 必须显式 skipped，不能算"通过"
    expect(report.checks.find((c) => c.id === "schema_attention")?.skipped).toBe(true);
    // 加载时没有历史样本 → insight 可达性跳过（运行时会再判）
    expect(report.checks.find((c) => c.id === "insight_reachable")?.skipped).toBe(true);
  });
});

describe("validatePersonalityLoad：坏卡说清坏在哪", () => {
  const detailOf = (raw: unknown, id: string): string => {
    const r = validatePersonalityLoad(raw);
    const c = r.checks.find((x) => x.id === id);
    expect(c?.ok, `${id} 应当报错`).toBe(false);
    return c?.detail ?? "";
  };

  it("未知顶层字段 / a.* / attachment.* / c.* 都 fail-closed", () => {
    expect(detailOf({ ...GOOD, extra: 1 }, "unknown_fields")).toContain("extra");
    expect(detailOf({ ...GOOD, a: { ...GOOD.a, unknownA: 1 } }, "unknown_fields")).toContain("a.unknownA");
    expect(detailOf({ ...GOOD, attachment: { ...GOOD.attachment, unknownD: 1 } }, "unknown_fields")).toContain(
      "attachment.unknownD",
    );
    expect(detailOf({ ...GOOD, c: { ...GOOD.c, unknownC: 1 } }, "unknown_fields")).toContain("c.unknownC");
  });

  it("OCEAN / 依恋越界、阈值越界都在 numeric_ranges 里点名", () => {
    const detail = detailOf(
      {
        ...GOOD,
        centroid: { ...GOOD.centroid, O: 1.4 },
        attachment: { anxiety: -0.2, avoidance: 0.3 },
        insightThreshold: 400,
      },
      "numeric_ranges",
    );
    expect(detail).toContain("centroid.O");
    expect(detail).toContain("attachment.anxiety");
    expect(detail).toContain("insightThreshold");
  });

  it("self_schema 少于 2 条直接不通过（§9.3）", () => {
    expect(detailOf({ ...GOOD, a: { ...GOOD.a, selfSchema: ["只有一条"] } }, "self_schema")).toContain("2~3");
  });

  it("质心离所有原型 > 0.5 时 outlier 报错", () => {
    // 原点离最近原型 0.5724（F124 的网格实测）
    expect(detailOf({ ...GOOD, centroid: { O: 0, C: 0, E: 0, A: 0, N: 0 } }, "centroid_distance")).toContain("0.5");
  });

  it("依恋-曲线不一致只进 warnings（v5.2 §9.4 降级），不拦加载", () => {
    const raw = { ...GOOD, bondCurveId: "secure" }; // 0.62/0.28 → preoccupied
    const r = validatePersonalityLoad(raw);
    const c = r.checks.find((x) => x.id === "attachment_curve");
    expect(c?.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0] ?? "").toContain("preoccupied");
  });

  it("给了 evidenceMedian 时，阈值不可达报错；可达不报", () => {
    const bad = validatePersonalityLoad({ ...GOOD, insightThreshold: 50 }, { evidenceMedian: 2 });
    expect(bad.checks.find((c) => c.id === "insight_reachable")?.ok).toBe(false);
    expect(bad.ok).toBe(false);
    const fine = validatePersonalityLoad({ ...GOOD, insightThreshold: 5 }, { evidenceMedian: 4 });
    expect(fine.checks.find((c) => c.id === "insight_reachable")?.ok).toBe(true);
  });

  it("不是对象时也不抛错（只报 unknown_fields）", () => {
    const r = validatePersonalityLoad("nope");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "unknown_fields")?.detail).toContain("不是对象");
  });
});
