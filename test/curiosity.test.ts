/**
 * 好奇心测试（G5-④ / v5.4-P1 D13）：§10.2 目标生成 + §8.2 curiosity 污点。
 *
 * 三条测试重点，对应三个容易"看起来对、其实错"的写法：
 *   1. `boredom` 已废弃——不传 `curiosity_gap` 就必须跳过并写明，而不是当成 0 静默忽略；
 *   2. 倒 U 动机：缺口太小/太大都不探索，且 `coping`（精力）是乘子；
 *   3. `funny_memes` / `random_exploration` 的来源是 web ⇒ 必须打污点，
 *      而 `relationship_confirmation` 的来源是 player ⇒ 不该打。
 */

import { describe, expect, it } from "vitest";

import { loadConfig, type EngineConfig } from "../src/engine/config.js";
import { initialSState, type SState } from "../src/engine/state.js";
import {
  coverageGap,
  curiosityLine,
  curiosityMotivation,
  curiosityTargets,
  taintForCuriosity,
  type Contact,
} from "../src/learning/curiosity.js";

const cfg = await loadConfig();
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const state = (over: Partial<SState> = {}): SState => ({ ...initialSState(), ...over });
const SECURE = { anxiety: 0.2, avoidance: 0.2 };

describe("§10.2 目标生成", () => {
  it("pressure>0.5 触发关系确认；低压力不触发", () => {
    const hot = curiosityTargets({ state: state({ pressure: 0.6, energy: 0.5 }), attachment: SECURE }, cfg);
    expect(hot.targets.map((t) => t.kind)).toEqual(["relationship_confirmation"]);
    expect(hot.targets[0]?.reason).toContain("pressure=0.60>0.5");

    const calm = curiosityTargets({ state: state({ pressure: 0.4, energy: 0.5 }), attachment: SECURE }, cfg);
    expect(calm.targets).toEqual([]);
  });

  it("anxiety>0.6 单独也能触发（不必看 pressure）", () => {
    const r = curiosityTargets({ state: state({ pressure: 0.2, energy: 0.5 }), attachment: { anxiety: 0.7, avoidance: 0.2 } }, cfg);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]?.reason).toContain("anxiety>0.6");
  });

  it("未配置依恋时跳过 anxiety 判据，并显式写进 skipped", () => {
    const r = curiosityTargets({ state: state({ pressure: 0.2, energy: 0.5 }) }, cfg);
    expect(r.targets).toEqual([]);
    expect(r.skipped.join("；")).toMatch(/attachment 未配置/);
  });

  it("energy>0.7 想找乐子；energy 低时不想", () => {
    const r = curiosityTargets({ state: state({ energy: 0.8, pressure: 0.2 }), attachment: SECURE }, cfg);
    expect(r.targets.map((t) => t.kind)).toContain("funny_memes");
    const low = curiosityTargets({ state: state({ energy: 0.5, pressure: 0.2 }), attachment: SECURE }, cfg);
    expect(low.targets.map((t) => t.kind)).not.toContain("funny_memes");
  });

  it("curiosity_gap 未传 → 跳过 random_exploration 并说明 boredom 已废弃", () => {
    const r = curiosityTargets({ state: state({ pressure: 0.2, energy: 0.5 }), attachment: SECURE }, cfg);
    expect(r.targets).toEqual([]);
    expect(r.skipped.join("；")).toMatch(/curiosity_gap 未提供.*boredom 已废弃/);
  });

  it("倒 U：峰值缺口 + 高精力才探索，缺口过大不探索", () => {
    // 用独立的 coping 抬高动机，避免 energy>0.7 先触发 funny_memes 把随机探索挤掉
    const peak = curiosityTargets(
      { state: state({ pressure: 0.2, energy: 0.5 }), attachment: SECURE, curiosityGap: 1 / 3, coping: 0.9 },
      cfg,
    );
    expect(peak.targets.map((t) => t.kind)).toEqual(["random_exploration"]);
    expect(peak.targets[0]?.reason).toContain("动机 0.90");

    // gap=0.95 已超出倒 U 的有效区：0.95×0.05²/峰值项 ≈ 0.016，乘 0.9 后远低于阈值
    const tooFar = curiosityTargets(
      { state: state({ pressure: 0.2, energy: 0.5 }), attachment: SECURE, curiosityGap: 0.95, coping: 0.9 },
      cfg,
    );
    expect(tooFar.targets.map((t) => t.kind)).not.toContain("random_exploration");
  });

  it("精力低（coping 小）时同一缺口不触发；gap 非有限值抛 RangeError", () => {
    const tired = curiosityTargets(
      { state: state({ pressure: 0.2, energy: 0.2 }), attachment: SECURE, curiosityGap: 1 / 3 },
      cfg,
    );
    expect(tired.targets.map((t) => t.kind)).not.toContain("random_exploration");
    expect(() =>
      curiosityTargets({ state: state(), attachment: SECURE, curiosityGap: Number.NaN }, cfg),
    ).toThrow(RangeError);
  });

  it("联系人未聊完的话题生成 common_topic:<id>，按输入顺序稳定", () => {
    const contacts: Contact[] = [{ id: "u1", pendingTopic: true }, { id: "u2" }, { id: "u3", pendingTopic: true }];
    const r = curiosityTargets({ state: state({ pressure: 0.2, energy: 0.5 }), attachment: SECURE, contacts }, cfg);
    expect(r.targets.map((t) => t.label)).toEqual(["common_topic:u1", "common_topic:u3"]);
  });

  it("多条判据同时成立时顺序与规格一致（已想找乐子就不再叠加随机探索）", () => {
    const r = curiosityTargets({
      state: state({ pressure: 0.9, energy: 0.9 }),
      attachment: SECURE,
      curiosityGap: 1 / 3,
      contacts: [{ id: "u1", pendingTopic: true }],
    }, cfg);
    expect(r.targets.map((t) => t.kind)).toEqual([
      "relationship_confirmation",
      "funny_memes",
      "common_topic",
    ]);
  });
});

