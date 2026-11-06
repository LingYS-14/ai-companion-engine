/**
 * v5.4-P1 §4.2 冷热分层：A34（纯函数无副作用）+ 冷边界回归（95h warm / 97h cold）+ 迁移。
 *
 * 这里只测**模块本身**；「cold 不入候选」的 A37a 要等 S2 的检索管线落地，
 * 现阶段先覆盖特赦判定的三条边界（S1 验收里写的是 A37a「先测」）。
 */

import { describe, expect, it } from "vitest";
import { knobNumber, loadConfig } from "../../src/engine/config.js";
import { HOUR_MS, activationNow, baseActivationAfterRetrieval, hoursBetween, migratedBaseActivation, rescuedFromCold, thermalTier } from "../../src/memory/thermal.js";
import { makeMemory } from "../../src/memory/types.js";
import { float, forAll, int } from "../support/prop.js";

const cfg = loadConfig();
const decay = knobNumber(cfg, "ACT_R_DECAY");
const COLD_HOURS = 1 / decay; // base=0 的记录正好掉到 COLD 阈值所需小时数（=96h）

function withVisits(now: number, hoursSinceAccess: number, visits: number) {
  const r = makeMemory({ id: "m1", content: "她在等你", source: "player", created_at: now - 10 * HOUR_MS });
  return {
    ...r,
    access_count: visits,
    last_accessed: now - hoursSinceAccess * HOUR_MS,
    base_activation: 0,
  };
}

describe("§4.2 thermal：时间口径（N1）", () => {
  it("hoursBetween 用毫秒差换算小时，负数裁成 0", () => {
    expect(hoursBetween(0, 2 * HOUR_MS)).toBeCloseTo(2, 10);
    expect(hoursBetween(2 * HOUR_MS, 0)).toBe(0);
    expect(hoursBetween(Number.NaN, 5)).toBe(0);
  });

  it("一次检索的抬升不超过 ln2，且随 Δt 单调递减", () => {
    const a = baseActivationAfterRetrieval(0, 0, cfg);
    const b = baseActivationAfterRetrieval(0, 1, cfg);
    const c = baseActivationAfterRetrieval(0, 48, cfg);
    expect(a).toBeCloseTo(Math.LN2, 10);
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    expect(c).toBeGreaterThan(0);
  });
});

describe("§4.2 thermal：冷边界（验收 95h warm / 97h cold）", () => {
  it("base=0、正好 COLD_HOURS 未访问 → warm；再多 1 小时 → cold", () => {
    const now = 1_000 * HOUR_MS;
    expect(thermalTier(withVisits(now, COLD_HOURS, 0), now, cfg)).toBe("warm");
    expect(thermalTier(withVisits(now, COLD_HOURS + 1, 0), now, cfg)).toBe("cold");
  });

  it("刚访问过、激活被抬高 → hot", () => {
    const now = 1_000 * HOUR_MS;
    const r = { ...withVisits(now, 0, 1), base_activation: Math.LN2 };
    expect(thermalTier(r, now, cfg)).toBe("hot");
  });

  it("A34：thermalTier/activationNow 只读，冻结记录也能算", () => {
    const now = 500 * HOUR_MS;
    const frozen = Object.freeze(withVisits(now, 30, 2));
    const before = JSON.stringify(frozen);
    expect(() => thermalTier(frozen, now, cfg)).not.toThrow();
    expect(() => activationNow(frozen, now, cfg)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("§4.2 特赦阈值（本仓库 specificity 口径，F4 重校准）", () => {
  it("低于两条线都不特赦；任一条过线就特赦", () => {
    const spec = knobNumber(cfg, "SPECIFICITY_RESCUE_THRESHOLD");
    const emo = knobNumber(cfg, "EMOTION_RESCUE_THRESHOLD");
    expect(rescuedFromCold({ specificity: spec - 0.01, emotionMatch: emo - 0.01 }, cfg)).toBe(false);
    expect(rescuedFromCold({ specificity: spec + 0.01, emotionMatch: 0 }, cfg)).toBe(true);
    expect(rescuedFromCold({ specificity: 0, emotionMatch: emo + 0.01 }, cfg)).toBe(true);
  });

  it("属性：两条线都是严格大于才特赦（等于不特赦）", () => {
    const spec = knobNumber(cfg, "SPECIFICITY_RESCUE_THRESHOLD");
    forAll(float(0, spec), (v) => expect(rescuedFromCold({ specificity: v, emotionMatch: 0 }, cfg)).toBe(false), {
      label: "specificity 未过线不特赦",
    });
    expect(rescuedFromCold({ specificity: spec, emotionMatch: 0 }, cfg)).toBe(false);
  });
});

describe("§4.2 迁移（D2）：旧记录补 base_activation", () => {
  it("访问多、年龄小 → 初值更接近 0；老且没访问过 → 被压到 -1 附近", () => {
    const now = 10_000 * HOUR_MS;
    const fresh = migratedBaseActivation({ access_count: 5, last_accessed: now - 2 * HOUR_MS }, now, cfg);
    const old = migratedBaseActivation({ access_count: 0, last_accessed: now - 10_000 * HOUR_MS }, now, cfg);
    expect(fresh).toBeGreaterThan(old);
    expect(fresh).toBeLessThanOrEqual(0);
    expect(old).toBeGreaterThanOrEqual(-1);
  });

  it("属性：任何访问次数/年龄组合都返回有限且 ∈[-1,0]", () => {
    const now = 10_000 * HOUR_MS;
    forAll(int(0, 200), (visits) => {
      const v = migratedBaseActivation({ access_count: visits, last_accessed: now - visits * HOUR_MS }, now, cfg);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(0);
    }, { label: "迁移初值有界" });
  });
});

describe("§4.2 属性：激活随时间单调不增", () => {
  it("Δt 越大，activationNow 越低", () => {
    const now = 1_000 * HOUR_MS;
    forAll(float(0, 500), (age) => {
      const r = withVisits(now, age, 1);
      const a = activationNow(r, now, cfg);
      const b = activationNow(r, now + 10 * HOUR_MS, cfg);
      expect(b).toBeLessThanOrEqual(a);
    }, { label: "activation 单调不增" });
  });
});
