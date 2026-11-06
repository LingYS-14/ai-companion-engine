/**
 * 把「一条 B 站视频」变成她真正能引用的知识：字幕说了什么 + 画面大致什么样。
 *
 * 三层职责分明：
 *   - `subtitle.ts` 取字幕、`storyboard.ts` 取拼图并算格子坐标（纯取数/纯计算）；
 *   - 本文件负责**碰 ffmpeg 与磁盘**（裁格子、取平均色、存帧图），再组织成一段话；
 *   - 写进知识库沿用 `ingest.ts` 的记录形状与 `bili:<bvid>` 幂等 id。
 *
 * 为什么画面只写「明暗 + 主色 + 帧间变化」：这是**没有视觉模型时唯一诚实的描述**。
 * 编「画面里有个女孩在跑」很动听，但那是猜的；而「3 处取样、偏暗、以蓝紫为主、帧间变化明显」
 * 每个字都能用 ffmpeg 复算，将来接入视觉模型时也只需要在这一层加描述，不动上层。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KnowledgeRecord, KnowledgeWritePort, KnobReader } from "../ports/index.js";
import { DEFAULT_BILI_INGEST, formatBiliCount, truncateDescription } from "./ingest.js";
import { fetchVideoMeta, type BiliDeps, type BiliVideo } from "./public.js";
import {
  chooseTileSamples,
  cropFilter,
  downloadSprite,
  fetchStoryboard,
  formatSec,
  visualSummary,
  type FrameColor,
  type StoryboardSprite,
  type TileSample,
} from "./storyboard.js";
import { fetchSubtitleTrack, pickSubtitleQuotes, subtitleCharCount } from "./subtitle.js";

/** 一条知识最多多少字：太长会被检索当噪声，太短又装不下引用 */
export const NOTE_MAX_CHARS = 460;
/** 单句引用最多多少字 */
export const NOTE_QUOTE_MAX_CHARS = 48;

export interface VideoNoteCfg {
  /** 引用几句字幕 */
  readonly quotes: number;
  /** 字幕全文超过这个字数才写「字幕 N 字」（它本身是可信度信号） */
  readonly subtitleChars: number;
  /** 取几帧 */
  readonly frameSamples: number;
  /** 每轮学习最多深读几条（0 = 只存标题简介，与旧行为一致） */
  readonly enrichPerRound: number;
  /** ffmpeg 可执行文件（缺省用 PATH 里的 ffmpeg） */
  readonly ffmpegPath: string;
  /** 帧图落盘目录（按 bvid 分子目录） */
  readonly frameRoot: string;
  /** 拼图缓存目录 */
  readonly spriteDir: string;
}

