/**
 * 写通道新增 op 的请求 / 响应形状（task-137 通道地基，纯类型、零 IO）。
 *
 * 为什么单独一个文件：`chat` 与 `web_search` 的 payload/result 形状既要被
 * 插件侧（`src/plugin/write-client.ts` 的调用方）用，也要被 daemon 侧
 * （`scripts/autonomy/main.mjs` 的 handler、后续 `chat-turn.ts` / `web/tool-run.ts`）用。
 * 形状放在 spine 的一个纯类型文件里，两边都只 import type，不会把任何运行时依赖
 * 带进装配层，也不会让 tools 层 import spine 的实现。
 *
 * 边界：
 * - 这里只描述「通道上跑的数据」，不含校验、预算、睡眠门——那些是业务（task-138/139）。
 * - `WebSearchResult` 是**通道结果**（含 code/failure/stats），不是
 *   `src/web/types.ts` 里的搜索执行结果；两层刻意分开，避免把 web 的实现类型
 *   漏进写通道契约。
 */

/** 网页聊天请求（写通道 `op:"chat"` 的 payload）。 */
export interface ChatRequest {
  /** 用户输入；trim 后 1–2000 字（校验在 daemon 侧，见 task-138）。 */
  readonly text: string;
  /** 客户端短标识（网页会话），≤64。 */
  readonly clientId: string;
  /** 可选：客户端重试幂等用，≤64（P2.1 才真正消费）。 */
  readonly requestId?: string;
  /** 客户端发出时刻（毫秒时间戳），由调用方提供，通道不自行取时。 */
  readonly sentAtMs?: number;
}

/** 网页聊天成功结果（写通道 `op:"chat"` 的 result）。 */
export interface ChatResult {
  /** 她的回复正文（已过 cleanReply / 禁区处理）。 */
  readonly reply: string;
  /** 回合 mode（NORMAL / …），只作展示用。 */
  readonly mode?: string;
  /** 关系阶段（stranger / …），只作展示用。 */
  readonly stage?: string;
  /** 这一轮是否写入了共享历史。 */
  readonly historyWritten?: boolean;
  /** 可选追踪 id（日志用）。 */
  readonly traceId?: string;
}

/** `soul_web_search` 工具请求（写通道 `op:"web_search"` 的 payload）。 */
export interface WebSearchRequest {
  /** 搜索词；2–120 字、单行、无控制字符（校验在 daemon 侧，见 task-139）。 */
  readonly query: string;
  /** 期望条数；1–10，缺省由 daemon 侧决定。 */
  readonly maxResults?: number;
  /** true = 只看最近 7 天（没有就返回空列表，不回退旧结果）。 */
  readonly fresh?: boolean;
}

/** 通道里返回的一条搜索命中（已过 URL 安全校验，不含原文/凭据）。 */
export interface WebSearchHitPayload {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly siteName: string;
  readonly publishedAtMs: number | null;
  /** 结果权威度（0–4），由搜索服务给出。 */
  readonly authority: number;
}

/** 通道预算读数（只读，用于工具面板展示）。 */
export interface WebSearchStats {
  readonly searchCount: number;
  readonly dailyCap: number;
}

/**
 * `web_search` 的通道结果。
 * 失败时 ok=false，code 为业务错误码（如 WEB_BUDGET_INTERVAL / bad-request），
 * hits 为空数组；成功时 ok=true、code=null。
 */
export interface WebSearchResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly hits: readonly WebSearchHitPayload[];
  /** 搜索执行层给的失败分类（网络/HTTP/超时…），成功时为 null。 */
  readonly failure: string | null;
  /** 给人看的一句话（失败原因或提示；成功时可为 null）。 */
  readonly message: string | null;
  /** 预算闸建议的重试等待（毫秒）；不适用为 null。 */
  readonly retryAfterMs: number | null;
  readonly stats: WebSearchStats;
}

/** `soul_web_fetch` 工具请求（写通道 `op:"web_fetch"` 的 payload）。 */
export interface WebFetchRequest {
  /** 目标 URL；trim 后 8–2048 字、单行、无控制字符（校验在 daemon 侧，见 fetch-run.ts）。 */
  readonly url: string;
  /** 返回正文最多多少字；500–4000，缺省 2000。 */
  readonly maxChars?: number;
}

/** 抓取工具的一条预算读数（只读，用于面板展示）。 */
export interface WebFetchStats {
  readonly fetchCount: number;
  readonly dailyCap: number;
}

/**
 * `web_fetch` 的通道结果。
 * 失败时 ok=false、code 为业务错误码（WEB_DISABLED / WEB_BUDGET_INTERVAL / …），
 * 文本字段为 null；成功时 ok=true、code=null。
 */
export interface WebFetchResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly url: string | null;
  readonly finalUrl: string | null;
  readonly title: string | null;
  readonly text: string | null;
  readonly truncated: boolean;
  /** 页面原始字节数（截断前；失败为 0）。 */
  readonly bytes: number;
  readonly fetchedAtMs: number | null;
  /** 抓取执行层给的失败分类（blocked/timeout/…），成功时为 null。 */
  readonly failure: string | null;
  /** 给人看的一句话（失败原因或提示；成功时 null）。 */
  readonly message: string | null;
  /** 预算闸建议的重试等待（毫秒）；不适用为 null。 */
  readonly retryAfterMs: number | null;
  readonly stats: WebFetchStats;
}
