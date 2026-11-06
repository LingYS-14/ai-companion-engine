import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "tools", "audit", "check_execution.mjs");
const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-h2-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("执行层门禁 H2：边界", () => {
  it("真实执行层只依赖标准库与自身，门禁 PASS", () => {
    const out = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("H2 边界");
    expect(out.stdout).toContain("执行层门禁");
  });

  it("执行层越界 import 业务模块时 FAIL", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.ts"), 'import { x } from "../memory/store.js";\nexport const y = x;\n', "utf8");
    const out = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ACE_H2_DIR: dir },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("越界 import");
  });
});

describe("执行层门禁 H11：出站收口", () => {
  it("白名单之外的新文件引入发送函数时 FAIL", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "qq"), { recursive: true });
    writeFileSync(join(dir, "qq", "onebot.ts"), "export const sendPrivateText = 1;\n", "utf8");
    writeFileSync(join(dir, "evil.ts"), 'import { sendPrivateText } from "./qq/onebot.js";\nexport const x = sendPrivateText;\n', "utf8");
    const out = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ACE_H11_SRC: dir },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("出站函数");
  });

  it("真实仓库里出站函数只在白名单文件被引入", () => {
    const out = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
    expect(out.stdout).toContain("H11 出站收口");
  });
});

describe("执行层门禁 H12：队列恢复接线", () => {
  it("真实仓库 PASS：executor 用 claim/ack、常驻进程 open+drain", () => {
    const out = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("H12 队列恢复接线");
  });

  it("常驻进程没有 drainPending 时 FAIL", () => {
    const dir = tempDir();
    const daemon = join(dir, "main.mjs");
    writeFileSync(daemon, 'import { PendingQueue } from "../../dist/execution/queue.js";\nPendingQueue.open("x", 0);\n', "utf8");
    const out = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ACE_H12_DAEMON: daemon },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("drainPending");
  });

  it("把 drainQueue 交给装配层动作包装时 PASS（F301 形态）", () => {
    const dir = tempDir();
    const daemon = join(dir, "main.mjs");
    writeFileSync(
      daemon,
      [
        'import { PendingQueue } from "../../dist/execution/queue.js";',
        'PendingQueue.open("x", 0);',
        "drainPending({});",
        "const drainQueue = async () => {};",
        "const actions = wrapActions({ actions, refreshModel, tickHooks: { drainQueue }, now });",
        "",
      ].join("\n"),
      "utf8",
    );
    const out = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ACE_H12_DAEMON: daemon },
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("H12 队列恢复接线");
  });

  it("定义了 drainQueue 却没人调用时 FAIL（审计 B.4 的现场）", () => {
    const dir = tempDir();
    const daemon = join(dir, "main.mjs");
    writeFileSync(
      daemon,
      [
        'import { PendingQueue } from "../../dist/execution/queue.js";',
        'PendingQueue.open("x", 0);',
        "drainPending({});",
        "const drainQueue = async () => {};",
        "",
      ].join("\n"),
      "utf8",
    );
    const out = spawnSync(process.execPath, [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ACE_H12_DAEMON: daemon },
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("没人消费");
  });
});
