/**
 * §6.7 记忆冲突（INSIST / DOUBT）
 *
 * 规格原文（fixtures/v531.txt:699-716，段落 [864]-[868]）只有六行：
 *
 *     W = INSIST_WEIGHTS
 *     insist = (W.confidence * m.confidence + W.self * m.self_relevance
 *             + W.taboo * m.taboo_hit + W.trust * (1 - state.trust))
 *     return "INSIST" if insist > W.threshold else "DOUBT"
 *
 * 两处缺口，必须显式替代而不是静默补值（见 docs/DESIGN.md F24）：
 *
 *   1. `INSIST_WEIGHTS` 被引用但从未注册（spec/config/engine.json 里没有这一项，
 *      也没有任何表给出四个权重与阈值）。这里给出一组显式默认值，并让调用方可以
 *      整组覆盖；resolveConflict 的返回值里带 `weightsSource`，调用方据此知道
 *      自己拿到的是规格值还是实现侧默认值。
 *   2. `taboo_hit` 出现在 §6.2 的字段表（fixtures/v531.txt:567）里，却不在
 *      spec/schema/memory.schema.json 的 27 个字段中 —— 已落盘的记忆里没有这一项。
 *      读不到时按 0 计，并把 "taboo_hit" 写进返回值的 `missing`，让"这条判定的
 *      分量被当成 0 用了"成为可见事实。
 */

import type { MemoryRecord } from "./types.js";

/** §6.7 的四个权重与阈值。规格未给值，这里是实现侧默认值。 */
export interface InsistWeights {
  readonly confidence: number;
  readonly self: number;
  readonly taboo: number;
  readonly trust: number;
  readonly threshold: number;
}

/**
 * 实现侧默认权重（规格缺 INSIST_WEIGHTS）。
 * 取舍：把分量最多给 confidence（自我确信度），taboo 给得低是因为它现在恒为 0，
 * 给高只会把判定推向"永远不会 INSIST"；trust 项表达"越不信对方越坚持自己"。
 */
export const DEFAULT_INSIST_WEIGHTS: InsistWeights = Object.freeze({
  confidence: 0.4,
  self: 0.3,
  taboo: 0.2,
  trust: 0.1,
  threshold: 0.5,
});

export type ConflictVerdict = "INSIST" | "DOUBT";

export interface ConflictResolution {
  readonly verdict: ConflictVerdict;
  readonly insist: number;
  /** 各分量乘完权重的实测值，便于解释"为什么是这个判定"。 */
  readonly parts: {
    readonly confidence: number;
    readonly self: number;
    readonly taboo: number;
    readonly trust: number;
  };
  readonly weights: InsistWeights;
  readonly weightsSource: "spec" | "fallback";
  /** 规格引用但记忆里读不到的字段（目前只有 taboo_hit）。 */
  readonly missing: readonly string[];
}

function assertUnit(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} 必须在 [0,1] 内，收到 ${String(value)}`);
  }
}

function assertWeights(w: InsistWeights): void {
  for (const key of ["confidence", "self", "taboo", "trust"] as const) {
    assertUnit(`INSIST_WEIGHTS.${key}`, w[key]);
  }
  assertUnit("INSIST_WEIGHTS.threshold", w.threshold);
}

/** 规格里的 `m.taboo_hit`：字段表有、schema 没有，读不到就是 0。 */
function tabooHitOf(m: MemoryRecord): { value: number; missing: boolean } {
  const raw = (m as MemoryRecord & { taboo_hit?: number }).taboo_hit;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { value: 0, missing: true };
  return { value: Math.min(1, Math.max(0, raw)), missing: false };
}

/**
 * 一条记忆面对当前状态时，是坚持自己（INSIST）还是承认可能记错（DOUBT）。
 *
 * 边界照规格：`insist > threshold` 才是 INSIST，等于阈值算 DOUBT。
 */
export function resolveConflict(
  m: MemoryRecord,
  state: { readonly trust: number },
  weights: InsistWeights = DEFAULT_INSIST_WEIGHTS,
  weightsSource: "spec" | "fallback" = "fallback",
): ConflictResolution {
  assertWeights(weights);
  assertUnit("memory.confidence", m.confidence);
  assertUnit("memory.self_relevance", m.self_relevance);
  assertUnit("state.trust", state.trust);

  const taboo = tabooHitOf(m);
  const parts = {
    confidence: weights.confidence * m.confidence,
    self: weights.self * m.self_relevance,
    taboo: weights.taboo * taboo.value,
    trust: weights.trust * (1 - state.trust),
  };
  const insist =
    parts.confidence + parts.self + parts.taboo + parts.trust;
  const missing: string[] = [];
  if (taboo.missing) missing.push("taboo_hit");

  return {
    verdict: insist > weights.threshold ? "INSIST" : "DOUBT",
    insist,
    parts,
    weights,
    weightsSource,
    missing,
  };
}

/** 一行可读输出，给工具层用。 */
export function conflictLine(res: ConflictResolution, id: string): string {
  const p = res.parts;
  const miss = res.missing.length > 0 ? ` missing=${res.missing.join(",")}` : "";
  return (
    `[conflict] ${id} verdict=${res.verdict} insist=${res.insist.toFixed(4)} ` +
    `threshold=${res.weights.threshold} weights=${res.weightsSource}` +
    ` parts=confidence:${p.confidence.toFixed(4)},self:${p.self.toFixed(4)},` +
    `taboo:${p.taboo.toFixed(4)},trust:${p.trust.toFixed(4)}${miss}`
  );
}
