import { describe, expect, it } from "vitest";

import { affordanceFamily } from "../src/orchestrator/intent/candidates.js";
import {
  AUTONOMY_TOOL_CATALOG,
  availableAffordances,
  createToolPort,
  familyOf,
  describeToolPort,
} from "../src/contracts/tool-catalog.js";

describe("ToolPort（B5）：她能做什么，从这里来", () => {
  it("能力族与意图引擎同口径（两边不能各说各话）", () => {
    for (const entry of AUTONOMY_TOOL_CATALOG) {
      expect(familyOf(entry.tool)).toBe(affordanceFamily(entry.tool));
    }
  });

  it("catalog 里的 family 与工具名推导一致（防止手工填错）", () => {
    for (const entry of AUTONOMY_TOOL_CATALOG) {
      expect(entry.family).toBe(familyOf(entry.tool));
    }
  });

  it("只把此刻可用的工具交给她", () => {
    const port = createToolPort({ "knowledge.read": true, "qq.send_text": true });
    const usable = availableAffordances(port);
    expect(usable.map((a) => a.tool)).toEqual(["knowledge.read", "qq.send_text"]);
    // 不可用的仍在清单里（她能知道"有这能力但现在用不了"）
    expect(port.capabilities().some((t) => t.tool === "desktop.screen" && !t.available)).toBe(true);
  });

  it("风险档：只读 0、发消息 1，且不再声称没有实现的写文件能力", () => {
    const byTool = new Map(AUTONOMY_TOOL_CATALOG.map((t) => [t.tool, t]));
    expect(byTool.get("knowledge.read")?.risk).toBe(0);
    expect(byTool.get("qq.send_text")?.risk).toBe(1);
    // F256：local.write_file 曾是"声明了、实现 0 处"的幽灵能力，已从清单删除。
    // 这里锁住它不会被人再加回来（真要加，先有实现与执行层适配器）。
    expect(byTool.has("local.write_file")).toBe(false);
  });

  it("日志摘要只报可用数，不报「全都行」", () => {
    const port = createToolPort({ "knowledge.read": true, "bili.read": true, "qq.send_text": true });
    const line = describeToolPort(port);
    expect(line).toContain("可用 3/7");
    expect(line).toContain("read 2");
    expect(line).not.toContain("全都");
  });

  it("全部不可用时摘要为 0/N（不伪造）", () => {
    const port = createToolPort({});
    expect(describeToolPort(port)).toContain("可用 0/7");
    expect(availableAffordances(port)).toEqual([]);
  });
});
