import { describe, expect, it } from "vitest";
import {
  deriveTrigger,
  dueIntentions,
  dueIntentionsSafe,
  lookaheadTable,
  pickDueIntention,
  resolveEffectiveOutlet,
  splitDue,
  triggerDue,
  validateTrigger,
} from "../src/orchestrator/intent/lookahead.js";
import { activate, newIntention } from "../src/orchestrator/intent/bus.js";
import type { IntentionRecord, IntentionTrigger } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T04:00:00.000Z";
const NOW = Date.parse("2026-10-31T04:00:00.000Z");

function record(id: string, trigger: IntentionTrigger | null): IntentionRecord {
  return newIntention({
    id,
    at: AT,
    kind: "reach_out",
    goal: `意图 ${id}`,
    why: "因为想有人陪",
    trigger,
  });
}

/** D11-2：同一张表里"先不说"的 held，带 trigger 也该到点回来 */
function heldRecord(id: string, trigger: IntentionTrigger | null): IntentionRecord {
  return { ...record(id, trigger), status: "held" };
}

describe("P1 前置：前瞻意图表（未接线）", () => {
  it("validateTrigger：坏 spec 当场抛，不让整张表静默失效", () => {
    expect(() => validateTrigger({ type: "time", spec: "不是时间" })).toThrow(RangeError);
    expect(() => validateTrigger({ type: "event", spec: "  " })).toThrow(RangeError);
    expect(() => validateTrigger({ type: "cue", spec: "" })).toThrow(RangeError);
    expect(validateTrigger({ type: "time", spec: AT })).toEqual({ type: "time", spec: AT });
  });

  it("到点判定：time 按 nowMs，event/cue 按本 tick 的匹配集；无 trigger 永不因此浮现", () => {
    expect(triggerDue(null, { nowMs: NOW })).toBe(false);
    expect(triggerDue({ type: "time", spec: AT }, { nowMs: NOW })).toBe(true);
    expect(triggerDue({ type: "time", spec: AT }, { nowMs: NOW - 1 })).toBe(false);
    expect(triggerDue({ type: "event", spec: "her_online" }, { nowMs: NOW, events: ["her_online"] })).toBe(true);
    expect(triggerDue({ type: "event", spec: "her_online" }, { nowMs: NOW, events: [] })).toBe(false);
    expect(triggerDue({ type: "cue", spec: "昨天那件事" }, { nowMs: NOW, cues: ["昨天那件事"] })).toBe(true);
    expect(triggerDue({ type: "cue", spec: "昨天那件事" }, { nowMs: NOW })).toBe(false);
  });

  it("dueIntentions 取 pending 与带 trigger 的 held，并按时间触发的到点时刻升序、再按 id 排序（确定性）", () => {
    const records = [
      record("itn-c", { type: "time", spec: "2026-10-31T06:00:00.000Z" }),
      record("itn-b", { type: "event", spec: "her_online" }),
      record("itn-a", { type: "time", spec: "2026-10-31T05:00:00.000Z" }),
      record("itn-d", null),
      heldRecord("itn-held", { type: "time", spec: "2026-10-31T06:30:00.000Z" }),
      heldRecord("itn-held-null", null),
    ];
    const later = Date.parse("2026-10-31T07:00:00.000Z");
    const due = dueIntentions(records, { nowMs: later, events: ["her_online"] });
    // 时间触发按到点时刻升序（05:00 → 06:00 → held 06:30），无时间的排在最后
    expect(due.map((item) => item.id)).toEqual(["itn-a", "itn-c", "itn-held", "itn-b"]);
    // 无 trigger 的 held 不会因为"held 自身"被当成到点
    expect(due.map((item) => item.id)).not.toContain("itn-held-null");
    // 同一输入两次结果一致
    expect(dueIntentions(records, { nowMs: later, events: ["her_online"] })).toEqual(due);
  });

  it("已完成/已激活的意图不再因 trigger 浮现", () => {
    const done = activate(record("itn-done", { type: "time", spec: AT }));
    expect(dueIntentions([done], { nowMs: NOW })).toEqual([]);
  });

  it("lookaheadTable：统计有 trigger 的条数、各类型（pending + 带 trigger 的 held）与下一次未来时间触发", () => {
    const records = [
      record("itn-a", { type: "time", spec: "2026-10-31T05:00:00.000Z" }),
      record("itn-b", { type: "time", spec: "2026-10-30T05:00:00.000Z" }), // 已过，不算下一次
      record("itn-c", { type: "event", spec: "her_online" }),
      record("itn-d", null),
      heldRecord("itn-held", { type: "time", spec: "2026-10-31T05:30:00.000Z" }),
      heldRecord("itn-held-null", null),
    ];
    const table = lookaheadTable(records, NOW);
    expect(table.total).toBe(6);
    // withTrigger 口径不变：只看"有没有 trigger"，不看状态
    expect(table.withTrigger).toBe(4);
    // D11-2：byType/nextAtMs 把带 trigger 的 held 也算进来（与 due 读取面一致）
    expect(table.byType).toEqual({ time: 3, event: 1, cue: 0 });
    expect(table.nextAtMs).toBe(Date.parse("2026-10-31T05:00:00.000Z"));
  });

  it("splitDue：只摘到点的（pending + held），其余保持原顺序；原数组不被修改", () => {
    const records = [
      record("itn-a", { type: "time", spec: AT }),
      record("itn-b", { type: "time", spec: "2026-10-31T06:00:00.000Z" }),
      heldRecord("itn-held-due", { type: "time", spec: AT }),
      heldRecord("itn-held-future", { type: "time", spec: "2026-10-31T06:00:00.000Z" }),
    ];
    const { due, remaining } = splitDue(records, { nowMs: NOW });
    expect(due.map((item) => item.id)).toEqual(["itn-a", "itn-held-due"]);
    expect(remaining.map((item) => item.id)).toEqual(["itn-b", "itn-held-future"]);
    expect(records.map((item) => item.id)).toEqual(["itn-a", "itn-b", "itn-held-due", "itn-held-future"]);
  });
});

