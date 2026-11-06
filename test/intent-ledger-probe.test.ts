import { describe, it, expect } from "vitest";
import {
  CAPABILITY_LEDGER_VERSION,
  describeLedgerDiff,
  diffCapabilityLedgers,
  mergeCapabilityRecords,
  parseCapabilityLedger,
  serializeCapabilityLedger,
} from "../src/orchestrator/intent/ledger-file.js";
import {
  MAX_PROBES_PER_NIGHT,
  PROBE_INTERVAL_MS,
  applyProbeObservations,
  describeProbeSummary,
  planProbeNight,
  probeSummary,
  validateObservation,
  validateTarget,
} from "../src/orchestrator/intent/probe.js";
import type { EffectivityEntry } from "../src/orchestrator/intent/forge.js";
import type { CapabilityRecord } from "../src/orchestrator/intent/types.js";

const NOW_MS = Date.parse("2026-10-31T04:00:00.000Z");
const NOW_ISO = "2026-10-31T04:00:00.000Z";

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    capId: "cap-1",
    kind: "tool",
    tool: "bili.search",
    sourceIntentionId: "itn-1",
    effectivityBefore: 0,
    effectivityAfter: 0.6,
    tests: [{ name: "smoke", passed: true }],
    riskCeiling: 1,
    status: "quarantined",
    createdAt: "2026-10-30T04:00:00.000Z",
    ...overrides,
  };
}

function effectivity(overrides: Partial<EffectivityEntry> = {}): EffectivityEntry {
  return { tool: "bili.search", declared: true, available: true, effectivity: 1, reason: null, lastProbeAt: NOW_ISO, ...overrides };
}

describe("能力账本落盘", () => {
  it("序列化键序固定、按 capId 排序：同输入逐字节相同", () => {
    const a = record({ capId: "cap-b" });
    const b = record({ capId: "cap-a" });
    const first = serializeCapabilityLedger([a, b], NOW_MS);
    const second = serializeCapabilityLedger([b, a], NOW_MS);
    expect(first).toBe(second);
    expect(first.indexOf('"cap-a"')).toBeLessThan(first.indexOf('"cap-b"'));
    expect(first.endsWith("\n")).toBe(true);
  });

  it("非法 savedAtMs 直接抛（不写出一个时间坏掉的账本）", () => {
    expect(() => serializeCapabilityLedger([record()], Number.NaN)).toThrow(RangeError);
    expect(() => serializeCapabilityLedger([record()], -1)).toThrow(RangeError);
  });

  it("解析往返：记录、保存时刻都回来，排序稳定", () => {
    const raw = serializeCapabilityLedger([record({ capId: "cap-2" }), record({ capId: "cap-1" })], NOW_MS);
    const parsed = parseCapabilityLedger(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.savedAtMs).toBe(NOW_MS);
    expect(parsed.records?.map((item) => item.capId)).toEqual(["cap-1", "cap-2"]);
    expect(parsed.records?.[0]).toEqual(record());
  });

  it("坏文件一律 errors 且 records=null（不给半份账本）", () => {
    const badJson = parseCapabilityLedger("{nope");
    expect(badJson.records).toBeNull();
    expect(badJson.errors[0]).toContain("JSON");

    const unknownField = JSON.parse(serializeCapabilityLedger([record()], NOW_MS));
    unknownField.extra = true;
    const unknown = parseCapabilityLedger(JSON.stringify(unknownField));
    expect(unknown.errors[0]).toContain("未知字段");

    const badVersion = { ...JSON.parse(serializeCapabilityLedger([record()], NOW_MS)), version: CAPABILITY_LEDGER_VERSION + 1 };
    expect(parseCapabilityLedger(JSON.stringify(badVersion)).errors[0]).toContain("版本不符");

    const badSavedAt = { version: CAPABILITY_LEDGER_VERSION, savedAtMs: "now", records: [] };
    expect(parseCapabilityLedger(JSON.stringify(badSavedAt)).errors[0]).toContain("savedAtMs");

    const dup = { version: CAPABILITY_LEDGER_VERSION, savedAtMs: NOW_MS, records: [record(), record()] };
    expect(parseCapabilityLedger(JSON.stringify(dup)).errors[0]).toContain("capId 重复");

    const badRecord = { version: CAPABILITY_LEDGER_VERSION, savedAtMs: NOW_MS, records: [record({ effectivityAfter: 2 })] };
    const bad = parseCapabilityLedger(JSON.stringify(badRecord));
    expect(bad.errors[0]).toContain("第 1 条");
    expect(bad.records).toBeNull();
  });

  it("合并：新覆盖旧、其余保留、结果按 capId 升序", () => {
    const merged = mergeCapabilityRecords(
      [record({ capId: "b", status: "quarantined" }), record({ capId: "a" })],
      [record({ capId: "b", status: "active" }), record({ capId: "c" })],
    );
    expect(merged.map((item) => item.capId)).toEqual(["a", "b", "c"]);
    expect(merged[1]?.status).toBe("active");
  });

  it("差异：新增/转正/退役/变更分开报，空差异返回 null 说明", () => {
    const before = [record({ capId: "a", status: "quarantined" }), record({ capId: "b", status: "active" }), record({ capId: "c" })];
    const after = [
      record({ capId: "a", status: "active" }),
      record({ capId: "b", status: "retired" }),
      record({ capId: "d" }),
    ];
    const diff = diffCapabilityLedgers(before, after);
    expect(diff.added).toEqual(["d"]);
    expect(diff.removed).toEqual(["c"]);
    expect(diff.promoted).toEqual(["a"]);
    expect(diff.retired).toEqual(["b"]);
    expect(diff.changed).toEqual(["a", "b"]);
    expect(describeLedgerDiff(diff)).toContain("转正 1");

    const empty = diffCapabilityLedgers(before, before);
    expect(describeLedgerDiff(empty)).toBeNull();
  });
});

