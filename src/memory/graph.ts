/**
 * §4.7 扩散激活用的关联图 + §4.4 巩固优先级里的 hub 权重。
 *
 * 两条硬约束都写在这里而不是调用点：
 *   1. **边只来自内容**：tags 共现（Jaccard）、participants 共现、source_chain 重叠。
 *      **不含 loci 边**（否则"同一格"会把不相干的记忆拉进来）。
 *   2. **纯函数**：建图、邻居、权重、优先级都不写 state/bond/memories（A35 的本地计算要求）。
 *
 * 图是每次检索时按当前热档临时构建的——记忆量级（几十到几百条）下比维护持久邻接表便宜，
 * 也避免"图里留着重启前的旧节点"这种更难查的问题。
 */

import { knobNumber, knobObject, type EngineConfig } from "../engine/config.js";
import { thermalTier } from "./thermal.js";
import type { MemoryRecord } from "./types.js";

/** 语义近邻阈值：spec 的 emb 余弦阈值没给数，取 0.35（同主题短句普遍在 0.3~0.6） */
export const GRAPH_SEMANTIC_THRESHOLD = 0.35;

export interface AssociationGraph {
  /** 邻居 id → 权重 */
  readonly neighbors: (id: string) => readonly (readonly [string, number])[];
  readonly weight: (a: string, b: string) => number;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 临时关联图。节点 = 未遗忘的记忆；边 = tags/participants/source_chain 三类共现取最大值。
 * 只连"有共同内容"的记忆，权重为 1 的边意味着 tags 完全一致。
 */
export function buildAssociationGraph(
  records: readonly MemoryRecord[],
  similarity?: (a: MemoryRecord, b: MemoryRecord) => number,
): AssociationGraph {
  const alive = records.filter((r) => !r.forgotten);
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number): void => {
    if (a === b || w <= 0) return;
    let ma = adj.get(a);
    if (ma === undefined) { ma = new Map(); adj.set(a, ma); }
    ma.set(b, Math.max(ma.get(b) ?? 0, w));
    let mb = adj.get(b);
    if (mb === undefined) { mb = new Map(); adj.set(b, mb); }
    mb.set(a, Math.max(mb.get(a) ?? 0, w));
  };

  const sourceChains = new Map<string, string[]>();
  for (const r of alive) {
    const chain = r.tags.filter((t) => t.startsWith("src:") || t.startsWith("chain:"));
    if (chain.length > 0) sourceChains.set(r.id, chain);
  }

  for (let i = 0; i < alive.length; i += 1) {
    const a = alive[i]!;
    const pa = a.encode_state["participants"];
    const participants = Array.isArray(pa) ? pa.filter((x): x is string => typeof x === "string") : [];
    for (let j = i + 1; j < alive.length; j += 1) {
      const b = alive[j]!;
      const pb = b.encode_state["participants"];
      const pbArr = Array.isArray(pb) ? pb.filter((x): x is string => typeof x === "string") : [];
      const wTag = jaccard(a.tags, b.tags);
      const wPart = jaccard(participants, pbArr);
      const wChain = jaccard(sourceChains.get(a.id) ?? [], sourceChains.get(b.id) ?? []);
      const wEmb = similarity === undefined ? 0 : similarity(a, b);
      const wSem = wEmb > GRAPH_SEMANTIC_THRESHOLD ? wEmb : 0;
      link(a.id, b.id, Math.max(wTag, wPart, wChain, wSem));
    }
  }
  return {
    neighbors: (id: string) => [...(adj.get(id) ?? new Map<string, number>()).entries()],
    weight: (a: string, b: string) => adj.get(a)?.get(b) ?? 0,
  };
}

/**
 * §4.7：从一条种子扩散一步。种子本身是 cold ⇒ 扩散结果为空；cold 邻居也丢弃（INV-7）。
 * 只保留边权 > MIN_GRAPH_WEIGHT 的邻居。
 */
export function spreadActivation(
  seed: MemoryRecord,
  nowMs: number,
  graph: AssociationGraph,
  cfg: EngineConfig,
  byId: ReadonlyMap<string, MemoryRecord>,
): readonly MemoryRecord[] {
  if (thermalTier(seed, nowMs, cfg) === "cold") return [];
  const floor = knobNumber(cfg, "MIN_GRAPH_WEIGHT");
  const out: MemoryRecord[] = [];
  for (const [id, w] of graph.neighbors(seed.id)) {
    if (w <= floor) continue;
    const n = byId.get(id);
    if (n === undefined || n.forgotten) continue;
    if (thermalTier(n, nowMs, cfg) === "cold") continue;
    out.push(n);
  }
  return out;
}

export interface ConsolidationBoost {
  readonly recency: number;
  readonly schema_gap: number;
}

/** §4.4：priority = centrality × (1 + min(recency,cap) + min(schema_gap,cap))——加性 boost，不会把高中心节点归零 */
export function consolidationPriority(
  centrality: number,
  recencyBoost: number,
  schemaGapBoost: number,
  cfg: EngineConfig,
): number {
  const caps = knobObject<ConsolidationBoost>(cfg, "CONSOLIDATION_PRIORITY_BOOST");
  const r = Math.min(Math.max(recencyBoost, 0), caps["recency"]);
  const s = Math.min(Math.max(schemaGapBoost, 0), caps["schema_gap"]);
  return centrality * (1 + r + s);
}
