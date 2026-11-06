/**
 * `encoding_specificity(m.encode_ctx, ctx)` —— §6.6 检索与 §6.8 执念都用它，但规格
 * **只给了调用、没给定义**（`fixtures/v531.txt:683` 与 `:711` 各出现一次，全文没有函数体，
 * 见 docs/DESIGN.md F25）。
 *
 * 实现侧替代规则（单一真源，两处共用，避免 §6.6 与 §6.8 各算一套）：
 *
 *   1. 若 `m.encode_ctx` 非空：把它的每个 `键: 值` 与查询上下文比对 —— 值（字符串化后）
 *      出现在 `ctx.tags` 里算命中，键本身出现在 ctx 里且值相等也算命中；命中率即特指度。
 *      这是"编码时在场的东西，此刻也在场吗"。
 *   2. 若 `m.encode_ctx` 为空：退化为标签重合率
 *      `|m.tags ∩ ctx.tags| / |ctx.tags|` —— 与 §6.6 之前的内联算法完全一致，
 *      所以这次重构不改变既有检索分数（有回归测试锁住）。
 *
 * 现状快照（2026-11-04，只读统计最近 30 条唯一记忆，P2a 写侧接线前后各重算一次）：
 *   - 30 条 encode_ctx 非空；其中 10 条带 cue_fingerprint（33.3%）；
 *   - 其余 20 条是 selftalk（encode_ctx 只有 selftalk_kind/relation）；
 *   - 带 cue 的 10 条里 goal_at_time 全是 `unknown:no-goal-at-write`——
 *     P2a 之前写入路径拿不到意图上下文；P2a 之后装配层知晓时会带真实目标。
 *
 *
 * 两种输入下都返回 [0,1]；查询为空返回 0（没有"特指"可言）。
 */

import type { MemoryRecord } from "./types.js";

export interface SpecificityContext {
  readonly tags: readonly string[];
}

/** 调用方上下文里除 tags 外的键（QueryContext / ObsessionContext 都没有索引签名）。 */
function readCtx(ctx: SpecificityContext, key: string): unknown {
  return (ctx as unknown as Record<string, unknown>)[key];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** `m.encode_ctx` 非空的少数情况下，按"编码现场 vs 当前查询"算重合率。 */
function fromEncodeCtx(encodeCtx: Readonly<Record<string, unknown>>, ctx: SpecificityContext): number | null {
  const entries = Object.entries(encodeCtx);
  if (entries.length === 0) return null;

  let hits = 0;
  for (const [key, value] of entries) {
    const asText = typeof value === "string" ? value : JSON.stringify(value);
    if (asText !== undefined && ctx.tags.includes(asText)) {
      hits += 1;
      continue;
    }
    const ctxValue = readCtx(ctx, key);
    if (ctxValue !== undefined && String(ctxValue) === asText) hits += 1;
  }
  return clamp01(hits / entries.length);
}

/** 编码特指度：0 = 与此刻无关，1 = 编码现场与此刻完全对上。 */
export function encodingSpecificity(m: MemoryRecord, ctx: SpecificityContext): number {
  if (ctx.tags.length === 0) return 0;
  const fromCtx = fromEncodeCtx(m.encode_ctx as Readonly<Record<string, unknown>>, ctx);
  const tagHits = m.tags.filter((t) => ctx.tags.includes(t)).length;
  const fromTags = clamp01(tagHits / ctx.tags.length);
  // 取两者较大者，而不是"encode_ctx 非空就覆盖"：runtime 写记忆时总会塞
  // encode_ctx.channel="gui" 这种记账字段，若覆盖会把所有记忆的特指度清零（实测踩过）。
  if (fromCtx === null) return fromTags;
  return Math.max(fromCtx, fromTags);
}
