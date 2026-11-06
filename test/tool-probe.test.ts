import { describe, expect, it } from "vitest";

import {
  TOOL_PROBE_TTL_MS,
  describeToolProbe,
  inToolProbeWindow,
  latestToolProbes,
  observeTool,
  parseToolProbeLines,
  planToolProbe,
  serializeToolProbe,
  type ToolProbeTarget,
} from "../src/orchestrator/intent/tool-probe.js";
import type { ProbeObservation } from "../src/orchestrator/intent/probe.js";

const NOW = Date.parse("2026-10-31T17:10:00.000Z");

function target(tool: string, risk: 0 | 1 | 2 = 0, declared = true): ToolProbeTarget {
  return { tool, risk, declared };
}

function observation(tool: string, available: boolean, at: string, reason?: "port-down" | "unknown"): ProbeObservation {
  return {
    tool,
    available,
    effectivity: available ? 1 : 0,
    ...(reason === undefined ? {} : { reason }),
    at,
  };
}

describe("只读探测（B3）：测出来的可用性，不是拍脑袋的", () => {
  it("只挑 risk 0 的工具，有副作用的进人工名单", () => {
    const plan = planToolProbe([
      target("knowledge.read", 0),
      target("qq.send_text", 1),
      target("file.write", 2),
    ]);
    expect(plan.due.map((t) => t.tool)).toEqual(["knowledge.read"]);
    expect(plan.needsManual.map((t) => t.tool)).toEqual(["qq.send_text", "file.write"]);
    expect(plan.count).toBe(1);
  });

  it("每晚有上限，超出的不探（不把一夜排满）", () => {
    const many = Array.from({ length: 12 }, (_, i) => target(`tool.${String(i)}`, 0));
    expect(planToolProbe(many, 5).due).toHaveLength(5);
    expect(planToolProbe(many, 5).count).toBe(5);
    expect(() => planToolProbe(many, 0)).toThrow(RangeError);
    expect(() => planToolProbe(many, 1.5)).toThrow(RangeError);
  });

  it("观测只在和声明不一致时给原因（没有异常不编故事）", () => {
    const ok = observeTool(target("knowledge.read", 0, true), true, NOW);
    expect(ok.reason).toBeNull();
    expect(ok.effectivity).toBe(1);
    const bad = observeTool(target("bili.read", 0, true), false, NOW, "port-down");
    expect(bad.reason).toBe("port-down");
    expect(bad.effectivity).toBe(0);
    expect(bad.at).toBe("2026-10-31T17:10:00Z");
  });

  it("时间不合法就拒绝写观测", () => {
    expect(() => observeTool(target("knowledge.read"), true, Number.NaN)).toThrow(RangeError);
  });

  it("序列化 → 解析往返一致（坏行只计数，好行照读）", () => {
    const lines = [
      serializeToolProbe(observation("knowledge.read", true, "2026-10-31T17:00:00.000Z")),
      "这不是 JSON",
      serializeToolProbe(observation("bili.read", false, "2026-10-31T17:00:00.000Z", "port-down")),
      JSON.stringify({ tool: "", available: true, effectivity: 1, at: "2026-10-31T17:00:00.000Z" }),
    ].join("\n");
    const parsed = parseToolProbeLines(lines);
    expect(parsed.observations.map((o) => o.tool)).toEqual(["knowledge.read", "bili.read"]);
    expect(parsed.observations[1]?.reason).toBe("port-down");
    expect(parsed.errors).toHaveLength(2);
  });

  it("最新的那一拍说了算，但过期的不算数", () => {
    const observations = [
      observation("knowledge.read", false, "2026-10-31T10:00:00.000Z", "unknown"),
      observation("knowledge.read", true, "2026-10-31T16:00:00.000Z"),
      observation("bili.read", false, "2026-10-30T16:00:00.000Z", "port-down"),
    ];
    const latest = latestToolProbes(observations, NOW);
    expect(latest.get("knowledge.read")?.available).toBe(true);
    // bili.read 的观测超过 12 小时，已经不算"此刻的事实"
    expect(latest.has("bili.read")).toBe(false);
  });

  it("未来时间的观测跳过（时钟错乱也不让未来覆盖现在）", () => {
    const latest = latestToolProbes([observation("knowledge.read", true, "2026-10-31T18:00:00.000Z")], NOW);
    expect(latest.size).toBe(0);
  });

  it("TTL 可覆盖，但非法 ttl / now 抛错", () => {
    const observations = [observation("knowledge.read", true, "2026-10-31T16:00:00.000Z")];
    expect(latestToolProbes(observations, NOW, TOOL_PROBE_TTL_MS).size).toBe(1);
    expect(latestToolProbes(observations, NOW, 60_000).size).toBe(0);
    expect(() => latestToolProbes(observations, Number.NaN)).toThrow(RangeError);
    expect(() => latestToolProbes(observations, NOW, 0)).toThrow(RangeError);
  });

  it("夜间窗口是 03:00–05:00，边界含头不含尾", () => {
    expect(inToolProbeWindow(3)).toBe(true);
    expect(inToolProbeWindow(4)).toBe(true);
    expect(inToolProbeWindow(2)).toBe(false);
    expect(inToolProbeWindow(5)).toBe(false);
    expect(() => inToolProbeWindow(24)).toThrow(RangeError);
    expect(() => inToolProbeWindow(3.5)).toThrow(RangeError);
  });

  it("日志摘要说人话：可用/不可用各几条、为什么", () => {
    const line = describeToolProbe([
      observation("knowledge.read", true, "2026-10-31T17:00:00.000Z"),
      observation("bili.read", true, "2026-10-31T17:00:00.000Z"),
      observation("desktop.screen", false, "2026-10-31T17:00:00.000Z", "unknown"),
    ]);
    expect(line).toContain("探测 3 条：可用 2 / 不可用 1");
    expect(line).toContain("desktop.screen（unknown）");
    expect(describeToolProbe([])).toContain("探测 0 条");
  });
});
