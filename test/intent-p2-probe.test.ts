import { describe, expect, it } from "vitest";
import type { Stage } from "../src/engine/bonds.js";
import { initialSState, type SState } from "../src/engine/state.js";
import { initialAccumulator } from "../src/orchestrator/intent/bus.js";
import { digestTick, diffDigests, runConsistencyProbe, tickWithState } from "../src/orchestrator/intent/consistency.js";
import { survivalSummary, ticksToSurvival } from "../src/orchestrator/intent/half-life.js";
import { IDLE_MAX_MS, IDLE_MIN_MS, idleDue, idleIntervalMs, planIdleTick, seedFraction } from "../src/orchestrator/intent/idle.js";
import {
  initialIntentState,
  parseIntentState,
  serializeIntentState,
  stateEquals,
  type IntentRuntimeState,
} from "../src/orchestrator/intent/state-file.js";
import { runIntentTick, type IntentTickInput } from "../src/orchestrator/intent/tick.js";
import type { Affordance, IntentionRecord, IntentionStatus } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T06:00:00.000Z";
const QQ: Affordance = { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false };

function state(overrides: Partial<SState> = {}): SState {
  return { ...initialSState(), ...overrides };
}

function tickInput(overrides: Partial<IntentTickInput> = {}): IntentTickInput {
  return {
    situation: {
      at: AT,
      localHour: 14,
      channel: "qq",
      participants: ["用户"],
      affordances: [QQ],
      sinceLastContactMin: 30,
      activeIntents: [],
      budget: { rph: 8, peak: false },
      singleWriterConflict: false,
    },
    state: state({ energy: 0.6, suppressionLoad: 0.2 }),
    stage: "stranger",
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 5,
    valueDeviation: 0.1,
    coverageGap: 0.3,
    trust: 0.5,
    trustFloor: 0.2,
    ...overrides,
  };
}

function intention(survival: number, status: IntentionStatus): IntentionRecord {
  return {
    id: `itn-${survival}-${status}`,
    created_at: AT,
    kind: "reach_out",
    goal: "想找人说句话",
    why: "connection 缺口",
    trigger: null,
    deadline: null,
    status,
    attempts: [],
    superseded_by: null,
    survival,
    source_ids: [],
  };
}

function rtState(overrides: Partial<IntentRuntimeState> = {}): IntentRuntimeState {
  return { ...initialIntentState(1_760_000_000_000), ...overrides };
}

describe("P2 意图运行状态落盘（state-file.ts）", () => {
  it("初始状态序列化后可解析回来，且逐字段相等", () => {
    const initial = rtState({ accumulator: initialAccumulator() });
    const parsed = parseIntentState(serializeIntentState(initial));
    expect(parsed.errors).toEqual([]);
    expect(parsed.state).not.toBeNull();
    expect(stateEquals(serialized(parsed.state), initial)).toBe(true);
  });

  it("带累积器与上一拍驱动往返不丢精度", () => {
    const live = rtState({
      accumulator: { ...initialAccumulator(), reach_out: 0.123456789 },
      previousDrive: { energy: 0.4, integrity: 0.2, connection: 0.75, competence: 0.1, novelty: 0.3, coherence: 0.05 },
      lastTickAtMs: 1_760_000_123_456,
    });
    const parsed = parseIntentState(serializeIntentState(live));
    expect(parsed.errors).toEqual([]);
    expect(stateEquals(serialized(parsed.state), live, 1e-12)).toBe(true);
  });

  it("版本不符直接拒（不静默兼容旧格式）", () => {
    const bad = JSON.parse(serializeIntentState(rtState())) as Record<string, unknown>;
    bad.version = 2;
    const parsed = parseIntentState(JSON.stringify(bad));
    expect(parsed.state).toBeNull();
    expect(parsed.errors.join("；")).toContain("版本");
  });

  it("缺字段 / 越界值 / 坏 JSON 都 fail-closed 并给理由", () => {
    const missing = parseIntentState(JSON.stringify({ version: 1 }));
    expect(missing.state).toBeNull();
    expect(missing.errors.length).toBeGreaterThan(0);

    const outOfRange = JSON.parse(serializeIntentState(rtState())) as Record<string, unknown>;
    (outOfRange.accumulator as Record<string, unknown>).reach_out = 1.5;
    const badValue = parseIntentState(JSON.stringify(outOfRange));
    expect(badValue.state).toBeNull();
    expect(badValue.errors.join("；")).toContain("reach_out");

    const broken = parseIntentState("{not json");
    expect(broken.state).toBeNull();
    expect(broken.errors.join("；")).toContain("JSON");
  });

  it("未知键报错（避免字段被静默吞掉）", () => {
    const withUnknown = JSON.parse(serializeIntentState(rtState())) as Record<string, unknown>;
    withUnknown.mystery = 1;
    const parsed = parseIntentState(JSON.stringify(withUnknown));
    expect(parsed.state).toBeNull();
    expect(parsed.errors.join("；")).toContain("mystery");
  });
});

function serialized(value: IntentRuntimeState | null): IntentRuntimeState {
  if (value === null) throw new Error("解析返回 null，测试自身有问题");
  return value;
}

