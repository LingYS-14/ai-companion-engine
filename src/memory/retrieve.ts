/**
 * §6.6 检索排序：候选评分 → 惩罚 → 目标预算（capacity）；v5.4-P1 追加冷热门、loci boost、池上限。
 *
 * 规格里 RETRIEVAL_WEIGHTS 原来 7 项和 = 1.10，导致"满分"候选能到 1.10 并压过惩罚；
 * v5.3.1 已归一到 1.00。这里**不信任权重本身**：加载时归一再算，权重表被改坏也只影响相对权重。
 *
 * v5.4-P1 §4.2/§4.3/INV-5/INV-7：
 *   - `thermalTier` 决定候选可见性：cold 默认不进候选，除非 specificity/emotion 特赦（INV-7）；
 *   - loci boost 在 rerank **最后**乘上去，且只对非负基础分（INV-5），不进 RETRIEVAL_WEIGHTS；
 *   - `recency_curve` 与 B_i 不叠加：`scoreMemory` 里那一项 recency 是「记忆时新度」，
 *     `thermalTier` 只做可见性门，不改分数。
 *
 * 纯函数：不读写 store，只对传入的候选打分排序。
 */

import { knobNumber, knobObject, type EngineConfig } from "../engine/config.js";
import type { MemoryRecord } from "./types.js";
import { encodingSpecificity } from "./specificity.js";
import { buildAssociationGraph, spreadActivation } from "./graph.js";
import { rescuedFromCold, thermalTier, type RescueSignals, type ThermalTier } from "./thermal.js";

/** §4.7 种子上限：spec 写死 200（不是可调旋钮） */
const SEED_LIMIT = 200;

const DAY_MS = 86_400_000;

export interface QueryContext {
  /** 查询命中的标签 */
  readonly tags: readonly string[];
  /** 查询向量与记忆的余弦相似度（0..1），调用方给；没有就是 0 */
  readonly semantic: Readonly<Record<string, number>>;
  /** 当前情绪（用于情绪一致性加权） */
  readonly state: Readonly<Record<string, number>>;
  readonly now: number;
  /** §4.3 记忆宫殿：查询所在的格子（同 path 且距离 ≤1 得满分） */
  readonly loci?: { readonly path_id: number; readonly order: number };
}

export interface ScoredMemory {
  readonly id: string;
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
  readonly penalties: number;
  /** 冷热层（诊断用；不影响分数，只影响是否进候选） */
  readonly tier?: ThermalTier;
}

function weights(cfg: EngineConfig): Record<string, number> {
  const raw = knobObject<Record<string, number>>(cfg, "RETRIEVAL_WEIGHTS");
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error("RETRIEVAL_WEIGHTS 之和必须为正");
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v / sum;
  return out;
}

/** 与 `scoreMemory` 共享的特赦信号（INV-7 特赦与评分用同一份 specificity 口径） */
export function rescueSignals(m: MemoryRecord, ctx: QueryContext): RescueSignals {
  return {
    specificity: encodingSpecificity(m, ctx),
    emotionMatch: ctx.state["valence"] === undefined ? 0 : 1 - Math.abs((m.vividness ?? 0) - clamp01(ctx.state["valence"]!)),
  };
}

/** 单条记忆的基础分（0..1 量级）：特指度、语义、鲜活、时新、情绪一致、状态依赖、访问频次 */
export function scoreMemory(m: MemoryRecord, ctx: QueryContext, cfg: EngineConfig): ScoredMemory {
  const w = weights(cfg);
  // 特指度走共享实现（F25：规格只给了 encoding_specificity 的调用、没给定义）
  const signals = rescueSignals(m, ctx);
  const specificity = signals.specificity;
  const semantic = ctx.semantic[m.id] ?? 0;
  const recency = Math.pow(0.5, Math.max(0, ctx.now - m.created_at) / (7 * DAY_MS));
  const access = 1 - Math.pow(0.5, m.access_count / 5);
  const emotionMatch = signals.emotionMatch;
  const stateDependent = Math.abs((m.encode_state["valence"] ?? 0.5) - (ctx.state["valence"] ?? 0.5)) < 0.2 ? 1 : 0;

  const components = {
    specificity: w["specificity"]! * specificity,
    semantic: w["semantic"]! * semantic,
    vividness: w["vividness"]! * clamp01(m.vividness),
    recency: w["recency"]! * recency,
    emotion: w["emotion"]! * clamp01(emotionMatch),
    state_dependent: w["state_dependent"]! * stateDependent,
    access_count: w["access_count"]! * access,
  };
  const base = Object.values(components).reduce((a, b) => a + b, 0);

  const p = knobObject<{ suppressed: number; taint: number }>(cfg, "RETRIEVAL_PENALTIES");
  let penalties = 0;
  if (m.suppressed_by_stronger) penalties += p.suppressed;
  if (m.retrieved_under_taint) penalties += p.taint;

  // §4.8 Zeigarnik boost：乘性、且只对非负基础分（INV-5）——负分条目不会被"没想完"翻正。
  let score = base + penalties;
  if (score >= 0) {
    const zBoost = knobNumber(cfg, "UNRESOLVED_RETRIEVAL_BOOST");
    score *= 1 + zBoost * clamp01(m.unresolved_score);
  }

  return {
    id: m.id,
    score,
    components,
    penalties,
    tier: thermalTier(m, ctx.now, cfg),
  };
}