describe("能力夜更：排期", () => {
  it("从没探过的先探；超过 24h 才算到期；今晚名额之外进 deferred", () => {
    const targets = [
      { tool: "b.tool", declared: true, lastProbeAt: null, riskCeiling: 0 },
      { tool: "a.tool", declared: true, lastProbeAt: new Date(NOW_MS - PROBE_INTERVAL_MS - 1000).toISOString(), riskCeiling: 0 },
      { tool: "c.tool", declared: true, lastProbeAt: new Date(NOW_MS - 1000).toISOString(), riskCeiling: 0 },
    ];
    const plan = planProbeNight(targets, NOW_MS);
    expect(plan.due.map((item) => item.tool)).toEqual(["b.tool", "a.tool"]);
    expect(plan.note).toContain("今晚探 2");
  });

  it("名额上限生效时多出来的进 deferred，不丢", () => {
    const targets = Array.from({ length: MAX_PROBES_PER_NIGHT + 3 }, (_, index) => ({
      tool: `tool-${String(index).padStart(2, "0")}`,
      declared: true,
      lastProbeAt: null,
      riskCeiling: 0,
    }));
    const plan = planProbeNight(targets, NOW_MS, 4);
    expect(plan.due).toHaveLength(4);
    expect(plan.deferred).toHaveLength(MAX_PROBES_PER_NIGHT - 1);
  });

  it("未声明的不探、risk>0 的不自动探，各自归类且排序稳定", () => {
    const plan = planProbeNight(
      [
        { tool: "z", declared: true, lastProbeAt: null, riskCeiling: 2 },
        { tool: "a", declared: true, lastProbeAt: null, riskCeiling: 1 },
        { tool: "q", declared: false, lastProbeAt: null, riskCeiling: 0 },
        { tool: "p", declared: false, lastProbeAt: null, riskCeiling: 0 },
      ],
      NOW_MS,
    );
    expect(plan.needsManual.map((item) => item.tool)).toEqual(["a", "z"]);
    expect(plan.undeclared.map((item) => item.tool)).toEqual(["p", "q"]);
    expect(plan.due).toEqual([]);
  });

  it("非法目标与非法参数抛 RangeError（不吃掉配置错误）", () => {
    expect(() => planProbeNight([{ tool: "", declared: true, lastProbeAt: null, riskCeiling: 0 }], NOW_MS)).toThrow(RangeError);
    expect(() => planProbeNight([], Number.NaN)).toThrow(RangeError);
    expect(() => planProbeNight([], NOW_MS, 0)).toThrow(RangeError);
    expect(validateTarget({ tool: "x", declared: true, lastProbeAt: "昨天", riskCeiling: 0 })[0]).toContain("ISO");
    expect(validateTarget({ tool: "x", declared: true, lastProbeAt: null, riskCeiling: 9 })[0]).toContain("0..3");
  });
});

