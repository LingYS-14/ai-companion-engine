/**
 * 协议文本的守护测试。
 *
 * 这段文本直接进系统提示，等于角色行为规范；它错了不会报错，只会让角色演歪。
 * 所以这里盯四件事：①点名的工具都真实存在 ②没有教错参数形状 ③在预算内 ④禁止项还在。
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_BUDGET, PROTOCOL_RULES, PROTOCOL_TEXT, PROTOCOL_TOOLS } from "../src/plugin/protocol.js";
import { buildTools } from "../src/plugin/tools.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { FakeClock } from "../src/engine/clock.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let conf: SoulConfig;

function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "soul-protocol-"));
  conf = { characterId: "p", dataDir: dir, trace: false };
}

describe("对话协议", () => {
  it("在预算内（超了会挤掉系统提示里别的东西）", () => {
    expect(PROTOCOL_TEXT.length).toBeLessThanOrEqual(PROTOCOL_BUDGET);
  });

  it("点名的每个工具都真实注册了", async () => {
    setup();
    try {
      const rt = await SoulRuntime.open(conf, new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12));
      const names = new Set(buildTools(rt).map((d) => d.name));
      for (const tool of PROTOCOL_TOOLS) expect(names.has(tool)).toBe(true);
      // 反向：不该点名不存在的工具
      for (const tool of PROTOCOL_TOOLS) expect(PROTOCOL_TEXT).toContain(tool);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("教的是扁平参数，不是对象（这个坑踩过一次：包成对象会被 schema 过滤成默认值）", () => {
    expect(PROTOCOL_TEXT).toContain("扁平参数");
    expect(PROTOCOL_TEXT).toContain("goal_congruence");
    expect(PROTOCOL_TEXT).not.toContain("appraisal:");
    expect(PROTOCOL_TEXT).not.toMatch(/appraisal\s*\{/);
  });

  it("保留三条禁止项：不念数字、不编状态、不擅自 purge", () => {
    const ids = PROTOCOL_RULES.map((r) => r.id);
    expect(ids).toContain("obey-style");
    expect(ids).toContain("no-fabrication");
    expect(ids).toContain("maintenance");
    expect(PROTOCOL_TEXT).toContain("不要把任何数字念给用户");
    expect(PROTOCOL_TEXT).toContain("绝不假装调用过");
    expect(PROTOCOL_TEXT).toContain("purge");
  });


  it("风格冲突时给出明确优先级（DEFENSE/BREAK 允许放弃敬称）", () => {
    expect(PROTOCOL_TEXT).toContain("优先级");
    expect(PROTOCOL_TEXT).toContain("[style]");
    expect(PROTOCOL_TEXT).toContain("DEFENSE/BREAK");
    // 顺序断言：style 必须排在 stage-style 之前出现，否则优先级读起来是反的
    expect(PROTOCOL_TEXT.indexOf("`[style]`（当前状态）")).toBeLessThan(
      PROTOCOL_TEXT.indexOf("`[stage-style]`（关系阶段）"),
    );
  });

  it("F31：事件层写进优先级，并排在关系阶段之前", () => {
    expect(PROTOCOL_TEXT).toContain("[event]");
    expect(PROTOCOL_TEXT).toContain("这一轮允许怎么反应");
    expect(PROTOCOL_TEXT.indexOf("`[event]`（这一轮发生了什么）")).toBeGreaterThan(
      PROTOCOL_TEXT.indexOf("`[style]`（当前状态）"),
    );
    expect(PROTOCOL_TEXT.indexOf("`[event]`（这一轮发生了什么）")).toBeLessThan(
      PROTOCOL_TEXT.indexOf("`[stage-style]`（关系阶段）"),
    );
  });

  it("规则 id 唯一（重复 id 说明两段协议在说同一件事，该合并）", () => {
    const ids = PROTOCOL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
