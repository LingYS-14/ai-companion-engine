/**
 * v5.4-P1 §4.1 事件类型累计 cap：A33（γ 单调不增、有下限、≤1）+ D6（γ 只缩静态 cap）。
 *
 * 规格的 A33 原文是「第 k 次严格小于第 k−1 次」——与 GAMMA_FLOOR 的 max() 截断直接冲突
 * （触底后相等），审计 F1 已裁决改成**非增**。这里就按非增断言。
 */

import { describe, expect, it } from "vitest";
import { affectionDelta, gammaFor, parseAppraisal, type AppraisalContext, type AppraisalRaw } from "../../src/engine/appraisal.js";
import { knobNumber, knobObject, loadConfig, type EngineConfig } from "../../src/engine/config.js";
import { forAll, int } from "../support/prop.js";

const cfg = loadConfig();

/** 只带两个旋钮的假配置：用来验证 fail-closed 分支，不依赖真实 engine.json */
const fake = (table: Record<string, number>, floor = 1e-4): EngineConfig =>
  ({
    knobs: {
      GAMMA_FLOOR: { kind: "number", value: floor },
      EVENT_TYPE_SATURATION_LAMBDA: { kind: "object", value: table },
    },
  }) as unknown as EngineConfig;

const raw = (over: Partial<AppraisalRaw> = {}): AppraisalRaw => ({
  goal_congruence: 0.9,
  goal_relevance: 1,
  coping_potential: 0.8,
  novelty: 0.1,
  legitimacy: 0.9,
  ...over,
});

const ctx = (count: number): AppraisalContext => ({
  audience_present: 1,
  source: "player",
  event_type: "approach",
  event_type_count: count,
});

describe("§4.1 γ_t：形状与边界（A33）", () => {
  it("首轮 γ=1；随 n_t 单调不增；始终 ≤1 且 ≥GAMMA_FLOOR", () => {
    const floor = knobNumber(cfg, "GAMMA_FLOOR");
    expect(gammaFor("approach", 0, cfg)).toBeCloseTo(1, 12);
    let prev = 1;
    for (let n = 1; n <= 200; n += 1) {
      const g = gammaFor("approach", n, cfg);
      expect(g).toBeLessThanOrEqual(prev);
      expect(g).toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThanOrEqual(floor);
      prev = g;
    }
  });

  it("第 20 次事件约为静态增益的 25%（验收口径）", () => {
    const g = gammaFor("approach", 19, cfg);
    expect(g).toBeGreaterThanOrEqual(0.2);
    expect(g).toBeLessThanOrEqual(0.3);
  });

  it("未登记的事件类型走 default λ，绝不静默按 0 处理（否则 γ 恒为 1）", () => {
    const table = knobObject<Record<string, number>>(cfg, "EVENT_TYPE_SATURATION_LAMBDA");
    const g = gammaFor("从来没有过的事件名", 19, cfg);
    expect(g).toBeCloseTo(1 / (1 + (table["default"] ?? 0) * 19), 10);
    expect(g).toBeLessThan(1);
  });

  it("λ<0 或缺 default 都 fail-closed", () => {
    expect(() => gammaFor("gift", 1, fake({ gift: -1, default: 0.1 }))).toThrow(/必须 ≥ 0/);
    expect(() => gammaFor("gift", 1, fake({ gift: 0.1 }))).toThrow(/缺 default/);
  });

  it("属性：任意 n_t 下 γ 都是有限正值", () => {
    forAll(int(0, 10_000), (n) => {
      const g = gammaFor("approach", n, cfg);
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeGreaterThan(0);
    }, { label: "γ 有限" });
  });
});

describe("§4.1 D6：γ 只缩静态 cap，不叠加乘法链", () => {
  it("饱和后 |delta| 被 cap×γ 夹住，且 γ 越小 |delta| 上限越低", () => {
    const rec = parseAppraisal(raw(), "approach", "e1");
    const first = affectionDelta(rec, ctx(0), cfg);
    const saturated = affectionDelta(rec, ctx(50), cfg);
    expect(first.cappedAt).toBeGreaterThan(saturated.cappedAt);
    expect(Math.abs(saturated.delta)).toBeLessThanOrEqual(saturated.cappedAt + 1e-12);
    expect(saturated.gamma ?? 1).toBeCloseTo(gammaFor("approach", 50, cfg), 12);
  });

  it("被拒来源不产生 delta（gamma 也不该改写这条结论）", () => {
    const rec = parseAppraisal(raw(), "approach", "e1");
    const res = affectionDelta(rec, { ...ctx(5), source: "unknown_source" }, cfg);
    expect(res.applied).toBe(false);
    expect(res.delta).toBe(0);
  });
});