describe("能力夜更：观测应用与摘要", () => {
  it("观测校验：档位只能是 0/0.5/1，available 与 effectivity 不能矛盾，时间要能解析", () => {
    expect(validateObservation({ tool: "x", available: true, effectivity: 1, reason: null, at: NOW_ISO })).toEqual([]);
    expect(validateObservation({ tool: "x", available: true, effectivity: 0, reason: null, at: NOW_ISO })[0]).toContain("自相矛盾");
    expect(validateObservation({ tool: "x", available: false, effectivity: 1, reason: null, at: NOW_ISO })[0]).toContain("自相矛盾");
    expect(validateObservation({ tool: "x", available: true, effectivity: 1, reason: null, at: "x" })[0]).toContain("ISO");
  });

  it("应用观测：更新效力与原因、lastProbeAt 用观测时间（不是现在）、结果按工具名排序", () => {
    const before = [effectivity({ tool: "b", effectivity: 1 }), effectivity({ tool: "a", effectivity: 1 })];
    const at = "2026-10-31T03:00:00.000Z";
    const result = applyProbeObservations(before, [
      { tool: "a", available: false, effectivity: 0, reason: "no-login", at },
      { tool: "b", available: true, effectivity: 0.5, reason: "rate-limited", at },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(["a", "b"]);
    expect(result.entries.map((item) => item.tool)).toEqual(["a", "b"]);
    expect(result.entries[0]).toMatchObject({ available: false, effectivity: 0, reason: "no-login", lastProbeAt: at });
    expect(result.entries[1]).toMatchObject({ effectivity: 0.5, lastProbeAt: at });
  });

  it("未知工具、矛盾观测、坏时间都拒收并逐条记理由（不悄悄丢）", () => {
    const before = [effectivity()];
    const result = applyProbeObservations(before, [
      { tool: "未声明工具", available: true, effectivity: 1, reason: null, at: NOW_ISO },
      { tool: "bili.search", available: true, effectivity: 0, reason: null, at: NOW_ISO },
      { tool: "bili.search", available: true, effectivity: 1, reason: null, at: "坏时间" },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.entries[0]?.effectivity).toBe(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("没有这个工具");
  });

  it("摘要：变好/变差/不变/新增分开；无变化时说无变化", () => {
    const before = [effectivity({ tool: "a", effectivity: 0 }), effectivity({ tool: "b", effectivity: 1 }), effectivity({ tool: "c", effectivity: 0.5 })];
    const after = [effectivity({ tool: "a", effectivity: 1 }), effectivity({ tool: "b", effectivity: 0 }), effectivity({ tool: "c", effectivity: 0.5 }), effectivity({ tool: "d", effectivity: 1 })];
    const summary = probeSummary(before, after);
    expect(summary.improved).toEqual(["a"]);
    expect(summary.regressed).toEqual(["b"]);
    expect(summary.unchanged).toEqual(["c"]);
    expect(summary.added).toEqual(["d"]);
    expect(describeProbeSummary(summary)).toContain("变好 1");

    const flat = probeSummary(before, before);
    expect(describeProbeSummary(flat)).toContain("无变化");
  });
});
