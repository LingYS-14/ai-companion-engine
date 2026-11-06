/**
 * 桌面工具层：校验、授权、与 PowerShell 的接口。
 *
 * 这里**不碰真的鼠标键盘**——执行器是可注入的，测试全部用假 exec。
 * 真机只验只读动作（windows / screen），那是安全的；输入动作靠参数校验和授权闸保证。
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildArgs,
  escapeSendKeys,
  runDesktop,
  toSendKeys,
  validateRequest,
  type DesktopDeps,
} from "../src/desktop/desktop.js";

const ON = { allowInput: true } as const;
const OFF = { allowInput: false } as const;

describe("按键写法 → SendKeys", () => {
  it("常见组合", () => {
    expect(toSendKeys("CTRL+S")).toBe("^s");
    expect(toSendKeys("shift+alt+F4")).toBe("+%{F4}");
    expect(toSendKeys("ENTER")).toBe("{ENTER}");
    expect(toSendKeys("a")).toBe("a");
  });

  it("不认识的修饰键/主键一律拒绝（宁可不按）", () => {
    expect(toSendKeys("WIN+D")).toBeNull();
    expect(toSendKeys("CTRL+")).toBeNull();
    expect(toSendKeys("CTRL+FOO")).toBeNull();
    expect(toSendKeys("")).toBeNull();
  });

  it("文本里的特殊字符要转义，否则 SendKeys 会乱按", () => {
    expect(escapeSendKeys("a+b{c}")).toBe("a{+}b{{}c{}}");
  });
});

describe("授权与参数校验", () => {
  it("只读动作不需要输入授权", () => {
    expect(validateRequest({ action: "screen" }, OFF)).toBeNull();
    expect(validateRequest({ action: "windows" }, OFF)).toBeNull();
  });

  it("输入动作默认被拒（闸在代码里，不靠调用方自觉）", () => {
    expect(validateRequest({ action: "click", x: 1, y: 2 }, OFF)).toContain("输入未授权");
    expect(validateRequest({ action: "type", text: "hi" }, OFF)).toContain("输入未授权");
    expect(validateRequest({ action: "key", keys: "ENTER" }, OFF)).toContain("输入未授权");
  });

  it("坐标必须是整数且在范围内", () => {
    expect(validateRequest({ action: "click", x: 1, y: 2 }, ON)).toBeNull();
    expect(validateRequest({ action: "click", y: 2 }, ON)).toContain("需要 x 和 y");
    expect(validateRequest({ action: "click", x: 1.5, y: 2 }, ON)).toContain("整数");
    expect(validateRequest({ action: "click", x: -1, y: 2 }, ON)).toContain("越界");
  });

  it("打字限长、空文本拒绝", () => {
    expect(validateRequest({ action: "type", text: "" }, ON)).toContain("为空");
    expect(validateRequest({ action: "type", text: "x".repeat(600) }, ON)).toContain("过长");
    expect(validateRequest({ action: "type", text: "你好" }, { allowInput: true, maxTextChars: 2000 })).toBeNull();
  });
});

describe("参数组装", () => {
  const deps: DesktopDeps = {
    powershellExe: "powershell",
    scriptPath: "tools/desktop/desktop.ps1",
    outDir: "data/screens",
    now: () => 1_700_000_000_000,
  };

  it("截图带 OutPath，点击带坐标，按键带翻译后的写法", () => {
    const screen = buildArgs(deps, { action: "screen" }, "C:/out/a.png");
    expect(screen).toContain("-Action");
    expect(screen[screen.indexOf("-Action") + 1]).toBe("screen");
    expect(screen[screen.indexOf("-OutPath") + 1]).toBe("C:/out/a.png");

    const click = buildArgs(deps, { action: "click", x: 800, y: 600 }, "C:/out/x.txt");
    expect(click.slice(click.indexOf("-X"))).toEqual(["-X", "800", "-Y", "600"]);

    const key = buildArgs(deps, { action: "key", keys: "CTRL+S" }, "C:/out/x.txt");
    expect(key[key.indexOf("-Keys") + 1]).toBe("^s");
  });
});

describe("执行：失败不抛、成功回形状", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ase-desktop-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function depsWith(exec: DesktopDeps["exec"]): DesktopDeps {
    return {
      powershellExe: "powershell",
      scriptPath: "script.ps1",
      outDir: join(dir, "screens"),
      now: () => 1_700_000_000_000,
      exec,
    };
  }

  it("截图成功：返回路径、目录被建出来", async () => {
    const calls: string[][] = [];
    const deps = depsWith(async (_cmd, args) => {
      calls.push([...args]);
      return { code: 0, stdout: '{"ok":true,"action":"screen","width":2560,"height":1440}', stderr: "" };
    });
    const r = await runDesktop({ action: "screen" }, deps, ON);
    expect(r.ok).toBe(true);
    expect(r.path).toContain("screen-");
    expect(existsSync(join(dir, "screens"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("PowerShell 说失败：把 error 原样带回来", async () => {
    const deps = depsWith(async () => ({ code: 1, stdout: '{"ok":false,"error":"Access denied"}', stderr: "" }));
    const r = await runDesktop({ action: "windows" }, deps, ON);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Access denied");
  });

  it("输出不是 JSON（比如 PowerShell 崩了）：判失败，不猜成功", async () => {
    const deps = depsWith(async () => ({ code: 1, stdout: "boom", stderr: "Cannot find assembly" }));
    const r = await runDesktop({ action: "windows" }, deps, ON);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Cannot find assembly");
  });

  it("执行器抛错也不冒泡", async () => {
    const deps = depsWith(async () => {
      throw new Error("spawn ENOENT");
    });
    const r = await runDesktop({ action: "windows" }, deps, ON);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ENOENT");
  });

  it("没授权时连执行器都不碰（不产生任何副作用）", async () => {
    let called = 0;
    const deps = depsWith(async () => {
      called += 1;
      return { code: 0, stdout: '{"ok":true}', stderr: "" };
    });
    const r = await runDesktop({ action: "click", x: 10, y: 10 }, deps, OFF);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("输入未授权");
    expect(called).toBe(0);
  });
});

describe("截图不留垃圾：只保留最近 N 张", () => {
  it("超过上限时删最老的，保留最新的", async () => {
    const { mkdirSync, writeFileSync, utimesSync, readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "ase-shots-"));
    try {
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 5; i += 1) {
        const p = join(dir, `screen-old${i}.png`);
        writeFileSync(p, "x");
        utimesSync(p, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000));
      }
      const { pruneScreens } = await import("../src/desktop/desktop.js");
      expect(pruneScreens(dir, 2)).toBe(3);
      expect(readdirSync(dir).sort()).toEqual(["screen-old3.png", "screen-old4.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在返回 0（不抛）", async () => {
    const { pruneScreens } = await import("../src/desktop/desktop.js");
    expect(pruneScreens(join(tmpdir(), "ase-no-such-dir-xyz"), 5)).toBe(0);
  });
});
