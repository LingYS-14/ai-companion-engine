/**
 * B 站「公开读取」第一块：热门榜、视频详情、视频标签、登录态自检（只读、无写操作）。
 *
 * 三条边界（写在这里，免得接线的人重新发明一套）：
 *   1. **默认匿名，登录态只能从外部注入**：不传 `deps.session` 时请求只带 UA 与
 *      Referer，与接入登录前逐字段一致；传了才多一个 `Cookie`。凭据**只允许**
 *      出现在请求头里——不进日志、不进 `BiliError.message`（B 站历史上出过把
 *      凭据打进日志的事故，`cookieHeader` 的返回值只许交给 `headers`）。
 *   2. **不引入依赖**：Node 20+ 自带 fetch，测试注入假实现（`deps.fetchFn`）。
 *   3. **时间从外部来**：本目录不读系统时钟（CI 的 writers 闸会拦），
 *      需要「现在几点」的地方一律走 `deps.now()`。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BiliVideo {
  readonly bvid: string;
  readonly aid?: number;
  readonly title: string;
  readonly description: string;
  readonly owner: string;
  readonly view: number;
  readonly like: number;
  /** 投稿时间（毫秒）。接口给的是秒，这里统一换算好，调用方不再关心单位 */
  readonly pubdateMs: number;
  readonly durationSec: number;
  readonly tags: readonly string[];
}

export interface BiliDeps {
  /** 注入点：默认全局 `fetch`；测试给假实现（同 `src/qq/onebot.ts` 的做法） */
  readonly fetchFn?: typeof fetch;
  /** 时间从外部来：日志时间戳（以后要做缓存 TTL 也走它，本目录不读系统时钟） */
  now(): number;
  log?(line: string): void;
  /**
   * 登录态。**缺省 = 匿名**，请求头里不会出现 `Cookie` 键（与接入登录前一致）。
   * 由调用方从 `data/bili-<characterId>.json` 读出后注入，本层不自己找文件。
   */
  readonly session?: BiliSession | null;
}

/**
 * B 站登录态：只取传输层真正用得到的两个 cookie。
 *
 * 为什么不多带 `dedeUserId` / `savedAt`：那是**给人看**的元数据，传输层不需要；
 * 少留一个字段就少一条被顺手打进日志的路径。
 */
export interface BiliSession {
  /** `SESSDATA` 的值，**原样**使用（里面形如 `%2C` 的是编码内容，不要解码） */
  readonly sessdata: string;
  /** `bili_jct`（csrf token）：只读接口可以不带，带了也不影响 GET */
  readonly biliJct?: string;
}

/**
 * 从文件读登录态（JSON：`{ "sessdata": "...", "biliJct": "...", "dedeUserId": ..., "savedAt": ... }`）。
 *
 * 任何失败都返回 `null`：缺文件、没权限、JSON 坏了、`sessdata` 缺失或空串。
 * 为什么吞掉错误而不是抛：这条路径的输入是**凭据文件**，异常对象最容易顺手
 * 带上文件内容；自检工具只需要知道「有没有登录态」，不需要知道「为什么坏」。
 * 值原样保留 —— `%2C` 是 cookie 的编码内容，解码会把 cookie 弄坏。
 */
export function loadBiliSessionFromFile(path: string): BiliSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // 缺文件 / 无权限：当成「没登录」，不记录路径之外的任何内容
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏 JSON：同样不把原文带进错误（原文就是凭据）
    return null;
  }
  const record = readRecord(parsed);
  const sessdata = readString(record["sessdata"], "").trim();
  if (sessdata === "") return null;
  const biliJct = readString(record["biliJct"], "").trim();
  return biliJct === "" ? { sessdata } : { sessdata, biliJct };
}

/**
 * 按角色取登录态：`<dataDir>/bili-<characterId>.json`（与 `state-<id>.json`
 * 同一套命名习惯）。文件缺失或坏掉返回 `null`，调用方按匿名继续跑。
 */
export function loadBiliSession(dataDir: string, characterId: string): BiliSession | null {
  const id = characterId.trim();
  if (id === "") return null;
  return loadBiliSessionFromFile(join(dataDir, `bili-${id}.json`));
}

/**
 * B 站调用失败。
 * `code` 是 B 站业务码（HTTP 层失败时是 HTTP 状态码，传输/解析失败用负数哨兵）。
 */
export class BiliError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "BiliError";
    this.code = code;
  }
}

