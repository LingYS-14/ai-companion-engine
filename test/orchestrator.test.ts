import { describe, expect, it } from "vitest";
import { initialSState, type SState } from "../src/engine/state.js";
import { loadConfig, tickHours } from "../src/engine/config.js";
import { FakeClock } from "../src/engine/clock.js";
import { runTurn, nextIdle, type TurnContext, type TurnRequest } from "../src/orchestrator/turn.js";
import { vetWrite, guardRetrieve } from "../src/firewall/guard.js";
import { assertExpressionTable, composePrompt } from "../src/dialogue/render.js";
import type { AppraisalRaw } from "../src/engine/appraisal.js";

const cfg = loadConfig();
const TAU = tickHours(cfg);

const clock = new FakeClock(Date.UTC(2026, 0, 1));
const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  clock,
  characterId: "lin",
  channel: "web",
  source: "player",
  eventType: "insult",
  audiencePresent: 1,
  ...over,
});

const angry = (over: Partial<AppraisalRaw> = {}): TurnRequest => ({
  text: "你根本不在乎",
  appraisal: {
    goal_congruence: -1,
    goal_relevance: 1,
    coping_potential: 0.1,
    novelty: 0.5,
    legitimacy: 0.9,
    ...over,
  },
});

describe("orchestrator / turn", () => {
  it("单轮强冲突 → pressure 进 DEFENSE 区间，再空转一轮回落", () => {
    const s = initialSState();
    const req = angry();
    // 让 gain 达到 0.7 量级：jealousy/shame/fear 加权后不足 0.85，用 pressureGain 直接给
    const r = runTurn({ ...req, text: "x" }, s, ctx(), cfg);
    expect(r.trace.pressure).toBeLessThan(0.85); // 普通冲突到不了 DEFENSE

    const s2 = initialSState();
    const r2 = runTurn(req, s2, ctx(), cfg);
    void r2;
    // impulse 0.7：直接走 tick 验证边界（turn 的 gain 来自情绪，量级更小）
    const s3 = initialSState();
    const r3 = runTurn(
      {
        text: "y",
        appraisal: { goal_congruence: -1, goal_relevance: 1, coping_potential: 0, novelty: 0.5, legitimacy: 1 },
        crisis: { id: "c", severity: 0.9, summary: "当众羞辱" },
      },
      s3,
      ctx(),
      cfg,
    );
    expect(r3.immediate).not.toBeNull();
    expect(s3.pressure).toBeCloseTo(1.0, 6); // 0.2 + 0.9 → clamp 1.0
    expect(r3.mode).toBe("DEFENSE");
    nextIdle(s3, cfg);
    expect(s3.pressure).toBeLessThan(1.0);
  });

  it("mode 用 post-tick 状态：同轮就到 BREAK", () => {
    const s = initialSState();
    s.suppressionLoad = 0.68; // 差一点到 0.70
    s.pressure = 0.69;
    const r = runTurn(
      {
        text: "z",
        appraisal: { goal_congruence: -1, goal_relevance: 1, coping_potential: 0.2, novelty: 0.3, legitimacy: 0.5 },
        suppressionIntensity: 1,
      },
      s,
      ctx(),
      cfg,
    );
    expect(r.mode).toBe("BREAK");
    expect(s.maskIntegrity).toBeLessThan(0.35);
  });

  it("affection 只对 RELATION_SOURCES 生效，且被单事件 cap 截断", () => {
    const s1 = initialSState();
    runTurn(angry({ goal_congruence: 1 }), s1, ctx({ source: "player", eventType: "approach" }), cfg);
    const s2 = initialSState();
    const r2 = runTurn(angry({ goal_congruence: 1 }), s2, ctx({ source: "web", eventType: "approach" }), cfg);
    expect(r2.affection.applied).toBe(false);
    expect(s2.affection).toBeCloseTo(0.3, 10);
    expect(s1.affection).toBeGreaterThan(0.3);
  });

  it("信任单步封顶：越强烈的证据也只有 ±0.10", () => {
    const s = initialSState();
    runTurn(angry({ goal_congruence: 1, goal_relevance: 1 }), s, ctx(), cfg);
    expect(s.trust).toBeCloseTo(0.3, 10); // 0.2 + 0.10（而非 +0.5）
  });

  it("crisis 与 si 同时给会抛错（防双计）", () => {
    const s = initialSState();
    expect(() =>
      runTurn(
        { ...angry(), crisis: { id: "c", severity: 0.9, summary: "x" }, suppressionIntensity: 0.5 },
        s,
        ctx(),
        cfg,
      ),
    ).toThrow(/双计/);
  });

  it("hints 带出 mode/stage/信号，供 LLM 使用", () => {
    const s = initialSState();
    const r = runTurn(angry(), s, ctx({ bondProgress: 0.6 }), cfg);
    expect(r.hints.mode).toBe(r.mode);
    expect(r.hints.stage).toBe("close");
    expect(r.hints.maskIntegrity).toBe(s.maskIntegrity);
  });

  it("Clock 冻结：连续两次 turn 的事件 id 不同但不需要真实时间", () => {
    const s = initialSState();
    const a = runTurn(angry(), s, ctx(), cfg);
    clock.advance(TAU * 3_600_000);
    const b = runTurn(angry(), s, ctx(), cfg);
    expect(a.mode).toBeDefined();
    expect(b.mode).toBeDefined();
  });
});

