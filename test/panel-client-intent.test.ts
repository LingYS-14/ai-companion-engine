import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P4-4 P1（工作台）：client 半只留一个 iframe，工作台页面在 `lib/soul/*`。
 *
 * F288 的意图面没有消失，只是搬家了：以前它画在 React 面板里（`lib/client.js`），
 * 现在画在同源静态页 `lib/soul/soul.js`。这组测试跟着搬，防两件事：
 *   1. 有人把旧渲染又塞回 client 半（双实现会漂移）；
 *   2. 工作台那一节被"优化"掉——静默失败，面板看起来一切正常，只是没有那一节。
 */

const ROOT = process.cwd();
const CLIENT = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const SOUL = readFileSync(join(ROOT, "lib", "soul", "soul.js"), "utf8");
const PANEL = readFileSync(join(ROOT, "src", "assembly", "panel-payload.ts"), "utf8");
const INDEX = readFileSync(join(ROOT, "src", "plugin", "index.ts"), "utf8");
const HANDLERS = readFileSync(join(ROOT, "src", "plugin", "web", "handlers.ts"), "utf8");

describe("P4-4 P1：client 半只嵌工作台（F288 意图面迁到 /soul）", () => {
  it("client 半只留 iframe，指向同源 /soul", () => {
    expect(CLIENT).toContain("iframe");
    expect(CLIENT).toContain("src: SOUL_PAGE");
    expect(CLIENT).toContain('"/soul"');
    expect(CLIENT).toContain('title: "灵魂 · 工作台"');
    expect(CLIENT).not.toContain("她正想做什么");
  });

  it("侧边栏注册与热重载清理原样保留（重载不能多出第二个「灵魂」）", () => {
    expect(CLIENT).toContain('name: "sidebar.panellist"');
    expect(CLIENT).toContain("order: 60");
    expect(CLIENT).toContain("__ase_panel_disposers__");
  });

  it("工作台有「她正想做什么」这一节，并读 data.intent", () => {
    expect(SOUL).toContain("她正想做什么");
    expect(SOUL).toContain("data.intent");
    expect(SOUL).toContain("intent.intentions");
    expect(SOUL).toContain("intent.notes");
    expect(SOUL).toContain("intent.gaps");
  });

  it("数据缺失时不编：整节跳过，而不是显示「没有心事」", () => {
    expect(SOUL).toContain("data.intent === undefined || data.intent === null");
    // 只有拿到数据、且 items 为空时才说「此刻没有开着的心事」
    expect(SOUL).toContain("此刻没有开着的心事");
    expect(SOUL).toMatch(/items\.length === 0[\s\S]{0,400}?此刻没有开着的心事/);
  });

  it("在等回音 / 能力缺口 / 读不到的说明都有对应的显示文案", () => {
    expect(SOUL).toContain("在等回音：");
    expect(SOUL).toContain("卡在能力缺口：");
    expect(SOUL).toContain("notes[i]");
  });

  it("这一节在页脚之前（顺序错会把它埋到底部看不到）", () => {
    const intentAt = SOUL.indexOf("她正想做什么");
    const footerAt = SOUL.indexOf("睡点 ");
    expect(intentAt).toBeGreaterThan(-1);
    expect(footerAt).toBeGreaterThan(intentAt);
  });

  it("服务端仍把 intent 交给前端（F295 后由装配层组装）", () => {
    expect(PANEL).toMatch(/intent:\s*/);
    // F295：面板数据层搬到装配层，端点只收 buildPayload；装配点把 facts 传进去
    expect(INDEX).toContain("panelPayload(runtime, conf, facts, fresh)");
    expect(HANDLERS).toContain("buildPayload");
  });

  it("意图区没有「让她去做」的命令入口；只有人这边回一句（F299 允许）", () => {
    // 边界：工作台不替她推进（不能点一下就让灵魂做事），但人可以回她的问询。
    const intentBlock = SOUL.slice(SOUL.indexOf("她正想做什么"), SOUL.indexOf("睡点 "));
    expect(intentBlock).not.toContain("soul_");
    expect(intentBlock).not.toContain("/apply");
    expect(intentBlock).not.toContain("让她");
    // 唯一的 POST 是回答端点（人侧回执），不是指令
    expect(intentBlock).toContain('"/plugins/ai-companion-engine/answer"');
    expect(intentBlock).toContain('method: "POST"');
  });
});
