/**
 * D8 / A38b-1 / A38b-2：jealousy 联动衰减。
 *
 * 规格字面是「半衰期死常数 + recovery 派生衰减」，用户 2026-10-29 明确要求
 * 「半衰期不能一成不变，要跟其它项联动」，因此改为：
 *   实际半衰期 = JEALOUSY_BASE_HALF_LIFE_HOURS / k(state)，
 *   k 由信任/心情/反刍/压力/依恋焦虑共同决定（有界，不让极端状态把衰减拉死）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import {
  initialSState,
  jealousyDecayK,
  jealousyDecayPerHour,
  jealousyHalfLifeHours,
  tick,
  type SState,
} from "../src/engine/state.js";

const cfg = await loadConfig();
const HOUR = 3_600_000;

const view = (over: Partial<{ trust: number; valence: number; rumination: number; pressure: number; anxiety: number }> = {}) => ({
  trust: 0.5,
  valence: 0.5,
  rumination: 0,
  pressure: 0,
  anxiety: 0,
  ...over,
});

describe("D8 联动系数", () => {
  it("中性状态 k=1，半衰期=基线 720h（30 天）", () => {
    expect(jealousyDecayK(view(), cfg)).toBeCloseTo(1, 12);
    expect(jealousyHalfLifeHours(view(), cfg)).toBeCloseTo(720, 9);
    expect(jealousyDecayPerHour(view(), cfg)).toBeCloseTo(Math.LN2 / 720, 12);
  });

  it("信任高 + 心情好 → 消气更快；反刍/压力/焦虑高 → 消气更慢", () => {
    const warm = jealousyHalfLifeHours(view({ trust: 0.9, valence: 0.8 }), cfg);
    const cold = jealousyHalfLifeHours(view({ rumination: 0.7, pressure: 0.6, anxiety: 0.8 }), cfg);
    expect(warm).toBeLessThan(720);
    expect(cold).toBeGreaterThan(720);
  });

  it("系数有界：极端状态不会把半衰期拉出 [12 天, 75 天]", () => {
    const best = jealousyHalfLifeHours(view({ trust: 1, valence: 1, rumination: 0, pressure: 0, anxiety: 0 }), cfg);
    const worst = jealousyHalfLifeHours(view({ trust: 0, valence: 0, rumination: 1, pressure: 1, anxiety: 1 }), cfg);
    expect(best).toBeGreaterThanOrEqual(12 * 24);
    expect(worst).toBeLessThanOrEqual(75 * 24);
  });

  it("半衰期读数实测：经过一个半衰期后 jealousy 减半；k 越大衰减越快", () => {
    const s: SState = { ...initialSState(), jealousy: 0.8, trust: 0.5, valence: 0.5 };
    const half = jealousyHalfLifeHours(view({ trust: s.trust, valence: s.valence, rumination: s.rumination, pressure: s.pressure }), cfg);
    tick(s, { dtHours: half, attachmentAnxiety: 0 }, cfg);
    expect(s.jealousy).toBeCloseTo(0.4, 6);

    const warm: SState = { ...initialSState(), jealousy: 0.8, trust: 0.95, valence: 0.9 };
    const cold: SState = { ...initialSState(), jealousy: 0.8, trust: 0.05, valence: 0.1, rumination: 0.8 };
    tick(warm, { dtHours: 72, attachmentAnxiety: 0.1 }, cfg);
    tick(cold, { dtHours: 72, attachmentAnxiety: 0.9 }, cfg);
    expect(warm.jealousy).toBeLessThan(cold.jealousy);
  });

  it("A38b-2：tick 不直接引用 recovery/EMOTION_DYNAMICS，只经派生衰减率", () => {
    const src = readFileSync(join(process.cwd(), "src/engine/state.ts"), "utf8");
    expect(src).not.toMatch(/recoveryHours|EMOTION_DYNAMICS/);
  });

  it("attachmentAnxiety 越界/非有限时按配置语义处理（有限值参与，NaN 抛错）", () => {
    const s: SState = { ...initialSState(), jealousy: 0.5 };
    expect(() => tick(s, { dtHours: 1, attachmentAnxiety: Number.NaN }, cfg)).toThrow(RangeError);
  });
});
