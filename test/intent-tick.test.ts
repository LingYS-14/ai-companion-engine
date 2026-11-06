import { describe, expect, it } from "vitest";
import type { Stage } from "../src/engine/bonds.js";
import { initialSState, type SState } from "../src/engine/state.js";
import { initialAccumulator } from "../src/orchestrator/intent/bus.js";
import { runIntentTick, tickDriveInput, type IntentTickInput } from "../src/orchestrator/intent/tick.js";
import type { Affordance, IntentKind, SituationFrame } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T06:00:00.000Z";

const QQ: Affordance = { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false };

function state(overrides: Partial<SState> = {}): SState {
  return { ...initialSState(), ...overrides };
}

function input(overrides: Partial<IntentTickInput> = {}): IntentTickInput {
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

describe("P1 一拍完整计算（tick.ts）", () => {
  it("帧、投影、候选、自述一条链都产出，且顺序确定", () => {
    const r = runIntentTick(input());
    expect(r.frame.channel).toBe("qq");
    expect(r.frame.hardBlocks).toEqual([]);
    expect(r.drive.energy).toBeCloseTo(0.4, 12);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.top).not.toBeNull();
    expect(r.narrative?.line.length).toBeGreaterThan(0);
    expect(r.narrative?.whyLine.length).toBeGreaterThan(0);
    expect(r.gate.verdict).toBe("speak");
    expect(r.wouldSpeak).toBe(true);
  });

  it("第一拍没有 previousDrive → 不产生 drift，累积器全 0", () => {
    const r = runIntentTick(input());
    for (const value of Object.values(r.accumulator)) expect(value).toBe(0);
    expect(r.emitted).toEqual([]);
  });

  it("缺口扩大时累积器上升；连续两拍缩小则回落（衰减生效）", () => {
    const first = runIntentTick(input({ state: state({ energy: 0.6, suppressionLoad: 0.2 }) }));
    const second = runIntentTick(
      input({
        // 压力升高：integrity 缺口扩大
        state: state({ energy: 0.6, suppressionLoad: 0.6 }),
        previousDrive: first.drive,
        accumulator: first.accumulator,
      }),
    );
    expect(second.accumulator.repair).toBeGreaterThan(first.accumulator.repair);
    expect(second.accumulator.withdraw).toBeGreaterThan(0);

    const third = runIntentTick(
      input({
        state: state({ energy: 0.6, suppressionLoad: 0.6 }),
        previousDrive: second.drive,
        accumulator: second.accumulator,
      }),
    );
    expect(third.accumulator.withdraw).toBeLessThan(second.accumulator.withdraw);
  });

  it("静默时段：不再被硬闸拦下（A6），候选照样算出来，说与不说留给处境", () => {
    const r = runIntentTick(
      input({ situation: { ...input().situation, localHour: 23 } }),
    );
    expect(r.frame.hardBlocks).toContain("quiet_hours");
    // A6：静默只是事实，不再否决；说不说由出口协议（HOLD）决定
    expect(r.gate.verdict).toBe("speak");
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("额度用完 → hardBlocks 含 rate_limited、硬闸 quota", () => {
    const r = runIntentTick(
      input({ situation: { ...input().situation, budget: { rph: 0, peak: true } } }),
    );
    expect(r.gate.verdict).toBe("quota");
    expect(r.wouldSpeak).toBe(false);
  });

  it("信任低于下限 → distrust，但候选与自述仍然产出（只是不许主动开口）", () => {
    const r = runIntentTick(input({ trust: 0.1, trustFloor: 0.2 }));
    expect(r.gate.verdict).toBe("distrust");
    expect(r.wouldSpeak).toBe(false);
    expect(r.narrative).not.toBeNull();
  });

  it("同类已有活跃意图 → 不再浮现", () => {
    const first = runIntentTick(input());
    // 手动把两类都顶到阈值之上，再声明 reach_out 已活跃
    const acc = { ...initialAccumulator(), reach_out: 0.95, withdraw: 0.95 };
    const noActive = runIntentTick(
      input({ accumulator: acc, previousDrive: first.drive, activeKinds: [] }),
    );
    expect(noActive.emitted).toContain("reach_out");
    const withActive = runIntentTick(
      input({ accumulator: acc, previousDrive: first.drive, activeKinds: ["reach_out"] }),
    );
    expect(withActive.emitted).not.toContain("reach_out");
  });

  it("决定性的确定性：同输入跑两次，结果逐字段相同", () => {
    const a = runIntentTick(input());
    const b = runIntentTick(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("tickDriveInput 只是把 tick 输入折成 DriveInput，不改原对象", () => {
    const i = input();
    const d = tickDriveInput(i);
    expect(d.sinceLastContactMin).toBe(30);
    expect(d.state).toBe(i.state);
    expect((i.situation as SituationFrame).channel).toBe("qq");
  });

  it("非法信任值当场抛错（不把 NaN 带进闸）", () => {
    expect(() => runIntentTick(input({ trust: Number.NaN }))).toThrow(RangeError);
  });

  it("stage 变化会改变 connection 基线（beloved 比 stranger 更不容易想找人）", () => {
    const stranger = runIntentTick(input({ stage: "stranger" as Stage }));
    const beloved = runIntentTick(input({ stage: "beloved" as Stage }));
    expect(stranger.drive.connection).toBeGreaterThan(beloved.drive.connection);
  });

  it("A4：闸放行也不等于要说话——explore 做上 top 时 wouldSpeak 必须为 false", () => {
    // 高知识缺口 + 低连接需求：让 explore 成为 top。
    const r = runIntentTick(
      input({
        situation: {
          at: AT,
          localHour: 14,
          channel: "qq",
          participants: [],
          affordances: [{ tool: "knowledge.read", risk: 0, requiresLogin: false, rateLimited: false }],
          sinceLastContactMin: 0,
          activeIntents: [],
          budget: { rph: 8, peak: false },
          singleWriterConflict: false,
        },
        stage: "close",
        coverageGap: 0.95,
        trust: 0.9,
      }),
    );
    expect(r.top?.kind).toBe("explore");
    expect(r.gate.allowed).toBe(true);
    // 旧实现这里会是 true，于是"想去看点东西"被当成"想找他说话"。
    expect(r.wouldSpeak).toBe(false);
  });

  it("A8：有类别越阈时，top 必须从那类里挑（不能因为 idle 分数高就永远不开口）", () => {
    // 构造：reach_out 的累积器已经憋到阈值，但 idle 的效用分更高。
    // 旧实现 top=idle → wouldSpeak=false，线上就会出现"emitted=reach_out 却永远不开口"。
    const base = input({
      situation: {
        at: AT,
        localHour: 14,
        channel: "qq",
        participants: [],
        affordances: [QQ],
        sinceLastContactMin: 300,
        activeIntents: [],
        budget: { rph: 8, peak: false },
        singleWriterConflict: false,
      },
      stage: "stranger",
    });
    const now = runIntentTick({
      ...base,
      accumulator: { ...initialAccumulator(), reach_out: 0.7 },
      previousDrive: base ? runIntentTick(base).drive : undefined,
    });
    expect(now.emitted).toContain("reach_out");
    expect(now.top?.kind).toBe("reach_out");
    expect(now.wouldSpeak).toBe(true);
  });
});

describe("F312：同类重复刹车（suppressedKinds）", () => {
  it("被压的类别不出现在候选里，top 也不再是它", () => {
    const first = runIntentTick(input());
    expect(first.top).not.toBeNull();
    const topKind = first.top?.kind as IntentKind;
    const second = runIntentTick(input({ suppressedKinds: [topKind] }));
    expect(second.candidates.every((candidate) => candidate.kind !== topKind)).toBe(true);
    expect(second.top?.kind).not.toBe(topKind);
  });

  it("全部类别被压 → 没有候选、top=null、wouldSpeak=false", () => {
    const all: readonly IntentKind[] = [
      "explore",
      "create",
      "repair",
      "continue_thread",
      "reach_out",
      "withdraw",
      "idle",
    ];
    const r = runIntentTick(input({ suppressedKinds: all }));
    expect(r.candidates).toEqual([]);
    expect(r.top).toBeNull();
    expect(r.wouldSpeak).toBe(false);
  });

  it("不传 / 传空数组时行为一致（旧行为不变）", () => {
    const a = runIntentTick(input());
    const b = runIntentTick(input({ suppressedKinds: [] }));
    expect(b.candidates.map((candidate) => candidate.kind)).toEqual(a.candidates.map((candidate) => candidate.kind));
  });
});
