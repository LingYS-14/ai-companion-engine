/**
 * `soul_web_fetch` 的 daemon 侧纯编排（F1）。
 *
 * 设计：`.tmp/handover/design-web-fetch.md` v2 §4。职责只有「闸 → 执行 → 记账」：
 *   1. 开关（复用 `WEB_SEARCH_ENABLED`）→ 凭据 → 共享抓取额度/最小间隔；
 *   2. 参数校验（url 长度/单行/控制字符；maxChars 500–4000）；
 *   3. **先记尝试**（失败也占一次最小间隔，避免失败风暴）→ 调 `fetch`；
 *   4. 成功且正文非空才 consume（日计数只加成功），账本由调用方落盘。
 *
 * 本文件不读时钟、不写盘、不联网：`nowMs`/`usage` 由装配层传入，`fetch` 由装配层注入。
 */

import { canFetch, consumeFetch, touchFetchAttempt, type WebUsage } from "./budget.js";
import type { WebConfig } from "./config.js";
import type { WebFetchFailureKind2, WebFetchResult2 } from "./types.js";
import type { WebFetchResult } from "../autonomy/write-protocol.js";

/** 工具允许的 url 长度（trim 后） */
export const WEB_FETCH_URL_MIN = 8;
export const WEB_FETCH_URL_MAX = 2_048;
/** 工具允许的正文长度 */
export const WEB_FETCH_MAX_CHARS_MIN = 500;
export const WEB_FETCH_MAX_CHARS_MAX = 4_000;
export const WEB_FETCH_MAX_CHARS_DEFAULT = 2_000;
/**
 * 单次抓取的整体预算（含跳转与重试）。插件侧工具超时 25s，这里留 1s 余量；
 * `fetchPageText` 每次尝试的超时取 `min(timeoutMs, 剩余预算)`，预算耗尽直接 timeout。
 */
export const WEB_FETCH_TOTAL_BUDGET_MS = 24_000;
/** 编排层也做一遍地址形状校验（不只依赖执行层），拦截 http/非 443/带凭据/非法 URL。 */
const BLOCKED_MESSAGE = "这个地址不允许抓取（只允许 https + 公网 + 443 端口）";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface WebFetchRunInput {
  readonly url: string;
  readonly maxChars?: number | undefined;
  readonly nowMs: number;
  readonly cfg: WebConfig;
  readonly usage: WebUsage;
  readonly hasKey: boolean;
  /** 真正的抓取（装配层注入 `fetchPageText`；测试用假实现，禁止真连网） */
  readonly fetch: (
    url: string,
    opts: { readonly maxChars: number; readonly deadlineAtMs: number },
  ) => Promise<WebFetchResult2>;
}

export interface WebFetchRunResult {
  readonly result: WebFetchResult;
  readonly usage: WebUsage;
}

function statsOf(usage: WebUsage, cfg: WebConfig): WebFetchResult["stats"] {
  return { fetchCount: usage.fetchCount, dailyCap: cfg.fetchDailyCap };
}

function fail(
  usage: WebUsage,
  cfg: WebConfig,
  code: string,
  message: string,
  extra: { readonly failure?: string | null; readonly retryAfterMs?: number | null } = {},
): WebFetchRunResult {
  return {
    result: {
      ok: false,
      code,
      url: null,
      finalUrl: null,
      title: null,
      text: null,
      truncated: false,
      bytes: 0,
      fetchedAtMs: null,
      failure: extra.failure ?? null,
      message,
      retryAfterMs: extra.retryAfterMs ?? null,
      stats: statsOf(usage, cfg),
    },
    usage,
  };
}

const FAILURE_CODE: Readonly<Record<WebFetchFailureKind2, string>> = {
  blocked: "WEB_BLOCKED",
  timeout: "WEB_TIMEOUT",
  network: "WEB_NETWORK",
  http: "WEB_HTTP",
  "not-found": "WEB_NOT_FOUND",
  "rate-limit": "WEB_RATE_LIMIT",
  server: "WEB_SERVER",
  "too-large": "WEB_TOO_LARGE",
  "unsupported-type": "WEB_UNSUPPORTED_TYPE",
  parse: "WEB_PARSE",
};

const FAILURE_MESSAGE: Readonly<Record<WebFetchFailureKind2, string>> = {
  blocked: "这个地址不允许抓取（只允许 https + 公网 + 443 端口）",
  timeout: "抓取超时",
  network: "网络错误",
  http: "网页返回了错误状态",
  "not-found": "网页不存在（404）",
  "rate-limit": "对方限流（429）",
  server: "对方服务器错误（5xx）",
  "too-large": "网页太大，超过 256KB 截断阈值",
  "unsupported-type": "网页类型不是可读文本（只收 html/纯文本/xhtml）",
  parse: "抓到了内容但没能提取出正文",
};

