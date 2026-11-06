/**
 * 网页能力（W1）的公共形状与注入依赖。
 *
 * 分层（`spec/config/layers.json`）：本目录属 **tools**，只允许 import `src/ports/` 与
 * Node 内置；不 import engine/autonomy/orchestrator（R3），也不 import `src/dialogue/**`。
 *
 * 时间口径：本目录内**禁止直接读系统时钟**（`npm run lint:writers` 会抓）——
 * 所有时间都由调用方以 `nowMs` 传进来，方便测试与回放。
 */

import type { LearningWebPlan } from "../ports/index.js";

/** 脊髓层产出的计划形状只在这里转出一份（定义在 `src/ports/index.ts`，不复制） */
export type { LearningWebPlan };

/** Search 返回的一条结果（DeepSeek Search API 的 results[]，只留下游要用的字段） */
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** API 的 site_name；缺失按空串 */
  readonly siteName: string;
  /** 结果发布时间（毫秒）；API 没给 date 或解析不了时为 null */
  readonly publishedAtMs: number | null;
  /** 权威度 0–4（API 的 authority）；缺失按 0 */
  readonly authority: number;
  /** 重排分 0–3（API 的 rerank_score）；缺失按 0 */
  readonly rerankScore: number;
  /** 长摘要（API 的 summary，600–800 字）；W1 只用于落库内容的截断 */
  readonly summary: string;
}

/** 一次搜索失败的种类：日志/降级只按它分流，不把原始 query 或 key 带出去 */
export type WebSearchFailureKind =
  | "blocked"
  | "timeout"
  | "http"
  | "rate-limit"
  | "server"
  | "network"
  | "parse";

export interface WebSearchResult {
  readonly ok: boolean;
  readonly hits: readonly WebSearchHit[];
  /** ok=false 时给；ok=true 时为 null */
  readonly failure: WebSearchFailureKind | null;
  readonly status: number | null;
}

/** 请求形状（`policy.assertSearchRequest` 校验的就是它） */
export interface WebSearchRequest {
  readonly query: string;
  readonly count: number;
  readonly querySource: "learning-plan" | "hot-topic" | "tool";
  /**
   * learning-plan / hot-topic 必填，且必须与 query 完全一致。
   * 隐私口径：学习路径的 query 只能来自学习计划/热榜，不能来自聊天原文或记忆正文。
   */
  readonly planKeyword?: string;
}

/** W3 才用：抓回来的网页正文 */
export interface WebPage {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly fetchedAtMs: number;
}

/** 抓网页的失败种类；W1 不执行抓取，只保留形状给 W3 */
export type WebFetchFailureKind = WebSearchFailureKind | "not-found";

export interface WebPageResult {
  readonly ok: boolean;
  readonly page: WebPage | null;
  readonly failure: WebFetchFailureKind | null;
  readonly status: number | null;
}

/** F1（soul_web_fetch）的失败分类；比 W3 预留形状多了大小/类型/解析三类。 */
export type WebFetchFailureKind2 =
  | "blocked"
  | "timeout"
  | "network"
  | "http"
  | "not-found"
  | "rate-limit"
  | "server"
  | "too-large"
  | "unsupported-type"
  | "parse";

/** F1 抓回来的网页（title/text 已清洗；truncated 表示正文被 256KB 字节阈值截过）。 */
export interface WebFetchPage {
  /** 请求的 URL（重定向前） */
  readonly url: string;
  /** 实际抓到的 URL（重定向后） */
  readonly finalUrl: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
  /** 页面原始字节数（截断前） */
  readonly bytes: number;
  readonly fetchedAtMs: number;
}

/** F1 抓取执行结果（`src/web/fetch.ts` 的返回形状；与写通道的 WebFetchResult 区分）。 */
export interface WebFetchResult2 {
  readonly ok: boolean;
  readonly page: WebFetchPage | null;
  readonly failure: WebFetchFailureKind2 | null;
  readonly status: number | null;
}

/**
 * 响应 body 的最小流式形状（真实 fetch 的 `Response.body` 满足它）。
 * F339：超时不仅要让调用方返回，还要能 `cancel()` 掉底层下载。
 */
export interface WebFetchBodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel?(): Promise<void> | void;
}

export interface WebFetchBody {
  getReader(): WebFetchBodyReader;
}

/**
 * fetch 的最小依赖形状（签名与 `src/autonomy/llm.ts` 的 `FetchLike` 兼容）。
 * 为什么在这里再写一份而不是 import 它：llm.ts 属 spine，tools import spine 是 R2 违规。
 */
export type WebFetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    /**
     * 请求体；GET/HEAD 必须省略（真实 fetch 对 GET/HEAD 带 body 会直接抛
     * `Request with GET/HEAD method cannot have body`）。POST 搜索才传。
     */
    readonly body?: string | undefined;
    readonly signal: AbortSignal;
    /** F1：手动重定向以便逐跳校验（缺省时由真实 fetch 决定） */
    readonly redirect?: "follow" | "manual" | "error" | undefined;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  /** 可选：重定向逐跳校验需要 Location；真实 fetch 的 Response 自带 */
  readonly headers?: { get(name: string): string | null } | undefined;
  /** 可选：F339 优先走流式读取，超时能 cancel 掉底层 body；没有时回退 text() */
  readonly body?: WebFetchBody | null | undefined;
  text(): Promise<string>;
}>;

/** 搜索/抓取的注入依赖（由装配点从 llm 配置 + 全局 fetch 组装） */
export interface WebDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl: WebFetchLike;
  /** 超时（毫秒）；缺省 8000（overlay `WEB_TIMEOUT_MS` 由装配层传入） */
  readonly timeoutMs?: number | undefined;
  /** 当前时间（毫秒）；所有时间戳必须来自它 */
  readonly now: () => number;
  /** 日志（query 截 40 字；不得出现 key） */
  readonly log?: ((line: string) => void) | undefined;
}
