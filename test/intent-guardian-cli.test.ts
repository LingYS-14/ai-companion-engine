/**
 * 监护人通道 CLI：`tools/intent/guardian.mjs`
 *
 * 这个 CLI 是「说完没人回」这条链的**人这一侧**：她写请求，人写应答。
 * 测试守四件事：空收件箱不吓人、请求能被读成人话、应答真的落盘、超时写成事实而不是清零。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardianReplyFileName } from "../src/orchestrator/intent/guardian.js";

const CLI = join(process.cwd(), "tools", "intent", "guardian.mjs");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guardian-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function requestLine(overrides: Record<string, unknown> = {}): string {
  const now = Date.now();
  return JSON.stringify({
    requestId: "grd-itn-aaa-100",
    at: new Date(now - 5 * 60 * 1000).toISOString(),
    intentionId: "itn-aaa",
    what: "我想用桌面控制帮你点一下那个按钮",
    tried: ["看了工具清单", "试过 risk 0 探测"],
    need: "permission",
    ask: "允许我用桌面控制点一下吗",
    timeoutMs: 7_200_000,
    ...overrides,
  });
}

function writeInbox(...lines: readonly string[]): void {
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "guardian-assistant.ndjson"), lines.join("\n") + "\n", "utf8");
}

describe("guardian CLI：人这一侧的回音通道", () => {
  it("收件箱为空时说人话，不装有事", () => {
    const res = run(["list"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("收件箱是空的");
    expect(res.stdout).toContain("还没开口");
  });

  it("把一条请求读成人话：卡在哪、试过什么、想请对方做什么", () => {
    writeInbox(requestLine());
    const res = run(["list"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("grd-itn-aaa-100");
    expect(res.stdout).toContain("等回音");
    expect(res.stdout).toContain("我想用桌面控制帮你点一下那个按钮");
    expect(res.stdout).toContain("看了工具清单 / 试过 risk 0 探测");
    expect(res.stdout).toContain("允许我用桌面控制点一下吗");
  });

  it("answer --help 写应答文件，list 立刻显示已答", () => {
    writeInbox(requestLine());
    const answered = run(["answer", "grd-itn-aaa-100", "--help", "--note", "我在，说吧"]);
    expect(answered.code).toBe(0);
    expect(answered.stdout).toContain("已写应答");
    const path = join(root, "data", "guardian-reply", `${guardianReplyFileName("grd-itn-aaa-100")}.json`);
    expect(existsSync(path)).toBe(true);
    const reply = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(reply["verdict"]).toBe("help");
    expect(reply["from"]).toBe("lead");

    const list = run(["list"]);
    expect(list.stdout).toContain("已答（help）");
  });

  it("answer 一个不存在的 requestId：exit 1，不乱写文件", () => {
    writeInbox(requestLine());
    const res = run(["answer", "grd-nope", "--help"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("没有这个 requestId");
    expect(existsSync(join(root, "data", "guardian-reply", "grd-nope.json"))).toBe(false);
  });

  it("超时的请求解成事实「问过，暂无回音」，不清零尝试", () => {
    writeInbox(requestLine({ requestId: "grd-itn-old-1", at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
    const res = run(["resolve"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("已超时 1");
    expect(res.stdout).toContain("问过，暂无回音");
  });

  it("decline 也写成事实（对方暂时帮不了），带上对方的话", () => {
    writeInbox(requestLine());
    const res = run(["answer", "grd-itn-aaa-100", "--decline", "--note", "这个我帮不了"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("暂时帮不了");
    expect(res.stdout).toContain("这个我帮不了");
  });

  it("--help 打用法，不是被当成回 help 的开关", () => {
    const res = run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("监护人通道 CLI");
  });
});
