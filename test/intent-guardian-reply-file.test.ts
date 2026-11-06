/**
 * 监护人回执文件名（F269）。
 *
 * 背景：requestId 形如 `grd-cap-gap:knowledge/api-29890798`，带 `:` 和 `/`。
 * 在 Windows 上把这种字符串直接当文件名，写入会落进 NTFS 的"备用数据流"或直接失败——
 * 文件列表里只看到一个截断名，内容读不回来，于是她永远等不到回音（与 F254 的 dshAskId 同一类坑）。
 * 这组测试就是钉住"真实 requestId 也必须能写进去、读回来"。
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildGuardianRequest, guardianReplyFileName } from "../src/orchestrator/intent/guardian.js";
import { removeGuardianReply, readGuardianReplies, writeGuardianReply } from "../src/orchestrator/intent/persist.js";

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guardian-reply-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const help = {
  blockedIntentionId: "cap-gap:knowledge/api",
  what: "想查 B 站字幕",
  tried: ["试过直接 fetch"],
  need: "plugin" as const,
  ask: "能不能给我一个取字幕的办法",
};

const reply = (requestId: string) => ({
  requestId,
  at: new Date(NOW).toISOString(),
  from: "owner" as const,
  verdict: "help" as const,
  note: "我在，说吧",
});

describe("guardianReplyFileName", () => {
  it("文件名只含安全字符（不含冒号、斜杠、反斜杠、以及 Windows 保留字符）", () => {
    const name = guardianReplyFileName("grd-cap-gap:knowledge/api-29890798");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name.includes(":")).toBe(false);
    expect(name.includes("/")).toBe(false);
    expect(name.includes("\\")).toBe(false);
    for (const ch of '<>:"|?*') expect(name.includes(ch)).toBe(false);
  });

  it("确定性：同一 id 每次都得到同一文件名", () => {
    const id = "grd-cap-gap:knowledge/api-29890798";
    expect(guardianReplyFileName(id)).toBe(guardianReplyFileName(id));
  });

  it("只差标点的两个 id 不会落到同一个文件（有哈希防撞）", () => {
    const a = guardianReplyFileName("grd-a:b-123");
    const b = guardianReplyFileName("grd-a-b-123");
    expect(a).not.toBe(b);
  });

  it("空 id 当场抛（程序错误，不要静默生成怪文件名）", () => {
    expect(() => guardianReplyFileName("")).toThrow(RangeError);
    expect(() => guardianReplyFileName("   ")).toThrow(RangeError);
  });
});

describe("回执落盘与读取（真实 requestId）", () => {
  it("带冒号与斜杠的 requestId 能写进去、也能读回来并配对", () => {
    const request = buildGuardianRequest(help, new Date(NOW).toISOString(), NOW);
    expect(request.requestId).toContain(":");
    const path = writeGuardianReply(dir, reply(request.requestId));
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]+\.json$/)]);

    const read = readGuardianReplies(dir);
    expect(read.errors).toEqual([]);
    expect(read.replies.length).toBe(1);
    expect(read.replies[0]?.requestId).toBe(request.requestId);
    expect(path.endsWith(".json")).toBe(true);
  });

  it("删除回执按同一个命名规则（不会留下删不掉的文件）", () => {
    const request = buildGuardianRequest(help, new Date(NOW).toISOString(), NOW);
    writeGuardianReply(dir, reply(request.requestId));
    expect(readdirSync(dir).length).toBe(1);
    removeGuardianReply(dir, request.requestId);
    expect(readdirSync(dir)).toEqual([]);
  });
});
