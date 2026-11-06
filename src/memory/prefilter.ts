/**
 * §6.6 检索的第一行：`channel_scoped_index.search(query_emb, channel, top_k=200)`
 * 再加 `search_obsession(channel)`（G6-⑥）。
 *
 * ## 为什么需要它
 *
 * 没有预筛时，每次召回都要对**全库**做 256 维余弦（G6-② 的 `semanticScores`），
 * 记忆上万条后单次召回就是几十万次乘加，而插件跑在宿主进程里、和对话同一线程。
 * 规格把它写成"先取 top-200，再 rerank"，正是为了让排序成本与库大小解耦。
 *
 * ## 规格缺什么、这里怎么补
 *
 * - `channel`：§6.2 的 27 字段里没有 `channel`，也没有 `memory_layer`（F22/F23）。
 *   这里按「`encode_ctx.channel` 有就用，没有就归到 `gui`」派生，不新加字段。
 *   这是个**偏差**：规格想要的是"按对话渠道分区"，我们只能按写入时记录的渠道近似。
 * - `query_emb`：同样没有 `emb` 字段，用 `semantic.ts` 的 hashing 向量现算（与 G6-② 同一套）。
 * - `search_obsession(channel)`：规格没说 obsessions 是否参与 top-k 截断。这里让它们
 *   **总是进入候选**（只在本渠道内），因为执念记忆如果被预筛漏掉，§6.8 的整条链就没有入口了。
 */

import type { EngineConfig } from "../engine/config.js";
import { embed, embedCached, cosine } from "./semantic.js";
import type { MemoryRecord } from "./types.js";

/** 规格原文 `top_k=200` 的字面量：它是检索预算，不是可调旋钮（93 个旋钮里没有它） */
export const INDEX_TOP_K = 200;

/** 与 `semantic.ts` 的向量缓存上限保持一致（超出就不缓存，见下方注释） */
export const CACHE_LIMIT = 8192;

/** `encode_ctx` 里没有渠道信息时的归属（本插件的记忆都是经 GUI 会话写入的） */
export const DEFAULT_CHANNEL = "gui";

/**
 * 不分区：调用方**不知道自己此刻在哪个渠道**时用它。
 *
 * 以前没有这个哨兵，`recall()` 不传 channel 就按 `DEFAULT_CHANNEL=gui` 过滤；
 * 在写入侧给 QQ/网页记忆打上真实渠道（F199）之后，这会让这些记忆在工具面检索里直接消失。
 * 分区是性能优化，不是语义：调用方不知道渠道时，正确的语义是"在全库里找"。
 */
export const ALL_CHANNELS = "*";

/** 一条记忆属于哪个渠道：只读既有字段，不新增 schema */
export function channelOf(m: MemoryRecord): string {
  const raw = m.encode_ctx["channel"];
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_CHANNEL;
}

export interface PrefilterResult {
  /** 进入 rerank 的候选（≤ INDEX_TOP_K + 本渠道的执念条目） */
  readonly candidates: readonly MemoryRecord[];
  /** 分区后该渠道的记忆总数，用来判断预筛有没有真的截断 */
  readonly poolSize: number;
  /** 被 top-k 截掉的条数（= poolSize - 语义排名保留数） */
  readonly dropped: number;
  /** 因执念被额外拉回的条数 */
  readonly obsessionAdded: number;
}

/**
 * 渠道分区 + top-k 语义预筛 + 执念条目兜底。
 *
 * 纯函数、确定性：语义分相同按 id 字典序，保证同一输入永远同样的候选集。
 */
export function prefilter(
  records: readonly MemoryRecord[],
  query: string,
  cfg: EngineConfig,
  channel?: string,
  topK: number = INDEX_TOP_K,
): PrefilterResult {
  void cfg; // 预筛目前不吃旋钮（top_k 是规格字面量）；保留参数位以便将来接 capacity 旋钮
  const target = channel ?? DEFAULT_CHANNEL;
  const inChannel =
    target === ALL_CHANNELS
      ? records.filter((m) => !m.forgotten)
      : records.filter((m) => !m.forgotten && channelOf(m) === target);

  // 池子小于缓存上限时才走缓存：缓存是为"同一小批记忆被反复召回"设计的，
  // 库比缓存大时它只会不断淘汰、把 40% 的时间花在记账上（实测 50k 条时 161ms → 329ms）。
  const cached = inChannel.length <= CACHE_LIMIT;
  const vec = cached ? embedCached : embed;
  const q = vec(query);
  let qNorm = 0;
  for (let i = 0; i < q.length; i += 1) qNorm += (q[i] ?? 0) ** 2;

  const ranked = inChannel
    .map((m) => ({ m, sim: qNorm === 0 ? 0 : Math.max(0, cosine(q, vec(m.content))) }))
    .sort((a, b) => (b.sim - a.sim) || (a.m.id < b.m.id ? -1 : 1));

  const kept = ranked.slice(0, Math.max(0, topK)).map((r) => r.m);
  const keptIds = new Set(kept.map((m) => m.id));
  const obsessions = inChannel.filter((m) => m.is_obsession && !keptIds.has(m.id));

  return {
    candidates: [...kept, ...obsessions],
    poolSize: inChannel.length,
    dropped: ranked.length - kept.length,
    obsessionAdded: obsessions.length,
  };
}