const API_BASE = "https://api.bilibili.com";
const USER_AGENT = "Mozilla/5.0 ai-companion-engine";
const REFERER = "https://www.bilibili.com/";
/** 传输失败 / 返回非 JSON / 缺 code 字段的哨兵码（B 站业务码不会取这些值） */
const TRANSPORT_ERROR = -1;
const PARSE_ERROR = -2;
/** B 站把「没有登录态」也报成业务错：nav 匿名访问返回 code -101「账号未登录」 */
const NAV_NOT_LOGIN = -101;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

/** 数字或数字字符串都收；其余一律 undefined（字段缺失时"没有"，不是 0） */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * 拼 `Cookie` 头；没有登录态时返回空串，调用方据此**不写**这个键
 * （保证匿名请求头一个字节都不变）。
 *
 * 返回值只允许进 `headers`：不要 `log` 它，不要拼进 `BiliError.message`。
 * 这是本文件里唯一接触凭据的函数，审计时看这一处 + `requestJson` 的 headers 即可。
 */
function cookieHeader(session: BiliSession | null | undefined): string {
  if (session === null || session === undefined) return "";
  const sessdata = session.sessdata.trim();
  if (sessdata === "") return "";
  const biliJct = session.biliJct?.trim() ?? "";
  return biliJct === "" ? `SESSDATA=${sessdata}` : `SESSDATA=${sessdata}; bili_jct=${biliJct}`;
}

/**
 * 一次 GET：成功返回 `data` 字段，失败一律抛 `BiliError`。
 *
 * 顺序是刻意的：先判 HTTP 状态，再解析 JSON，最后判业务码。B 站的 WAF 拦截
 * 常返回 412 + HTML，先解析 JSON 只会得到「不是 JSON」这种没用的错误。
 *
 * 凭据纪律：`Cookie` 只拼进 `headers`；日志只有 path 与时间戳，错误消息只有
 * path / 状态码 / 接口 message —— 四个出口都不含请求头。
 */
