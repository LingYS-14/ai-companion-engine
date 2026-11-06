import { describe, expect, it } from "vitest";
import { applyHardGate, intentHardGate } from "../src/orchestrator/intent/gate.js";
import { buildSituation } from "../src/orchestrator/intent/situation.js";
import { newIntention } from "../src/orchestrator/intent/bus.js";
import type { Affordance, SituationFrame } from "../src/orchestrator/intent/types.js";

const AFF: Affordance[] = [{ tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false }];

function frame(overrides: { localHour?: number; rph?: number; singleWriter?: boolean; affordances?: Affordance[] } = {}): SituationFrame {
  return buildSituation({
    at: "2026-10-31T04:00:00.000Z",
    localHour: overrides.localHour ?? 14,
    channel: "qq",
    participants: ["owner"],
    affordances: overrides.affordances ?? AFF,
    sinceLastContactMin: 60,
    activeIntents: [],
    budget: { rph: overrides.rph ?? 8, peak: false },
    singleWriterConflict: overrides.singleWriter ?? false,
  });
}

function intention() {
  return newIntention({
    id: "itn-gate-1",
    at: "2026-10-31T04:00:00.000Z",
    kind: "reach_out",
    goal: "问问她今天怎么样",
    why: "因为想有人陪",
  });
}

describe("P1 前置：主动性四否决硬闸（未接线）", () => {
  it("放行：无告警 + trust 高于下限 → speak", () => {
    const decision = intentHardGate({ frame: frame(), trust: 0.7, trustFloor: 0.3 });
    expect(decision.allowed).toBe(true);
    expect(decision.verdict).toBe("speak");
    expect(decision.note).toBe("硬闸放行（静默只作情境），交给候选打分决定说什么");
  });

  it("额度优先：rph=0 时先报额度，不报静默（顺序固定，可审计）", () => {
    const decision = intentHardGate({ frame: frame({ rph: 0, localHour: 23 }), trust: 0.7, trustFloor: 0.3 });
    expect(decision.allowed).toBe(false);
    expect(decision.verdict).toBe("quota");
  });

  it("A6：静默时段不再否决（只说事实，由她自己在出口里决定说还是先不说）", () => {
    const decision = intentHardGate({ frame: frame({ localHour: 23 }), trust: 0.7, trustFloor: 0.3 });
    expect(decision.allowed).toBe(true);
    expect(decision.verdict).toBe("speak");
    expect(decision.note).toContain("静默只作情境");
  });

  it("单写者冲突拦主动开口（不抢另一个进程的写锁）", () => {
    const decision = intentHardGate({ frame: frame({ singleWriter: true }), trust: 0.7, trustFloor: 0.3 });
    expect(decision.verdict).toBe("single_writer");
  });

  it("关系信任不足只拦主动开口，且说明回消息不受此限", () => {
    const decision = intentHardGate({ frame: frame(), trust: 0.2, trustFloor: 0.3 });
    expect(decision.verdict).toBe("distrust");
    expect(decision.note).toContain("回消息不受此限");
  });

  it("trust 非有限数字当场抛（不把 NaN 当信任）", () => {
    expect(() => intentHardGate({ frame: frame(), trust: Number.NaN, trustFloor: 0.3 })).toThrow(RangeError);
  });

  it("applyHardGate：放行不动记录；被拦写成 blocked 并写明是谁拦的", () => {
    const record = intention();
    expect(applyHardGate(record, intentHardGate({ frame: frame(), trust: 0.7, trustFloor: 0.3 }))).toBe(record);

    const blocked = applyHardGate(
      record,
      intentHardGate({ frame: frame({ singleWriter: true }), trust: 0.7, trustFloor: 0.3 }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by).toBe("single_writer");
    expect(blocked.survival).toBe(record.survival + 1);
    expect(record.status).toBe("pending"); // 原记录不被改（纯函数）
  });
});
