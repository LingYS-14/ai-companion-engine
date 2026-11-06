import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdWriterLock, rememberReplyThrough, startAutonomyQq } from "../src/autonomy/qq-runner.js";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-qqrunner-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("常驻进程侧的 QQ 接待", () => {
  it("没有模型凭据时不启动接待（不静默乱回）", () => {
    const lines: string[] = [];
    const handle = startAutonomyQq({
      runtime: {} as never,
      llm: null,
      dataDir: tempDir(),
      characterId: "assistant",
      repoRoot: process.cwd(),
      onebot: {
        baseUrl: "http://127.0.0.1:3000",
        wsUrl: "ws://127.0.0.1:3001",
        token: "t",
        wsToken: "t",
        peer: 10000001,
        dryRun: true,
      },
      quietFrom: 23,
      quietTo: 7,
      minGapMs: 60_000,
      maxPerHour: 6,
      now: () => 1000,
      localHour: () => 12,
      log: (line) => lines.push(line),
    });
    expect(handle).toBeNull();
    expect(lines.join("\n")).toContain("没有模型凭据");
  });

  it("写锁：本进程持有后同一路径可续心跳，stop 后不再更新", () => {
    const dir = tempDir();
    const path = join(dir, ".writer-lock");
    let now = 1000;
    const holder = holdWriterLock({
      path,
      pid: process.pid,
      owner: "autonomy",
      now: () => now,
      note: "test",
      heartbeatMs: 10_000,
    });
    expect(holder.lock?.owner).toBe("autonomy");
    expect(existsSync(path)).toBe(true);
    const first = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as { heartbeatAt: number };
    now = 20_000;
    // 同 pid 的再次 acquire 会续写心跳
    const again = holdWriterLock({ path, pid: process.pid, owner: "autonomy", now: () => now, note: "t2" });
    const second = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as { heartbeatAt: number };
    expect(second.heartbeatAt).toBe(20_000);
    expect(second.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
    again.stop();
    holder.stop();
  });
});

// ---------- P0-F：回信记忆种子（daemon 侧唯一写者） ----------

type RememberFn = Parameters<typeof rememberReplyThrough>[0]["remember"];

function fakeRuntime(remember: RememberFn): Parameters<typeof rememberReplyThrough>[0] {
  return { remember };
}

describe("F350 I2：主动开口不再从 proactive 记忆补位（案 A，源码锁）", () => {
  const source = readFileSync(new URL("../src/autonomy/qq-runner.ts", import.meta.url), "utf8");
  const start = source.indexOf("recallForProactive:");
  const block = source.slice(start, start + 400);

  it("recallForProactive 只传 excludeSources，不再带 backfillSources/maxBackfill", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain("excludeSources: SELF_AUTHORED_SOURCES");
    expect(block).not.toContain("backfillSources");
    expect(block).not.toContain("maxBackfill");
    // 整个文件也不应残留这两个键（I2 只改主动路径，回信路径本来就没配）
    expect(source).not.toContain("backfillSources");
    expect(source).not.toContain("maxBackfill");
  });

  it("I2 只改调用侧：recall 内核的 NEVER_BACKFILL 语义原样保留（案 A 不碰内核）", () => {
    const recall = readFileSync(new URL("../src/dialogue/recall.ts", import.meta.url), "utf8");
    expect(recall).toContain("NEVER_BACKFILL");
    expect(recall).toContain("SELFTALK_SOURCE");
    expect(recall).toContain("CHAT_REPLY_SOURCE");
  });
});

describe("P0-F rememberReplyThrough", () => {
  it("成功：写一条 chat_reply/outbound，tags 带通道，日志说写了哪条", () => {
    const remember = vi.fn(() => ({ stored: true, reason: "", id: "m1" }));
    const lines: string[] = [];
    rememberReplyThrough(fakeRuntime(remember as unknown as RememberFn), (line) => lines.push(line))("好呀♪");

    expect(remember).toHaveBeenCalledTimes(1);
    const seed = remember.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(seed["content"]).toBe("我说：「好呀♪」");
    expect(seed["source"]).toBe("chat_reply");
    expect(seed["direction"]).toBe("outbound");
    expect(seed["tags"]).toEqual(["chat", "qq"]);
    expect(lines.join("\n")).toContain("已写 m1");
  });

  it("大脑侧正常拒写（stored:false）：只记 reason，不算错误", () => {
    const remember = vi.fn(() => ({ stored: false, reason: "duplicate", id: null }));
    const lines: string[] = [];
    rememberReplyThrough(fakeRuntime(remember as unknown as RememberFn), (line) => lines.push(line))("再说一次");
    expect(lines.join("\n")).toContain("未写（duplicate）");
  });

  it("remember 抛错：不冒泡，日志强调不影响已发出的消息", () => {
    const remember = vi.fn(() => {
      throw new Error("disk full");
    });
    const lines: string[] = [];
    expect(() =>
      rememberReplyThrough(fakeRuntime(remember as unknown as RememberFn), (line) => lines.push(line))("好呀♪"),
    ).not.toThrow();
    expect(lines.join("\n")).toContain("不影响已发出的消息");
    expect(lines.join("\n")).toContain("disk full");
  });
});
