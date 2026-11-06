/**
 * 意图表查看器：`tools/intent/intentions.mjs`
 *
 * 这个 CLI 是"她在想什么"的**人这一侧**：她每一拍把想做的事写进意图表，
 * 人不用读 JSON，就能看到哪些还开着、为什么最后没做、试过几次。
 * 测试守四件事：没有表不吓人、默认只看开着的、坏表 fail-closed 不猜、--json 形状稳定。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(process.cwd(), "tools", "intent", "intentions.mjs");
const NOW = Date.UTC(2026, 9, 31, 2, 0, 0);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "intentions-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: readonly string[]): { code: number; stdout: string } {
  const res = spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "" };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "itn-1",
    created_at: new Date(NOW - 30 * 60_000).toISOString(),
    kind: "reach_out",
    goal: "想找用户说句话",
    why: "因为想有人陪（缺口 0.62）",
    trigger: null,
    deadline: null,
    status: "pending",
    blocked_by: null,
    attempts: [],
    superseded_by: null,
    survival: 0,
    source_ids: [],
    ...overrides,
  };
}

function writeTable(records: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): void {
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intent-assistant.json"),
    JSON.stringify({ version: 1, savedAtMs: NOW, records, ...extra }),
    "utf8",
  );
}

describe("意图表查看器", () => {
  it("--help 打用法、exit 0", () => {
    const { code, stdout } = run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("意图表");
    expect(stdout).toContain("--all");
  });

  it("没有表时说人话、exit 0（不是故障）", () => {
    const { code, stdout } = run([]);
    expect(code).toBe(0);
    expect(stdout).toContain("意图表还没有");
  });

  it("默认只看开着的；开着 1 条、结束 1 条时计数照实说", () => {
    writeTable([
      record({ id: "open-1", status: "pending" }),
      record({ id: "done-1", status: "done", created_at: new Date(NOW - 60 * 60_000).toISOString() }),
    ]);
    const { code, stdout } = run([]);
    expect(code).toBe(0);
    expect(stdout).toContain("2 条（开着 1，结束 1，放弃 0）");
    expect(stdout).toContain("想找用户说句话");
    expect(stdout).not.toContain("done-1");
  });

  it("--all 把结束的也列出来，并显示中文状态", () => {
    writeTable([record({ id: "done-1", status: "done" })]);
    const { code, stdout } = run(["--all"]);
    expect(code).toBe(0);
    expect(stdout).toContain("做完了");
    expect(stdout).toContain("想找用户说句话");
  });

  it("坏表 fail-closed：exit 1、不猜内容", () => {
    const dir = join(root, "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intent-assistant.json"), "{ 这不是 json", "utf8");
    const { code, stdout } = run([]);
    expect(code).toBe(1);
    expect(stdout).toContain("读不出来");
    expect(stdout).not.toContain("想找用户说句话");
  });

  it("--json 形状稳定（path/exists/counts/shown）", () => {
    writeTable([record({ id: "itn-json", status: "blocked", blocked_by: "single_writer" })]);
    const { code, stdout } = run(["--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as {
      exists: boolean;
      counts: Record<string, number>;
      shown: Array<{ id: string; blockedBy: string | null }>;
    };
    expect(payload.exists).toBe(true);
    expect(payload.counts.blocked).toBe(1);
    expect(payload.shown[0]?.id).toBe("itn-json");
    expect(payload.shown[0]?.blockedBy).toBe("single_writer");
  });

  it("未知参数 exit 2（不静默忽略）", () => {
    const res = spawnSync(process.execPath, [CLI, "--nope"], { encoding: "utf8" });
    expect(res.status).toBe(2);
  });
});