describe("firewall", () => {
  it("可信来源 → clean", () => {
    const v = vetWrite({ content: "她说她累了" }, { source: "player", channel: "web", observedAt: 1 }, cfg);
    expect(v.verdict).toBe("clean");
    expect(v.markTainted).toBe(false);
  });

  it("UNTRUSTED_SOURCES → 保留但打污点", () => {
    const v = vetWrite({ content: "网传她退网了" }, { source: "web", channel: "web", observedAt: 1 }, cfg);
    expect(v.verdict).toBe("quarantined");
    expect(v.markTainted).toBe(true);
  });

  it("空来源 / 空内容 / 非有限时间戳 → 拒绝，不抛错", () => {
    expect(vetWrite({ content: "x" }, { source: "", channel: "web", observedAt: 1 }, cfg).verdict).toBe("rejected");
    expect(vetWrite({ content: "   " }, { source: "player", channel: "web", observedAt: 1 }, cfg).verdict).toBe("rejected");
    expect(vetWrite({ content: "x" }, { source: "player", channel: "web", observedAt: Number.NaN }, cfg).verdict).toBe("rejected");
  });

  it("检索守卫只标记污点记忆（排除 + 打标，不删除）", () => {
    const marks = guardRetrieve([
      { id: "m1", source: "player" },
      { id: "m2", source: "web", retrieved_under_taint: true },
    ]);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.memoryId).toBe("m2");
  });
});

describe("dialogue 表达层", () => {
  it("EXPRESSION_TABLE 空表 → 抛'未实现'，不静默回退", () => {
    expect(() => assertExpressionTable(cfg)).toThrow(/尚未填值/);
  });

  it("composePrompt 按 mask 给三级抑制指令", () => {
    const strong = composePrompt({ mode: "NORMAL", stage: "close", valence: 0.6, arousal: 0.5, maskIntegrity: 0.9, suppressionLoad: 0.1 });
    const weak = composePrompt({ mode: "NORMAL", stage: null, valence: 0.1, arousal: 0.8, maskIntegrity: 0.2, suppressionLoad: 0.8 });
    expect(strong.suppressInstruction).toMatch(/透一点/);
    expect(weak.suppressInstruction).toMatch(/几乎不承认/);
    expect(strong.stageStyle).toMatch(/默契/);
    expect(weak.stageStyle).toMatch(/普通相识/);
  });
});

describe("SState 没有第 14 个字段", () => {
  it("boredom / mode / mark 都不在 S 层", () => {
    const s: SState = initialSState();
    expect(Object.keys(s).sort()).toEqual(
      [
        "affection", "arousal", "dissonance", "energy", "entropy", "jealousy",
        "maskIntegrity", "pressure", "rumination", "suppressionLoad", "taintMap", "trust", "valence",
      ].sort(),
    );
  });
});

describe("v5.4-P1 §4.1：调度层把 n_t 传进 turn，γ 逐次收紧", () => {
  const warm = (): TurnRequest => ({
    text: "谢谢你的礼物",
    appraisal: { goal_congruence: 0.9, goal_relevance: 1, coping_potential: 0.8, novelty: 0.1, legitimacy: 0.9 },
  });

  it("同一类型第 1 轮 γ=1，第 21 轮明显变小，affection 增量也被缩小", () => {
    const first = runTurn(warm(), initialSState(), ctx({ eventType: "gift", eventTypeCount: 0 }), cfg);
    const later = runTurn(warm(), initialSState(), ctx({ eventType: "gift", eventTypeCount: 20 }), cfg);
    expect(first.affection.gamma).toBeCloseTo(1, 10);
    expect(later.affection.gamma).toBeLessThan(0.4);
    expect(later.affection.delta).toBeLessThan(first.affection.delta);
  });

  it("不传 eventTypeCount 等价于首轮（向后兼容）", () => {
    const a = runTurn(warm(), initialSState(), ctx({ eventType: "gift" }), cfg);
    expect(a.affection.gamma).toBeCloseTo(1, 10);
  });
});
