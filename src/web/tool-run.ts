/**
 * task-138：`soul_web_search` 的纯编排（daemon 代理入口）。
 *
 * 为什么单独一层：插件进程没有 key、不写额度账本、也不该碰 URL 校验；
 * 真正的闸（开关 → 凭据 → 共享额度 → 发起 → 成功计数 → fresh 过滤 → clamp）都在这里，
 * 用纯函数表达，测试可以注入假 search，禁止真连网。
 *
 * 口径（design-web-tool v4 §2.2 / §3.3）：
 * - 预算与 learning 共用 `data/web-usage-<id>.json`；只有「成功且结果非空」才 consume，
 *   发起尝试（无论成功失败）都会把 lastSearchAtMs 推到 now（由装配层落盘）。
 * - `fresh=true` 时按服务端 `published_at` 保留 7 天内；若全都太旧 → 返回空 + 标记，
 *   **不回退旧结果**（旧闻不算"新的"）。
 * - 这里不碰 memory/knowledge：工具面默认只读，要记住由模型另调 soul_remember(source="web")。
 */

import type { WebSearchFailureKind, WebSearchHit, WebSearchResult } from "./types.js";
import type { WebConfig } from "./config.js";
import type { WebUsage } from "./budget.js";
import { canSearch, consumeSearch, touchSearchAttempt } from "./budget.js";
import { WEB_TOOL_QUERY_MAX, WEB_TOOL_QUERY_MIN } from "./policy.js";
import type { WebSearchHitPayload, WebSearchResult as ChannelWebSearchResult } from "../autonomy/write-protocol.js";

/** 工具默认返回条数（design §2.2：maxResults 默认 5）。 */
export const WEB_TOOL_DEFAULT_COUNT = 5;
/** 工具面单次上限（design §2.2：1–10）。 */
export const WEB_TOOL_MAX_COUNT = 10;
/** fresh=true 的"新"窗口：7 天（design v4 §2.3）。 */
export const WEB_TOOL_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 限流时给调用方的退避建议（design §3.3 示例 retryAfter=12m）。 */
export const WEB_TOOL_RATE_LIMIT_RETRY_MS = 12 * 60 * 1000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** 工具面对插件承诺的结果形状（物理通道上仍是 WebSearchResult + fresh）。 */
export interface WebToolResult extends ChannelWebSearchResult {
  /** 本次是否启动了 fresh 过滤（插件据此把「全旧」与「真没有」说清楚）。 */
  readonly fresh: boolean;
}

export interface WebToolRunResult {
  readonly result: WebToolResult;
  readonly usage: WebUsage;
}

export interface WebToolRunInput {
  /** 已由插件侧 trim 过的自由文本（这里仍会再校一次，daemon 不信任调用方）。 */
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly fresh: boolean;
  readonly nowMs: number;
  readonly cfg: WebConfig;
  /** 当前账本（纯函数不修改它；返回新对象由装配层落盘）。 */
  readonly usage: WebUsage;
  readonly hasKey: boolean;
  readonly search: (query: string, count: number) => Promise<WebSearchResult>;
}

function clampCount(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return WEB_TOOL_DEFAULT_COUNT;
  return Math.max(1, Math.min(WEB_TOOL_MAX_COUNT, Math.trunc(raw)));
}

function toPayload(hit: WebSearchHit): WebSearchHitPayload {
  return {
    title: hit.title,
    url: hit.url,
    snippet: hit.snippet,
    siteName: hit.siteName ?? null,
    publishedAtMs: hit.publishedAtMs ?? null,
    authority: hit.authority,
  };
}

const FAILURE_CODE: Readonly<Record<WebSearchFailureKind, string>> = {
  blocked: "WEB_BLOCKED",
  timeout: "WEB_TIMEOUT",
  http: "WEB_HTTP",
  "rate-limit": "WEB_RATE_LIMIT",
  server: "WEB_SERVER",
  network: "WEB_NETWORK",
  parse: "WEB_PARSE",
};

