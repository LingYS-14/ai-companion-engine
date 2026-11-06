/**
 * 记忆条目的**线上格式**（wire format）。
 *
 * 刻意保留 snake_case：schema 是 `spec/schema/memory.schema.json`，持久化文件要能被 schema 直接校验。
 * 引擎内部若改用 camelCase，就必须有一层翻译，而翻译层的漂移是 lint 抓不到的
 * （F16 的 `last_access` / `last_accessed` 就是这么来的）。所以：**磁盘上叫什么，代码里就叫什么。**
 */

export type Provenance = "trusted" | "tainted";

export interface MemoryRecord {
  id: string;
  content: string;
  distorted_content: string | null;
  tags: string[];
  /** §6.2 鲜明度；reconsolidate 时按 A06 更新，但系数必须 ≤0.5（F14） */
  vividness: number;
  confidence: number;
  accuracy: number;
  self_relevance: number;
  schema_congruence: number;
  participants: string[];
  /**
   * §8.3 shared_self：她**明确愿意分享**的记忆（只有主人能打这个标）。
   * 缺省 = 私有：访客检索不到。见 memory/visibility.ts。
   */
  allow_share?: boolean;
  /** 来源：player / qq_contact_verified / web / parasocial / unknown … */
  source: string;
  /** 溯源链（v5.2 §6.2；旧名 source_chain，这里沿用 schema 名） */
  source_chain: string[];
  /** 编码时是否处于污点环境 */
  state_provenance: Provenance;
  /** 记忆层污点：**永不清除**，只影响检索排序（块 3 的解读 2） */
  retrieved_under_taint: boolean;
  reconsolidated_under_taint: boolean;
  encode_ctx: Record<string, unknown>;
  encode_state: Record<string, number>;
  created_at: number;
  last_accessed: number;
  access_count: number;
  /** v5.4-P1 §4.2 冷热分层的激活强度标量（ACT-R 简化版；D1/D2） */
  base_activation: number;
  /** v5.4-P1 §4.3 记忆宫殿：稳定的 path id（stable_hash(channel:primary_tag) % 32），可缺省 */
  loci_path_id?: number;
  /** v5.4-P1 §4.3 记忆宫殿：槽内位置（每槽 2 条，溢出进下一槽） */
  loci_order?: number;
  distortion: number;
  is_obsession: boolean;
  unresolved_score: number;
  forgotten: boolean;
  suppressed_by_stronger: boolean;
  suppression_strength: number;
  derivation_chain: string[];
}

/** 新建一条记忆所需的字段；其余由默认值补齐 */
export interface MemorySeed {
  id: string;
  content: string;
  source: string;
  created_at: number;
  state_provenance?: Provenance;
  retrieved_under_taint?: boolean;
  tags?: string[];
  participants?: string[];
  allow_share?: boolean;
  source_chain?: string[];
  vividness?: number;
  confidence?: number;
  accuracy?: number;
  self_relevance?: number;
  schema_congruence?: number;
  encode_ctx?: Record<string, unknown>;
  encode_state?: Record<string, number>;
  derivation_chain?: string[];
}

export function makeMemory(seed: MemorySeed): MemoryRecord {
  return {
    id: seed.id,
    content: seed.content,
    distorted_content: null,
    tags: seed.tags ?? [],
    vividness: seed.vividness ?? 0.5,
    confidence: seed.confidence ?? 0.5,
    accuracy: seed.accuracy ?? 0.8,
    self_relevance: seed.self_relevance ?? 0.3,
    schema_congruence: seed.schema_congruence ?? 0.5,
    participants: seed.participants ?? [],
    ...(seed.allow_share === true ? { allow_share: true } : {}),
    source: seed.source,
    source_chain: seed.source_chain ?? [seed.source],
    state_provenance: seed.state_provenance ?? "trusted",
    retrieved_under_taint: seed.retrieved_under_taint ?? false,
    reconsolidated_under_taint: false,
    encode_ctx: seed.encode_ctx ?? {},
    encode_state: seed.encode_state ?? {},
    created_at: seed.created_at,
    last_accessed: seed.created_at,
    access_count: 0,
    base_activation: 0,
    distortion: 0,
    is_obsession: false,
    unresolved_score: 0,
    forgotten: false,
    suppressed_by_stronger: false,
    suppression_strength: 0,
    derivation_chain: seed.derivation_chain ?? [],
  };
}