describe("D11-2：held 带 trigger 到点也应浮现（B1/B2）", () => {
  it("held + trigger 到点进 due；held + 无 trigger；held + 未到点都不进", () => {
    const dueAtNow = heldRecord("itn-held-due", { type: "time", spec: AT });
    const heldNull = heldRecord("itn-held-null", null);
    const heldFuture = heldRecord("itn-held-future", { type: "time", spec: "2026-10-31T05:00:00.000Z" });
    const due = dueIntentions([dueAtNow, heldNull, heldFuture], { nowMs: NOW });
    expect(due.map((item) => item.id)).toEqual(["itn-held-due"]);
  });

  it("dueIntentionsSafe 同样覆盖 held；held 的坏 trigger 只 skipped，不炸整表", () => {
    const good = heldRecord("itn-held-good", { type: "time", spec: AT });
    const bad: IntentionRecord = {
      ...heldRecord("itn-held-bad", { type: "time", spec: AT }),
      trigger: { type: "time", spec: "不是时间" },
    };
    const safe = dueIntentionsSafe([good, bad], { nowMs: NOW });
    expect(safe.due.map((item) => item.id)).toEqual(["itn-held-good"]);
    expect(safe.skipped.map((item) => item.id)).toEqual(["itn-held-bad"]);
  });

  it("lookaheadTable 把带 trigger 的 held 计入 byType/nextAtMs，total/withTrigger 口径不变", () => {
    const records = [
      record("itn-pending", null),
      heldRecord("itn-held", { type: "time", spec: "2026-10-31T05:00:00.000Z" }),
      heldRecord("itn-held-null", null),
    ];
    const table = lookaheadTable(records, NOW);
    expect(table.total).toBe(3);
    expect(table.withTrigger).toBe(1);
    expect(table.byType).toEqual({ time: 1, event: 0, cue: 0 });
    expect(table.nextAtMs).toBe(Date.parse("2026-10-31T05:00:00.000Z"));
  });
});

describe("P1 接线：写侧 deriveTrigger", () => {
  const HOUR = 3_600_000;

  it("reach_out +6h / continue_thread +12h / repair +24h；其他类别不生成 trigger", () => {
    expect(deriveTrigger("reach_out", NOW)).toEqual({
      type: "time",
      spec: new Date(NOW + 6 * HOUR).toISOString(),
    });
    expect(deriveTrigger("continue_thread", NOW)).toEqual({
      type: "time",
      spec: new Date(NOW + 12 * HOUR).toISOString(),
    });
    expect(deriveTrigger("repair", NOW)).toEqual({
      type: "time",
      spec: new Date(NOW + 24 * HOUR).toISOString(),
    });
    for (const kind of ["explore", "create", "withdraw", "idle"] as const) {
      expect(deriveTrigger(kind, NOW)).toBeNull();
    }
  });

  it("只吃传入的 nowMs（不读系统时钟）；非法 nowMs 抛 RangeError", () => {
    expect(deriveTrigger("reach_out", 0)).toEqual({
      type: "time",
      spec: new Date(6 * HOUR).toISOString(),
    });
    expect(deriveTrigger("reach_out", NOW)).toEqual(deriveTrigger("reach_out", NOW));
    expect(() => deriveTrigger("reach_out", Number.NaN)).toThrow(RangeError);
  });

  it("生成值落在 created_at+1h..+48h 窗口内（§3.1 约束；6/12/24h 都在窗口里）", () => {
    for (const kind of ["reach_out", "continue_thread", "repair"] as const) {
      const trigger = deriveTrigger(kind, NOW);
      expect(trigger).not.toBeNull();
      const specMs = Date.parse(trigger!.spec);
      expect(specMs - NOW).toBeGreaterThanOrEqual(HOUR);
      expect(specMs - NOW).toBeLessThanOrEqual(48 * HOUR);
    }
  });
});

