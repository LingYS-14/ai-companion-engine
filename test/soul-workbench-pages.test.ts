import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P4-4 P3（工作台补完）：记忆 / 知识 / 意图 / 设置四页不能是占位。
 *
 * 背景：P1 只立了外壳、P2 补了对话页，记忆/知识/意图/设置一直挂着
 * 「P2/P3 建」的占位文案。2026-11-03 用户要求「UI 今晚做了」，这组测试
 * 锁住四页真的接了 state-v2 数据、并且沿用只读口径（无 innerHTML、
 * 无 soul_ 工具、无写状态），防止以后被"优化"回占位。
 */

const ROOT = process.cwd();
const HTML = readFileSync(join(ROOT, "lib", "soul", "index.html"), "utf8");
const SOUL = readFileSync(join(ROOT, "lib", "soul", "soul.js"), "utf8");
const CSS = readFileSync(join(ROOT, "lib", "soul", "soul.css"), "utf8");

describe("P4-4 P3：工作台四页（记忆/知识/意图/设置）已接数据", () => {
  it("六页导航齐全，没有任何 P2/P3 占位文案残留", () => {
    for (const page of ["overview", "dialog", "memory", "knowledge", "intent", "settings"]) {
      expect(HTML).toContain(`id="page-${page}"`);
      expect(HTML).toContain(`data-page="${page}"`);
    }
    expect(HTML).not.toContain('class="placeholder"');
    expect(HTML).not.toContain("页 P2 建");
    expect(HTML).not.toContain("nav-badge");
  });

  it("四页各有自己的挂载点，不是同一块复用", () => {
    for (const id of ["memory-stats", "memory-list", "knowledge-list", "intent-list", "intent-waiting", "settings-sleep", "settings-about"]) {
      expect(HTML).toContain(`id="${id}"`);
    }
    expect(HTML).toContain('id="theme-seg"');
  });

  it("渲染函数存在，并且在 render() 里真的被调用", () => {
    for (const fn of ["renderMemoryPage", "renderKnowledgePage", "renderIntentPage", "renderSettings"]) {
      expect(SOUL).toContain(`function ${fn}(data)`);
      expect(SOUL).toMatch(new RegExp(`${fn}\\(data\\);`));
    }
  });

  it("记忆页读 counts + recent，不自己编数据", () => {
    expect(SOUL).toContain('statCard("总数", mem.total');
    expect(SOUL).toContain('statCard("活跃", mem.active');
    expect(SOUL).toContain('statCard("已忘", mem.forgotten');
    expect(SOUL).toContain("data.recent");
    expect(HTML).toContain("完整记忆流");
  });

  it("知识页读 knowledge 列表与 memory.knowledge 计数", () => {
    expect(SOUL).toContain("data.knowledge");
    expect(SOUL).toContain("mem.knowledge");
    expect(SOUL).toContain("k.type");
  });

  it("意图页读 intentions/dsh/guardian，回答走既有 answer 端点", () => {
    expect(SOUL).toContain("intent.intentions");
    expect(SOUL).toContain("intent.dsh");
    expect(SOUL).toContain("intent.guardian");
    expect(SOUL).toContain('"/plugins/ai-companion-engine/answer"');
  });

  it("设置页有暗/亮主题，选择存在本机 localStorage，不动宿主", () => {
    expect(HTML).toContain('data-theme-set="dark"');
    expect(HTML).toContain('data-theme-set="light"');
    expect(SOUL).toContain('data-theme"');
    expect(SOUL).toContain("localStorage");
    expect(SOUL).toContain("soul-theme");
    expect(CSS).toContain(':root[data-theme="light"]');
  });

  it("只读口径：没有 innerHTML、没有 soul_ 工具、没有写状态", () => {
    expect(SOUL).not.toContain("innerHTML");
    expect(SOUL).not.toMatch(/soul_[a-z_]+\s*\(/);
    expect(SOUL).not.toContain("/apply");
    // 唯一改写她状态的入口是对话页的 chat send（daemon 侧唯一写者）；answer 只写人侧回执
    expect(SOUL).toContain("/plugins/ai-companion-engine/chat/send");
  });
});
