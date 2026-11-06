import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SOUL_TOOL_SPECS } from "../src/plugin/tool-definitions.js";

/**
 * F289：27 个 soul_* 工具的「名字/描述/参数」住在工具数据层，装配点只接线。
 *
 * 为什么单独立锁：审计 R4 文本规则禁的是"装配点定义工具"。如果只把文字挪走、
 * 却在装配点又写回 `name: "soul_x"` 或自己拼一份参数，规则会红、功能也可能悄悄
 * 丢掉一个工具（面板里少一个，用户看不出来）。这里同时锁"数据完整"和"接线完整"。
 */

const ROOT = process.cwd();
const TOOLS = readFileSync(join(ROOT, "src", "plugin", "tools.ts"), "utf8");
const SPECS = readFileSync(join(ROOT, "src", "plugin", "tool-definitions.ts"), "utf8");

const EXPECTED_NAMES = [
  "soul_qqlab",
  "soul_qq_dbprobe",
  "soul_persona",
  "soul_turn",
  "soul_state",
  "soul_recall",
  "soul_remember",
  "soul_advance",
  "soul_curious",
  "soul_obsess",
  "soul_conflict",
  "soul_stats",
  "soul_desktop",
  "soul_archive",
  "soul_consolidate",
  "soul_insight",
  "soul_bili_feed",
  "soul_bili_learn",
  "soul_bili_read",
  "soul_bili_me",
  "soul_qq_status",
  "soul_qq_poll",
  "soul_qq_send",
  "soul_qq_proactive",
  "soul_reset",
  "soul_web_search",
  "soul_web_fetch",
];

describe("工具定义搬进数据层（F289）", () => {
  it("恰好 27 个工具，名字不重复且与预期集合一致", () => {
    const names = Object.values(SOUL_TOOL_SPECS).map((s) => s.name);
    expect(names).toHaveLength(27);
    expect(new Set(names).size).toBe(27);
    expect([...names].sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it("每个工具都有非空描述与 object 参数 schema", () => {
    for (const [key, spec] of Object.entries(SOUL_TOOL_SPECS)) {
      expect(spec.description.length, key).toBeGreaterThan(8);
      expect(spec.parameters["type"], key).toBe("object");
      expect(typeof spec.name, key).toBe("string");
    }
  });

  it("装配点不再写工具名：没有 name: \"soul_…\" 字面量", () => {
    expect(TOOLS).not.toMatch(/name:\s*"soul_[a-z_]+"/);
    expect(TOOLS).toContain("SOUL_TOOL_SPECS");
  });

  it("装配点接线完整：27 处 spread 对应 27 个工具", () => {
    const used = [...TOOLS.matchAll(/\.\.\.SOUL_TOOL_SPECS\.([a-z_]+)/g)].map((m) => m[1]);
    expect(used).toHaveLength(27);
    expect(new Set(used).size).toBe(27);
    expect([...used].sort()).toEqual(Object.keys(SOUL_TOOL_SPECS).sort());
  });

  it("数据层是纯数据：没有 import、没有 runtime / execution 依赖", () => {
    expect(SPECS).not.toMatch(/^\s*import\s/m);
    expect(SPECS).not.toContain("SoulRuntime");
    expect(SPECS).not.toContain("createServer");
  });
});
