import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatLog } from "../src/autonomy/chat-log.js";
import type { ChatHistoryEntry } from "../src/ports/chat-history.js";

/**
 * P2（task-139）：共享对话流水。
 *
 * 这个文件是 QQ 与网页唯一的共同历史面——两边都 append、组提示词都 recent。
 * 所以测试只锁三件真会坏事的事：坏行不能把启动打挂、内存只留尾部、
 * 轮转只在启动时做且保留最新 1000 行（运行中不轮转，避免把正在写的行截断）。
 */

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-log-"));
  dirs.push(dir);
  return dir;
}

function entry(atMs: number, who: "peer" | "her" = "peer", text = "hi"): ChatHistoryEntry {
  return { atMs, who, text, channel: who === "her" ? "web" : "qq" };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("P2：ChatLog 共享历史", () => {
  it("空目录打开：0 条、recent 空、路径是 chat-<id>.ndjson", () => {
    const dir = tempDir();
    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    expect(log.count).toBe(0);
    expect(log.recent(10)).toEqual([]);
    expect(log.pathname).toBe(join(dir, "chat-test.ndjson"));
  });

  it("append 后 recent 按时间顺序返回；重开能读回（跨进程共享的根据）", () => {
    const dir = tempDir();
    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    log.append(entry(NOW, "peer", "在吗"));
    log.append(entry(NOW + 1, "her", "在呢♪"));

    expect(log.count).toBe(2);
    expect(log.recent(10).map((e) => e.text)).toEqual(["在吗", "在呢♪"]);

    const reopened = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW + 2 });
    expect(reopened.count).toBe(2);
    expect(reopened.recent(10).map((e) => [e.who, e.text, e.channel])).toEqual([
      ["peer", "在吗", "qq"],
      ["her", "在呢♪", "web"],
    ]);
  });

  it("坏行跳过：启动不被一条脏数据打挂，坏行计数只写日志", () => {
    const dir = tempDir();
    const file = join(dir, "chat-test.ndjson");
    appendFileSync(file, '{"atMs":1,"who":"peer","text":"好的","channel":"qq"}\n');
    appendFileSync(file, "{不是 json\n");
    appendFileSync(file, '{"atMs":2,"who":"alien","text":"??","channel":"qq"}\n');
    appendFileSync(file, '{"atMs":3,"who":"her","text":"收到♪","channel":"web"}\n');

    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    // count 是磁盘行数（坏行也算——轮转按物理行数算），recent 只给能解析的。
    expect(log.count).toBe(4);
    expect(log.recent(10).map((e) => e.text)).toEqual(["好的", "收到♪"]);
  });

  it("内存只留尾部 200 条，但磁盘保留全部（recent 不越界）", () => {
    const dir = tempDir();
    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    for (let i = 0; i < 230; i += 1) log.append(entry(i, i % 2 === 0 ? "peer" : "her", `m${i}`));

    expect(log.count).toBe(230);
    expect(log.recent(1000).length).toBe(200);
    expect(log.recent(1000)[0]?.text).toBe("m30");
    expect(log.recent(0)).toEqual([]);

    const lines = readFileSync(join(dir, "chat-test.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBe(230);
  });

  it("启动时超过 5000 行才轮转：保留最后 1000 行，原子重写", () => {
    const dir = tempDir();
    const file = join(dir, "chat-test.ndjson");
    const lines: string[] = [];
    for (let i = 0; i < 5001; i += 1) {
      lines.push(JSON.stringify(entry(i, "peer", `m${i}`)));
    }
    appendFileSync(file, `${lines.join("\n")}\n`);

    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    expect(log.count).toBe(1000);
    expect(log.recent(1)[0]?.text).toBe("m5000");

    const after = readFileSync(file, "utf8").trim().split("\n");
    expect(after.length).toBe(1000);
    expect(JSON.parse(after[0] ?? "{}")).toMatchObject({ text: "m4001" });
  });

  it("append 校验形状：非法 who/channel/atMs 抛错，不写坏行", () => {
    const dir = tempDir();
    const log = ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
    expect(() => log.append({ atMs: NOW, who: "alien" as unknown as "peer", text: "x", channel: "qq" })).toThrow(
      RangeError,
    );
    expect(() => log.append({ atMs: NOW, who: "peer", text: "x", channel: "sms" as unknown as "qq" })).toThrow(
      RangeError,
    );
    expect(() => log.append({ atMs: Number.NaN, who: "peer", text: "x", channel: "qq" })).toThrow(RangeError);
    expect(log.count).toBe(0);
  });
});

describe("B1（task-148）：启动期 TDZ 回归", () => {
  it("main.mjs：logPath 在 ChatLog.open 之前声明（否则坏行/轮转会 ReferenceError）", () => {
    const source = readFileSync(new URL("../scripts/autonomy/main.mjs", import.meta.url), "utf8");
    const logPathAt = source.indexOf("const logPath = join(");
    const openAt = source.indexOf("const chatLog = ChatLog.open(");
    expect(logPathAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(logPathAt).toBeLessThan(openAt);
  });

  it("启动遇到坏行 + 超 5000 行轮转：只调用注入 log，open 不抛", () => {
    const dir = tempDir();
    const lines: string[] = ["{坏行", "not json"];
    for (let i = 0; i < 5_005; i += 1) {
      lines.push(JSON.stringify(entry(NOW + i, i % 2 === 0 ? "peer" : "her", `m${i}`)));
    }
    writeFileSync(join(dir, "chat-test.ndjson"), `${lines.join("\n")}\n`, "utf8");

    const logs: string[] = [];
    const log = ChatLog.open({
      dataDir: dir,
      characterId: "test",
      now: () => NOW,
      log: (line) => logs.push(line),
    });

    expect(log.count).toBe(1_000);
    expect(log.recent(200)).toHaveLength(200);
    const joined = logs.join("\n");
    expect(joined).toContain("跳过 2 条坏行");
    expect(joined).toContain("轮转：5007 → 1000 行");
  });
});
