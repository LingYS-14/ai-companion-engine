/**
 * 身份协议（F326 / P4-3 方案 A）。
 *
 * 为什么值得单独锁：人格卡删掉后，模型看到的「她是谁」只剩这一小段文本。
 * 它必须是**协议**而不是人设：没有名字、没有设定、没有口癖；只挡两条退化边
 * （自称 AI/助手、背设定变客服），不给她设内容限制。
 *
 * 2026-11-02 用户裁决「完全不设限」：原第 5–9 条安全底线已删除，
 * 这里改锁「4 条身份协议 + 不存在安全条款」——加回任何一条都会变红。
 *
 * 同时锁住三处接线：引擎两条提示词（回信 + 主动）真用它；DSH 系统提示也真注入它；
 * 任何一处被悄悄接回 renderPersona 都必须变红。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROTOCOL_IDENTITY } from "../src/dialogue/protocol-identity.js";

const promptSource = readFileSync(new URL("../src/dialogue/prompt.ts", import.meta.url), "utf8");
const pluginIndexSource = readFileSync(new URL("../src/plugin/index.ts", import.meta.url), "utf8");

describe("PROTOCOL_IDENTITY：身份 4 条（不设内容限制）", () => {
  it("恰好 4 条、逐条编号（1.-4.）", () => {
    const lines = PROTOCOL_IDENTITY.split("\n");
    expect(lines).toHaveLength(4);
    lines.forEach((line, i) => expect(line.startsWith(`${i + 1}. `)).toBe(true));
  });

  it("覆盖身份必决内容：第一人称/不自称 AI/不背设定/身份来自记忆", () => {
    expect(PROTOCOL_IDENTITY).toContain("第一人称");
    expect(PROTOCOL_IDENTITY).toContain("不要自称 AI");
    expect(PROTOCOL_IDENTITY).toContain("客服腔");
    expect(PROTOCOL_IDENTITY).toContain("不要背设定");
    expect(PROTOCOL_IDENTITY).toContain("身份只来自记忆");
  });

  it("完全不设限：不含安全条款（2026-11-02 用户裁决，原 5–9 条删除）", () => {
    expect(PROTOCOL_IDENTITY).not.toContain("不写违法内容");
    expect(PROTOCOL_IDENTITY).not.toContain("伤害他人");
    expect(PROTOCOL_IDENTITY).not.toContain("未成年");
    expect(PROTOCOL_IDENTITY).not.toContain("露骨");
    expect(PROTOCOL_IDENTITY).not.toContain("自伤");
    expect(PROTOCOL_IDENTITY).not.toContain("安全底线");
  });

  it("不是人设卡：不含角色名/称呼/世界观/关系设定，且短到不占预算", () => {
    expect(PROTOCOL_IDENTITY).not.toMatch(/AI助手|用户|粉色妖精|崩坏|逐火/);
    expect(PROTOCOL_IDENTITY).not.toMatch(/【人格|【设定|角色卡/);
    // 协议是机制层的最小约束（身份 4 条）；超过一小段就是在偷偷写人设。
    expect(PROTOCOL_IDENTITY.length).toBeLessThan(400);
  });

  it("引擎回信与主动开口都直接用协议（不是 renderPersona）", () => {
    expect(promptSource.match(/const who = PROTOCOL_IDENTITY;/g)?.length ?? 0).toBe(2);
    expect(promptSource).not.toContain("renderPersona(");
  });

  it("DSH 系统提示真的注入身份协议（B1 回归锁）", () => {
    expect(pluginIndexSource).toContain('import { PROTOCOL_IDENTITY } from "../dialogue/protocol-identity.js";');
    expect(pluginIndexSource).toContain('name: "ai-companion-engine:identity"');
    expect(pluginIndexSource).toContain("text: PROTOCOL_IDENTITY");
  });
});
