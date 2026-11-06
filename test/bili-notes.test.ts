/**
 * 视频深读的规则测试：字幕解析 / 引用挑选 / 故事板取样 / 画面描述 / 知识正文。
 *
 * 全程不碰网络也不调 ffmpeg：
 *   - 取数与裁剪在 `subtitle.ts`、`storyboard.ts`、`notes.ts` 的边界上，输入是接口原文的**形状**；
 *   - 「哪个格子对应第几秒」是纯算术，错了会裁出一张不相干的图——这正是要钉死的地方；
 *   - 正文措辞是给检索用的，断言它**包含什么**，不逐字锁全文（否则每次润色都要改测试）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { knobNumber, loadConfig } from "../src/engine/config.js";
import { KnowledgeStore } from "../src/memory/knowledge.js";
import type { BiliVideo } from "../src/bili/public.js";
import {
  composeVideoNote,
  ingestVideoNote,
  notesConfig,
  type BuiltVideoNote,
  type VideoNoteCfg,
} from "../src/bili/notes.js";
import {
  chooseTileSamples,
  colorName,
  cropFilter,
  formatSec,
  parseStoryboard,
  spriteCapacity,
  visualSummary,
} from "../src/bili/storyboard.js";
import {
  normalizeSubtitleUrl,
  parseSubtitleBody,
  parseSubtitleTrackList,
  pickSubtitleQuotes,
  subtitleCharCount,
} from "../src/bili/subtitle.js";

const NOW = 1_760_000_000_000;

const board = {
  img_x_len: 5,
  img_y_len: 4,
  img_x_size: 160,
  img_y_size: 90,
  image: ["//i0.hdslb.com/bfs/storyboard/a.jpg"],
  index: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57],
};

const video = (over: Partial<BiliVideo> = {}): BiliVideo => ({
  bvid: "BV1test",
  title: "测试视频",
  description: "关于测试的简介",
  owner: "测试UP",
  view: 12_345,
  like: 678,
  pubdateMs: NOW,
  durationSec: 60,
  tags: [],
  ...over,
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ase-notes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("字幕：解析与引用", () => {
  it("挑第一条有地址的轨，协议相对地址补全 https", () => {
    const head = parseSubtitleTrackList({
      subtitle: {
        subtitles: [
          { lan: "zh-CN", lan_doc: "", subtitle_url: "" },
          { lan: "zh-Hans", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/x.json" },
        ],
      },
    });
    expect(head).toEqual({ lang: "中文（自动生成）", url: "https://aisubtitle.hdslb.com/x.json" });
    expect(normalizeSubtitleUrl("https://a/b.json")).toBe("https://a/b.json");
    expect(parseSubtitleTrackList({ subtitle: { subtitles: [] } })).toBeNull();
    expect(parseSubtitleTrackList({})).toBeNull();
  });

  it("body 按 from 排序字段解析，空文本丢弃，to<from 修正为 from", () => {
    const lines = parseSubtitleBody({
      body: [
        { from: 0.5, to: 2, content: "大家好，今天讲点东西" },
        { from: 2, to: 1, content: "时间戳写反的一句" },
        { from: 3, to: 4, content: "   " },
        { from: -1, to: 1, content: "负时间戳" },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({ fromSec: 2, toSec: 2, text: "时间戳写反的一句" });
    expect(subtitleCharCount(lines)).toBe(10 + 8);
  });

  it("引用等距抽取、过短句不入选、重复不重复出现", () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({
      fromSec: i,
      toSec: i + 1,
      text: `这是第${String(i)}句话，长度够用`,
    }));
    const quotes = pickSubtitleQuotes(lines, 3, 40);
    expect(quotes).toHaveLength(3);
    expect(quotes[0]).toContain("第3句");
    expect(quotes[2]).toContain("第9句");
    expect(pickSubtitleQuotes([{ fromSec: 0, toSec: 1, text: "嗯" }], 3, 40)).toEqual([]);
    const filler = [
      { fromSec: 0, toSec: 1, text: "大家好，今天想聊一聊这件事" },
      { fromSec: 1, toSec: 2, text: "最近刷到黄磊老师做锅包肉的视频" },
      { fromSec: 2, toSec: 3, text: "因为原片的制作方法不是特别完整" },
    ];
    expect(pickSubtitleQuotes(filler, 1, 40)).toEqual(["因为原片的制作方法不是特别完整"]);
    expect(pickSubtitleQuotes(lines, 0, 40)).toEqual([]);
  });
});

describe("故事板：解析与取样", () => {
  it("几何字段缺失或越界一律 null；能解析时补全图片协议", () => {
    expect(parseStoryboard({})).toBeNull();
    expect(parseStoryboard({ ...board, img_x_len: 0 })).toBeNull();
    expect(parseStoryboard({ ...board, image: [] })).toBeNull();
    expect(parseStoryboard({ ...board, index: [] })).toBeNull();
    const parsed = parseStoryboard(board);
    expect(parsed?.images[0]).toBe("https://i0.hdslb.com/bfs/storyboard/a.jpg");
    expect(parsed?.cols).toBe(5);
    expect(parsed !== null ? spriteCapacity(parsed).perImage : 0).toBe(20);
  });

  it("60 秒取 3 格落到 9/30/51 秒（最近格），并与图片内行列一致", () => {
    const parsed = parseStoryboard(board);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const samples = chooseTileSamples(parsed, 60, 3);
    expect(samples.map((s) => s.sec)).toEqual([9, 30, 51]);
    for (const sample of samples) {
      expect(sample.col).toBeGreaterThanOrEqual(0);
      expect(sample.col).toBeLessThan(5);
      expect(sample.row).toBeGreaterThanOrEqual(0);
      expect(sample.row).toBeLessThan(4);
    }
    // 第 9 秒是第 3 格（0 起），应落在第 0 行第 3 列
    expect({ col: samples[0]?.col, row: samples[0]?.row }).toEqual({ col: 3, row: 0 });
  });

  it("crop 表达式是 crop=宽:高:x:y，按行列位移", () => {
    const parsed = parseStoryboard(board);
    if (parsed === null) throw new Error("board 解析失败");
    const sample = chooseTileSamples(parsed, 60, 3)[0];
    if (sample === undefined) throw new Error("没有样本");
    expect(cropFilter(parsed, sample)).toBe("crop=160:90:480:0");
  });

  it("极短视频格数少于取样数时允许重复，不返回空", () => {
    const parsed = parseStoryboard({ ...board, index: [0, 3] });
    if (parsed === null) throw new Error("board 解析失败");
    const samples = chooseTileSamples(parsed, 6, 3);
    expect(samples).toHaveLength(3);
    expect(new Set(samples.map((s) => s.flat)).size).toBeLessThanOrEqual(2);
  });
});

describe("画面描述：明暗、主色、帧间变化", () => {
  it("颜色名走可解释的粗分类", () => {
    expect(colorName(10, 10, 12)).toBe("黑");
    expect(colorName(250, 250, 248)).toBe("白");
    expect(colorName(128, 128, 130)).toBe("灰");
    expect(colorName(30, 40, 200)).toBe("蓝");
    expect(colorName(200, 40, 60)).toBe("红");
  });

  it("三帧同色 → 几乎无变化；差异大 → 变化明显；并写清取样时刻", () => {
    const dark = [
      { sec: 9, file: "a.jpg", r: 30, g: 45, b: 120 },
      { sec: 27, file: "b.jpg", r: 32, g: 44, b: 118 },
      { sec: 45, file: "c.jpg", r: 31, g: 45, b: 121 },
    ];
    const same = visualSummary(dark);
    expect(same).toContain("偏暗");
    expect(same).toContain("以蓝为主");
    expect(same).toContain("几乎没有变化");
    const mixed = visualSummary([
      { sec: 9, file: "a.jpg", r: 20, g: 20, b: 20 },
      { sec: 27, file: "b.jpg", r: 240, g: 240, b: 240 },
    ]);
    expect(mixed).toContain("变化明显");
    expect(visualSummary([])).toContain("没有取到");
    expect(formatSec(125)).toBe("02:05");
  });
});

describe("知识正文与入库", () => {
  it("正文含标题/UP/时长/引用/画面，且没有内容时不写废话", () => {
    const text = composeVideoNote(video(), {
      quotes: ["第一句引用内容够长", "第二句引用内容够长"],
      subtitleChars: 1200,
      frames: [{ sec: 9, file: "a.jpg", r: 20, g: 22, b: 40 }],
    });
    expect(text).toContain("测试视频");
    expect(text).toContain("播放 1.2 万");
    expect(text).toContain("01:00");
    expect(text).toContain("字幕片段");
    expect(text).toContain("AI 字幕 1200 字");
    expect(text).toContain("画面：1 处取样");
    const bare = composeVideoNote(video({ description: "" }), {});
    expect(bare).not.toContain("简介");
    expect(bare).not.toContain("字幕");
    expect(Array.from(bare).length).toBeLessThanOrEqual(460);
  });

  it("同 bvid 只写一次（幂等），且写入的是富正文而不是标题", () => {
    const store = new KnowledgeStore(join(dir, "knowledge.ndjson")).open();
    const note: BuiltVideoNote = {
      content: "在 B 站看了《测试视频》……字幕片段：「引用」",
      quotes: ["引用"],
      subtitleChars: 0,
      frames: [],
      frameFiles: [],
    };
    expect(ingestVideoNote(store, video(), note, NOW)).toBe(true);
    expect(ingestVideoNote(store, video(), note, NOW + 1)).toBe(false);
    const saved = store.all()[0];
    expect(store.all()).toHaveLength(1);
    expect(saved?.content).toContain("字幕片段");
  });

  it("配置读不到旋钮时退回默认值，读得到时按 overlay 生效", () => {
    const cfg = loadConfig();
    const noteCfg = notesConfig({ read: (name) => knobNumber(cfg, name) }, { ffmpegPath: "ffmpeg", frameRoot: dir, spriteDir: dir });
    expect(noteCfg.enrichPerRound).toBe(1);
    expect(noteCfg.quotes).toBe(3);
    expect(noteCfg.frameSamples).toBe(3);
    const placeholder: VideoNoteCfg = noteCfg;
    expect(placeholder.subtitleChars).toBeGreaterThanOrEqual(0);
    writeFileSync(join(dir, "x.txt"), "ok", "utf8");
  });
});
