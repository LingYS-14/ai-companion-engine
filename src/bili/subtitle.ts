/**
 * B 站 AI 字幕：取「视频里到底说了什么」。
 *
 * 两步走，与官方播放器一致：
 *   1. `GET /x/player/v2?bvid=&cid=` → `data.subtitle.subtitles[]`（挑一条 `subtitle_url`）；
 *   2. 下载那个 JSON（`body[]`，每项 `from`/`to`/`content`）——**CDN 域名，不带 Cookie**。
 *
 * 这一层只做「取词 + 解析 + 挑引用」，不写知识库：知道怎么把字幕变成可引用句子的是
 * `notes.ts`，这一层保持纯取数与纯解析，方便用假 fetch 测。
 *
 * 硬约束：
 *   - 没有字幕就返回 null（不抛）——「这条视频没字幕」是正常结果，不是故障；
 *   - `lan_doc` 为空时退回 `lan`，再退回「未知」，供知识条目直接引用；
 *   - 引用只挑**足够长的整句**，并跳过纯语气词（「啊」「嗯」「好了」），
 *     宁可少引用，也不要把「嗯」当台词写进知识库。
 */

import { BiliError, fetchApiData, fetchPlainJson, type BiliDeps } from "./public.js";

export interface SubtitleLine {
  readonly fromSec: number;
  readonly toSec: number;
  readonly text: string;
}

export interface SubtitleTrack {
  /** 语言标签（原样保留接口给的 `lan_doc`，例如「中文（自动生成）」） */
  readonly lang: string;
  /** 字幕 JSON 的地址（只用于日志与排障，不落知识库） */
  readonly url: string;
  readonly lines: readonly SubtitleLine[];
}

/** 单条字幕文本上限（按 code point）：字幕偶尔会带一句超长贯口，直接截断 */
export const SUBTITLE_LINE_MAX_CHARS = 200;
/** 解析时最多收多少条：一小时视频约 600–1200 条，留 4000 足够且能防恶意大包 */
export const SUBTITLE_MAX_LINES = 4000;
/** 引用句至少多少字（按 code point）才算「有内容」 */
export const SUBTITLE_QUOTE_MIN_CHARS = 10;

/**
 * 开头问候 / 片尾求三连 / 广告口播的开头模式：这类句子再长也没有信息量。
 * 只认**开头**，不认包含——「谢谢」出现在句中往往是正经对话。
 */
export const SUBTITLE_FILLER_PREFIX = /^(?:大家好|哈喽|嗨|谢谢(?:大家|观看|收看)?|感谢(?:大家|观看|收看)?|点赞|关注|投币|三连|转发|拜拜|下期见|咱们下期|我们下期|欢迎来到|我是.{0,6}(?:今天|这次)|问你一个问题|最近刷到)/u;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function clampText(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

/** `//aisubtitle.hdslb.com/...` → `https://aisubtitle.hdslb.com/...`；已带协议的原样返回 */
export function normalizeSubtitleUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

/**
 * 从 `/x/player/v2` 的 `data` 里挑一条字幕轨（优先人工/中文，接口顺序通常已经是优先级）。
 * 没有 `subtitles` 数组、或所有条目都没有 `subtitle_url` → null。
 */
export function parseSubtitleTrackList(raw: unknown): { lang: string; url: string } | null {
  const data = readRecord(raw);
  const subtitle = readRecord(data["subtitle"]);
  const tracks = subtitle["subtitles"];
  if (!Array.isArray(tracks)) return null;
  for (const item of tracks) {
    const record = readRecord(item);
    const url = normalizeSubtitleUrl(typeof record["subtitle_url"] === "string" ? record["subtitle_url"] : "");
    if (url === "") continue;
    const lanDoc = typeof record["lan_doc"] === "string" ? record["lan_doc"].trim() : "";
    const lan = typeof record["lan"] === "string" ? record["lan"].trim() : "";
    return { lang: lanDoc !== "" ? lanDoc : lan !== "" ? lan : "未知", url };
  }
  return null;
}

/** `body[]` → 有序行；空文本、越界时间戳丢弃，`to < from` 修正为 `from` */
export function parseSubtitleBody(raw: unknown): readonly SubtitleLine[] {
  const body = readRecord(raw)["body"];
  if (!Array.isArray(body)) return [];
  const lines: SubtitleLine[] = [];
  for (const item of body.slice(0, SUBTITLE_MAX_LINES)) {
    const record = readRecord(item);
    const text = typeof record["content"] === "string" ? record["content"].trim() : "";
    if (text === "") continue;
    const from = readNumber(record["from"]);
    if (from === undefined || from < 0) continue;
    const to = readNumber(record["to"]);
    lines.push({
      fromSec: from,
      toSec: to !== undefined && to >= from ? to : from,
      text: clampText(text, SUBTITLE_LINE_MAX_CHARS),
    });
  }
  return lines;
}

/**
 * 挑引用：把可用句按时间**等距**抽 `count` 条，每条截到 `maxChars`。
 *
 * 为什么等距而不是取前 N 条：前 N 条几乎全是开场问候（「大家好」），
 * 等距抽样才能覆盖「开头 / 中段 / 结尾」三段的信息。
 * 去重保留第一次出现——同一句复读在字幕里很常见。
 */
export function pickSubtitleQuotes(
  lines: readonly SubtitleLine[],
  count = 3,
  maxChars = 60,
): readonly string[] {
  if (count <= 0 || lines.length === 0) return [];
  const usable = lines.filter((line) => {
    const length = Array.from(line.text).length;
    return length >= SUBTITLE_QUOTE_MIN_CHARS && !SUBTITLE_FILLER_PREFIX.test(line.text);
  });
  if (usable.length === 0) return [];
  const quotes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // 取「(i+1)/(count+1)」分位而不是等距起点：开头 10% 常是问候/广告口播
    const index = Math.min(usable.length - 1, Math.floor(((i + 1) * usable.length) / (count + 1)));
    const line = usable[index];
    if (line === undefined) break;
    const text = clampText(line.text, maxChars);
    if (!quotes.includes(text)) quotes.push(text);
  }
  return quotes;
}

/** 字幕纯文本总字数（按 code point），用于「字幕 N 字」这类可核对的事实 */
export function subtitleCharCount(lines: readonly SubtitleLine[]): number {
  let total = 0;
  for (const line of lines) total += Array.from(line.text).length;
  return total;
}

/**
 * 取一条字幕轨；没有字幕返回 null。
 * `cid` 缺失时也发请求（部分稿件 bvid 能直接取到），接口报错则上抛由调用方决定降级。
 */
export async function fetchSubtitleTrack(
  deps: BiliDeps,
  bvid: string,
  cid?: number,
): Promise<SubtitleTrack | null> {
  const id = bvid.trim();
  if (id === "") return null;
  const cidPart = cid === undefined ? "" : `&cid=${String(cid)}`;
  const data = await fetchApiData(deps, `/x/player/v2?bvid=${encodeURIComponent(id)}${cidPart}`);
  const head = parseSubtitleTrackList(data);
  if (head === null) return null;
  let body: unknown;
  try {
    body = await fetchPlainJson(deps, head.url);
  } catch (err) {
    if (err instanceof BiliError) throw err;
    throw new BiliError(-1, `字幕下载失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = parseSubtitleBody(body);
  if (lines.length === 0) return null;
  return { lang: head.lang, url: head.url, lines };
}
