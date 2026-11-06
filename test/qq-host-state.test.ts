/**
 * 批次1A：QQ 状态文件的往返（`loadQQState` / `saveQQState`）。
 *
 * 为什么单独测：主动开口的记账 `proactiveAt` / `lastProactiveAt` 一直存在状态类型里、
 * `saveQQState` 也会写全量，但 `loadQQState` 没读回来——进程一重启就清零，
 * 于是日志里 84 条主动开口、状态里只有 1 条（P0-F 的根因）。
 *
 * 这里锁三件事：往返不丢字段；旧存档（没有这两个字段）照常读；脏值不会污染计数。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadQQState, saveQQState } from "../src/qq/host.js";
import { emptyQQState } from "../src/qq/types.js";

const NOW = 1_700_000_000_000;
const CHAR = "chara-1";

const dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qq-state-"));
  dirs.push(dir);
  return dir;
}

/** 直接落一份存档 JSON（模拟旧版本写出来的文件） */
function writeRaw(dir: string, raw: unknown): void {
  writeFileSync(join(dir, `qq-${CHAR}.json`), JSON.stringify(raw), "utf8");
}

describe("loadQQState / saveQQState", () => {
  it("往返保留 proactiveAt / lastProactiveAt（主动开口的记账不再清零）", () => {
    const dir = dataDir();
    saveQQState(dir, CHAR, {
      ...emptyQQState(),
      cursorEpochNs: 42,
      repliedIds: ["ob-1"],
      replyTimes: [NOW - 1_000],
      lastReplyAt: NOW - 2_000,
      proactiveAt: [NOW - 10_000, NOW - 5_000],
      lastProactiveAt: NOW,
    });

    const loaded = loadQQState(dir, CHAR);
    expect(loaded.proactiveAt).toEqual([NOW - 10_000, NOW - 5_000]);
    expect(loaded.lastProactiveAt).toBe(NOW);
    // 旧字段不能因为这次改动丢掉
    expect(loaded.cursorEpochNs).toBe(42);
    expect(loaded.repliedIds).toEqual(["ob-1"]);
    expect(loaded.replyTimes).toEqual([NOW - 1_000]);
    expect(loaded.lastReplyAt).toBe(NOW - 2_000);
  });

  it("旧存档（没有这两个字段）照常读：proactiveAt 按空数组、lastProactiveAt 按 null", () => {
    const dir = dataDir();
    writeRaw(dir, { version: 1, cursorEpochNs: 7, repliedIds: ["ob-2"], replyTimes: [], lastReplyAt: null });

    const loaded = loadQQState(dir, CHAR);
    expect(loaded.proactiveAt).toEqual([]);
    expect(loaded.lastProactiveAt ?? null).toBeNull();
    expect(loaded.cursorEpochNs).toBe(7);
    expect(loaded.repliedIds).toEqual(["ob-2"]);
  });

  it("脏值被过滤：只有 number 进数组，坏的单值读成 null", () => {
    const dir = dataDir();
    writeRaw(dir, {
      version: 1,
      cursorEpochNs: 0,
      repliedIds: [],
      replyTimes: [],
      lastReplyAt: null,
      proactiveAt: [NOW, "坏值", null, NOW + 1],
      lastProactiveAt: "不是数字",
    });

    const loaded = loadQQState(dir, CHAR);
    expect(loaded.proactiveAt).toEqual([NOW, NOW + 1]);
    expect(loaded.lastProactiveAt ?? null).toBeNull();
  });

  it("文件不存在时返回空状态（proactiveAt 按空数组读）", () => {
    const dir = dataDir();
    const loaded = loadQQState(dir, "没这只角色");
    expect(loaded.proactiveAt ?? []).toEqual([]);
    expect(loaded.lastProactiveAt ?? null).toBeNull();
    expect(loaded.cursorEpochNs).toBe(0);
  });
});

// 不把临时目录留在系统 temp 里：一个用例一份，测试结束统一删。
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果
    }
  }
});
