/**
 * B 站写操作（发弹幕 / 发评论 / 点赞）与单条视频详情读取。
 *
 * 为什么单独一个文件而不是塞进 public.ts：
 * - 读接口是匿名可用的，写接口必须有登录态 + csrf（bili_jct），两者的失败语义与
 *   日志纪律不同；写操作一旦泄漏 cookie 就是账号风险，放在一起容易顺手把 header
 *   打进日志。
 * - 这里的函数全部注入 fetchFn / now，不读时钟、不碰全局状态，测试可以用假 fetch
 *   断言「URL、表单、header」三件事。
 *
 * 纪律（与 public.ts 一致）：
 * - sessdata / bili_jct 只允许出现在 Cookie header 与 csrf 表单字段里；
 * - 日志与错误 message 一律先过 redact()，即便上游错误信息意外带了 cookie 也不会落盘；
 * - B 站业务 code 非 0 视为失败，但**不抛异常**——调用方（自主循环）要能记账后继续跑。
 */

import type { BiliDeps, BiliSession } from "./public.js";

const API_BASE = "https://api.bilibili.com";
const UA = "Mozilla/5.0 ai-companion-engine";
const REFERER = "https://www.bilibili.com/";
const ORIGIN = "https://www.bilibili.com";
const DEFAULT_TIMEOUT_MS = 15_000;
/** 弹幕文案上限（B 站接口限制 100 字，这里按字节无关的字符数校验） */
const MAX_DANMAKU_CHARS = 100;
/** 评论上限（B 站允许 1000 字，这里只做接口级校验；生成侧另有更短的目标） */
const MAX_COMMENT_CHARS = 1_000;

/** 传输层失败：重试有意义 */
const TRANSPORT_ERROR = -1;
/** 返回体不是 JSON / 缺 code */
const PARSE_ERROR = -2;
/** 写操作缺登录态或 bili_jct */
const NO_CSRF = -3;
/** 入参本身不合法（空文案 / 缺 cid 等），重试没有意义 */
const INVALID_INPUT = -4;

/** 写操作依赖：在 public.ts 的 BiliDeps 上补一个单请求超时。 */
export interface BiliWriteDeps extends BiliDeps {
  /** 单次请求超时；缺省 15s，避免常驻循环被一个挂起的连接拖住 */
  readonly timeoutMs?: number;
}

export interface BiliWriteSuccess {
  readonly ok: true;
  readonly code: 0;
  readonly message: string;
  /** B 站返回的 data 原样带出，调用方按需取（点赞只关心 success） */
  readonly data: unknown;
}

export interface BiliWriteFailure {
  readonly ok: false;
  /** B 站业务 code，或本地负数码（传输 / 解析 / 凭据 / 入参） */
  readonly code: number;
  readonly message: string;
  /** 网络抖动 / 5xx / 429 可以下次再试；业务拒绝与入参错误不要重试 */
  readonly retryable: boolean;
}

export type BiliWriteResult = BiliWriteSuccess | BiliWriteFailure;

/** 可用写操作的动作名；与 activity 的决策结果对齐，方便账本统一。 */
export type BiliWriteAction = "danmaku" | "comment" | "like";

export interface DanmakuInput {
  readonly bvid: string;
  /** 视频分 P 的 cid（不是 aid） */
  readonly cid: number;
  readonly text: string;
  /** 弹幕出现的位置（毫秒）；缺省 0 = 视频开头 */
  readonly progressMs?: number;
}

export interface CommentInput {
  readonly aid: number;
  readonly text: string;
}

export interface LikeInput {
  readonly aid: number;
  /** 缺省 true；B 站接口用 like=1 表示点赞 */
  readonly like?: boolean;
}

export interface VideoDetail {
  readonly bvid: string;
  readonly aid: number;
  readonly cid: number;
  readonly title: string;
  readonly description: string;
  readonly durationSec: number;
  readonly owner: string;
  /** 分 P 数；1 表示单 P。弹幕要用 cid，调用方通常直接用这里的 cid。 */
  readonly pages: number;
}

function fail(code: number, message: string, retryable: boolean): BiliWriteFailure {
  return { ok: false, code, message, retryable };
}

/**
 * 把凭据从任意文本里抹掉再写日志 / 进错误 message。
 * 宁可多替换几次，也不让 cookie 出现在 data/*.log 里。
 */
