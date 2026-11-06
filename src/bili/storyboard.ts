/**
 * B 站故事板（videoshot）：不下载视频也能「看到」画面。
 *
 * 接口 `GET /x/player/videoshot?bvid=&index=1` 返回一张或多张**拼图**（每张 `cols × rows` 格），
 * 以及 `index[]`：第 i 格对应视频的第 `index[i]` 秒。于是「取第 48 秒的画面」= 算出格子坐标、
 * 用 ffmpeg 从拼图里裁一块出来。
 *
 * 这一层同样只做纯计算与取数：**裁剪/取色在 `notes.ts`**（那里才碰 ffmpeg 与磁盘）。
 *
 * 为什么不用 yt-dlp 下整片：一条 3 分钟视频 30–80MB，而 5 张拼图不到 1MB；
 * 她要的只是「这视频里画面大致是什么样」，不是逐帧。省带宽也省时间。
 */

import { BiliError, fetchApiData, type BiliDeps } from "./public.js";

export interface StoryboardSprite {
  /** 拼图地址（已补全协议），至少一张 */
  readonly images: readonly string[];
  /** 每格对应的视频秒数；长度 = 总格数 */
  readonly index: readonly number[];
  readonly cols: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

export interface TileSample {
  /** 这一格在视频里的秒数 */
  readonly sec: number;
  /** 属于第几张拼图（0 起） */
  readonly imageIndex: number;
  /** 拼图内的列/行（0 起） */
  readonly col: number;
  readonly row: number;
  /** 该格的扁平序号（= index 数组下标），日志用 */
  readonly flat: number;
}

export interface FrameColor {
  readonly sec: number;
  readonly file: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 默认取几格（overlay 的 LEARN_FRAME_SAMPLES 会覆盖） */
export const DEFAULT_FRAME_SAMPLES = 3;
/** 单格边长上限：故事板格子一般 160×90 或 320×180，超过这个值说明接口变了 */
export const MAX_TILE_EDGE = 640;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

function readInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

/** `//i0.hdslb.com/...` → `https://...`；空串返回空串 */
export function normalizeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

/**
 * 解析 `data`。必需的四个几何字段（cols/rows/tile 宽高）任一缺失或非法 → null：
 * 宁可这条视频没有画面摘要，也不要拿错格子去裁一张不相干的图。
 */
export function parseStoryboard(raw: unknown): StoryboardSprite | null {
  const data = readRecord(raw);
  const cols = readInt(data["img_x_len"]);
  const rows = readInt(data["img_y_len"]);
  const tileWidth = readInt(data["img_x_size"]);
  const tileHeight = readInt(data["img_y_size"]);
  if (cols === undefined || rows === undefined || tileWidth === undefined || tileHeight === undefined) return null;
  if (cols <= 0 || rows <= 0 || tileWidth <= 0 || tileHeight <= 0) return null;
  if (tileWidth > MAX_TILE_EDGE || tileHeight > MAX_TILE_EDGE) return null;
  const rawImages = data["image"];
  if (!Array.isArray(rawImages)) return null;
  const images = rawImages
    .map((item) => normalizeImageUrl(typeof item === "string" ? item : ""))
    .filter((url) => url !== "");
  if (images.length === 0) return null;
  const rawIndex = data["index"];
  if (!Array.isArray(rawIndex)) return null;
  const index = rawIndex.map((item) => readInt(item)).filter((sec): sec is number => sec !== undefined && sec >= 0);
  if (index.length === 0) return null;
  return { images, index, cols, rows, tileWidth, tileHeight };
}

/**
 * 选格：按「(i+0.5)/count」在总时长上等距取 `count` 个时刻，各自找**最近**的一格。
 *
 * 为什么取中点而不是 0 时刻：0 秒常是黑场/标题卡；等距中点更可能落在正片内容上。
 * 为什么允许重复格：极短视频只有 2 格时，取 3 个样本必然重复——重复也比空着诚实。
 */
export function chooseTileSamples(
  board: StoryboardSprite,
  durationSec: number,
  count: number = DEFAULT_FRAME_SAMPLES,
): readonly TileSample[] {
  if (count <= 0 || board.index.length === 0) return [];
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : board.index[board.index.length - 1] ?? 0;
  if (duration <= 0) return [];
  const perImage = board.cols * board.rows;
  const samples: TileSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = (duration * (i + 0.5)) / count;
    let bestFlat = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let flat = 0; flat < board.index.length; flat += 1) {
      const gap = Math.abs((board.index[flat] ?? 0) - target);
      if (gap < bestGap) {
        bestGap = gap;
        bestFlat = flat;
      }
    }
    const imageIndex = Math.min(board.images.length - 1, Math.floor(bestFlat / perImage));
    const within = bestFlat - imageIndex * perImage;
    samples.push({
      sec: board.index[bestFlat] ?? 0,
      imageIndex,
      col: within % board.cols,
      row: Math.floor(within / board.cols),
      flat: bestFlat,
    });
  }
  return samples;
}

