/**
 * 网页能力（W1）的 barrel：装配层只从这一个入口 import。
 *
 * 显式列名而不是 `export *`：让"这一层对外承诺什么"一眼可见（与 `src/ports` 的
 * 类型转出同一个理由——边界要能被读出来）。
 */

export type {
  LearningWebPlan,
  WebDeps,
  WebFetchFailureKind,
  WebFetchFailureKind2,
  WebFetchLike,
  WebFetchPage,
  WebFetchResult2,
  WebPage,
  WebPageResult,
  WebSearchFailureKind,
  WebSearchHit,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";
export {
  FETCH_ALLOWED_TYPES,
  FETCH_MAX_CHARS,
  FETCH_REDIRECT_LIMIT,
  FETCH_TRUNCATE_BYTES,
  fetchPageText,
  htmlToText,
} from "./fetch.js";
export {
  WEB_FETCH_MAX_CHARS_DEFAULT,
  WEB_FETCH_MAX_CHARS_MAX,
  WEB_FETCH_MAX_CHARS_MIN,
  WEB_FETCH_URL_MAX,
  WEB_FETCH_URL_MIN,
  runWebFetch,
} from "./fetch-run.js";
export type { WebFetchRunInput, WebFetchRunResult } from "./fetch-run.js";
export { WebPolicyError, WEB_QUERY_SOURCES, WEB_TOOL_QUERY_MAX, WEB_TOOL_QUERY_MIN, assertPublicUrl, assertSearchRequest } from "./policy.js";
export type { WebPolicyReason } from "./policy.js";
export { WEB_CONFIG_DEFAULTS, readWebConfig } from "./config.js";
export type { WebConfig } from "./config.js";
export {
  DEFAULT_SEARCH_TIMEOUT_MS,
  FETCH_CONTENT_LIMIT,
  LEARNING_SEARCH_COUNT,
  LOG_QUERY_LIMIT,
  RETRY_DELAY_MS,
  fetchPage,
  parsePublishedAtMs,
  searchForLearning,
  searchForTool,
} from "./search.js";
export {
  WEB_FRESHNESS,
  WEB_NEWS_WINDOW_MS,
  WEB_OBJECTIVE_FRESHNESS,
  WEB_SOCIAL_FRESHNESS,
  WEB_SOURCE,
  WEB_SOURCE_CREDIBILITY,
  WEB_SUMMARY_LIMIT,
  distillHit,
  ingestHits,
} from "./ingest.js";
export type { WebDistilled, WebIngestResult } from "./ingest.js";
export {
  WEB_DEFAULT_TZ_OFFSET_MINUTES,
  WEB_USAGE_VERSION,
  canFetch,
  canSearch,
  consumeFetch,
  consumeSearch,
  emptyWebUsage,
  localDateOf,
  normalizeWebUsage,
  touchFetchAttempt,
  touchSearchAttempt,
} from "./budget.js";
export type { WebBudgetConfig, WebBudgetGate, WebUsage } from "./budget.js";
export {
  WEB_TOOL_DEFAULT_COUNT,
  WEB_TOOL_FRESH_WINDOW_MS,
  WEB_TOOL_MAX_COUNT,
  WEB_TOOL_RATE_LIMIT_RETRY_MS,
  runWebToolSearch,
} from "./tool-run.js";
export type { WebToolResult, WebToolRunInput, WebToolRunResult } from "./tool-run.js";
