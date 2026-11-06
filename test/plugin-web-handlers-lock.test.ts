import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/**
 * F277：插件三个 HTTP 端点从装配点搬进工具层。
 *
 * 这组锁防的是「以后有人图省事又把 HTML / res.end 写回 assembly」——
 * 审计 R4 文本规则管的是结构位置，不是审美：装配点里一旦有 HTTP 细节，
 * 边界检查就会出现盲区（基线冻结之后更难发现）。
 */
describe("F277：插件 HTTP 端点住在工具层", () => {
  const index = read("src/plugin/index.ts");
  const handlers = read("src/plugin/web/handlers.ts");

  it("装配点不再写 HTTP 细节（res.end / HTML / createServer）", () => {
    expect(index).not.toContain("res.end(");
    expect(index).not.toContain("<!doctype");
    expect(index).not.toContain("createServer(");
  });

  it("三个 handler 工厂都在工具层，且装配点 import 它们", () => {
    for (const name of ["createAvatarHandler", "createBiliQrHandler", "createStateHandler"]) {
      expect(handlers).toContain(`export function ${name}(`);
      expect(index).toContain(`${name}(`);
    }
    expect(index).toContain('from "./web/handlers.js"');
  });

  it("工具层不 import 大脑实现，也不认识装配根（R3 / 审计 P2-3）", () => {
    // F295：handlers 不再 import ../runtime.js、../panel.js，也不 import 大脑实现——
    // 状态端点只收一个 buildPayload 函数，怎么算由装配点注入。
    expect(handlers).not.toContain('from "../orchestrator/');
    expect(handlers).not.toContain('from "../runtime.js"');
    expect(handlers).not.toContain('from "../panel.js"');
    expect(handlers).toContain("buildPayload: () => unknown");
    expect(index).toContain("panelPayload(");
  });

  it("R4 文本基线只记旧债：index.ts 的旧债与工具定义都不在装配点了（F277/F289）", () => {
    // 批次1C（P1-H）后基线不再为空：R4-business 冻结的是 scripts/autonomy/main.mjs 的
    // 存量判定调用；这条用例只守 plugin 装配点不再出现工具定义债务。
    const baseline = JSON.parse(read("spec/config/layers-text-baseline.json")) as {
      entries: Array<{ file: string; rule: string; target: string }>;
    };
    expect(baseline.entries.some((item) => item.file === "src/plugin/index.ts")).toBe(false);
    expect(baseline.entries.some((item) => item.file === "src/plugin/tools.ts")).toBe(false);
  });
});