/** ffmpeg 的 crop 滤镜表达式：`crop=w:h:x:y` */
export function cropFilter(board: StoryboardSprite, sample: TileSample): string {
  const x = sample.col * board.tileWidth;
  const y = sample.row * board.tileHeight;
  return `crop=${String(board.tileWidth)}:${String(board.tileHeight)}:${String(x)}:${String(y)}`;
}

const COLOR_NAMES: readonly { readonly name: string; readonly hue: number }[] = [
  { name: "红", hue: 0 },
  { name: "橙", hue: 30 },
  { name: "黄", hue: 60 },
  { name: "绿", hue: 120 },
  { name: "青", hue: 180 },
  { name: "蓝", hue: 220 },
  { name: "紫", hue: 275 },
  { name: "粉", hue: 330 },
];

/**
 * RGB → 中文粗色名（给「主色偏蓝紫」这类话用）。
 *
 * 低饱和或极暗/极亮一律走描述性词：把 #1a1a1a 叫「黑」、把 #f5f5f5 叫「白灰」，
 * 比硬套色轮诚实——色相对它们没有意义。
 */
export function colorName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = max === 0 ? 0 : delta / max;
  if (lightness <= 32) return "黑";
  if (lightness >= 232 && saturation <= 0.08) return "白";
  if (saturation <= 0.12) return "灰";
  let hue: number;
  if (max === r) hue = ((g - b) / delta) * 60;
  else if (max === g) hue = ((b - r) / delta) * 60 + 120;
  else hue = ((r - g) / delta) * 60 + 240;
  if (hue < 0) hue += 360;
  let best = COLOR_NAMES[0];
  let bestGap = 360;
  for (const item of COLOR_NAMES) {
    const gap = Math.min(Math.abs(item.hue - hue), 360 - Math.abs(item.hue - hue));
    if (gap < bestGap) {
      bestGap = gap;
      best = item;
    }
  }
  return best?.name ?? "灰";
}

function brightnessWord(value: number): string {
  if (value <= 80) return "偏暗";
  if (value >= 180) return "偏亮";
  return "亮度适中";
}

function distance(a: FrameColor, b: FrameColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 把取样帧说成一句人话。**不描述内容语义**（没有视觉模型就不编「画面里有个女孩」），
 * 只给可复算的量：取样时刻、平均色、明暗、帧间差异。
 */
export function visualSummary(frames: readonly FrameColor[]): string {
  if (frames.length === 0) return "画面：没有取到取样帧";
  const count = frames.length;
  const sum = frames.reduce(
    (acc, f) => ({ r: acc.r + f.r, g: acc.g + f.g, b: acc.b + f.b }),
    { r: 0, g: 0, b: 0 },
  );
  const r = Math.round(sum.r / count);
  const g = Math.round(sum.g / count);
  const b = Math.round(sum.b / count);
  const light = Math.round((r + g + b) / 3);
  let maxDelta = 0;
  for (let i = 0; i < frames.length; i += 1) {
    for (let j = i + 1; j < frames.length; j += 1) {
      const a = frames[i];
      const c = frames[j];
      if (a === undefined || c === undefined) continue;
      maxDelta = Math.max(maxDelta, distance(a, c));
    }
  }
  const change = maxDelta <= 24 ? "帧间几乎没有变化" : maxDelta >= 96 ? "帧间变化明显" : "帧间有些变化";
  const times = frames.map((f) => formatSec(f.sec)).join("/");
  return `画面：${String(count)} 处取样（${times}），${brightnessWord(light)}、以${colorName(r, g, b)}为主，${change}`;
}

/** `125` → `02:05` */
export function formatSec(total: number): string {
  const value = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const m = Math.floor(value / 60);
  const s = value % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 取故事板；没有或解析不出返回 null（调用方据此跳过画面摘要，不影响字幕） */
export async function fetchStoryboard(deps: BiliDeps, bvid: string): Promise<StoryboardSprite | null> {
  const id = bvid.trim();
  if (id === "") return null;
  const data = await fetchApiData(deps, `/x/player/videoshot?bvid=${encodeURIComponent(id)}&index=1`);
  return parseStoryboard(data);
}

/** 下载拼图（CDN，不带 Cookie）；失败转成 BiliError 由调用方降级 */
export async function downloadSprite(deps: BiliDeps, url: string, timeoutMs = 20_000): Promise<Uint8Array> {
  const fetchFn: typeof fetch = deps.fetchFn ?? fetch;
  deps.log?.(`[bili] GET ${url.replace(/\?.*$/u, "")} (image)`);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": "Mozilla/5.0 ai-companion-engine", Referer: "https://www.bilibili.com/" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BiliError(-1, `拼图下载失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new BiliError(response.status, `拼图 HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 供测试/调试：拼图 json 里的 image 数量与总格数是否自洽 */
export function spriteCapacity(board: StoryboardSprite): { readonly perImage: number; readonly total: number } {
  const perImage = board.cols * board.rows;
  return { perImage, total: perImage * board.images.length };
}
