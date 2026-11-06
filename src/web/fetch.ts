/**
 * 网页抓取执行层（F1：`soul_web_fetch` 只读抓取）。
 *
 * 设计：`.tmp/handover/design-web-fetch.md` v2 §3.2/§5。
 *
 * 边界：
 * - 只做「把一条 https URL 变成一个可读的 {title,text}」：开关/额度/参数校验在
 *   `fetch-run.ts`，落库/记忆/提示词都在别处（本文件不写任何东西）。
 * - `FETCH_TRUNCATE_BYTES` 是**截断阈值**，不是读取上限：响应带 content-length 且已超阈值时
 *   直接拒绝（too-large，不下载）；没有 content-length 时只能读完再按 UTF-8 字节截断，
 *   并标 `truncated=true`，此时内存峰值≈页面大小（超时/AbortController 兜底）。
 * - 安全：仅 https、端口仅 443、逐跳重定向重验、拒私网/凭据/IPv6、content-type 白名单、
 *   不执行 JS。v1 不做 DNS 解析后校验（写进报告的诚实边界）。
 * - 时间口径：所有时间戳来自 `deps.now()`；`setTimeout` 只用于超时/退避。
 */

import { Buffer } from "node:buffer";

import { assertPublicUrl } from "./policy.js";
import type {
  WebDeps,
  WebFetchBody,
  WebFetchFailureKind,
  WebFetchFailureKind2,
  WebFetchResult2,
  WebPageResult,
} from "./types.js";

/** 正文截断阈值（256KB）；注意这是截断阈值不是下载上限，见文件头。 */
export const FETCH_TRUNCATE_BYTES = 256 * 1024;
/** 返回给模型的正文最多多少字（默认值；工具可传 500–4000） */
export const FETCH_MAX_CHARS = 2_000;
/** 重定向逐跳上限 */
export const FETCH_REDIRECT_LIMIT = 3;
/** 允许的 content-type（媒体类型，忽略 charset 等参数） */
export const FETCH_ALLOWED_TYPES = ["text/html", "text/plain", "application/xhtml+xml"] as const;

const DEFAULT_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 250;
const LOG_URL_LIMIT = 120;

/** 整个抓取（含跳转与重试）的 deadline 到了：折成 timeout，不再发起下一次请求。 */
class FetchDeadlineExceeded extends Error {
  constructor() {
    super("fetch deadline exceeded");
    this.name = "FetchDeadlineExceeded";
  }
}

/** 距离整体 deadline 还剩多少毫秒；未设 deadline 视为无限。时钟走 `deps.now()`（lint:writers 禁止直连 Date.now）。 */
function remainingBudgetMs(deadlineAtMs: number | undefined, now: () => number): number {
  return deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : deadlineAtMs - now();
}

interface RawFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | undefined;
  /** F339：真实 Response 带 body 时优先流式读，超时能 cancel 掉底层下载 */
  readonly body?: WebFetchBody | null | undefined;
  text(): Promise<string>;
}

function truncateLogUrl(url: string): string {
  const chars = Array.from(url.replace(/\s+/g, " ").trim());
  return chars.length <= LOG_URL_LIMIT ? chars.join("") : `${chars.slice(0, LOG_URL_LIMIT).join("")}…`;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function failure(
  kind: WebFetchFailureKind2,
  status: number | null,
  url: string,
  deps: WebDeps,
): WebFetchResult2 {
  deps.log?.(`[web] fetch fail kind=${kind} status=${status === null ? "-" : String(status)} url=${truncateLogUrl(url)}`);
  return { ok: false, page: null, failure: kind, status };
}

function decodeEntities(text: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把 HTML 变成纯文本（无依赖的暴力提取）。
 *
 * 不追求完整 DOM 语义：去掉不可见容器、把块级标签换成换行、剥标签、解实体、压空白。
 * 复杂页面可能留下导航/页脚文字，这是 v1 的已知边界（见设计 §9）。
 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch === null ? "" : collapseWhitespace(decodeEntities(stripTags(titleMatch[1] ?? "")));
  let body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<br\b[^>]*>/gi, "\n");
  body = body.replace(
    /<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|main|aside|blockquote|pre)\b[^>]*>/gi,
    "\n",
  );
  body = stripTags(body);
  return { title, text: collapseWhitespace(decodeEntities(body)) };
}

/** 按 UTF-8 字节截断（不会切断多字节字符），返回截断后的文本与实际总字节数。 */
function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return { text: out, bytes, truncated: true };
}

