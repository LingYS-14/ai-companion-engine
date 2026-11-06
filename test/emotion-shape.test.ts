/**
 * A38a：EMOTION_DYNAMICS 的 onset / peak 必须在 emerge 里被真正引用。
 *
 * 规格只要求"被引用"，但直接按 onset 归零会把日常 0.2 的嫉妒抹平（角色性格级回归），
 * 所以实现成 0.6–1.0 的淡入：onset 以下仍保留 60% 强度，peak 及以上满强度。
 */

import { describe, expect, it } from "vitest";

import { emerge, emotionStrength, parseAppraisal } from "../src/engine/appraisal.js";

const DYN = {
  jealousy: { onset: 0.5, peak: 0.8 },
  shame: { onset: 0.4, peak: 0.7 },
  joy: { onset: 0.6, peak: 0.9 },
  anger: { onset: 0.5, peak: 0.8 },
  fear: { onset: 0.7, peak: 0.9 },
  sadness: { onset: 0.3, peak: 0.6 },
  surprise: { onset: 0.8, peak: 0.95 },
};
const shape = (): Record<string, { onset: number; peak: number }> => ({ jealousy: { onset: 0.5, peak: 0.8 } });
const raw = (over: Record<string, number> = {}) => ({
  goal_relevance: 0.8,
  goal_congruence: -0.6,
  novelty: 0.4,
  coping_potential: 0.3,
  legitimacy: 0.2,
  ...over,
});

describe("A38a 涌现强度归一化", () => {
  it("onset 以下保留 60%，onset→peak 线性升到 100%，peak 以上封顶 100%", () => {
    expect(emotionStrength(0.2, { onset: 0.5, peak: 0.8 })).toBeCloseTo(0.12, 12);
    expect(emotionStrength(0.65, { onset: 0.5, peak: 0.8 })).toBeCloseTo(0.65 * (0.6 + 0.4 * 0.5), 12);
    expect(emotionStrength(0.79, { onset: 0.5, peak: 0.8 })).toBeLessThanOrEqual(0.79);
    expect(emotionStrength(0.95, { onset: 0.5, peak: 0.8 })).toBeCloseTo(0.95, 12);
  });

  it("单调不减：raw 越大，涌现强度不会反而变小", () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = emotionStrength(x, { onset: 0.3, peak: 0.9 });
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = y;
    }
  });

  it("onset/peak 非法（span<=0）直接抛，不静默退化", () => {
    expect(() => emotionStrength(0.5, { onset: 0.8, peak: 0.8 })).toThrow(RangeError);
    expect(() => emotionStrength(0.5, { onset: 0.9, peak: 0.2 })).toThrow(RangeError);
  });

  it("emerge 传 dynamics 时每个情绪都被归一化；缺声明 fail-closed", () => {
    const record = parseAppraisal(raw(), "insult", "a38a-1");
    const plain = emerge(record, { audience_present: 0 });
    const shaped = emerge(record, { audience_present: 0 }, DYN);
    expect(shaped.jealousy).toBeLessThan(plain.jealousy);
    expect(shaped.joy).toBe(plain.joy); // joy 的 raw 本来就是 0，归一化不动 0
    expect(() => emerge(record, { audience_present: 0 }, shape())).toThrow(/缺少情绪/);
  });
});
