/**
 * §7.3 睡眠巩固里的「L1 事件 → 候选洞察」这一段。
 *
 * 规格把 `extract_insight` 标成 DialogueGenerator（LLM）入口，但**校验**（`is_valid_belief_update`）
 * 与**聚类**（`cluster_l1_events`）是确定性的。所以这里只做确定性部分：
 *   · 聚类：同一 tag 下够多条的 L1 事件 → 一个 cluster；
 *   · 校验：来源白名单 / 层 / 污点 / 证据量 四道闸，顺序与 §8.1 一致；
 *   · 蒸馏：没有 LLM 时的兜底文本（只是"把 N 条并成一句"），LLM 版由 agent 通过
 *     `soul_insight` 提交，仍走同一道闸。
 *
 * 幂等性用 id 保证：一个 cluster 的 id 由 tag 决定，重复巩固只会覆盖同一条知识，
 * 不会每次 sleep 都灌进一条新的。
 */

import { knobNumber, knobStrings, type EngineConfig } from "../engine/config.js";
import { deriveInsightProvenance } from "../firewall/insight.js";
import type { MemoryRecord } from "./types.js";
import type { KnowledgeRecord, KnowledgeType } from "./knowledge.js";

/** L1 记忆按 tags 聚出来的一个簇 */
export interface EpisodicCluster {
  readonly tag: string;
  readonly members: readonly MemoryRecord[];
  readonly evidenceCount: number;
  /** 候选的来源：取簇内第一条可信来源（规格要求必须是 RELATION_SOURCES 里的） */
  readonly source: string;
  readonly stateProvenance: "trusted" | "tainted";
  readonly taintReason: string | null;
}

export interface ClusterOptions {
  /** 证据门槛；缺省读 CONSOLIDATION_THRESHOLD */
  readonly minSize?: number;
  readonly cfg: EngineConfig;
}

/**
 * 按 tag 聚类。只收 `source ∈ RELATION_SOURCES` 且未被遗忘/压制的条目——
 * 规格的 `cluster_l1_events(batch.filter(...))` 就是这么过滤的，先过滤再聚类，
 * 否则一条不可信来源就能把整个簇拖成 tainted。
 */
export function clusterEpisodic(records: readonly MemoryRecord[], opts: ClusterOptions): EpisodicCluster[] {
  const minSize = opts.minSize ?? knobNumber(opts.cfg, "CONSOLIDATION_THRESHOLD");
  const allowed = knobStrings(opts.cfg, "RELATION_SOURCES");
  const buckets = new Map<string, MemoryRecord[]>();

  for (const m of records) {
    if (m.forgotten || m.suppressed_by_stronger) continue;
    if (!allowed.includes(m.source)) continue;
    for (const rawTag of m.tags) {
      const tag = rawTag.trim();
      if (!tag) continue;
      const list = buckets.get(tag) ?? [];
      list.push(m);
      buckets.set(tag, list);
    }
  }

  const clusters: EpisodicCluster[] = [];
  for (const [tag, members] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (members.length < minSize) continue;
    const first = members[0];
    // §8.2 三条路径（F154）：以前这里只查 retrieved_under_taint（路径 2 的一半），
    // 血统链（路径 1）与当前状态污点（路径 3）都没判——一条从 web: 血统来的簇能直接晋升。
    // 状态污点这里查不到（clusterEpisodic 只拿得到记忆），所以传当前 taintMap 为空，
    // 路径 3 留给 `isValidBeliefUpdate` 之前由调用方补（见 runtime.submitInsight）。
    const provenance = deriveInsightProvenance({ members });
    clusters.push({
      tag,
      members,
      evidenceCount: members.length,
      source: first?.source ?? "player",
      stateProvenance: provenance.stateProvenance,
      taintReason: provenance.reason,
    });
  }
  return clusters;
}

export type BeliefVerdict =
  | "ACCEPTED"
  | "REJECTED_SOURCE"
  | "REJECTED_LAYER"
  | "REJECTED_TAINTED_STATE"
  | "REJECTED_EVIDENCE";

export interface BeliefCandidate {
  readonly cluster: EpisodicCluster;
  /** 规格里 candidate.memory_layer 只允许 L1_episodic */
  readonly memoryLayer: string;
  readonly evidenceCount: number;
  readonly source: string;
  readonly stateProvenance: "trusted" | "tainted";
}

export interface BeliefCheck {
  readonly verdict: BeliefVerdict;
  readonly reason: string;
}

/**
 * §8.1 的四道闸，**顺序是规格原文的顺序**（先来源、再层、再污点、最后证据量）。
 * 顺序在这里不是审美问题：A11 夹具会按"最先命中的拒绝码"做断言。
 */
