import { describe, expect, it } from "vitest";
import { appraise, affectionDelta, emerge, parseAppraisal, pressureGainFrom, trustDelta } from "../src/engine/appraisal.js";
import { applyRelational, initialSState } from "../src/engine/state.js";
import type { AppraisalRaw, AppraisalContext } from "../src/engine/appraisal.js";
import { loadConfig } from "../src/engine/config.js";

const cfg = loadConfig();

const raw = (over: Partial<AppraisalRaw> = {}): AppraisalRaw => ({
  goal_congruence: -0.8,
  goal_relevance: 1,
  coping_potential: 0.2,
  novelty: 0.4,
  legitimacy: 0.9,
  ...over,
});

const ctx = (over: Partial<AppraisalContext> = {}): AppraisalContext => ({
  audience_present: 1,
  source: "player",
  event_type: "approach",
  ...over,
});

describe("§4.2 Step 1 emerge", () => {
  it("七通道按规格公式取值（阻断型事件）", () => {
    const em = emerge(parseAppraisal(raw(), "insult", "e1"), { audience_present: 1 });
    expect(em.jealousy).toBeCloseTo(0.064, 10);
    expect(em.shame).toBeCloseTo(0.72, 10);
    expect(em.anger).toBeCloseTo(0.576, 10);
    expect(em.fear).toBeCloseTo(0.064, 10);
    expect(em.sadness).toBeCloseTo(0.256, 10);
    expect(em.surprise).toBeCloseTo(0.4, 10);
    expect(em.joy).toBeCloseTo(0, 10);
  });

  it("正向事件只出 joy，不出 anger/shame", () => {
    const em = emerge(parseAppraisal(raw({ goal_congruence: 0.9 }), "praise", "e2"), { audience_present: 1 });
    expect(em.joy).toBeCloseTo(0.9 * 1 * 0.2, 10);
    expect(em.anger).toBe(0);
    expect(em.shame).toBe(0);
  });

  it("audience_present 只放大 shame，不放大 anger", () => {
    const withPeople = emerge(parseAppraisal(raw(), "insult", "e3"), { audience_present: 1 });
    const alone = emerge(parseAppraisal(raw(), "insult", "e3"), { audience_present: 0 });
    expect(withPeople.shame).toBeGreaterThan(alone.shame);
    expect(alone.shame).toBe(0);
    expect(withPeople.anger).toBeCloseTo(alone.anger, 10);
  });

  it("分量非有限值时抛错（不许静默 NaN 进状态）", () => {
    expect(() => parseAppraisal(raw({ goal_relevance: Number.NaN }), "insult", "e4")).toThrow(/非有限值/);
  });
});

describe("§4.2 三分量与 gain", () => {
  it("liking / commitment 由三分量算出", () => {
    const r = parseAppraisal(raw(), "insult", "e5");
    expect(r.liking_component).toBeCloseTo(-0.8, 10);
    expect(r.commitment_component).toBeCloseTo(0.2 * 0.6, 10);
    expect(r.raw).toEqual(raw());
  });

  it("pressure gain 只由 jealousy/shame/fear 加权", () => {
    const em = emerge(parseAppraisal(raw(), "insult", "e6"), { audience_present: 1 });
    expect(pressureGainFrom(em, cfg)).toBeCloseTo(0.5 * 0.064 + 0.4 * 0.72 + 0.3 * 0.064, 10);
  });
});

describe("§4.2 apply_affection（增量由 state 写）", () => {
  it("RELATION_SOURCES 之外来源不改 affection", () => {
    const res = affectionDelta(parseAppraisal(raw(), "insult", "e7"), ctx({ source: "web" }), cfg);
    expect(res.applied).toBe(false);
    expect(res.delta).toBe(0);
  });

  it("单事件增量被 AFFECTION_EVENT_CAP[event_type] 截断", () => {
    const strong = parseAppraisal(raw({ goal_congruence: 1, goal_relevance: 1 }), "approach", "e8");
    const res = affectionDelta(strong, ctx({ event_type: "approach" }), cfg);
    expect(res.delta).toBeCloseTo(0.02, 10);
    expect(res.cappedAt).toBeCloseTo(0.02, 10);
  });

  it("state.applyRelational 是唯一写入点，clamp 在 [0,1]", () => {
    const s = initialSState();
    applyRelational(s, -0.5, -0.5);
    expect(s.affection).toBeCloseTo(0, 10);
    expect(s.trust).toBeCloseTo(0, 10);
    applyRelational(s, 5, 5);
    expect(s.affection).toBe(1);
    expect(s.trust).toBe(1);
  });
});

describe("§4.4 apply_trust_update", () => {
  it("单步被 TRUST_MAX_STEP 封顶（防一步到 1.0）", () => {
    expect(trustDelta(1, 1, 1, cfg)).toBeCloseTo(0.1, 10);
    expect(trustDelta(-1, 1, 1, cfg)).toBeCloseTo(-0.1, 10);
  });

  it("正常量级不触顶：0.5×0.4×0.5 = 0.1 恰好等于上限", () => {
    expect(trustDelta(1, 0.4, 0.5, cfg)).toBeCloseTo(0.1, 10);
    expect(trustDelta(-1, 0.02, 0.5, cfg)).toBeCloseTo(-0.025, 10);
  });
});

describe("appraise() 汇总", () => {
  it("一次调用给出 record / emotions / gain / affection 增量，但不改 S 层", () => {
    const s = initialSState();
    const out = appraise(raw(), "insult", "e9", ctx(), s, cfg);
    // emerge 带 EMOTION_DYNAMICS 归一化（A38a）后压力增益略降：0.3392 → 0.31872
    expect(out.pressureGain).toBeCloseTo(0.31872, 10);
    expect(out.affection.applied).toBe(true);
    expect(s.affection).toBeCloseTo(0.3, 10);
    expect(s.trust).toBeCloseTo(0.2, 10);
  });
});

describe("信任的正向增量应边际递减（否则 8 次好话就钉死在 1.0）", () => {
  it("余量越少，同样一句好话带来的增量越小", () => {
    const atLow = trustDelta(1, 1, 1, cfg, 0.2);
    const atHigh = trustDelta(1, 1, 1, cfg, 0.9);
    expect(atLow).toBeCloseTo(0.1, 10); // 原始 0.5×1×1×(1−0.2)=0.4，被 TRUST_MAX_STEP 夹到 0.1
    expect(atHigh).toBeLessThan(atLow);
    expect(atHigh).toBeCloseTo(0.05, 10); // 0.5×1×1×0.1 = 0.05，未触顶
  });

  it("负向不因信任底子打折", () => {
    expect(trustDelta(-1, 1, 1, cfg, 0.9)).toBeCloseTo(-0.1, 10);
  });

  it("连续满分正向只能逼近、不能钉死在 1.0", () => {
    let t = 0.2;
    for (let i = 0; i < 30; i += 1) t = Math.min(1, t + trustDelta(1, 1, 1, cfg, t));
    expect(t).toBeLessThan(1);
    expect(t).toBeGreaterThan(0.9);
  });
});