export const DEFAULT_VIDEO_NOTE_CFG: Omit<VideoNoteCfg, "frameRoot" | "spriteDir"> = {
  quotes: 3,
  subtitleChars: 400,
  frameSamples: 3,
  enrichPerRound: 1,
  ffmpegPath: "ffmpeg",
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从 engine 配置读三个学习深度旋钮，读不到就退回默认值。
 *
 * 为什么 try/catch：`knobs.read` 遇到缺失键会抛（fail-closed 是注册表检查的意图），
 * 但这里在**运行期**，一条视频因为没有旋钮就不学，代价远大于用默认值继续。
 *
 * `knobs` 由装配点注入（见 `src/ports/index.ts` 的 `KnobReader`）：工具层不 import
 * `engine/config.js`，那条依赖被端口挡住了。
 */
export function notesConfig(
  knobs: KnobReader,
  paths: { readonly ffmpegPath: string; readonly frameRoot: string; readonly spriteDir: string },
): VideoNoteCfg {
  const read = (name: string, fallback: number): number => {
    try {
      return knobs.read(name);
    } catch {
      return fallback;
    }
  };
  return {
    quotes: clampInt(read("LEARN_VIDEO_QUOTES", DEFAULT_VIDEO_NOTE_CFG.quotes), 1, 5, DEFAULT_VIDEO_NOTE_CFG.quotes),
    subtitleChars: clampInt(
      read("LEARN_SUBTITLE_CHARS", DEFAULT_VIDEO_NOTE_CFG.subtitleChars),
      0,
      4000,
      DEFAULT_VIDEO_NOTE_CFG.subtitleChars,
    ),
    frameSamples: clampInt(
      read("LEARN_FRAME_SAMPLES", DEFAULT_VIDEO_NOTE_CFG.frameSamples),
      0,
      5,
      DEFAULT_VIDEO_NOTE_CFG.frameSamples,
    ),
    enrichPerRound: clampInt(
      read("LEARN_ENRICH_PER_ROUND", DEFAULT_VIDEO_NOTE_CFG.enrichPerRound),
      0,
      2,
      DEFAULT_VIDEO_NOTE_CFG.enrichPerRound,
    ),
    ffmpegPath: paths.ffmpegPath,
    frameRoot: paths.frameRoot,
    spriteDir: paths.spriteDir,
  };
}

/** 组织成一段可入库的话；`parts` 缺失的部分直接不出现（不写「无字幕」这种废话） */
export function composeVideoNote(
  video: BiliVideo,
  parts: {
    readonly quotes?: readonly string[];
    readonly subtitleChars?: number;
    readonly frames?: readonly FrameColor[];
  },
): string {
  const head =
    `在 B 站看了《${video.title}》（${video.owner}，播放 ${formatBiliCount(video.view)}，` +
    `时长 ${formatSec(video.durationSec)}）`;
  const pieces: string[] = [head];
  const desc = video.description.trim();
  if (desc !== "") pieces.push(`简介：${truncateDescription(desc, 60)}`);
  const quotes = parts.quotes ?? [];
  if (quotes.length > 0) {
    pieces.push(`字幕片段：「${quotes.join("」「")}」`);
    const chars = parts.subtitleChars ?? 0;
    if (chars > 0) pieces.push(`（AI 字幕 ${String(chars)} 字）`);
  }
  const frames = parts.frames ?? [];
  if (frames.length > 0) pieces.push(visualSummary(frames));
  const text = pieces.join("。").replaceAll(/。+/gu, "。");
  const chars = Array.from(text);
  return chars.length <= NOTE_MAX_CHARS ? text : `${chars.slice(0, NOTE_MAX_CHARS).join("")}…`;
}

function runFfmpeg(ffmpegPath: string, args: readonly string[], timeoutMs = 20_000): Buffer | null {
  const result = spawnSync(ffmpegPath, [...args], { timeout: timeoutMs, windowsHide: true });
  if (result.error !== undefined || result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

/** 裁一格出来；成功返回 true */
export function cropTile(
  ffmpegPath: string,
  spritePath: string,
  board: StoryboardSprite,
  sample: TileSample,
  outPath: string,
): boolean {
  const filter = cropFilter(board, sample);
  const out = runFfmpeg(ffmpegPath, ["-v", "error", "-y", "-i", spritePath, "-vf", filter, "-frames:v", "1", outPath]);
  return out !== null && existsSync(outPath);
}

/** 平均色：缩到 1×1 再读 3 个字节——比解全图快两个数量级 */
export function averageColor(ffmpegPath: string, imagePath: string): { r: number; g: number; b: number } | null {
  const raw = runFfmpeg(ffmpegPath, [
    "-v", "error", "-i", imagePath, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  if (raw === null || raw.length < 3) return null;
  return { r: raw[0] ?? 0, g: raw[1] ?? 0, b: raw[2] ?? 0 };
}

export interface BuiltVideoNote {
  readonly content: string;
  readonly quotes: readonly string[];
  readonly subtitleChars: number;
  readonly frames: readonly FrameColor[];
  readonly frameFiles: readonly string[];
}

/**
 * 取一条视频的字幕与画面，组织成知识正文。
 *
 * 降级顺序（每一层失败都不影响后面）：字幕 → 画面。两者都失败时仍返回「标题 + 简介」的
 * 基础正文，保证「学过这条」这件事本身不会丢。
 */
export async function buildVideoNote(
  deps: BiliDeps,
  video: BiliVideo,
  cfg: VideoNoteCfg,
): Promise<BuiltVideoNote> {
  let quotes: readonly string[] = [];
  let subtitleChars = 0;
  try {
    let cid: number | undefined;
    try {
      const meta = await fetchVideoMeta(deps, video.bvid);
      cid = meta?.cid;
    } catch {
      cid = undefined;
    }
    const track = await fetchSubtitleTrack(deps, video.bvid, cid);
    if (track !== null) {
      quotes = pickSubtitleQuotes(track.lines, cfg.quotes, NOTE_QUOTE_MAX_CHARS);
      const total = subtitleCharCount(track.lines);
      if (total >= cfg.subtitleChars) subtitleChars = total;
    }
  } catch (err) {
    deps.log?.(`[note] ${video.bvid} 字幕取不到：${err instanceof Error ? err.message : String(err)}`);
  }

  const frames: FrameColor[] = [];
  const frameFiles: string[] = [];
  if (cfg.frameSamples > 0) {
    try {
      const board = await fetchStoryboard(deps, video.bvid);
      if (board === null) {
        deps.log?.(`[note] ${video.bvid} 没有可用的故事板（videoshot 没返回可用拼图：可能该视频无故事板，或被风控/限流）`);
      }
      if (board !== null) {
        const samples = chooseTileSamples(board, video.durationSec, cfg.frameSamples);
        if (samples.length === 0) {
          deps.log?.(
            `[note] ${video.bvid} 拼图有 ${String(board.index.length)} 个索引但挑不出帧（durationSec=${String(video.durationSec)}，frameSamples=${String(cfg.frameSamples)}）`,
          );
        }
        const dir = join(cfg.frameRoot, video.bvid);
        mkdirSync(dir, { recursive: true });
        let cropped = 0;
        const cached = new Map<number, string>();
        for (const [i, sample] of samples.entries()) {
          let spritePath = cached.get(sample.imageIndex);
          if (spritePath === undefined) {
            const url = board.images[sample.imageIndex];
            if (url === undefined) continue;
            mkdirSync(cfg.spriteDir, { recursive: true });
            const bytes = await downloadSprite(deps, url);
            spritePath = join(cfg.spriteDir, `${video.bvid}-${String(sample.imageIndex)}.jpg`);
            writeFileSync(spritePath, bytes);
            cached.set(sample.imageIndex, spritePath);
          }
          const framePath = join(dir, `f${String(i)}.jpg`);
          if (!cropTile(cfg.ffmpegPath, spritePath, board, sample, framePath)) continue;
          const color = averageColor(cfg.ffmpegPath, framePath);
          if (color === null) continue;
          frames.push({ sec: sample.sec, file: framePath, ...color });
          frameFiles.push(framePath);
          cropped += 1;
        }
        if (samples.length > 0 && cropped === 0) {
          deps.log?.(
            `[note] ${video.bvid} 拼图取到了但一帧都裁不出来（ffmpeg=${cfg.ffmpegPath}，samples=${String(samples.length)}）——多半是 ffmpeg 不可执行或不在 PATH`,
          );
        }
      }
    } catch (err) {
      deps.log?.(`[note] ${video.bvid} 画面取不到：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    content: composeVideoNote(video, { quotes, subtitleChars, frames }),
    quotes,
    subtitleChars,
    frames,
    frameFiles,
  };
}

/**
 * 写一条富知识。幂等口径与 `ingestVideos` 一致：`bili:<bvid>` 已存在就不写。
 * 闸门（擦边/离题）由调用方在**取字幕之前**过——不然会为一条注定被丢的视频花两次请求。
 */
export function ingestVideoNote(
  store: KnowledgeWritePort,
  video: BiliVideo,
  note: BuiltVideoNote,
  now: number,
  cfg: { readonly worldviewTranslated?: boolean } = {},
): boolean {
  const id = store.idFor(`bili:${video.bvid}`);
  if (store.has(id)) return false;
  const record: KnowledgeRecord = {
    id,
    content: note.content,
    knowledge_type: "trend",
    source: DEFAULT_BILI_INGEST.source,
    source_credibility: DEFAULT_BILI_INGEST.sourceCredibility,
    objective_freshness: DEFAULT_BILI_INGEST.objectiveFreshness,
    social_freshness: DEFAULT_BILI_INGEST.socialFreshness,
    freshness: DEFAULT_BILI_INGEST.freshness,
    access_count: 0,
    ingested_at: now,
    worldview_translated: cfg.worldviewTranslated ?? DEFAULT_BILI_INGEST.worldviewTranslated,
  };
  store.put(record);
  return true;
}