describe("P2 跨重启一致性探针（consistency.ts）", () => {
  it("同一份状态 + 同一份输入：落盘往返相等，两拍逐字段相同", () => {
    const live = rtState({ accumulator: initialAccumulator() });
    const report = runConsistencyProbe(tickInput(), live);
    expect(report.stateRoundTrip).toBe(true);
    expect(report.diffs).toEqual([]);
    expect(report.consistent).toBe(true);
    expect(report.verdict).toContain("一致");
  });

  it("第二拍接着第一拍的累积器走时，已吐出的意图不会重复吐出（同类活跃被跳过）", () => {
    const live = rtState({ accumulator: initialAccumulator() });
    const first = runIntentTick(tickInput());
    const second = tickWithState(
      { ...tickInput(), activeKinds: first.emitted },
      { ...live, accumulator: first.accumulator, previousDrive: first.drive },
    );
    for (const kind of second.emitted) expect(first.emitted).not.toContain(kind);
  });

  it("摘要差异会被逐条列出（不吞、不只报『不一致』）", () => {
    const a = digestTick(runIntentTick(tickInput()));
    const b = digestTick(runIntentTick(tickInput({ trust: 0.1 })));
    const diffs = diffDigests(a, b);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((line) => line.includes("gate"))).toBe(true);
  });

  it("篡改累积器后的两拍会报出 accumulator 差异", () => {
    const a = digestTick(runIntentTick(tickInput()));
    const tampered = digestTick(
      runIntentTick(tickInput({ accumulator: { ...initialAccumulator(), reach_out: 0.5 }, previousDrive: a.drive as never })),
    );
    expect(diffDigests(a, tampered).some((line) => line.includes("accumulator.reach_out"))).toBe(true);
  });
});

describe("P2 意图存活率半衰期（half-life.ts）", () => {
  it("6 条全部终结、每拍死一条 → 中位寿命 3 拍（KM 手算）", () => {
    const records = [1, 2, 3, 4, 5, 6].map((n) => intention(n, "done"));
    const s = survivalSummary(records);
    expect(s.samples).toBe(6);
    expect(s.deaths).toBe(6);
    expect(s.medianTicks).toBe(3);
    const at3 = s.curve.find((point) => point.survival === 3);
    expect(at3?.survivalProb).toBeCloseTo(0.5, 12);
  });

  it("删失样本只离开风险集、不计死亡", () => {
    const records = [intention(1, "done"), intention(1, "done"), intention(1, "done"), intention(2, "pending"), intention(2, "pending"), intention(2, "pending")];
    const s = survivalSummary(records);
    expect(s.deaths).toBe(3);
    // t=1: 3 死 / 6 风险 → 存活 0.5
    expect(s.curve[0]?.survivalProb).toBeCloseTo(0.5, 12);
    expect(s.medianTicks).toBe(1);
  });

  it("样本 < 5 不给半衰期（null，不硬算）", () => {
    const s = survivalSummary([intention(1, "done"), intention(2, "done")]);
    expect(s.medianTicks).toBeNull();
    expect(s.note).toContain("不计算");
  });

  it("全部还开着 → Infinity，不说『死得快』", () => {
    const s = survivalSummary([1, 2, 3, 4, 5].map((n) => intention(n, "active")));
    expect(s.deaths).toBe(0);
    expect(s.medianTicks).toBe(Number.POSITIVE_INFINITY);
    expect(s.note).toContain("全删失");
  });

  it("ticksToSurvival(0.5) 等于中位寿命；样本不足返回 null", () => {
    const records = [1, 2, 3, 4, 5, 6].map((n) => intention(n, "done"));
    expect(ticksToSurvival(records)).toBe(3);
    expect(ticksToSurvival([intention(1, "done")])).toBeNull();
  });
});

describe("P2 空转调度（idle.ts）", () => {
  it("种子是确定性的，间隔落在 20–40 分钟之间", () => {
    expect(seedFraction("assistant-2026-10-31")).toBe(seedFraction("assistant-2026-10-31"));
    const interval = idleIntervalMs("assistant-2026-10-31");
    expect(interval).toBeGreaterThanOrEqual(IDLE_MIN_MS);
    expect(interval).toBeLessThanOrEqual(IDLE_MAX_MS);
  });

  it("未排期（lastTick=null）不算到点，并说明原因", () => {
    expect(idleDue(null, 1_000, IDLE_MIN_MS)).toBe(false);
    const plan = planIdleTick({ lastTickAtMs: null, nowMs: 1_000, openIntentions: 0, seed: "s" });
    expect(plan.due).toBe(false);
    expect(plan.reason).toContain("首次启动");
  });

  it("专注档：到窗口且开着意图 < K_S → deliberate；≥ K_S → digest", () => {
    const lastTickAtMs = 1_760_000_000_000;
    const nowMs = lastTickAtMs + IDLE_MAX_MS;
    const light = planIdleTick({ lastTickAtMs, nowMs, openIntentions: 1, seed: "s" });
    expect(light.due).toBe(true);
    expect(light.mode).toBe("deliberate");
    const heavy = planIdleTick({ lastTickAtMs, nowMs, openIntentions: 4, seed: "s" });
    expect(heavy.mode).toBe("digest");
    expect(heavy.reason).toContain("只消化");
  });

  it("未到窗口时给出下一次时间，两次调用间隔稳定（同种子）", () => {
    const lastTickAtMs = 1_760_000_000_000;
    const plan = planIdleTick({ lastTickAtMs, nowMs: lastTickAtMs + 1_000, openIntentions: 0, seed: "s" });
    expect(plan.due).toBe(false);
    expect(plan.nextAtMs).toBe(lastTickAtMs + plan.intervalMs);
    const again = planIdleTick({ lastTickAtMs, nowMs: lastTickAtMs + 2_000, openIntentions: 0, seed: "s" });
    expect(again.intervalMs).toBe(plan.intervalMs);
    expect(again.nextAtMs).toBe(plan.nextAtMs);
  });
});
