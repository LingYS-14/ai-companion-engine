/**
 * `soul_desktop` 工具：只读观察这台电脑。
 *
 * 测试里执行器是注入的假 exec —— 不真的截图、不真的列窗口、绝不碰鼠标键盘。
 * 要验真机能力，用 `node tools/desktop/cli.mjs windows|screen`（那是人工动作）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { buildTools, type DesktopToolDeps } from "../src/plugin/tools.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-desktop-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function toolWith(desktop: DesktopToolDeps | null) {
  const rt = await SoulRuntime.open(conf, clock);
  const defs = buildTools(rt, desktop === null ? {} : { desktop });
  const tool = defs.find((d) => d.name === "soul_desktop");
  expect(tool).toBeDefined();
  return tool!;
}

function fakeDesktop(stdout: string): DesktopToolDeps {
  const calls: string[][] = [];
  return {
    powershellExe: "pwsh",
    scriptPath: "C:/repo/tools/desktop/desktop.ps1",
    outDir: join(dir, "screens"),
    exec: async (_cmd, args) => {
      calls.push([...args]);
      void calls;
      return { code: 0, stdout, stderr: "" };
    },
  };
}

describe("soul_desktop", () => {
  it("没接执行器时明确回答「没有接」，不假装能用", async () => {
    const tool = await toolWith(null);
    const out = await tool.execute({ action: "windows" });
    expect(String(out)).toContain("未接");
  });

  it("列窗口：pid 与标题原样返回，limit 生效", async () => {
    const payload = JSON.stringify({
      ok: true,
      count: 3,
      windows: [
        { pid: 1, title: "设置" },
        { pid: 2, title: "DeepSeek Harness" },
        { pid: 3, title: "Visual Studio Code" },
      ],
    });
    const tool = await toolWith(fakeDesktop(payload));
    const out = String(await tool.execute({ action: "windows", limit: 2 }));
    expect(out).toContain("count=3 shown=2");
    expect(out).toContain("DeepSeek Harness");
    expect(out).not.toContain("Visual Studio Code");
  });

  it("截图：返回落盘路径与尺寸", async () => {
    const tool = await toolWith(fakeDesktop('{"ok":true,"width":2560,"height":1440}'));
    const out = String(await tool.execute({ action: "screen" }));
    expect(out).toContain("screen ok");
    expect(out).toContain("2560x1440");
    expect(out).toContain("screens");
  });

  it("action 不认识时拒绝，不去调 PowerShell", async () => {
    let called = 0;
    const tool = await toolWith({
      powershellExe: "pwsh",
      scriptPath: "x.ps1",
      outDir: join(dir, "screens"),
      exec: async () => {
        called += 1;
        return { code: 0, stdout: '{"ok":true}', stderr: "" };
      },
    });
    const out = String(await tool.execute({ action: "click" }));
    expect(out).toContain("windows / screen / lease");
    expect(called).toBe(0);
  });

  it("PowerShell 报错时把原因带回来（不判成功）", async () => {
    const tool = await toolWith(fakeDesktop('{"ok":false,"error":"Access denied"}'));
    const out = String(await tool.execute({ action: "windows" }));
    expect(out).toContain("Access denied");
  });
});