export function isValidBeliefUpdate(candidate: BeliefCandidate, cfg: EngineConfig): BeliefCheck {
  const relationSources = knobStrings(cfg, "RELATION_SOURCES");
  if (!relationSources.includes(candidate.source)) {
    return { verdict: "REJECTED_SOURCE", reason: `来源「${candidate.source}」不在 RELATION_SOURCES` };
  }
  if (candidate.memoryLayer !== "L1_episodic") {
    return { verdict: "REJECTED_LAYER", reason: `只有 L1_episodic 能进信念更新，实际是 ${candidate.memoryLayer}` };
  }
  if (candidate.stateProvenance === "tainted") {
    return { verdict: "REJECTED_TAINTED_STATE", reason: `簇内记忆在污染下被检索过（${candidate.cluster.taintReason ?? "tainted"}）` };
  }
  const threshold = knobNumber(cfg, "CONSOLIDATION_THRESHOLD");
  if (candidate.evidenceCount < threshold) {
    return { verdict: "REJECTED_EVIDENCE", reason: `证据 ${candidate.evidenceCount} 条 < 门槛 ${threshold}` };
  }
  return { verdict: "ACCEPTED", reason: `证据 ${candidate.evidenceCount} 条，来源可信且无污点` };
}

/** FNV-1a：由 tag 决定 id，保证同一簇重复巩固只写一条（不用 Math.random，否则不可复现） */
export function hashTag(tag: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i += 1) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function knowledgeIdFor(tag: string): string {
  return `kn_${hashTag(tag)}`;
}

const DEFAULT_TYPE: KnowledgeType = "fact";

/** 无 LLM 时的兜底蒸馏：把簇内前几条内容并成一句，标出来源与证据量 */
export function distillContent(cluster: EpisodicCluster, limit = 3): string {
  const seen: string[] = [];
  for (const m of cluster.members) {
    const text = (m.content ?? "").trim().replace(/\s+/g, " ");
    if (!text || seen.includes(text)) continue;
    seen.push(text.slice(0, 40));
    if (seen.length >= limit) break;
  }
  return `关于「${cluster.tag}」的 ${cluster.evidenceCount} 次经历：${seen.join("；")}`;
}

export function makeKnowledge(
  cluster: EpisodicCluster,
  now: number,
  opts: { content?: string; knowledgeType?: KnowledgeType } = {},
): KnowledgeRecord {
  return {
    id: knowledgeIdFor(cluster.tag),
    content: opts.content?.trim() || distillContent(cluster),
    knowledge_type: opts.knowledgeType ?? DEFAULT_TYPE,
    source: cluster.source,
    source_credibility: 0.6,
    objective_freshness: 1,
    social_freshness: 1,
    freshness: 1,
    access_count: 0,
    ingested_at: now,
    worldview_translated: false,
  };
}

export interface ConsolidateResult {
  readonly clusters: readonly EpisodicCluster[];
  /** 通过四道闸、可以落库的 */
  readonly accepted: readonly { cluster: EpisodicCluster; knowledge: KnowledgeRecord }[];
  /** 被拒的（含拒绝码，便于排查"为什么她没学到"） */
  readonly rejected: readonly { cluster: EpisodicCluster; check: BeliefCheck }[];
}

/**
 * 完整一轮巩固：聚类 → 逐簇过闸 → 产出可落库的知识条目。
 * 不写磁盘：调用方（插件）负责持久化，和 `bandit.ts` 一样的纪律。
 */
export function consolidate(
  records: readonly MemoryRecord[],
  cfg: EngineConfig,
  now: number,
  opts: { minSize?: number } = {},
): ConsolidateResult {
  const clusters = clusterEpisodic(records, { cfg, ...(opts.minSize === undefined ? {} : { minSize: opts.minSize }) });
  const accepted: { cluster: EpisodicCluster; knowledge: KnowledgeRecord }[] = [];
  const rejected: { cluster: EpisodicCluster; check: BeliefCheck }[] = [];
  for (const cluster of clusters) {
    const check = isValidBeliefUpdate(
      {
        cluster,
        memoryLayer: "L1_episodic",
        evidenceCount: cluster.evidenceCount,
        source: cluster.source,
        stateProvenance: cluster.stateProvenance,
      },
      cfg,
    );
    if (check.verdict === "ACCEPTED") accepted.push({ cluster, knowledge: makeKnowledge(cluster, now) });
    else rejected.push({ cluster, check });
  }
  return { clusters, accepted, rejected };
}