function redact(text: string, session: BiliSession | null): string {
  let out = text;
  if (session !== null && session.sessdata !== "") {
    out = out.split(session.sessdata).join("***");
  }
  const csrf = session?.biliJct;
  if (csrf !== undefined && csrf !== "") {
    out = out.split(csrf).join("***");
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cookieHeader(session: BiliSession | null, requireCsrf: boolean): string | null {
  if (session === null || session.sessdata === "") return null;
  const csrf = session.biliJct;
  if (requireCsrf && (csrf === undefined || csrf === "")) return null;
  return csrf === undefined || csrf === "" ? `SESSDATA=${session.sessdata}` : `SESSDATA=${session.sessdata}; bili_jct=${csrf}`;
}

function baseHeaders(cookie: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Referer: REFERER,
    Accept: "application/json, text/plain, */*",
  };
  if (cookie !== null) headers.Cookie = cookie;
  return headers;
}

/** 把一次 POST 的公共部分收拢：凭据检查、超时、状态码、code 解析、脱敏。 */
async function postForm(
  deps: BiliWriteDeps,
  path: string,
  form: ReadonlyArray<readonly [string, string]>,
  session: BiliSession | null,
): Promise<BiliWriteResult> {
  const cookie = cookieHeader(session, true);
  if (cookie === null) {
    return fail(NO_CSRF, "B 站写操作需要登录态与 bili_jct（csrf），当前没有可用凭据", false);
  }
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  if (fetchFn === undefined) {
    return fail(TRANSPORT_ERROR, "没有可用的 fetch", true);
  }
  const body = new URLSearchParams();
  for (const [key, value] of form) body.append(key, value);
  deps.log?.(`[bili] POST ${path} @${String(deps.now())}`);
  let response: Response;
  try {
    response = await fetchFn(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        ...baseHeaders(cookie),
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(TRANSPORT_ERROR, redact(`B 站写请求失败（${path}）：${errorText(err)}`, session), true);
  }
  if (response.status !== 200) {
    const retryable = response.status >= 500 || response.status === 429;
    return fail(response.status, `B 站写接口 HTTP ${String(response.status)}（${path}）`, retryable);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return fail(PARSE_ERROR, redact(`B 站写接口读取返回失败（${path}）：${errorText(err)}`, session), true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(PARSE_ERROR, `B 站写接口返回不是 JSON（${path}）：${text.slice(0, 120)}`, true);
  }
  const obj = parsed as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof obj.code !== "number") {
    return fail(PARSE_ERROR, `B 站写接口返回缺少 code（${path}）`, true);
  }
  if (obj.code !== 0) {
    const message = typeof obj.message === "string" && obj.message !== "" ? obj.message : "B 站拒绝";
    return fail(obj.code, redact(`B 站写接口 code=${String(obj.code)}：${message}（${path}）`, session), false);
  }
  return { ok: true, code: 0, message: "ok", data: obj.data };
}

/**
 * 发一条弹幕。
 * 表单按 B 站当前接口（x/v2/dm/post）要求传 type=1、oid=cid、progress=毫秒、bvid。
 */
export async function postDanmaku(deps: BiliWriteDeps, input: DanmakuInput): Promise<BiliWriteResult> {
  const bvid = input.bvid.trim();
  const text = input.text.trim();
  if (bvid === "") return fail(INVALID_INPUT, "发弹幕缺少 bvid", false);
  if (!Number.isInteger(input.cid) || input.cid <= 0) return fail(INVALID_INPUT, "发弹幕缺少合法 cid", false);
  if (text === "") return fail(INVALID_INPUT, "弹幕文案为空", false);
  if (Array.from(text).length > MAX_DANMAKU_CHARS) {
    return fail(INVALID_INPUT, `弹幕文案超过 ${String(MAX_DANMAKU_CHARS)} 字`, false);
  }
  const rawProgress = input.progressMs ?? 0;
  const progressMs = Number.isFinite(rawProgress) && rawProgress > 0 ? Math.floor(rawProgress) : 0;
  const session = deps.session ?? null;
  return postForm(
    deps,
    "/x/v2/dm/post",
    [
      ["type", "1"],
      ["oid", String(input.cid)],
      ["msg", text],
      ["progress", String(progressMs)],
      ["bvid", bvid],
      ["csrf", session?.biliJct ?? ""],
    ],
    session,
  );
}

/** 发一条视频评论（oid 用 aid，不是 cid）。 */
export async function postComment(deps: BiliWriteDeps, input: CommentInput): Promise<BiliWriteResult> {
  const text = input.text.trim();
  if (!Number.isInteger(input.aid) || input.aid <= 0) return fail(INVALID_INPUT, "发评论缺少合法 aid", false);
  if (text === "") return fail(INVALID_INPUT, "评论文案为空", false);
  if (Array.from(text).length > MAX_COMMENT_CHARS) {
    return fail(INVALID_INPUT, `评论文案超过 ${String(MAX_COMMENT_CHARS)} 字`, false);
  }
  const session = deps.session ?? null;
  return postForm(
    deps,
    "/x/v2/reply/add",
    [
      ["type", "1"],
      ["oid", String(input.aid)],
      ["message", text],
      ["csrf", session?.biliJct ?? ""],
    ],
    session,
  );
}

/** 给视频点赞；B 站同一接口 like=1 / like=0 控制，这里只暴露点赞。 */
export async function likeVideo(deps: BiliWriteDeps, input: LikeInput): Promise<BiliWriteResult> {
  if (!Number.isInteger(input.aid) || input.aid <= 0) return fail(INVALID_INPUT, "点赞缺少合法 aid", false);
  const session = deps.session ?? null;
  const like = input.like === false ? "0" : "1";
  return postForm(
    deps,
    "/x/web-interface/archive/like",
    [
      ["aid", String(input.aid)],
      ["like", like],
      ["csrf", session?.biliJct ?? ""],
    ],
    session,
  );
}

/**
 * 读单条视频详情（aid/cid/标题/简介/时长）。
 *
 * 失败返回 null 而不是抛错：社交循环是“挑一条视频”，一条读不到就换下一条，
 * 不该让整个 tick 失败。失败原因仍会写一行日志（已脱敏）。
 */
export async function getVideoDetail(deps: BiliWriteDeps, bvid: string): Promise<VideoDetail | null> {
  const cleanBvid = bvid.trim();
  if (cleanBvid === "") return null;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  if (fetchFn === undefined) {
    deps.log?.("[bili] detail 失败：没有可用的 fetch");
    return null;
  }
  const session = deps.session ?? null;
  const cookie = cookieHeader(session, false);
  const path = "/x/web-interface/view";
  const url = `${API_BASE}${path}?bvid=${encodeURIComponent(cleanBvid)}`;
  deps.log?.(`[bili] GET ${path} @${String(deps.now())}`);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: baseHeaders(cookie),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    deps.log?.(redact(`[bili] detail 传输失败（${cleanBvid}）：${errorText(err)}`, session));
    return null;
  }
  if (response.status !== 200) {
    deps.log?.(`[bili] detail HTTP ${String(response.status)}（${cleanBvid}）`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch (err) {
    deps.log?.(redact(`[bili] detail 返回不可解析（${cleanBvid}）：${errorText(err)}`, session));
    return null;
  }
  const obj = parsed as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof obj.code !== "number" || obj.code !== 0) {
    const code = typeof obj.code === "number" ? obj.code : PARSE_ERROR;
    const message = typeof obj.message === "string" ? obj.message : "缺少 code";
    deps.log?.(redact(`[bili] detail code=${String(code)}：${message}（${cleanBvid}）`, session));
    return null;
  }
  const data = obj.data as
    | {
        bvid?: unknown;
        aid?: unknown;
        cid?: unknown;
        title?: unknown;
        desc?: unknown;
        duration?: unknown;
        owner?: { name?: unknown };
        pages?: unknown;
      }
    | undefined;
  if (data === undefined || typeof data.aid !== "number" || typeof data.cid !== "number") {
    deps.log?.(`[bili] detail 缺少 aid/cid（${cleanBvid}）`);
    return null;
  }
  return {
    bvid: typeof data.bvid === "string" && data.bvid !== "" ? data.bvid : cleanBvid,
    aid: data.aid,
    cid: data.cid,
    title: typeof data.title === "string" ? data.title : "",
    description: typeof data.desc === "string" ? data.desc : "",
    durationSec: typeof data.duration === "number" && data.duration > 0 ? data.duration : 0,
    owner: typeof data.owner?.name === "string" ? data.owner.name : "",
    pages: Array.isArray(data.pages) ? data.pages.length : 1,
  };
}
