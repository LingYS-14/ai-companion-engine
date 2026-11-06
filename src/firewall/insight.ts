/**
 * §8.2 `derive_insight` 的三条污点路径（V52-GAP M8-06）。
 *
 * 规格原话：一条洞察候选能不能当"信念"用，先看它的血统，三条路径按顺序判：
 *
 *   1. `source_chain`：簇里任一成员的血统链带 `web:` / `parasocial:` 前缀 → tainted；
 *   2. `memory_taint`：任一成员 `retrieved_under_taint` 或 `reconsolidated_under_taint`
 *      → tainted（v5.2 采纳解读 2：这不只是"排序降权"，它真的会挡晋升）；
 *   3. `state_taint`：候选所依赖的状态量**此刻**还脏着 → tainted（只看当前，不看历史）。
 *
 * 三条都不过才算 trusted。顺序不是审美：审计夹具会按"最先命中的原因"断言，
 * 所以这里必须按 1→2→3 短路。
 *
 * 注意这是**纯函数**：它回答"这条候选的血统干不干净"，不负责清洗、不负责拒绝整批。
 */

/**
 * 血统链里代表"外部内容"的来源（规格 §8.2 原文写的是 `web:` / `parasocial:` 前缀）。
 *
 * 为什么同时认裸名：规格描述的是溯源链的**规范形态**（`web:<站点>:<id>`），
 * 而这个仓库实际写进 `source_chain` 的是裸来源名（`runtime.remember` / `appendMemory`
 * 都是 `source_chain: [source]`，值是 `player` / `web` / `bili`…）。只认冒号形态的话，
 * 这条判据在线上永远不会命中——那就是装饰性的门。两种形态都认，判据才真的生效。
 */
export const UNTRUSTED_SOURCES = ["web", "parasocial"] as const;

/** 保留旧名（测试与调用方可能引用）：与 `UNTRUSTED_SOURCES` 等价 */
export const UNTRUSTED_SOURCE_PREFIXES = ["web:", "parasocial:"] as const;

export interface CandidateMember {
  readonly source: string;
  /** 溯源链（§6.2）；缺省时按 `[source]` 兜底 */
  readonly source_chain?: readonly string[];
  readonly retrieved_under_taint?: boolean;
  readonly reconsolidated_under_taint?: boolean;
  /** 编码时的状态快照，用来推"这条候选依赖了哪些状态量" */
  readonly encode_state?: Readonly<Record<string, number>>;
}

export interface InsightCandidateInput {
  readonly members: readonly CandidateMember[];
  /**
   * 候选依赖的状态量（§8.2 的 `derived_from_state_vars`）。
   * 不传时由成员的 `encode_state` 键推出——她蒸馏一条洞察，用的就是编码时那些状态。
   */
  readonly derivedFromStateVars?: readonly string[];
  /** 当前状态污点表；键是状态量名，value.state === "tainted" 表示此刻还脏 */
  readonly taintMap?: Readonly<Record<string, { readonly state: string }>>;
}

export interface InsightProvenance {
  readonly stateProvenance: "trusted" | "tainted";
  /** 最先命中的那条路径；trusted 时为 null */
  readonly reason: string | null;
}

/** 从成员的编码状态推"这条候选依赖哪些状态量"（去重、字典序，保证可复现） */
export function derivedStateVarsOf(members: readonly CandidateMember[]): readonly string[] {
  const set = new Set<string>();
  for (const m of members) {
    for (const key of Object.keys(m.encode_state ?? {})) set.add(key);
  }
  return [...set].sort();
}

export function deriveInsightProvenance(input: InsightCandidateInput): InsightProvenance {
  const prefixHit = findSourceChainHit(input.members);
  if (prefixHit !== null) {
    return { stateProvenance: "tainted", reason: `source_chain(${prefixHit})` };
  }

  const memHit = input.members.find((m) => m.retrieved_under_taint === true || m.reconsolidated_under_taint === true);
  if (memHit !== undefined) {
    const which = memHit.retrieved_under_taint === true ? "retrieved_under_taint" : "reconsolidated_under_taint";
    return { stateProvenance: "tainted", reason: `memory_taint(${which})` };
  }

  const vars = input.derivedFromStateVars ?? derivedStateVarsOf(input.members);
  const dirtyVar = vars.find((name) => input.taintMap?.[name]?.state === "tainted");
  if (dirtyVar !== undefined) {
    return { stateProvenance: "tainted", reason: `state_taint(${dirtyVar})` };
  }

  return { stateProvenance: "trusted", reason: null };
}

function findSourceChainHit(members: readonly CandidateMember[]): string | null {
  for (const m of members) {
    const chain = m.source_chain ?? [m.source];
    for (const entry of chain) {
      const key = entry.trim().toLowerCase();
      if (UNTRUSTED_SOURCES.some((s) => key === s || key.startsWith(`${s}:`))) return entry;
    }
  }
  return null;
}