async function doFetch(
  url: string,
  deps: WebDeps,
  timeoutMs: number,
  deadlineAtMs: number | undefined,
): Promise<RawFetchResponse> {
  const remaining = remainingBudgetMs(deadlineAtMs, deps.now);
  if (remaining <= 0) throw new FetchDeadlineExceeded();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, Math.min(timeoutMs, remaining));
  try {
    return await deps.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式读取响应正文（F339 / task-180 rev2）。
 *
 * 为什么这么做：`res.text()` 即使被 `Promise.race` 放弃，底层下载也不会停；而整个 body 共用一个
 * 定时器又会把「body 总时长」压成单次超时（两片各 5s 会在 8s 被误杀）。所以：
 * - 每次 `reader.read()` 单独与 `min(timeoutMs, 剩余 deadline)` 赛跑，每次 read 前重算剩余；
 * - 整体 deadline 仍生效：剩余 ≤0 时不再发起 read，先 `reader.cancel()` 放掉已取得的流再抛
 *   `FetchDeadlineExceeded`（supervisor rev2 B2：只抛不 cancel 会留下半开连接/未释放的 reader）；
 * - 单次 read 超时先 `reader.cancel()` 真正中止下载（cancel 的异常忽略），再抛 `FetchDeadlineExceeded`；
 * - 不按字节提前停：`bytes` 仍报页面原始字节数，截断语义留给调用方的 `truncateUtf8`。
 */
async function readBodyStream(
  body: WebFetchBody,
  deps: WebDeps,
  timeoutMs: number,
  deadlineAtMs: number | undefined,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const remaining = remainingBudgetMs(deadlineAtMs, deps.now);
    if (remaining <= 0) {
      // supervisor rev2 B2：整体预算耗尽时也要先把已取得的 reader 放掉，否则连接/流仍占着。
      try {
        await reader.cancel?.();
      } catch {
        // cancel 自己失败不改变结局：这次读取本来就是被放弃的。
      }
      throw new FetchDeadlineExceeded();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new FetchDeadlineExceeded());
      }, Math.min(timeoutMs, remaining));
    });
    try {
      const piece = await Promise.race([reader.read(), expired]);
      if (piece.done) break;
      if (piece.value !== undefined && piece.value.byteLength > 0) chunks.push(piece.value);
    } catch (err) {
      if (timedOut) {
        try {
          await reader.cancel?.();
        } catch {
          // cancel 自己失败不改变结局：这次读取本来就是被放弃的。
        }
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 读取响应正文，同样受单次超时与整体 deadline 约束。
 *
 * task-173 B1：响应头返回不代表正文有保护——`doFetch` 的 AbortController 在拿到响应头后就清掉了，
 * 如果服务端慢慢吐 body（或无 content-length 的大页面），24s/25s 的总预算会失效。
 * F339：有 `body` 时走 `readBodyStream()`（超时能 cancel 掉真实下载）；没有 body 的旧实现
 * 回退到 `res.text()` + 同一预算的计时器（行为与 task-173 一致）。
 */
async function readBodyWithDeadline(
  res: RawFetchResponse,
  deps: WebDeps,
  timeoutMs: number,
  deadlineAtMs: number | undefined,
): Promise<string> {
  if (res.body !== undefined && res.body !== null && typeof res.body.getReader === "function") {
    return readBodyStream(res.body, deps, timeoutMs, deadlineAtMs);
  }
  const remaining = remainingBudgetMs(deadlineAtMs, deps.now);
  if (remaining <= 0) throw new FetchDeadlineExceeded();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, Math.min(timeoutMs, remaining));
  try {
    return await Promise.race([
      res.text(),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new FetchDeadlineExceeded());
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 429/5xx 退避 250ms 后只重试一次；超时/网络/其它状态不重试。整体 deadline 在每次尝试前检查。 */
async function fetchWithRetry(  url: string,
  deps: WebDeps,
  timeoutMs: number,
  deadlineAtMs: number | undefined,
): Promise<RawFetchResponse> {
  let attempt = 0;
  for (;;) {
    const res = await doFetch(url, deps, timeoutMs, deadlineAtMs);
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      // 重试前先看预算：剩余不够一次退避就按 timeout 结束，不再发第二次请求。
      if (remainingBudgetMs(deadlineAtMs, deps.now) <= RETRY_DELAY_MS) throw new FetchDeadlineExceeded();
      attempt += 1;
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    return res;
  }
}

/**
 * 抓一个网页并返回可读正文（F1 主入口）。所有失败都折成 `WebFetchResult2`，不抛业务异常。
 * `opts.maxChars` 决定正文最多多少字（默认 `FETCH_MAX_CHARS`）。
 */
export async function fetchPageText(
  url: string,
  deps: WebDeps,
  opts: { readonly maxChars?: number; readonly deadlineAtMs?: number } = {},
): Promise<WebFetchResult2> {
  const maxChars = opts.maxChars ?? FETCH_MAX_CHARS;
  const deadlineAtMs = opts.deadlineAtMs;
  let current: URL;
  try {
    current = assertPublicUrl(url);
  } catch {
    return failure("blocked", null, url, deps);
  }
  const startUrl = current.href;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let hop = 0; hop <= FETCH_REDIRECT_LIMIT; hop += 1) {
    let res: RawFetchResponse;
    try {
      res = await fetchWithRetry(current.href, deps, timeoutMs, deadlineAtMs);
    } catch (err) {
      const isTimeout = err instanceof FetchDeadlineExceeded || isAbortError(err);
      return failure(isTimeout ? "timeout" : "network", null, current.href, deps);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get("location") ?? null;
      if (location === null || hop >= FETCH_REDIRECT_LIMIT) {
        return failure("http", res.status, current.href, deps);
      }
      try {
        current = assertPublicUrl(new URL(location, current).href);
      } catch {
        return failure("blocked", res.status, current.href, deps);
      }
      continue;
    }
    if (!res.ok) {
      const kind: WebFetchFailureKind2 =
        res.status === 404
          ? "not-found"
          : res.status === 429
            ? "rate-limit"
            : res.status >= 500
              ? "server"
              : "http";
      return failure(kind, res.status, current.href, deps);
    }

    const contentType = ((res.headers?.get("content-type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
    if (contentType === "") {
      deps.log?.(`[web] fetch content-type 缺失，按 text/html 处理 url=${truncateLogUrl(current.href)}`);
    } else if (!(FETCH_ALLOWED_TYPES as readonly string[]).includes(contentType)) {
      return failure("unsupported-type", res.status, current.href, deps);
    }

    const contentLengthRaw = res.headers?.get("content-length") ?? "";
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > FETCH_TRUNCATE_BYTES) {
      return failure("too-large", res.status, current.href, deps);
    }

    let raw: string;
    try {
      // task-173 B1：正文读取也要受整体 deadline 约束（响应头先回、body 卡住时必须仍能超时）。
      raw = await readBodyWithDeadline(res, deps, timeoutMs, deadlineAtMs);
    } catch (err) {
      const isTimeout = err instanceof FetchDeadlineExceeded || isAbortError(err);
      return failure(isTimeout ? "timeout" : "network", res.status, current.href, deps);
    }
    const truncated = truncateUtf8(raw, FETCH_TRUNCATE_BYTES);
    const parsed = htmlToText(truncated.text);
    if (parsed.text === "") {
      return failure("parse", res.status, current.href, deps);
    }
    const text = Array.from(parsed.text).slice(0, maxChars).join("");
    deps.log?.(
      `[web] fetch ok status=${String(res.status)} bytes=${String(truncated.bytes)}` +
        ` truncated=${String(truncated.truncated)} chars=${String(Array.from(text).length)} url=${truncateLogUrl(startUrl)}`,
    );
    return {
      ok: true,
      page: {
        url: startUrl,
        finalUrl: current.href,
        title: parsed.title,
        text,
        truncated: truncated.truncated,
        bytes: truncated.bytes,
        fetchedAtMs: deps.now(),
      },
      failure: null,
      status: res.status,
    };
  }
  return failure("blocked", null, startUrl, deps);
}

/**
 * 兼容旧调用方的抓取入口（W3 预留形状）：委托 `fetchPageText`，丢掉 title/truncated 等新字段。
 * 新代码请直接用 `fetchPageText`。
 */
export async function fetchPage(url: string, deps: WebDeps): Promise<WebPageResult> {
  const result = await fetchPageText(url, deps);
  if (!result.ok || result.page === null) {
    // 旧形状的 failure 联合类型没有 too-large/unsupported-type，兼容层折成 http。
    const legacyFailure: WebFetchFailureKind =
      result.failure === "too-large" || result.failure === "unsupported-type" ? "http" : (result.failure ?? "http");
    return { ok: false, page: null, failure: legacyFailure, status: result.status };
  }
  return {
    ok: true,
    page: {
      url: result.page.finalUrl,
      title: result.page.title,
      content: result.page.text,
      fetchedAtMs: result.page.fetchedAtMs,
    },
    failure: null,
    status: result.status,
  };
}
