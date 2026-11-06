import { describe, expect, it } from "vitest";
import {
  EMPOWERMENT_BY_KIND,
  EPISTEMIC_BY_KIND,
  INTENT_WEIGHTS,
  KIND_DRIVE_POLARITY,
  MAX_IMPACT,
  RPH_BASELINE,
  TOKEN_NORM,
  budgetPressure,
  explainScore,
  rankCandidates,
  reliefOf,
  riskNorm,
  scoreCandidate,
  validateDriveImpact,
} from "../src/orchestrator/intent/scoring.js";
import { buildSituation } from "../src/orchestrator/intent/situation.js";
import { DRIVE_KEYS, INTENT_KINDS, type Candidate, type DriveVector, type SituationFrame } from "../src/orchestrator/intent/types.js";

const DRIVE: DriveVector = {
  energy: 0,
  integrity: 0.5,
  connection: 0.8,
  competence: 0,
  novelty: 0.2,
  coherence: 0,
};

function frame(rph = RPH_BASELINE): SituationFrame {
  return buildSituation({
    at: "2026-10-31T14:00:00.000Z",
    localHour: 14,
    channel: "qq",
    participants: ["owner"],
    affordances: [{ tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false }],
    sinceLastContactMin: 10,
    budget: { rph, peak: false },
  });
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    kind: "reach_out",
    goal: "想找用户说句话",
    because: [{ drive: "connection", gap: 0.8 }],
    drive_impact: { connection: 0.3, novelty: 0.05, integrity: -0.1 },
    planSeeds: ["发一条问候"],
    score: 0,
    cost: { risk: 1, tokens: 0, socialRisk: 0.2 },
    identityFit: 0.5,
    ...overrides,
  };
}

