/**
 * B 站扫码页的显示名（F326 监督 B3 回归锁）。
 *
 * 人格卡删除后，页面文案不能再硬编码「AI助手」：有 displayName 用 displayName，
 * 没有就用中性的「她」。显示名来自配置，转义后再拼进 HTML。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildBiliQrPage } from "../src/plugin/web/handlers.js";

const handlersSource = readFileSync(new URL("../src/plugin/web/handlers.ts", import.meta.url), "utf8");

describe("B 站扫码页：显示名不再硬编码", () => {
  it("没有 displayName 时用中性的「她」，且不再出现旧角色名", () => {
    const html = buildBiliQrPage("/plugins/ai-companion-engine/bili-qr");
    expect(html).toContain("让她自己登录 B 站");
    expect(html).not.toContain("AI助手");
  });

  it("有 displayName 时使用显示名", () => {
    const html = buildBiliQrPage("/plugins/ai-companion-engine/bili-qr", "小满");
    expect(html).toContain("让小满自己登录 B 站");
  });

  it("显示名先转义再拼进 HTML（防标签注入）", () => {
    const html = buildBiliQrPage("/plugins/ai-companion-engine/bili-qr", "<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("handlers 源码不再硬编码角色名", () => {
    expect(handlersSource).not.toContain("AI助手");
  });
});