/** 参数校验；返回 null 表示通过。 */
function normalizeRequest(
  input: WebFetchRunInput,
): { url: string; maxChars: number } | { code: string; message: string; failure?: string } {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (url.length < WEB_FETCH_URL_MIN || url.length > WEB_FETCH_URL_MAX || CONTROL_CHARS.test(url)) {
    return { code: "WEB_BAD_REQUEST", message: `url 要是 ${WEB_FETCH_URL_MIN}–${WEB_FETCH_URL_MAX} 字的单行地址` };
  }
  // 编排层先卡地址形状：http/非 443/内嵌凭据/解析不了都不进执行层，也不 touch 额度。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { code: "WEB_BLOCKED", message: BLOCKED_MESSAGE, failure: "blocked" };
  }
  if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443")) {
    return { code: "WEB_BLOCKED", message: BLOCKED_MESSAGE, failure: "blocked" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { code: "WEB_BLOCKED", message: BLOCKED_MESSAGE, failure: "blocked" };
  }
  if (input.maxChars === undefined) return { url, maxChars: WEB_FETCH_MAX_CHARS_DEFAULT };
  if (
    !Number.isInteger(input.maxChars) ||
    input.maxChars < WEB_FETCH_MAX_CHARS_MIN ||
    input.maxChars > WEB_FETCH_MAX_CHARS_MAX
  ) {
    return {
      code: "WEB_BAD_REQUEST",
      message: `maxChars 要是 ${WEB_FETCH_MAX_CHARS_MIN}–${WEB_FETCH_MAX_CHARS_MAX} 的整数`,
    };
  }
  return { url, maxChars: input.maxChars };
}

/**
 * 抓取工具的一轮纯编排：闸、参数、尝试记账、执行、成功计数。
 * 所有失败都以 `ok:false` + 业务码返回，不抛异常（异常折成 WEB_INTERNAL）。
 */
export async function runWebFetch(input: WebFetchRunInput): Promise<WebFetchRunResult> {
  const { nowMs, cfg, usage, hasKey } = input;
  if (!cfg.enabled) {
    return fail(usage, cfg, "WEB_DISABLED", "网页能力没开（WEB_SEARCH_ENABLED=0）");
  }
  if (!hasKey) {
    return fail(usage, cfg, "WEB_NO_KEY", "没有模型凭据（抓取与模型共用 key）");
  }
  const gate = canFetch(nowMs, usage, cfg);
  if (!gate.allowed) {
    if (gate.reason === "daily-cap") {
      return fail(usage, cfg, "WEB_BUDGET_DAILY", `今日抓取额度已用完（${String(cfg.fetchDailyCap)} 次）`);
    }
    const retryAfterMs =
      usage.lastFetchAtMs === null ? cfg.minIntervalMs : Math.max(1, cfg.minIntervalMs - (nowMs - usage.lastFetchAtMs));
    return fail(usage, cfg, "WEB_BUDGET_INTERVAL", "抓取太频繁，等一会儿再试", { retryAfterMs });
  }
  const request = normalizeRequest(input);
  if ("code" in request) {
    return fail(usage, cfg, request.code, request.message, {
      ...(request.failure === undefined ? {} : { failure: request.failure }),
    });
  }

  // 先记尝试再发请求：失败也算用掉一次最小间隔，避免失败风暴（日计数只加成功）。
  const touched = touchFetchAttempt(usage, nowMs);
  let result: WebFetchResult2;
  try {
    result = await input.fetch(request.url, {
      maxChars: request.maxChars,
      deadlineAtMs: nowMs + WEB_FETCH_TOTAL_BUDGET_MS,
    });
  } catch (err) {
    return fail(touched, cfg, "WEB_INTERNAL", err instanceof Error ? err.message : String(err), {
      failure: "network",
    });
  }
  if (!result.ok || result.page === null) {
    const kind: WebFetchFailureKind2 = result.failure ?? "http";
    return fail(touched, cfg, FAILURE_CODE[kind], FAILURE_MESSAGE[kind], { failure: kind });
  }
  const page = result.page;
  const consumed = page.text === "" ? touched : consumeFetch(touched, nowMs);
  return {
    result: {
      ok: true,
      code: null,
      url: page.url,
      finalUrl: page.finalUrl,
      title: page.title === "" ? null : page.title,
      text: page.text,
      truncated: page.truncated,
      bytes: page.bytes,
      fetchedAtMs: page.fetchedAtMs,
      failure: null,
      message: null,
      retryAfterMs: null,
      stats: statsOf(consumed, cfg),
    },
    usage: consumed,
  };
}