describe("P1 接线：dueIntentionsSafe 逐条隔离坏 trigger", () => {
  it("同表好坏共存：好的进 due，坏的只进 skipped，整表不失效", () => {
    const good = record("itn-good", { type: "time", spec: AT });
    const bad: IntentionRecord = {
      ...record("itn-bad", { type: "time", spec: AT }),
      trigger: { type: "time", spec: "不是时间" },
    };
    const safe = dueIntentionsSafe([good, bad], { nowMs: NOW });
    expect(safe.due.map((item) => item.id)).toEqual(["itn-good"]);
    expect(safe.skipped).toHaveLength(1);
    expect(safe.skipped[0]?.id).toBe("itn-bad");
    expect(safe.skipped[0]?.error).toContain("不可解析");
  });

  it("排序与 dueIntentions 一致；pending 与带 trigger 的 held 都覆盖（done 不进 due）", () => {
    const records = [
      record("itn-b", { type: "time", spec: "2026-10-31T06:00:00.000Z" }),
      record("itn-a", { type: "time", spec: "2026-10-31T05:00:00.000Z" }),
      activate(record("itn-done", { type: "time", spec: AT })),
      heldRecord("itn-held", { type: "time", spec: "2026-10-31T05:30:00.000Z" }),
    ];
    const later = Date.parse("2026-10-31T07:00:00.000Z");
    const safe = dueIntentionsSafe(records, { nowMs: later });
    expect(safe.due.map((item) => item.id)).toEqual(["itn-a", "itn-held", "itn-b"]);
    expect(safe.skipped).toEqual([]);
  });

  it("旧表（全无 trigger）逐字不变：dueIntentionsSafe 与 dueIntentions 都返回空、无 skipped", () => {
    const legacy = [record("old-1", null), record("old-2", null), record("old-3", null)];
    const safe = dueIntentionsSafe(legacy, { nowMs: NOW });
    expect(safe.due).toEqual([]);
    expect(safe.skipped).toEqual([]);
    expect(dueIntentions(legacy, { nowMs: NOW })).toEqual([]);
  });
});

describe("P1 接线：pickDueIntention 四类拦截 + quiet 四档", () => {
  const due = [record("itn-a", { type: "time", spec: AT })];
  const base = {
    gateAllowed: true,
    currentOutletIsSpeak: false,
    suppressedKinds: [] as readonly string[],
    minutesSinceLastProactive: null as number | null,
    reRaiseQuietMin: 10,
  };

  it("硬闸不放行 / 本拍已有更急 speak → null", () => {
    expect(pickDueIntention(due, base)?.id).toBe("itn-a");
    expect(pickDueIntention(due, { ...base, gateAllowed: false })).toBeNull();
    expect(pickDueIntention(due, { ...base, currentOutletIsSpeak: true })).toBeNull();
  });

  it("被同类重复刹车压着的类别跳过；全被压时 null", () => {
    expect(pickDueIntention(due, { ...base, suppressedKinds: ["reach_out"] })).toBeNull();
    expect(pickDueIntention(due, { ...base, suppressedKinds: ["repair"] })?.id).toBe("itn-a");
  });

  it("minutes 四档：null 不阻止、0/5 在 quiet 内跳过、10 边界通过", () => {
    expect(pickDueIntention(due, { ...base, minutesSinceLastProactive: null })?.id).toBe("itn-a");
    expect(pickDueIntention(due, { ...base, minutesSinceLastProactive: 0 })).toBeNull();
    expect(pickDueIntention(due, { ...base, minutesSinceLastProactive: 5 })).toBeNull();
    expect(pickDueIntention(due, { ...base, minutesSinceLastProactive: 10 })?.id).toBe("itn-a");
  });
});

describe("P1 接线：resolveEffectiveOutlet due > speakable > outlet", () => {
  const outlet = {
    target: "journal" as const,
    kind: "reach_out" as const,
    line: "这一拍原本只想记一笔",
    whyLine: "因为被挡下",
    note: "journal note",
  };
  const due = record("itn-due", { type: "time", spec: AT });
  const speakable = record("itn-speak", null);

  it("due 存在时覆盖 speakable 与原 outlet，并标记 dueOverridden", () => {
    const out = resolveEffectiveOutlet({ due, speakable, outlet });
    expect(out.dueOverridden).toBe(true);
    expect(out.effective.target).toBe("speak");
    expect(out.effective.kind).toBe(due.kind);
    expect(out.effective.line).toBe(due.goal);
    expect(out.effective.whyLine).toBe(due.why);
    expect(out.effective.note).toContain("到点了");
  });

  it("无 due 时 speakable 覆盖 original；两者都无时原样返回", () => {
    const withSpeakable = resolveEffectiveOutlet({ due: null, speakable, outlet });
    expect(withSpeakable.dueOverridden).toBe(false);
    expect(withSpeakable.effective.line).toBe(speakable.goal);
    expect(withSpeakable.effective.note).toContain("接着上次");

    const unchanged = resolveEffectiveOutlet({ due: null, speakable: null, outlet });
    expect(unchanged.dueOverridden).toBe(false);
    expect(unchanged.effective).toBe(outlet);
  });
});
