/**
 * DSH 收件箱 CLI：`tools/intent/dsh.mjs`
 *
 * 这个 CLI 是「她 → DSH」通道的人这一侧：她写请求，人写回执。
 * 守四件事：空收件箱说人话、请求能读成人话、回执真的落盘、超时写成「暂无回音」。
 *
 * 注意：CLI 需要 `dist/` 里的编译产物（和 dashboard/metrics 一样走"脚本 + dist"模式）；
 * dist 不存在时（干净检出）跳过与 dist 相关的用例，帮助文本这条不依赖 dist、始终跑。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(process.cwd());
const CLI = join(REPO, "tools", "intent", "dsh.mjs");
const DIST = join(REPO, "dist", "orchestrator", "intent", "dsh-bridge.js");
const hasDist = existsSync(DIST);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dsh-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 造一行 inbox（与 dsh-bridge.ts 的版本/字段保持一致）。 */
function askLine(overrides: Record<string, unknown> = {}): string {
  const at = new Date(Date.now() - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return JSON.stringify({
    version: 1,
    id: "dsh-itn-aaa-100",
    intentionId: "itn-aaa",
    at,
    kind: "help",
    text: "我写不进那个文件，能帮我看一下吗？",
    tried: ["看了权限", "重启了脚本"],
    expiresAt: new Date(Date.now() + 115 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  });
}

describe("dsh.mjs（帮助不需要 dist）", () => {
  it("--help 打出用法并 exit 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("node tools/intent/dsh.mjs");
    expect(r.stdout).toContain("answer <id>");
  });

  it("未知参数 exit 非 0", () => {
    const r = run(["--nope"]);
    expect(r.code).not.toBe(0);
  });
});

describe.skipIf(!hasDist)("dsh.mjs（需要 dist）", () => {
  it("空收件箱说人话：不是没人管，是还没开口", () => {
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("收件箱是空的");
    expect(r.stdout).toContain("还没开口");
  });

  it("list 把请求读成人话：状态/想问/试过/超时都在", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "dsh-inbox-assistant.ndjson"), `${askLine()}\n`, "utf8");
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("等回音");
    expect(r.stdout).toContain("我写不进那个文件");
    expect(r.stdout).toContain("看了权限");
    expect(r.stdout).toContain("超时：");
  });

  it("answer --answer 写回执文件，list 立刻显示已答", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "dsh-inbox-assistant.ndjson"), `${askLine()}\n`, "utf8");
    const answer = run(["answer", "dsh-itn-aaa-100", "--answer", "文件我已经帮你打开了。"]);
    expect(answer.code).toBe(0);
    const file = join(root, "data", "dsh-reply", "dsh-itn-aaa-100.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { verdict: string; answer: string };
    expect(saved.verdict).toBe("answered");
    expect(saved.answer).toBe("文件我已经帮你打开了。");
    const list = run(["list"]);
    expect(list.stdout).toContain("已答");
    expect(list.stdout).toContain("她会记住：DSH 回我了");
  });

  it("answer 不存在的 id：exit 1 且不写回执", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "dsh-inbox-assistant.ndjson"), `${askLine()}\n`, "utf8");
    const r = run(["answer", "dsh-nope", "--answer", "好"]);
    expect(r.code).toBe(1);
    expect(existsSync(join(root, "data", "dsh-reply", "dsh-nope.json"))).toBe(false);
  });

  it("answer --decline / --later 有默认话术，落成事实", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "dsh-inbox-assistant.ndjson"), `${askLine()}\n${askLine({ id: "dsh-itn-bbb-100" })}\n`, "utf8");
    const decline = run(["answer", "dsh-itn-aaa-100", "--decline"]);
    expect(decline.code).toBe(0);
    expect(decline.stdout).toContain("帮不了");
    const later = run(["answer", "dsh-itn-bbb-100", "--later"]);
    expect(later.code).toBe(0);
    expect(later.stdout).toContain("稍后");
  });

  it("超时未回：resolve 把状态记成已超时，事实是「问过，暂无回音」", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    const at = new Date(Date.now() - 3 * 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(root, "data", "dsh-inbox-assistant.ndjson"),
      `${askLine({ at, expiresAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") })}\n`,
      "utf8",
    );
    const r = run(["resolve"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已超时");
    expect(r.stdout).toContain("问过，暂无回音");
  });

  it("坏行不吞好行：list 仍显示好请求，并提示坏行数", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "dsh-inbox-assistant.ndjson"), `${askLine()}\n{not json\n`, "utf8");
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("我写不进那个文件");
    expect(r.stdout).toContain("坏");
  });
});
