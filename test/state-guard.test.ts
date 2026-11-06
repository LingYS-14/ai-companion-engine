import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideStateWrite,
  describeStateSaveOutcome,
  readStateUpdatedAt,
  type StateWriteInput,
} from "../src/memory/state-guard.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { SystemClock } from "../src/engine/clock.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-state-guard-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const input = (over: Partial<StateWriteInput>): StateWriteInput => ({
  currentUpdatedAt: null,
  lastSeenUpdatedAt: 1000,
  role: "primary",
  ...over,
});

describe("state-guard：谁该写（纯判断）", () => {
  it("文件不存在/读不出 → 写（第一次落盘，没什么可保护）", () => {
    expect(decideStateWrite(input({ currentUpdatedAt: null }))).toBe("write");
  });

  it("磁盘版本与上次看到的一致 → 写（没人动过，包括本进程自己刚写过的）", () => {
    expect(decideStateWrite(input({ currentUpdatedAt: 1000 }))).toBe("write");
    expect(decideStateWrite(input({ currentUpdatedAt: 1000, role: "secondary" }))).toBe("write");
  });

  it("有人动过：主写者继续写但警告；次要写者拒绝覆盖", () => {
    expect(decideStateWrite(input({ currentUpdatedAt: 2000, role: "primary" }))).toBe("write-with-warning");
    expect(decideStateWrite(input({ currentUpdatedAt: 2000, role: "secondary" }))).toBe("reject-stale");
  });

  it("readStateUpdatedAt：缺失/坏 JSON/坏字段都返回 null，不抛", () => {
    const dir = tempDir();
    const file = join(dir, "state-x.json");
    expect(readStateUpdatedAt(file)).toBeNull();
    writeFileSync(file, "{not json", "utf8");
    expect(readStateUpdatedAt(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, updatedAt: "x" }), "utf8");
    expect(readStateUpdatedAt(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 42 }), "utf8");
    expect(readStateUpdatedAt(file)).toBe(42);
  });

  it("describeStateSaveOutcome 三种情形说人话", () => {
    expect(describeStateSaveOutcome({ decision: "write", written: true, currentUpdatedAt: 1 }, "primary")).toContain("已落盘");
    expect(
      describeStateSaveOutcome({ decision: "write-with-warning", written: true, currentUpdatedAt: 1 }, "primary"),
    ).toContain("覆盖");
    expect(describeStateSaveOutcome({ decision: "reject-stale", written: false, currentUpdatedAt: 1 }, "secondary")).toContain(
      "拒绝覆盖",
    );
  });
});

const conf = (dataDir: string, over: Partial<SoulConfig> = {}): SoulConfig => ({
  characterId: "guard-test",
  dataDir,
  trace: false,
  ...over,
});

const statePathOf = (dataDir: string): string => join(dataDir, "state-guard-test.json");

/** 模拟"另一个进程"把状态文件推进了一秒 */
const bumpStateFile = (dataDir: string, by: number): number => {
  const path = statePathOf(dataDir);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { updatedAt: number };
  parsed.updatedAt += by;
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  return parsed.updatedAt;
};

describe("state-guard：接在 SoulRuntime.save 上（批次 2a）", () => {
  it("次要写者（插件）不会覆盖别的进程写过的版本，并留下拒绝计数", async () => {
    const dir = tempDir();
    const clock = new SystemClock();
    const rt = await SoulRuntime.open(conf(dir, { stateWriter: "secondary" }), clock);
    rt.flush(); // 第一次：文件不存在 → 写
    const before = readStateUpdatedAt(statePathOf(dir));
    expect(before).not.toBeNull();

    const bumped = bumpStateFile(dir, 1000); // 模拟 daemon 推进
    rt.flush(); // 磁盘版本更新了 → 拒绝
    expect(readStateUpdatedAt(statePathOf(dir))).toBe(bumped);
    expect(rt.stateWriteStats().rejections).toBe(1);
    expect(rt.stateWriteStats().lastDecision).toBe("reject-stale");
  });

  it("reloadState 之后同一进程可以继续写（拿到写锁的场景）", async () => {
    const dir = tempDir();
    const clock = new SystemClock();
    const rt = await SoulRuntime.open(conf(dir, { stateWriter: "secondary" }), clock);
    rt.flush();
    bumpStateFile(dir, 1000);
    rt.reloadState(); // 拿到写锁后重读：lastSeen 对齐磁盘
    rt.flush();
    expect(rt.stateWriteStats().rejections).toBe(0);
    expect(rt.stateWriteStats().lastDecision).toBe("write");
    const written = readStateUpdatedAt(statePathOf(dir));
    expect(written).toBe(rt.stateWriteStats().lastSeenUpdatedAt);
  });

  it("装配点角色没被写反（插件 secondary / daemon primary）", () => {
    const root = join(import.meta.dirname, "..");
    const plugin = readFileSync(join(root, "src", "plugin", "index.ts"), "utf8");
    const daemon = readFileSync(join(root, "scripts", "autonomy", "main.mjs"), "utf8");
    const runtimeSrc = readFileSync(join(root, "src", "plugin", "runtime.ts"), "utf8");
    expect(plugin).toContain('stateWriter: "secondary"');
    expect(daemon).toContain('stateWriter: "primary"');
    expect(runtimeSrc).toContain("decideStateWrite(");
    expect(plugin).toContain("runtime.reloadState()");
  });

  it("主写者（daemon）不会被别的进程写卡住：仍落盘，但记一次警告", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const clock = new SystemClock();
    const rt = await SoulRuntime.open(conf(dir, { stateWriter: "primary", stateLog: (l) => lines.push(l) }), clock);
    rt.flush();
    const bumped = bumpStateFile(dir, 1000);
    rt.flush();
    expect(rt.stateWriteStats().lastDecision).toBe("write-with-warning");
    expect(lines.join("\n")).toContain("overwrite-warning");
    // 主写者写成功了：文件里的 updatedAt 不再是"别人写的那个"
    expect(readStateUpdatedAt(statePathOf(dir))).not.toBe(bumped);
  });
});
