/**
 * 网页搜索结果 → L2 知识（W1 只写码；W2 才在开关打开后真正落库）。
 *
 * 两条口径（spec v2.3 §5.2 / §6.2）：
 *   1. `source` 必须是裸 `"web"`——防火墙的 `vetWrite` 是**精确匹配**不可信源名单，
 *      `"web:<url>"` 永远不会命中，等于绕过污点标记；
 *   2. 蒸馏是纯函数（`distillHit`），可以脱离网络与磁盘单独测；摄取层只负责幂等 id、
 *      逐条写、数结果（rejected 只记数，不中断后面的条目）。
 *
 * W1 不读回来：污点条目怎么被检索侧过滤是 W2/后续批次的事，这一批只保证"写得进去"。
 */

import type { KnowledgeRecord, KnowledgeWritePort } from "../ports/index.js";
import type { WebSearchHit } from "./types.js";

/** 不可信源名单里就是裸 `"web"`（`spec/config/engine.json` 的 UNTRUSTED_SOURCES） */
export const WEB_SOURCE = "web";
/** web 的 source_credibility：低于 bili（0.7）——公开网页的可靠度更低 */
export const WEB_SOURCE_CREDIBILITY = 0.55;
export const WEB_OBJECTIVE_FRESHNESS = 0.9;
export const WEB_SOCIAL_FRESHNESS = 0.5;
export const WEB_FRESHNESS = 0.9;
/** 摘要截断长度（按 code point 数） */
export const WEB_SUMMARY_LIMIT = 300;
/** "新"的窗口：7 天内算 news，否则 fact */
export const WEB_NEWS_WINDOW_MS = 7 * 24 * 3_600_000;

export interface WebDistilled {
  /** 幂等 id 的 tag（`web:<url>`；id 由 `port.idFor` 推） */
  readonly tag: string;
  readonly content: string;
  readonly knowledgeType: "news" | "fact";
}

export interface WebIngestResult {
  readonly written: number;
  readonly skipped: number;
  readonly rejected: number;
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join("")}…`;
}

/** 纯算术的 UTC 日期（避免用日期构造器触发 lint:writers） */
function utcDateOf(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 一条搜索结果 → 一条知识（纯函数）。
 *
 * content 格式固定：`在网页上看到《标题》（<url>，站点，日期）：摘要`
 * 摘要优先用 API 的 summary，没有就用 snippet；统一截断到 300 字。
 */
export function distillHit(hit: WebSearchHit, query: string, nowMs: number): WebDistilled {
  const title = hit.title.trim() === "" ? hit.url : hit.title.trim();
  const site = hit.siteName.trim() === "" ? "未知站点" : hit.siteName.trim();
  const dateText = hit.publishedAtMs === null ? "日期未知" : utcDateOf(hit.publishedAtMs);
  const summary = truncate(hit.summary.trim() === "" ? hit.snippet : hit.summary, WEB_SUMMARY_LIMIT);
  const body = summary === "" ? "（无摘要）" : summary;
  const age = hit.publishedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - hit.publishedAtMs;
  const knowledgeType: "news" | "fact" =
    hit.publishedAtMs !== null && age >= 0 && age <= WEB_NEWS_WINDOW_MS ? "news" : "fact";
  return {
    tag: `web:${hit.url}`,
    content: `在网页上看到《${title}》（${hit.url}，${site}，${dateText}）：${body}`,
    knowledgeType,
  };
}

/**
 * 批量落库：同 id 幂等跳过；单条写失败只计数，不拖垮整批。
 *
 * `credibility` 由装配层从 overlay `WEB_SOURCE_CREDIBILITY` 传入；缺省用常量。
 */
export function ingestHits(
  port: KnowledgeWritePort,
  hits: readonly WebSearchHit[],
  nowMs: number,
  opts?: { readonly credibility?: number | undefined },
): WebIngestResult {
  let written = 0;
  let skipped = 0;
  let rejected = 0;
  const credibility = opts?.credibility ?? WEB_SOURCE_CREDIBILITY;
  for (const hit of hits) {
    if (hit.url.trim() === "") {
      rejected += 1;
      continue;
    }
    const distilled = distillHit(hit, "", nowMs);
    const id = port.idFor(distilled.tag);
    if (port.has(id)) {
      skipped += 1;
      continue;
    }
    const record: KnowledgeRecord = {
      id,
      content: distilled.content,
      knowledge_type: distilled.knowledgeType,
      source: WEB_SOURCE,
      source_credibility: credibility,
      objective_freshness: WEB_OBJECTIVE_FRESHNESS,
      social_freshness: WEB_SOCIAL_FRESHNESS,
      freshness: WEB_FRESHNESS,
      ingested_at: nowMs,
    };
    try {
      port.put(record);
      written += 1;
    } catch {
      rejected += 1;
    }
  }
  return { written, skipped, rejected };
}
