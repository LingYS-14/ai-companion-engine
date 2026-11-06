/**
 * §10.1 开放世界漏斗的纯逻辑测试（第 2 段预筛 + 第 5 段睡眠缓冲）。
 *
 * 钉住四件事：
 *   1. 新近/热度/互动/标题四项真的各自影响分数，且**可复现**（同输入同输出、tie 按 bvid 排）；
 *   2. 预筛的淘汰率按"去重后的候选"算，重复条目不算被筛掉（否则统计在骗人）；
 *   3. 缓冲**落盘**、跨实例能读回（她晚上会被重启，放内存就丢一晚）；
 *   4. 坏文件/坏条目只跳过不抛——凌晨巩固不能因为一个坏 JSON 停摆。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FUNNEL_RECENCY_HALF_LIFE_MS,
  OpenWorldBuffer,
  prefilterVideos,
  scoreVideo,
  type FunnelItem,
  type FunnelVideo,
} from "../src/learning/openworld.js";

const NOW = Date.UTC(2026, 9, 31, 2, 0, 0);
const HOUR = 3_600_000;

const video = (over: Partial<FunnelVideo> = {}): FunnelVideo => ({
  bvid: "BV1xx411c7mD",
  title: "一条普通标题，长度差不多二十四个字左右用来测分",
  play: 100_000,
  like: 5_000,
  pubdateMs: NOW - 6 * HOUR,
  durationSec: 180,
  ...over,
});

const dir = (): string => mkdtempSync(join(tmpdir(), "soul-openworld-"));

describe("第 2 段：廉价预筛打分", () => {
  it("越新分越高；半衰期正好一半", () => {
    const fresh = scoreVideo(video({ pubdateMs: NOW, play: 0, like: 0 }), NOW);
    const old = scoreVideo(video({ pubdateMs: NOW - FUNNEL_RECENCY_HALF_LIFE_MS, play: 0, like: 0 }), NOW);
    expect(fresh.parts.recency).toBeCloseTo(1, 6);
    expect(old.parts.recency).toBeCloseTo(0.5, 6);
    expect(fresh.score).toBeGreaterThan(old.score);
  });

  it("播放/点赞/标题各自影响分数", () => {
    const base = scoreVideo(video({ play: 0, like: 0 }), NOW);
    const hot = scoreVideo(video({ play: 900_000, like: 80_000 }), NOW);
    expect(hot.parts.popularity).toBeGreaterThan(base.parts.popularity);
    expect(hot.parts.engagement).toBeGreaterThan(0);
    // 标题离 24 字越远分越低
    const long = scoreVideo(video({ title: "标".repeat(70) }), NOW);
    expect(long.parts.title).toBeLessThan(base.parts.title);
  });

  it("缺 pubdate 时按中性 0.5 处理，不当成刚发布", () => {
    const missing = scoreVideo(video({ pubdateMs: undefined }), NOW);
    expect(missing.parts.recency).toBeCloseTo(0.5, 6);
  });

  it("同分的两条按 bvid 字典序稳定排序（可复现）", () => {
    const a = video({ bvid: "BV1aa", play: 1000, like: 10, pubdateMs: NOW, title: "短标题" });
    const b = video({ bvid: "BV1bb", play: 1000, like: 10, pubdateMs: NOW, title: "短标题" });
    const one = prefilterVideos([b, a], { nowMs: NOW, keep: 2 });
    const two = prefilterVideos([b, a], { nowMs: NOW, keep: 2 });
    expect(one.kept.map((k) => k.video.bvid)).toEqual(["BV1aa", "BV1bb"]);
    expect(two.kept.map((k) => k.video.bvid)).toEqual(one.kept.map((k) => k.video.bvid));
  });
});

describe("第 2 段：淘汰率与保留", () => {
  it("候选多时淘汰率 >90%（保留 3 条 / 40 条候选）", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      video({ bvid: `BV${String(i).padStart(3, "0")}`, play: i * 1000, pubdateMs: NOW - i * HOUR }),
    );
    const result = prefilterVideos(many, { nowMs: NOW, keep: 3 });
    expect(result.kept).toHaveLength(3);
    expect(result.dropRate).toBeGreaterThan(0.9);
  });

  it("重复 bvid 只算一条，且不计入「被筛掉」", () => {
    const dup = video({ bvid: "BV1dup" });
    const result = prefilterVideos([dup, dup, video({ bvid: "BV1two" })], { nowMs: NOW, keep: 2 });
    expect(result.examined).toBe(3);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toBe(0);
    expect(result.dropRate).toBe(0);
  });

  it("seen 里的 bvid 直接不进来（知识库已有了）", () => {
    const result = prefilterVideos([video({ bvid: "BV1seen" }), video({ bvid: "BV1new" })], {
      nowMs: NOW,
      keep: 3,
      seen: ["BV1seen"],
    });
    expect(result.kept.map((k) => k.video.bvid)).toEqual(["BV1new"]);
  });

  it("minScore 能进一步砍掉低分条目", () => {
    const stale = video({ bvid: "BV1old", play: 0, like: 0, pubdateMs: NOW - 60 * 86_400_000, title: "标".repeat(70) });
    const result = prefilterVideos([stale], { nowMs: NOW, keep: 3, minScore: 0.5 });
    expect(result.kept).toHaveLength(0);
  });

  it("空候选不崩，淘汰率给 0 而不是 NaN", () => {
    const result = prefilterVideos([], { nowMs: NOW });
    expect(result.kept).toEqual([]);
    expect(result.dropRate).toBe(0);
  });
});

describe("第 5 段：睡眠缓冲", () => {
  const item = (bvid: string, score: number, at: number): FunnelItem => ({ video: video({ bvid }), score, at });

  it("落盘后另一个实例能读回（进程重启不丢）", () => {
    const path = join(dir(), "openworld.json");
    const first = new OpenWorldBuffer({ path });
    expect(first.append([item("BV1a", 0.5, NOW), item("BV1b", 0.9, NOW)], NOW)).toBe(2);
    const second = new OpenWorldBuffer({ path });
    second.load();
    expect(second.size).toBe(2);
    expect(second.filePath).toBe(path);
  });

  it("drain 按进缓冲的先后取，取走的不再留在文件里", () => {
    const path = join(dir(), "openworld.json");
    const buf = new OpenWorldBuffer({ path });
    buf.append([item("BV1a", 0.5, NOW - 2 * HOUR), item("BV1b", 0.9, NOW - HOUR), item("BV1c", 0.7, NOW)], NOW);
    const out = buf.drain(NOW, 2);
    expect(out.map((x) => x.video.bvid)).toEqual(["BV1a", "BV1b"]); // 最老的两条先消化
    expect(buf.size).toBe(1);
    const reread = new OpenWorldBuffer({ path });
    reread.load();
    expect(reread.size).toBe(1);
  });

  it("超过 TTL 的候选不会被 drain 出来（热点过期了）", () => {
    const path = join(dir(), "openworld.json");
    const buf = new OpenWorldBuffer({ path, ttlMs: HOUR });
    buf.append([item("BV1old", 0.9, NOW - 5 * HOUR)], NOW - 5 * HOUR);
    expect(buf.drain(NOW, 5)).toEqual([]);
    expect(buf.stats().droppedExpired).toBeGreaterThan(0);
  });

  it("超过容量的缓冲丢最老的（不是最新的）", () => {
    const path = join(dir(), "openworld.json");
    const buf = new OpenWorldBuffer({ path, capacity: 2 });
    buf.append([item("BV1a", 0.5, NOW - 3 * HOUR), item("BV1b", 0.9, NOW - 2 * HOUR), item("BV1c", 0.7, NOW - HOUR)], NOW);
    expect(buf.size).toBe(2);
    const out = buf.drain(NOW, 5);
    expect(out.map((x) => x.video.bvid)).toEqual(["BV1b", "BV1c"]);
    expect(buf.stats().droppedOverflow).toBe(1);
  });

  it("同一个 bvid 只留分高的一份", () => {
    const path = join(dir(), "openworld.json");
    const buf = new OpenWorldBuffer({ path });
    buf.append([item("BV1a", 0.2, NOW - HOUR)], NOW);
    buf.append([item("BV1a", 0.8, NOW)], NOW);
    expect(buf.size).toBe(1);
    expect(buf.drain(NOW, 5)[0]?.score).toBe(0.8);
  });

  it("坏 JSON 给空缓冲，不抛", () => {
    const path = join(dir(), "openworld.json");
    writeFileSync(path, "{ 这不是 json", "utf8");
    const buf = new OpenWorldBuffer({ path });
    expect(() => buf.load()).not.toThrow();
    expect(buf.size).toBe(0);
  });

  it("坏条目跳过、好条目照读", () => {
    const path = join(dir(), "openworld.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, items: [item("BV1ok", 0.5, NOW), { video: { bvid: 42 }, score: "x" }] }),
      "utf8",
    );
    const buf = new OpenWorldBuffer({ path });
    buf.load();
    expect(buf.size).toBe(1);
  });

  it("目录不存在时自动建（第一晚跑就会出现）", () => {
    const path = join(dir(), "deep", "nested", "openworld.json");
    const buf = new OpenWorldBuffer({ path });
    buf.append([item("BV1a", 0.5, NOW)], NOW);
    expect(JSON.parse(readFileSync(path, "utf8"))["items"]).toHaveLength(1);
  });

  it("写入是原子的：目录里不残留 .tmp-* 文件", () => {
    const base = dir();
    const path = join(base, "openworld.json");
    const buf = new OpenWorldBuffer({ path });
    buf.append([item("BV1a", 0.5, NOW)], NOW);
    const leftovers = readdirSync(base).filter((name: string) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});
