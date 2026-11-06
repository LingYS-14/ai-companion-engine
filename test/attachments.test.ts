/**
 * 「她手上真有哪张画面可以发」——从取帧目录里挑一张。
 *
 * 为什么这条要单独测：F102 的教训是"说了要给图却拿不出图"。
 * 素材来源只有一处（她真看视频裁下来的帧），所以这个挑选函数必须：
 * 拿不到就老实返回 null（只发文字），不能返回一个过期/残缺/不存在的路径。
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pickShareableImage } from "../src/qq/attachments.js";

const NOW = Date.parse("2026-10-31T00:45:00+08:00");
const HOUR = 3_600_000;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ase-attach-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一帧：目录名= bvid，文件名 f1.jpg，大小/时间可控 */
function frame(bvid: string, name: string, bytes: number, ageMs: number): string {
  const dir = join(root, bvid);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  const at = (NOW - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
}

describe("pickShareableImage", () => {
  it("取最近 24 小时内最新的一张", () => {
    frame("BV1old", "f1.jpg", 12_000, 3 * HOUR);
    const newest = frame("BV1new", "f1.jpg", 12_000, HOUR);
    const picked = pickShareableImage({ root, nowMs: NOW });
    expect(picked?.path).toBe(newest);
    expect(picked?.bvid).toBe("BV1new");
  });

  it("超过 24 小时的不要（她已经想不起是哪个视频了）", () => {
    frame("BV1stale", "f1.jpg", 12_000, 30 * HOUR);
    expect(pickShareableImage({ root, nowMs: NOW })).toBeNull();
  });

  it("太小的文件当裁残了，不要", () => {
    frame("BV1tiny", "f1.jpg", 100, HOUR);
    expect(pickShareableImage({ root, nowMs: NOW })).toBeNull();
  });

  it("跳过拼图缓存目录（.sprites 不是她取的帧）", () => {
    mkdirSync(join(root, ".sprites"), { recursive: true });
    writeFileSync(join(root, ".sprites", "f1.jpg"), Buffer.alloc(12_000, 1));
    expect(pickShareableImage({ root, nowMs: NOW })).toBeNull();
  });

  it("只认 f*.jpg；别把日志或说明文件当画面", () => {
    frame("BV1ok", "f2.jpg", 12_000, HOUR);
    frame("BV1ok", "notes.txt", 12_000, HOUR);
    expect(pickShareableImage({ root, nowMs: NOW })?.path.endsWith("f2.jpg")).toBe(true);
  });

  it("目录不存在返回 null（不能抛）", () => {
    expect(pickShareableImage({ root: join(root, "nope"), nowMs: NOW })).toBeNull();
  });

  it("空目录返回 null", () => {
    expect(pickShareableImage({ root, nowMs: NOW })).toBeNull();
  });
});