async function requestJson(deps: BiliDeps, path: string): Promise<unknown> {
  const fetchFn: typeof fetch = deps.fetchFn ?? fetch;
  const url = `${API_BASE}${path}`;
  deps.log?.(`[bili] GET ${path} @${deps.now()}`);

  const cookie = cookieHeader(deps.session);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: REFERER,
    Accept: "application/json",
  };
  // 有登录态才加这个键：匿名路径的请求头必须与登录前完全一致
  if (cookie !== "") headers["Cookie"] = cookie;

  let response: Response;
  try {
    response = await fetchFn(url, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BiliError(TRANSPORT_ERROR, `B 站请求失败（${path}）：${message}`);
  }

  if (response.status !== 200) {
    throw new BiliError(response.status, `B 站接口 HTTP ${response.status}（${path}）`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BiliError(PARSE_ERROR, `B 站返回的不是 JSON（${path}）`);
  }

  const record = readRecord(body);
  const code = readNumber(record["code"]);
  if (code === undefined) throw new BiliError(PARSE_ERROR, `B 站返回缺少 code 字段（${path}）`);
  if (code !== 0) {
    const msg = readString(record["message"], "").trim() || readString(record["msg"], "").trim();
    throw new BiliError(code, `B 站接口 code=${code}${msg === "" ? "" : `：${msg}`}（${path}）`);
  }
  return record["data"];
}

/**
 * 把一条接口记录解析成 `BiliVideo`；没有 bvid 的记录返回 null（调用方决定丢弃还是当空）。
 *
 * 容错口径：缺字段不是错误（B 站字段随接口/灰度漂移），缺 bvid 才是——bvid 是去重的唯一键。
 * 标题/UP 主缺失给人类可读占位，计数缺失给 0。
 */
function parseVideo(raw: unknown): BiliVideo | null {
  const item = readRecord(raw);
  const bvid = readString(item["bvid"], "").trim();
  if (bvid === "") return null;

  const aid = readNumber(item["aid"]);
  const stat = readRecord(item["stat"]);
  const ownerRaw = item["owner"];
  const owner = typeof ownerRaw === "string"
    ? ownerRaw.trim()
    : readString(readRecord(ownerRaw)["name"], "").trim();
  const rawTags = item["tags"];
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => readString(t, "").trim()).filter((t) => t !== "")
    : [];

  return {
    bvid,
    ...(aid === undefined ? {} : { aid }),
    title: readString(item["title"], "").trim() || "（无标题）",
    // 热门榜用 desc，搜索/部分接口用 description；两个都认
    description: readString(item["desc"], "").trim() || readString(item["description"], "").trim(),
    owner: owner === "" ? "（未知 UP）" : owner,
    view: Math.max(0, Math.trunc(readNumber(stat["view"]) ?? 0)),
    like: Math.max(0, Math.trunc(readNumber(stat["like"]) ?? 0)),
    pubdateMs: Math.max(0, Math.trunc((readNumber(item["pubdate"]) ?? 0) * 1000)),
    durationSec: Math.max(0, Math.trunc(readNumber(item["duration"]) ?? 0)),
    tags,
  };
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

export interface PopularOptions {
  /** 一次拉几条；缺省 10，夹在 1..50（B 站 ps 的可用区间） */
  readonly pageSize?: number;
}

/** 热门榜（GET /x/web-interface/popular，pn 固定 1）。`data.list` 缺失按空列表处理 */
export async function fetchPopular(
  deps: BiliDeps,
  options: PopularOptions = {},
): Promise<readonly BiliVideo[]> {
  const pageSize = clampPageSize(options.pageSize);
  const data = readRecord(await requestJson(deps, `/x/web-interface/popular?ps=${pageSize}&pn=1`));
  const list = data["list"];
  if (!Array.isArray(list)) return [];

  const videos: BiliVideo[] = [];
  for (const item of list) {
    const video = parseVideo(item);
    if (video !== null) videos.push(video);
  }
  return videos;
}

/** 搜索一次拿几条；缺省 10，夹在 1..50（B 站 page_size 的可用区间） */
function clampSearchPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

/** 搜索标题带高亮标记（`<em class="keyword">…</em>`），要剥成纯文本才能进 L2 知识 */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

/** "12:34" / "1:02:03" → 秒；数字原样；解析不出来返回 undefined（字段缺失不是错误） */
function durationToSec(value: unknown): number | undefined {
  const numeric = readNumber(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  let total = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    total = total * 60 + Number(part);
  }
  return total;
}

/**
 * 把一条搜索记录归一成 `parseVideo` 认识的那套字段。
 *
 * 搜索接口是**扁平**结构（`author` / `play` / `like` / `duration:"MM:SS"` / `tag:"a,b"`），
 * 热门榜是嵌套结构（`owner.name` / `stat.view`）。两条通路必须落到同一个 `BiliVideo`
 * 口径，否则「学习」进来的知识会把播放量写成 0、UP 主写成「未知 UP」。
 *
 * 这里对两种结构都认：嵌套字段优先，扁平字段兜底。
 */
function normalizeSearchItem(raw: unknown): Readonly<Record<string, unknown>> {
  const item = readRecord(raw);
  const owner = readRecord(item["owner"]);
  const stat = readRecord(item["stat"]);
  const author = readString(owner["name"], "").trim() || readString(item["author"], "").trim();
  const view = readNumber(stat["view"]) ?? readNumber(item["play"]);
  const like = readNumber(stat["like"]) ?? readNumber(item["like"]);
  const rawTags = item["tags"];
  const flatTag = item["tag"];
  const tags = Array.isArray(rawTags) ? rawTags : typeof flatTag === "string" ? flatTag.split(",") : [];
  return {
    bvid: item["bvid"],
    aid: item["aid"],
    title: stripHtmlTags(readString(item["title"], "")).trim(),
    desc: item["desc"],
    description: item["description"],
    owner: { name: author },
    stat: { view: view ?? 0, like: like ?? 0 },
    pubdate: item["pubdate"],
    duration: durationToSec(item["duration"]) ?? 0,
    tags,
  };
}

/** 搜索主路径。wbi 版本可能需要签名，拿不到就退回同名的不签名接口 */
const SEARCH_PATH_WBI = "/x/web-interface/wbi/search/type";
const SEARCH_PATH_PLAIN = "/x/web-interface/search/type";

/** 搜索一次需要的参数：关键词必填，pageSize 缺省 10、夹在 1..50 */
export interface SearchOptions {
  readonly keyword: string;
  readonly pageSize?: number;
  /**
   * 搜索结果页码（从 1 开始）。自主进程的轮转跨重启存活后，同一个关键词会被反复学到，
   * 如果永远只取第 1 页，命中的就永远是同一批已入库视频——必须能往深里翻。
   */
  readonly page?: number;
}

function searchQuery(keyword: string, pageSize: number, page = 1): string {
  const p = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
  return `?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${String(p)}&page_size=${pageSize}`;
}

function errorCodeOf(err: unknown): number {
  return err instanceof BiliError ? err.code : TRANSPORT_ERROR;
}

function errorTextOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 按关键词搜视频（GET /x/web-interface/wbi/search/type?search_type=video&keyword=…&page=1&page_size=N）。
 *
 * 回退策略：wbi 接口需要签名时线上常回 412（或干脆要求 wbi 参数），所以主路径**任何**
 * 失败都退到不需要签名的 `/x/web-interface/search/type`（同一套参数、同一个解析器）；
 * 只有两条都失败才抛 `BiliError`——错误消息由两段 `requestJson` 的消息拼成，只含
 * path / 状态码 / 接口 message，**不含任何请求头或凭据**（见 `cookieHeader` 的纪律）。
 *
 * 空关键词不发请求、返回 `[]`（与 `fetchVideoInfo` 空 bvid 的处理一致，省一次注定 400 的请求）。
 * 解析口径与热门榜相同：缺 bvid 的条目丢弃，其余字段缺失给默认值。
 */
export async function searchVideos(
  deps: BiliDeps,
  options: SearchOptions,
): Promise<readonly BiliVideo[]> {
  const keyword = options.keyword.trim();
  if (keyword === "") return [];
  const pageSize = clampSearchPageSize(options.pageSize);
  const query = searchQuery(keyword, pageSize, options.page);

  let data: unknown;
  try {
    data = await requestJson(deps, `${SEARCH_PATH_WBI}${query}`);
  } catch (primaryErr) {
    // 日志只留 code：主接口的错误消息本身已不含凭据，日志更不该多留半句
    deps.log?.(`[bili] 搜索主接口失败，回退（code=${errorCodeOf(primaryErr)}）`);
    try {
      data = await requestJson(deps, `${SEARCH_PATH_PLAIN}${query}`);
    } catch (fallbackErr) {
      throw new BiliError(
        errorCodeOf(fallbackErr),
        `B 站搜索失败（${SEARCH_PATH_WBI}：${errorTextOf(primaryErr)}；`
          + `${SEARCH_PATH_PLAIN}：${errorTextOf(fallbackErr)}）`,
      );
    }
  }

  const result = readRecord(data)["result"];
  if (!Array.isArray(result)) return [];
  const videos: BiliVideo[] = [];
  for (const item of result) {
    const video = parseVideo(normalizeSearchItem(item));
    if (video !== null) videos.push(video);
  }
  return videos;
}

/**
 * 视频详情（GET /x/web-interface/view）。
 *
 * 返回值区分三件事：业务失败抛 `BiliError`、`data` 里没有 bvid 返回 null、
 * 正常返回记录。空 bvid 不发请求（省一次 400，也省一次日志噪音）。
 */
export async function fetchVideoInfo(deps: BiliDeps, bvid: string): Promise<BiliVideo | null> {
  const id = bvid.trim();
  if (id === "") return null;
  const data = await requestJson(deps, `/x/web-interface/view?bvid=${encodeURIComponent(id)}`);
  return parseVideo(data);
}

/**
 * 视频标签（GET /x/tag/archive/tags）。
 *
 * 失败一律返回 `[]` 而不是抛：标签是锦上添花，视频本体已经到了，
 * 标签接口 412/风控不该让整条摄取链路失败。
 */
export async function fetchVideoTags(deps: BiliDeps, bvid: string): Promise<readonly string[]> {
  const id = bvid.trim();
  if (id === "") return [];
  let data: unknown;
  try {
    data = await requestJson(deps, `/x/tag/archive/tags?bvid=${encodeURIComponent(id)}`);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const tags: string[] = [];
  for (const item of data) {
    const name = readString(readRecord(item)["tag_name"], "").trim();
    if (name !== "") tags.push(name);
  }
  return tags;
}

/** `/x/web-interface/nav` 的登录态摘要（只取自检要用的三个字段） */
export interface BiliNav {
  readonly isLogin: boolean;
  readonly uname: string;
  readonly mid: number;
}

/**
 * 登录态自检（GET /x/web-interface/nav，走同一个 `requestJson` 所以同样带
 * 注入的 session；不传 session 就是匿名自检）。
 *
 * 返回 `null` 只表示**问不到**：传输失败、HTTP 非 200、返回不是 JSON、或
 * 接口本身报了别的业务码。而「问到了但没登录」是 `{ isLogin: false }` ——
 * 这两件事对调用方的结论完全不同（cookie 失效 vs 网络不通）。
 *
 * B 站把「没有登录态」也报成业务错（`code=-101` 账号未登录），所以这里把
 * -101 归一成 `isLogin:false`；其余业务码说明接口坏了，按「问不到」处理。
 */
export async function fetchNav(deps: BiliDeps): Promise<BiliNav | null> {
  let data: unknown;
  try {
    data = await requestJson(deps, "/x/web-interface/nav");
  } catch (err) {
    if (err instanceof BiliError && err.code === NAV_NOT_LOGIN) {
      return { isLogin: false, uname: "", mid: 0 };
    }
    // 网络错 / 风控 / 解析失败：自检工具要能回答「问不到」，不该炸
    return null;
  }
  const record = readRecord(data);
  return {
    isLogin: record["isLogin"] === true,
    uname: readString(record["uname"], "").trim(),
    mid: Math.max(0, Math.trunc(readNumber(record["mid"]) ?? 0)),
  };
}

/**
 * 视频元信息（GET /x/web-interface/view）——只取**播放器需要用**的那几个字段：
 * `cid` 是字幕接口的必填参数，`pages` 用于确认多 P 视频（字幕只跟第 1P 走）。
 *
 * 为什么单独一个函数而不是扩充 `BiliVideo`：`BiliVideo` 是列表/详情共用的轻量记录，
 * 被摄取层与 daemon 广泛使用；把 `cid` 塞进去会让每条搜索结果都背上「要播放器元信息」
 * 的语义。需要播放器的调用方自己多要一次请求，边界更清楚。
 */
export interface VideoMeta {
  readonly bvid: string;
  readonly aid: number;
  readonly cid: number;
  readonly durationSec: number;
  readonly pages: readonly { readonly cid: number; readonly page: number; readonly part: string; readonly durationSec: number }[];
}

export async function fetchVideoMeta(deps: BiliDeps, bvid: string): Promise<VideoMeta | null> {
  const id = bvid.trim();
  if (id === "") return null;
  const data = readRecord(await requestJson(deps, `/x/web-interface/view?bvid=${encodeURIComponent(id)}`));
  const cid = readNumber(data["cid"]);
  const aid = readNumber(data["aid"]);
  if (cid === undefined || aid === undefined) return null;
  const pages: { cid: number; page: number; part: string; durationSec: number }[] = [];
  const rawPages = data["pages"];
  if (Array.isArray(rawPages)) {
    for (const item of rawPages) {
      const rec = readRecord(item);
      const pageCid = readNumber(rec["cid"]);
      if (pageCid === undefined) continue;
      pages.push({
        cid: pageCid,
        page: readNumber(rec["page"]) ?? pages.length + 1,
        part: readString(rec["part"], ""),
        durationSec: readNumber(rec["duration"]) ?? 0,
      });
    }
  }
  return { bvid: id, aid, cid, durationSec: readNumber(data["duration"]) ?? 0, pages };
}

/**
 * 给同目录其它模块用的底层 GET：只暴露「路径 → data」，凭据拼接仍然只在这个文件里。
 * 别把返回值直接给外部日志——它可能含接口原文。
 */
export async function fetchApiData(deps: BiliDeps, path: string): Promise<unknown> {
  return requestJson(deps, path);
}

/**
 * 取一个**非 API 域名**的 JSON（B 站字幕 CDN 用）。
 *
 * 刻意不带 Cookie：字幕 CDN 不校验登录态，而这里一旦带上 SESSDATA，
 * 凭据就会出现在比 api.bilibili.com 更不可控的域名上。UA/Referer 足够。
 */
export async function fetchPlainJson(deps: BiliDeps, url: string, timeoutMs = 20_000): Promise<unknown> {
  const fetchFn: typeof fetch = deps.fetchFn ?? fetch;
  deps.log?.(`[bili] GET ${url.replace(/\?.*$/u, "")} (json)`);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": USER_AGENT, Referer: REFERER, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BiliError(TRANSPORT_ERROR, `请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) throw new BiliError(response.status, `HTTP ${String(response.status)}`);
  try {
    return await response.json();
  } catch (err) {
    throw new BiliError(PARSE_ERROR, `不是 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}