describe("§4.3 (a) 候选打分：全文唯一的三处数学之一", () => {
  it("权重表是冻结的工程先验（运行期不可调），且七项齐全", () => {
    expect(INTENT_WEIGHTS).toEqual({
      drive: 1.0,
      epistemic: 0.6,
      empowerment: 0.5,
      identityFit: 0.7,
      risk: 0.8,
      socialRisk: 0.6,
      budget: 0.5,
    });
    expect(Object.isFrozen(INTENT_WEIGHTS)).toBe(true);
    expect(RPH_BASELINE).toBe(12);
    expect(TOKEN_NORM).toBe(200);
    // 类别先验：探索类信息增益最高，创造类影响通道最高，退开/待着为零
    expect(EPISTEMIC_BY_KIND.explore).toBeGreaterThan(EPISTEMIC_BY_KIND.reach_out);
    expect(EMPOWERMENT_BY_KIND.create).toBeGreaterThan(EMPOWERMENT_BY_KIND.reach_out);
    expect(EPISTEMIC_BY_KIND.withdraw).toBe(0);
    expect(EPISTEMIC_BY_KIND.idle).toBe(0);
    expect(EMPOWERMENT_BY_KIND.idle).toBe(0);
  });

  it("打分可手算：relief 0.2 + 先验项 0.62 − 风险 0.2667 − 社会 0.12 = 0.4333", () => {
    const value = scoreCandidate(candidate(), DRIVE, frame());
    // relief = .8*.3 + .2*.05 + .5*(-.1) = .24 + .01 − .05 = .2
    // + .6*.2（信息增益） + .5*.3（影响通道） + .7*.5（身份匹配）
    // − .8/3（风险 1 归一到 1/3） − .6*.2（社会风险） − 0（额度充足）
    expect(value).toBeCloseTo(0.2 + 0.12 + 0.15 + 0.35 - 0.8 / 3 - 0.12, 10);
    expect(value).toBeCloseTo(0.4333333333, 8);
  });

  it("有符号影响：缓解一个缺口会加剧另一个（硬着头皮社交 = connection + 但 integrity −）", () => {
    const value = scoreCandidate(candidate(), DRIVE, frame());
    const noIntegrityPenalty = scoreCandidate(
      candidate({ drive_impact: { connection: 0.3, novelty: 0.05 } }),
      DRIVE,
      frame(),
    );
    // 少了 .5 * (−.1) = −.05 的惩罚项，分数会高 .05
    expect(noIntegrityPenalty - value).toBeCloseTo(0.05, 10);
  });

  it("风险与额度：risk 0→3 扣 0.8；额度见底时按 token 比例压分，token 0 的候选不受影响", () => {
    const low = scoreCandidate(candidate({ cost: { risk: 0, tokens: 0, socialRisk: 0.2 } }), DRIVE, frame());
    const high = scoreCandidate(candidate({ cost: { risk: 3, tokens: 0, socialRisk: 0.2 } }), DRIVE, frame());
    expect(low - high).toBeCloseTo(0.8, 10);

    const expensive = candidate({ cost: { risk: 1, tokens: 240, socialRisk: 0.2 } });
    const rich = scoreCandidate(expensive, DRIVE, frame(RPH_BASELINE));
    const broke = scoreCandidate(expensive, DRIVE, frame(0));
    expect(budgetPressure(frame(0))).toBe(1);
    expect(budgetPressure(frame(RPH_BASELINE))).toBe(0);
    expect(rich - broke).toBeCloseTo(INTENT_WEIGHTS.budget * 1, 10); // 240/200 截到 1

    const cheap = candidate({ cost: { risk: 1, tokens: 100, socialRisk: 0.2 } });
    expect(scoreCandidate(cheap, DRIVE, frame(RPH_BASELINE)) - scoreCandidate(cheap, DRIVE, frame(0))).toBeCloseTo(
      INTENT_WEIGHTS.budget * 0.5,
      10,
    );

    const idleFree = candidate({ kind: "idle", drive_impact: {}, cost: { risk: 0, tokens: 0, socialRisk: 0 } });
    expect(scoreCandidate(idleFree, DRIVE, frame(0))).toBeCloseTo(
      scoreCandidate(idleFree, DRIVE, frame(RPH_BASELINE)),
      10,
    );
  });

  it("风险归一与幅度上限是写死的常数", () => {
    expect(riskNorm(0)).toBe(0);
    expect(riskNorm(3)).toBe(1);
    expect(riskNorm(1)).toBeCloseTo(1 / 3, 12);
    expect(MAX_IMPACT).toBe(1);
  });

  it("7×6 极性基表覆盖全部类别，只允许已申报的维度", () => {
    for (const kind of INTENT_KINDS) {
      const allowed = KIND_DRIVE_POLARITY[kind];
      expect(allowed, `${kind} 缺基表`).toBeDefined();
      for (const key of Object.keys(allowed)) {
        expect(DRIVE_KEYS).toContain(key);
        expect(["pos", "neg", "both"]).toContain(allowed[key as keyof DriveVector]);
      }
    }
    expect(validateDriveImpact("reach_out", { connection: 0.3, integrity: -0.1 })).toEqual([]);
    expect(validateDriveImpact("idle", {})).toEqual([]);
  });

  it("极性违规 / 超幅 / NaN 一律 fail-closed（返回错误或抛 RangeError），不返回看起来正常的数", () => {
    expect(validateDriveImpact("idle", { connection: 0.1 })).toHaveLength(1);
    expect(validateDriveImpact("reach_out", { competence: 0.1 })).toHaveLength(1);
    expect(validateDriveImpact("reach_out", { integrity: 0.1 })).toHaveLength(1);
    expect(validateDriveImpact("withdraw", { integrity: 1.4 })).toHaveLength(1);
    expect(validateDriveImpact("explore", { novelty: Number.NaN })).toHaveLength(1);
    expect(() => scoreCandidate(candidate({ kind: "idle", drive_impact: { connection: 0.1 } }), DRIVE, frame())).toThrow(
      RangeError,
    );
    expect(() =>
      scoreCandidate(candidate({ cost: { risk: 1, tokens: -5, socialRisk: 0.2 } }), DRIVE, frame()),
    ).toThrow(RangeError);
    expect(() => scoreCandidate(candidate(), { ...DRIVE, connection: Number.NaN }, frame())).toThrow(RangeError);
    expect(() => scoreCandidate(candidate({ identityFit: Number.NaN }), DRIVE, frame())).toThrow(RangeError);
  });

  it("reliefOf 给出逐维贡献，rankCandidates 全序稳定且不改输入", () => {
    const { relief, perDrive } = reliefOf(candidate(), DRIVE);
    expect(relief).toBeCloseTo(0.2, 10);
    expect(perDrive.connection).toBeCloseTo(0.24, 10);
    expect(perDrive.integrity).toBeCloseTo(-0.05, 10);

    const a = candidate({ kind: "explore", goal: "看一条新视频", drive_impact: { novelty: 0.4 } });
    const b = candidate({ kind: "reach_out", goal: "发一条问候" });
    for (const item of [a, b]) item.score = 0.5;
    const ranked = rankCandidates([a, b]);
    // 同分 → 按 INTENT_KINDS 顺序（reach_out 在 explore 之前）
    expect(ranked.map((item) => item.kind)).toEqual(["reach_out", "explore"]);
    expect([a, b].map((item) => item.kind)).toEqual(["explore", "reach_out"]); // 原数组未被原地排序

    // 分数不同时分数优先
    a.score = 0.9;
    expect(rankCandidates([a, b])[0]).toBe(a);

    // goal 字典序是第三顺位：同分同类时按目标文字排
    const c1 = candidate({ goal: "B 句" });
    const c2 = candidate({ goal: "A 句" });
    c1.score = 0.1;
    c2.score = 0.1;
    expect(rankCandidates([c1, c2]).map((item) => item.goal)).toEqual(["A 句", "B 句"]);
  });

  it("explainScore 是审计用的一行，含类别与总分，但不参与判定", () => {
    const text = explainScore(candidate(), DRIVE, frame());
    expect(text).toContain("reach_out");
    expect(text).toContain("U=");
    expect(text).toContain("connection");
  });
});