function failureMessage(kind: WebSearchFailureKind | null, status: number | null): string {
  if (kind === "blocked") return `关键词不合法（${WEB_TOOL_QUERY_MIN}–${WEB_TOOL_QUERY_MAX} 字、单行）`;
  if (kind === "timeout") return "搜索超时";
  if (kind === "http") return `搜索被服务端拒绝（HTTP ${status === null ? "?" : String(status)}）`;
  if (kind === "rate-limit") return "搜索服务限流，稍后再试";
  if (kind === "server") return "搜索服务暂时不可用";
  if (kind === "network") return "网络不通";
  if (kind === "parse") return "搜索返回看不懂";
  return "搜索失败";
}

/**
 * 执行一次工具面搜索。纯函数：不读时钟、不联网、不写盘；失败也返回结构化 code，
 * 让插件能给出"能照着行动"的提示（而不是一句模糊错误）。
 */
export async function runWebToolSearch(input: WebToolRunInput): Promise<WebToolRunResult> {
  let usage = input.usage;
  const dailyCap = input.cfg.searchDailyCap;
  const stats = () => ({ searchCount: usage.searchCount, dailyCap });

  const fail = (code: string, message: string, retryAfterMs: number | null = null): WebToolRunResult => ({
    result: { ok: false, code, hits: [], failure: null, message, retryAfterMs, stats: stats(), fresh: false },
    usage,
  });

  if (!Number.isFinite(input.nowMs)) return fail("WEB_INTERNAL", "内部时钟不可用");
  const query = input.query.trim();
  if (query.length < WEB_TOOL_QUERY_MIN || query.length > WEB_TOOL_QUERY_MAX || CONTROL_CHARS.test(query)) {
    return fail("WEB_BLOCKED", `query 要是 ${WEB_TOOL_QUERY_MIN}–${WEB_TOOL_QUERY_MAX} 字的一行文本`);
  }
  const count = clampCount(input.maxResults);

  if (!input.cfg.enabled) return fail("WEB_DISABLED", "网页搜索没开（WEB_SEARCH_ENABLED=0）");
  if (!input.hasKey) return fail("WEB_NO_KEY", "没有模型凭据（Search 与模型共用 key）");

  const gate = canSearch(input.nowMs, usage, input.cfg);
  if (!gate.allowed) {
    if (gate.reason === "daily-cap") {
      return fail("WEB_BUDGET_DAILY", `今天的网页搜索额度用完了（${String(dailyCap)} 次）`);
    }
    const last = usage.lastSearchAtMs;
    const retryAfterMs = last === null ? 0 : Math.max(0, input.cfg.minIntervalMs - (input.nowMs - last));
    return fail("WEB_BUDGET_INTERVAL", `刚查过网页，${String(Math.max(1, Math.ceil(retryAfterMs / 60_000)))} 分钟后再试`, retryAfterMs);
  }

  // 先记「尝试」再发请求：失败也算用掉一次最小间隔，避免失败风暴（日计数只加成功）。
  usage = touchSearchAttempt(usage, input.nowMs);

  let res: WebSearchResult;
  try {
    res = await input.search(query, count);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail("WEB_INTERNAL", `搜索内部错误：${detail}`);
  }

  if (!res.ok) {
    const kind = res.failure;
    const code = kind === null ? "WEB_INTERNAL" : (FAILURE_CODE[kind] ?? "WEB_INTERNAL");
    const retryAfterMs = kind === "rate-limit" ? WEB_TOOL_RATE_LIMIT_RETRY_MS : null;
    return {
      result: {
        ok: false,
        code,
        hits: [],
        failure: kind,
        message: failureMessage(kind, res.status),
        retryAfterMs,
        stats: stats(),
        fresh: false,
      },
      usage,
    };
  }

  if (res.hits.length > 0) usage = consumeSearch(usage, input.nowMs);

  const mapped = res.hits.map(toPayload);
  const filtered = input.fresh
    ? mapped.filter((hit) => hit.publishedAtMs !== null && input.nowMs - hit.publishedAtMs <= WEB_TOOL_FRESH_WINDOW_MS)
    : mapped;
  const hits = filtered.slice(0, count);
  const message =
    hits.length > 0
      ? null
      : input.fresh && filtered.length === 0 && mapped.length > 0
        ? "没有新的（fresh=true：只保留 7 天内的结果，全是旧闻）"
        : "没有结果";

  return {
    result: {
      ok: true,
      code: null,
      hits,
      failure: null,
      message,
      retryAfterMs: null,
      stats: stats(),
      fresh: input.fresh,
    },
    usage,
  };
}
