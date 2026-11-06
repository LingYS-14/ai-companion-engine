/**
 * 批次1B/T2：P2a 写侧接线的源码锁 + `intentContextOf` 三类出口单测。
 *
 * 锁的是"接线有没有断"：意图上下文原来在 main.mjs 里内联构造，P2a 之后
 * 由 close-loop 的纯函数汇聚，三类出口（speakable / dueHit / ensuredSpoken）
 * 都从同一个 topRecord 取 goalAtTime/goalId，避免某条出口忘了带目标。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  intentContextOf,
  type IntentContextGate,
  type IntentContextOutlet,
  type IntentContextTopRecord,
} from "../src/orchestrator/intent/close-loop.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAIN = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");
const CLOSE_LOOP = readFileSync(join(ROOT, "src", "orchestrator", "intent", "close-loop.ts"), "utf8");
const RUNTIME = readFileSync(join(ROOT, "src", "plugin", "runtime.ts"), "utf8");
const PORTS = readFileSync(join(ROOT, "src", "ports", "index.ts"), "utf8");

const SPEAK_OUTLET: IntentContextOutlet = {
  target: "speak",
  kind: "reach_out",
  line: "想和你说句话",
  whyLine: "因为你回来了",
  note: "",
};

const GATE: IntentContextGate = { allowed: true, verdict: "allow", note: "额度还够" };

function ctxFor(topRecord: IntentContextTopRecord | undefined) {
  return intentContextOf({
    outlet: SPEAK_OUTLET,
    emitted: ["intent"],
    gate: GATE,
    topRecord,
    situation: ["现在是 23:50（周日）"],
    lookaheadSurfacedId: undefined,
  });
}

describe("批次1B/T2：intentContextOf 三类出口都带同一个 goal", () => {
  it("speakable 出口：intentionId/goalAtTime/goalId 同源", () => {
    const ctx = ctxFor({ id: "itn-reach_out-1", goal: "问她今天过得怎么样" });
    expect(ctx.outlet).toBe("speak");
    expect(ctx.kind).toBe("reach_out");
    expect(ctx.intentionId).toBe("itn-reach_out-1");
    expect(ctx.goalAtTime).toBe("问她今天过得怎么样");
    expect(ctx.goalId).toBe("itn-reach_out-1");
    expect(ctx.gate).toEqual({ allowed: true, verdict: "allow", note: "额度还够" });
    expect(ctx.situation).toEqual({ lines: ["现在是 23:50（周日）"] });
  });

  it("dueHit 出口：到点的意图也是同一个 topRecord 汇聚", () => {
    const ctx = ctxFor({ id: "itn-continue_thread-2", goal: "把上次没说完的话说完" });
    expect(ctx.intentionId).toBe("itn-continue_thread-2");
    expect(ctx.goalAtTime).toBe("把上次没说完的话说完");
    expect(ctx.goalId).toBe("itn-continue_thread-2");
  });

  it("ensuredSpoken 出口：补出来的记录同样带目标", () => {
    const ctx = ctxFor({ id: "itn-repair-3", goal: "把刚才的别扭说开" });
    expect(ctx.intentionId).toBe("itn-repair-3");
    expect(ctx.goalAtTime).toBe("把刚才的别扭说开");
    expect(ctx.goalId).toBe("itn-repair-3");
  });

  it("没有 topRecord：不伪造 intentionId/goalAtTime/goalId", () => {
    const ctx = ctxFor(undefined);
    expect("intentionId" in ctx).toBe(false);
    expect("goalAtTime" in ctx).toBe(false);
    expect("goalId" in ctx).toBe(false);
  });

  it("串拍：上一拍有 ctx → 本拍入口重置 → 早退后 proactive 读到 undefined", () => {
    let lastIntentContext: ReturnType<typeof ctxFor> | undefined = ctxFor({
      id: "itn-reach_out-1",
      goal: "问她今天过得怎么样",
    });
    expect(lastIntentContext?.goalAtTime).toBe("问她今天过得怎么样");
    // 模拟 main.mjs 的每拍入口：先重置，再判睡早退（早退时不会重新赋值）
    const intentTick = (asleep: boolean): void => {
      lastIntentContext = undefined;
      if (asleep) return;
      lastIntentContext = ctxFor({ id: "itn-reach_out-2", goal: "换一句更轻的话" });
    };
    intentTick(true);
    expect(lastIntentContext).toBeUndefined();
  });

  it("journal 出口不带 gate；line 为 null 时不带 note", () => {
    const ctx = intentContextOf({
      outlet: { ...SPEAK_OUTLET, target: "journal", kind: null, line: null },
      emitted: [],
      gate: GATE,
      topRecord: { id: "itn-explore-1", goal: "翻一翻旧照片" },
      situation: undefined,
      lookaheadSurfacedId: undefined,
    });
    expect(ctx.outlet).toBe("journal");
    expect("gate" in ctx).toBe(false);
    expect("note" in ctx).toBe(false);
    expect("kind" in ctx).toBe(false);
    expect(ctx.goalAtTime).toBe("翻一翻旧照片");
  });
});

describe("批次1B/T2：源码锁（接线断了必须红）", () => {
  it("main.mjs：每拍入口先重置 lastIntentContext，再判睡", () => {
    const resetAt = MAIN.indexOf("lastIntentContext = undefined;");
    const asleepAt = MAIN.indexOf("if (runtime.sleepInfo().asleep) return;");
    expect(resetAt).toBeGreaterThan(0);
    expect(asleepAt).toBeGreaterThan(resetAt);
  });

  it("main.mjs：上下文经 intentContextOf 构造，并把 topRecord 传进去", () => {
    expect(MAIN).toContain("lastIntentContext = intentContextOf({");
    expect(MAIN).toContain("topRecord,");
    expect(MAIN).toContain("gate: { allowed: result.gate.allowed, verdict: result.gate.verdict, note: result.gate.note }");
  });

  it("main.mjs：主动开口的记忆 seed 展开 goalAtTime/goalId（undefined 不传）", () => {
    expect(MAIN).toContain("...(intentCtx?.goalAtTime === undefined ? {} : { goalAtTime: intentCtx.goalAtTime })");
    expect(MAIN).toContain("...(intentCtx?.goalId === undefined ? {} : { goalId: intentCtx.goalId })");
    expect(MAIN).toContain("spokenMemorySeed({");
  });

  it("close-loop.ts：intentContextOf 从 topRecord 同时取 id 与 goal", () => {
    expect(CLOSE_LOOP).toContain("goalAtTime: input.topRecord.goal");
    expect(CLOSE_LOOP).toContain("goalId: input.topRecord.id");
    expect(CLOSE_LOOP).toContain("intentionId: input.topRecord.id");
  });

  it("runtime.ts：remember/appendMemory 的 localHour 来自 Clock，且按需传 goal", () => {
    const localHours = RUNTIME.match(/localHour: this\.clock\.localHour\(\)/g) ?? [];
    expect(localHours.length).toBeGreaterThanOrEqual(2);
    expect(RUNTIME).toContain("...(input.goalAtTime === undefined ? {} : { goalAtTime: input.goalAtTime })");
    expect(RUNTIME).toContain("...(input.goalId === undefined ? {} : { goalId: input.goalId })");
  });

  it("ports/index.ts：RememberInput 暴露 goalAtTime/goalId", () => {
    expect(PORTS).toContain("readonly goalAtTime?: string;");
    expect(PORTS).toContain("readonly goalId?: string;");
  });
});
