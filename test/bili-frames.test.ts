/**
 * 取帧这条链路的「可诊断性」测试（F138）。
 *
 * 背景：她在常驻进程里连续十几轮 `frames=0`，而日志一个字都没有——拼图下载了 29 张、
 * 帧目录却是空的。根因可能有二（ffmpeg 不可执行 / 挑不出帧），而两条路径都**静默**。
 * 这里钉死三件事：
 *   1. `resolveFfmpegPath` 的优先级（显式 env → 用户 bin → PATH 兜底）；
 *   2. ffmpeg 不可用时，`buildVideoNote` 必须留下一行日志，而不是空目录；
 *   3. 拼图索引挑不出帧时，也要留下一行日志。
 *
 * 不碰网络：fetchFn 是假的；不真跑 ffmpeg：故意给一个不存在的可执行文件。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveFfmpegPath } from "../src/bili/ffmpeg.js";
import { buildVideoNote, type VideoNoteCfg } from "../src/bili/notes.js";
import type { BiliDeps, BiliVideo } from "../src/bili/public.js";

const NOW = 1_760_000_000_000;

const boardJson = {
  img_x_len: 5,
  img_y_len: 4,
  img_x_size: 160,
  img_y_size: 90,
  image: ["//i0.hdslb.com/bfs/storyboard/a.jpg"],
  index: [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30],
};

const emptyIndexBoardJson = { ...boardJson, index: [0, 0, 0, 0, 0] };

const video: BiliVideo = {
  bvid: "BV1frametest",
  title: "取帧测试",
  description: "为了验证静默失败不再静默",
  owner: "测试UP",
  view: 1,
  like: 1,
  pubdateMs: NOW,
  durationSec: 30,
};

function fakeFetch(storyboard: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/x/player/videoshot")) {
      return new Response(JSON.stringify({ code: 0, message: "0", data: storyboard }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("storyboard/a.jpg")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response(JSON.stringify({ code: -404, message: "no", data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-frames-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cfgOf = (ffmpegPath: string): VideoNoteCfg => ({
  quotes: 0,
  subtitleChars: 400,
  frameSamples: 3,
  enrichPerRound: 1,
  ffmpegPath,
  frameRoot: join(dir, "frames"),
  spriteDir: join(dir, "frames", ".sprites"),
});

const depsOf = (storyboard: unknown, lines: string[]): BiliDeps => ({
  fetchFn: fakeFetch(storyboard),
  now: () => NOW,
  log: (line) => lines.push(line),
});

describe("resolveFfmpegPath", () => {
  it("ACE_FFMPEG 显式指定时原样返回，不检查存在性", () => {
    const path = resolveFfmpegPath({
      env: { ACE_FFMPEG: "D:\\tools\\ffmpeg.exe", USERPROFILE: "C:\\Users\\user" },
      exists: () => false,
    });
    expect(path).toBe("D:\\tools\\ffmpeg.exe");
  });

  it("没指定时优先用 %USERPROFILE%\\bin\\ffmpeg.exe（存在才用）", () => {
    const path = resolveFfmpegPath({
      env: { USERPROFILE: "C:\\Users\\user", USERNAME: "user" },
      exists: (p) => p === "C:\\Users\\user\\bin\\ffmpeg.exe",
    });
    expect(path).toBe("C:\\Users\\user\\bin\\ffmpeg.exe");
  });

  it("没有 USERPROFILE 时用 C:\\Users\\<USERNAME> 兜底", () => {
    const path = resolveFfmpegPath({
      env: { USERNAME: "user" },
      exists: (p) => p === "C:\\Users\\user\\bin\\ffmpeg.exe",
    });
    expect(path).toBe("C:\\Users\\user\\bin\\ffmpeg.exe");
  });

  it("哪都找不到时退回 PATH 里的 ffmpeg", () => {
    expect(resolveFfmpegPath({ env: {}, exists: () => false })).toBe("ffmpeg");
  });
});

describe("buildVideoNote 的取帧诊断（F138）", () => {
  it("ffmpeg 不可执行时留下日志，而不是静默产出空目录", async () => {
    const lines: string[] = [];
    const note = await buildVideoNote(depsOf(boardJson, lines), video, cfgOf("definitely-not-ffmpeg-binary"));
    expect(note.frames).toHaveLength(0);
    expect(lines.some((l) => l.includes("一帧都裁不出来") && l.includes("definitely-not-ffmpeg-binary"))).toBe(true);
  });

  it("拼图索引全是 0（推不出时长、挑不出帧）时也留下日志", async () => {
    const lines: string[] = [];
    const note = await buildVideoNote(depsOf(emptyIndexBoardJson, lines), { ...video, durationSec: 0 }, cfgOf("ffmpeg"));
    expect(note.frames).toHaveLength(0);
    expect(lines.some((l) => l.includes("挑不出帧"))).toBe(true);
  });

  it("frameSamples=0 时完全不碰故事板接口（也不该报错）", async () => {
    const lines: string[] = [];
    const note = await buildVideoNote(depsOf(boardJson, lines), video, { ...cfgOf("ffmpeg"), frameSamples: 0 });
    expect(note.frames).toHaveLength(0);
    expect(lines.some((l) => l.includes("一帧都裁不出来"))).toBe(false);
    expect(lines.some((l) => l.includes("挑不出帧"))).toBe(false);
  });

  it("故事板接口没返回可用拼图时留下日志（这是最容易静默的一条）", async () => {
    const lines: string[] = [];
    const note = await buildVideoNote(depsOf({}, lines), video, cfgOf("ffmpeg"));
    expect(note.frames).toHaveLength(0);
    expect(lines.some((l) => l.includes("没有可用的故事板"))).toBe(true);
  });
});