describe("§4.6 倒 U 动机公式", () => {
  it("峰值归一化：gap=peak 时为 1；两端趋 0；coping 线性缩放", () => {
    const p = 1 / 3;
    expect(curiosityMotivation(p, 1, cfg)).toBeCloseTo(1, 10);
    expect(curiosityMotivation(0, 1, cfg)).toBe(0);
    expect(curiosityMotivation(1, 1, cfg)).toBe(0);
    expect(curiosityMotivation(p, 0.5, cfg)).toBeCloseTo(0.5, 10);
  });

  it("峰值配置非法（0/1）直接抛，不静默退化", () => {
    const setPeak = (v: number): EngineConfig => {
      const copy = JSON.parse(JSON.stringify(cfg)) as { knobs: Record<string, { value: unknown }> };
      copy.knobs["CURIOSITY_GAP_PEAK"].value = v;
      return copy as unknown as EngineConfig;
    };
    expect(() => curiosityMotivation(0.3, 1, setPeak(0))).toThrow(/CURIOSITY_GAP_PEAK/);
    expect(() => curiosityMotivation(0.3, 1, setPeak(1))).toThrow(/CURIOSITY_GAP_PEAK/);
  });
});

describe("§8.2 curiosity 污点", () => {
  it("web 来源的目标会把 curiosity 标脏，并记录来源", () => {
    const targets = curiosityTargets({ state: state({ energy: 0.9, pressure: 0.2 }), attachment: SECURE }, cfg).targets;
    const t = taintForCuriosity(initialSState().taintMap, targets, cfg, NOW);
    expect(t.tainted).toBe(true);
    expect(t.taintMap["curiosity"]).toEqual({ state: "tainted", since: NOW, sources: ["web"] });
  });

  it("只有关系确认（来源 player）时不打污点", () => {
    const targets = curiosityTargets({ state: state({ pressure: 0.8, energy: 0.4 }), attachment: SECURE }, cfg).targets;
    const t = taintForCuriosity(initialSState().taintMap, targets, cfg, NOW);
    expect(t.tainted).toBe(false);
    expect(t.taintMap["curiosity"]).toBeUndefined();
  });

  it("已有污点不会被好奇心顺手清掉（清污只走 shouldClearTaint）", () => {
    const existing = { ...initialSState().taintMap, curiosity: { state: "tainted" as const, since: NOW - 1000, sources: ["web"] } };
    const t = taintForCuriosity(existing, [], cfg, NOW);
    expect(t.tainted).toBe(false);
    expect(t.taintMap["curiosity"]).toEqual({ state: "tainted", since: NOW - 1000, sources: ["web"] });
  });
});

describe("输出", () => {
  it("没有目标时给中文占位，不是空串", () => {
    expect(curiosityLine([])).toBe("（暂无想弄清的事）");
  });

  it("有目标时每行一个，带原因", () => {
    const targets = curiosityTargets({ state: state({ pressure: 0.9, energy: 0.5 }), attachment: SECURE }, cfg).targets;
    const line = curiosityLine(targets);
    expect(line).toContain("relationship_confirmation ← ");
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("coverageGap（知识覆盖 → 好奇缺口）", () => {
  it("空库返回 undefined（跳过判据，不伪造 0）", () => {
    expect(coverageGap([])).toBeUndefined();
  });
  it("平均新鲜度 0.25 → 缺口 0.75；全新鲜 → 0", () => {
    expect(coverageGap([{ freshness: 0.25 }])).toBeCloseTo(0.75, 10);
    expect(coverageGap([{ freshness: 1 }, { freshness: 1 }])).toBe(0);
  });
  it("越界与非有限值被夹住，不把缺口算成负数", () => {
    expect(coverageGap([{ freshness: 2 }, { freshness: Number.NaN }])).toBeCloseTo(0.5, 10);
    expect(coverageGap([{ freshness: -1 }])).toBe(1);
  });
});
