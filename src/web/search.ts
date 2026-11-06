/**
 * 网页搜索 / 抓取的执行层（W1 只接搜索；抓取是 W3 的预留形状，W1 不接线）。
 *
 * spec v2.3 §5.2 / §6.1：
 *   - 对外只有 `searchForLearning(plan, deps)`、`searchForTool(query, deps)`、`fetchPage(url, deps)`；
 *   - 内部 `searchWeb(req, deps)` 不导出——URL 校验、重试、超时、日志截断都收在这里，
 *     装配层不许绕过它直接调 fetch；
 *   - 日志只记 query 前 40 字与计数，错误对象不带 query 原文、不带 key。
 *
 * 重试口径：403/404 不重试；429/5xx 退避 250ms 后**只重试一次**；超时不重试。
 * 时间口径：超时定时器用 `setTimeout`，但对外时间戳只来自 `deps.now()`。
 */

import type { LearningWebPlan } from "../ports/index.js";
import { WebPolicyError, assertPublicUrl, assertSearchRequest } from "./policy.js";
import { FETCH_MAX_CHARS, fetchPage as fetchPageCompat } from "./fetch.js";
import type {
  WebDeps,
  WebPageResult,
  WebSearchFailureKind,
  WebSearchHit,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";

export const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
/** 429/5xx 的重试退避（只重试一次） */
export const RETRY_DELAY_MS = 250;
/** 学习路径固定取 5 条（再按 authority/rerank 收窄到前 2 条落库） */
export const LEARNING_SEARCH_COUNT = 5;
/** 日志里 query 最多截 40 字（隐私口径） */
export const LOG_QUERY_LIMIT = 40;
/** 抓取正文只取前 2000 字（W3；F1 的默认值沿用同一个数） */
export const FETCH_CONTENT_LIMIT = FETCH_MAX_CHARS;

interface RawResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly location: string | null;
}

function truncateLogQuery(query: string): string {
  const chars = Array.from(query.replace(/\s+/g, " ").trim());
  return chars.length <= LOG_QUERY_LIMIT ? chars.join("") : `${chars.slice(0, LOG_QUERY_LIMIT).join("")}…`;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function failure(kind: WebSearchFailureKind, status: number | null, query: string, log: WebDeps["log"]): WebSearchResult {
  log?.(`[web] fail kind=${kind} status=${status === null ? "-" : String(status)} query=${truncateLogQuery(query)}`);
  return { ok: false, hits: [], failure: kind, status };
}

function failureKindOf(status: number): WebSearchFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 403 || status === 404) return "http";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "http";
}

/** 纯算术把 YYYY-MM-DD 转成 UTC 毫秒（不用 Date，避免 lint:writers 限制） */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** 解析 API 的 date 字段（支持 YYYY-MM-DD 与 ISO 前缀）；解析不了返回 null */
export function parsePublishedAtMs(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return daysFromCivil(year, month, day) * 86_400_000;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** API 的 results[] → 内部命中（URL 过不了公网校验的直接丢） */
function mapHits(raw: unknown): WebSearchHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: WebSearchHit[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = toText(rec.url);
    const title = toText(rec.title);
    if (url.length === 0) continue;
    try {
      assertPublicUrl(url);
    } catch {
      continue;
    }
    hits.push({
      title,
      url,
      snippet: toText(rec.snippet),
      siteName: toText(rec.site_name),
      publishedAtMs: parsePublishedAtMs(rec.date),
      authority: Math.trunc(toNumber(rec.authority, 0)),
      rerankScore: Math.trunc(toNumber(rec.rerank_score, 0)),
      summary: toText(rec.summary),
    });
  }
  return hits;
}

async function request(
  input: string,
  body: string,
  deps: WebDeps,
): Promise<RawResponse> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(input, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, location: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 内部搜索：校验 → 请求（429/5xx 重试一次）→ 解析。
 * 不直接导出：对外只给 `searchForLearning` / `searchForTool` 两种口径。
 */
async function searchWeb(req: WebSearchRequest, deps: WebDeps): Promise<WebSearchResult> {
  try {
    assertSearchRequest(req);
  } catch (err) {
    const kind = err instanceof WebPolicyError ? "blocked" : "parse";
    return failure(kind, null, req.query, deps.log);
  }

  const endpoint = `${deps.baseUrl.replace(/\/+$/, "")}/v1/tools/search`;
  const payload = JSON.stringify({ query: req.query, count: req.count });

  let res: RawResponse;
  try {
    res = await request(endpoint, payload, deps);
  } catch (err) {
    const kind = isAbortError(err) ? "timeout" : "network";
    return failure(kind, null, req.query, deps.log);
  }

  let kindOfStatus = failureKindOf(res.status);
  if (kindOfStatus === "rate-limit" || kindOfStatus === "server") {
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      res = await request(endpoint, payload, deps);
      kindOfStatus = failureKindOf(res.status);
    } catch (err) {
      const kind = isAbortError(err) ? "timeout" : "network";
      return failure(kind, null, req.query, deps.log);
    }
  }
  if (kindOfStatus !== null) return failure(kindOfStatus, res.status, req.query, deps.log);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return failure("parse", res.status, req.query, deps.log);
  }
  const results =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (results === null) return failure("parse", res.status, req.query, deps.log);

  const hits = mapHits(results);
  deps.log?.(`[web] search hits=${String(hits.length)} query=${truncateLogQuery(req.query)}`);
  return { ok: true, hits, failure: null, status: res.status };
}

/**
 * 学习路径的搜索入口：`plan.allowSearch=false` 时**不发请求**直接空结果。
 * 这是脊髓层的"该不该查"与装配层的"能不能查"之间的合同。
 */
export async function searchForLearning(plan: LearningWebPlan, deps: WebDeps): Promise<WebSearchResult> {
  if (!plan.allowSearch) return { ok: true, hits: [], failure: null, status: null };
  return searchWeb(
    { query: plan.keyword, count: LEARNING_SEARCH_COUNT, querySource: plan.querySource, planKeyword: plan.keyword },
    deps,
  );
}

/** W2 的交互面入口（W1 不接线；自由文本限长在 policy 里） */
export async function searchForTool(
  query: string,
  deps: WebDeps,
  count: number = LEARNING_SEARCH_COUNT,
): Promise<WebSearchResult> {
  // task-138：工具面由调用方给 count（1–10，已在 policy/tool-run 侧 clamp）；
  // learning 路径保持 LEARNING_SEARCH_COUNT 不变，避免两个入口互相改口径。
  return searchWeb({ query, count, querySource: "tool" }, deps);
}

/**
 * GET 一个网页（W3 预留形状）。
 *
 * F1 起实现搬到 `fetch.ts`（带 title/截断/content-type/逐跳重定向）；这里只保留旧签名做
 * 兼容委托——新代码请直接用 `fetchPageText`（返回更完整的 `WebFetchResult2`）。
 */
export async function fetchPage(url: string, deps: WebDeps): Promise<WebPageResult> {
  return fetchPageCompat(url, deps);
}