/** 同标签重复的候选只保留分最高的一条，其余扣 DEDUP_PENALTY（不是删除） */
export function dedupe(scored: readonly ScoredMemory[], records: readonly MemoryRecord[], cfg: EngineConfig): readonly ScoredMemory[] {
  const penalty = knobNumber(cfg, "DEDUP_PENALTY");
  const byId = new Map(records.map((r) => [r.id, r]));
  const seen = new Map<string, number>();
  const out: ScoredMemory[] = [];
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    const rec = byId.get(s.id);
    const key = rec === undefined ? s.id : [...rec.tags].sort().join("|");
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    out.push(count === 0 ? s : { ...s, score: s.score - penalty * count });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** §4.3 同 path 且槽内距离 d：d≤1→1.0，d==2→0.5，否则 0 */
export function lociMatch(
  a: { readonly path_id: number; readonly order: number },
  b: { readonly path_id: number; readonly order: number },
): number {
  if (a.path_id !== b.path_id) return 0;
  const d = Math.abs(a.order - b.order);
  return d <= 1 ? 1 : d === 2 ? 0.5 : 0;
}

/**
 * INV-7：cold 条目默认不进候选池；只有 specificity/emotion 特赦才留下。
 * 这里是**可见性**门，不改分数——特赦进来的 cold 仍按普通分数参与排序（A37b）。
 */
export function candidateAllowed(m: MemoryRecord, ctx: QueryContext, cfg: EngineConfig): { keep: boolean; tier: ThermalTier } {
  const tier = thermalTier(m, ctx.now, cfg);
  if (tier !== "cold") return { keep: true, tier };
  return { keep: rescuedFromCold(rescueSignals(m, ctx), cfg), tier };
}

/** 目标预算：capacity_base，外加高唤醒时的宽限（VIVIDNESS_BOOST 影响鲜活度而非条数） */
export function retrieve(
  records: readonly MemoryRecord[],
  ctx: QueryContext,
  cfg: EngineConfig,
): readonly ScoredMemory[] {
  const capacity = knobNumber(cfg, "CAPACITY_BASE");
  const poolMax = knobNumber(cfg, "MAX_CANDIDATE_POOL");
  const boost = knobNumber(cfg, "LOCI_MATCH_BOOST");

  const alive = records.filter((r) => !r.forgotten);
  const byId = new Map(alive.map((r) => [r.id, r]));

  // §4.7 扩散激活：语义分最高的 ≤200 条当种子，沿关联图扩一跳；扩散只加候选、不加分。
  // cold 种子扩散为空、cold 邻居在这里就丢（INV-7），分数仍由 scoreMemory 决定。
  const graph = buildAssociationGraph(alive);
  const seedIds = new Set(
    [...alive]
      .sort((a, b) => (ctx.semantic[b.id] ?? 0) - (ctx.semantic[a.id] ?? 0))
      .slice(0, SEED_LIMIT)
      .map((r) => r.id),
  );
  const candidates = new Map<string, MemoryRecord>();
  for (const r of alive) if (seedIds.has(r.id)) candidates.set(r.id, r);
  for (const r of alive) {
    if (!seedIds.has(r.id)) continue;
    for (const n of spreadActivation(r, ctx.now, graph, cfg, byId)) candidates.set(n.id, n);
  }
  // 预剪枝：种子优先、邻居按建图顺序，总数不超过 MAX_CANDIDATE_POOL
  const pool = [...candidates.values()].slice(0, poolMax);

  const scored = pool
    .filter((r) => candidateAllowed(r, ctx, cfg).keep)
    .map((r) => scoreMemory(r, ctx, cfg));

  const ranked = dedupe(scored, alive, cfg).map((s) => {
    const rec = byId.get(s.id);
    if (ctx.loci === undefined || rec?.loci_path_id === undefined || rec.loci_order === undefined) return s;
    if (s.score < 0) return s; // INV-5：乘性 boost 只对非负基础分施加
    const m = lociMatch(ctx.loci, { path_id: rec.loci_path_id, order: rec.loci_order });
    return m === 0 ? s : { ...s, score: s.score * (1 + boost * m) };
  });
  return ranked.sort((a, b) => b.score - a.score).slice(0, capacity);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
