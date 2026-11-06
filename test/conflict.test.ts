import { describe, expect, it } from "vitest";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import {
  conflictLine,
  DEFAULT_INSIST_WEIGHTS,
  resolveConflict,
  type InsistWeights,
} from "../src/memory/conflict.js";

const NOW = 1_700_000_000_000;

function rec(extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord {
  return makeMemory({
    id: "m1",
    content: "她说她那天下午一直在窗边等我。",
    source: "player",
    created_at: NOW,
    tags: ["下午"],
    ...extra,
  });
}

const sec = (n: number) => n.toFixed(4);

describe("§6.7 记忆冲突：INSIST / DOUBT", () => {
  it("高确信 + 高自我相关 + 低信任 ⇒ INSIST（越不信对方越坚持自己）", () => {
    const m = rec({ confidence: 0.9, self_relevance: 0.9 });
    const res = resolveConflict(m, { trust: 0.1 });
    // 0.4*0.9 + 0.3*0.9 + 0.2*0 + 0.1*0.9 = 0.36 + 0.27 + 0 + 0.09 = 0.72
    expect(sec(res.parts.confidence)).toBe("0.3600");
    expect(sec(res.parts.self)).toBe("0.2700");
    expect(sec(res.parts.taboo)).toBe("0.0000");
    expect(sec(res.parts.trust)).toBe("0.0900");
    expect(sec(res.insist)).toBe("0.7200");
    expect(res.verdict).toBe("INSIST");
  });

  it("低确信 + 低自我相关 + 高信任 ⇒ DOUBT", () => {
    const m = rec({ confidence: 0.1, self_relevance: 0.1 });
    const res = resolveConflict(m, { trust: 0.95 });
    // 0.04 + 0.03 + 0 + 0.005 = 0.075
    expect(sec(res.insist)).toBe("0.0750");
    expect(res.verdict).toBe("DOUBT");
  });

  it("等于阈值判 DOUBT（规格写的是 insist > threshold）", () => {
    // 只留 confidence 分量：w.confidence=0.4, confidence=1.0 ⇒ 0.4 ... 需要凑到 0.5
    const w: InsistWeights = { confidence: 0.5, self: 0, taboo: 0, trust: 0, threshold: 0.5 };
    const m = rec({ confidence: 0.5, self_relevance: 0 });
    const res = resolveConflict(m, { trust: 0 }, w);
    expect(res.insist).toBeCloseTo(0.25, 10);
    expect(res.verdict).toBe("DOUBT");

    const w2: InsistWeights = { confidence: 0.5, self: 0, taboo: 0, trust: 0, threshold: 0.25 };
    // 恰好 0.25，不大于阈值 ⇒ DOUBT
    expect(resolveConflict(m, { trust: 0 }, w2).verdict).toBe("DOUBT");
    const w3: InsistWeights = { confidence: 0.5, self: 0, taboo: 0, trust: 0, threshold: 0.24 };
    expect(resolveConflict(m, { trust: 0 }, w3).verdict).toBe("INSIST");
  });

  it("taboo_hit 不在 schema 里 ⇒ 按 0 计并在 missing 里标出来", () => {
    const res = resolveConflict(rec(), { trust: 0.5 });
    expect(res.parts.taboo).toBe(0);
    expect(res.missing).toEqual(["taboo_hit"]);
  });

  it("调用方显式给了 taboo_hit 时，这个分量真的参与计算", () => {
    const m = rec({ confidence: 0.5, self_relevance: 0.5 }) as MemoryRecord & { taboo_hit?: number };
    m.taboo_hit = 1;
    const res = resolveConflict(m, { trust: 0.5 });
    expect(sec(res.parts.taboo)).toBe("0.2000");
    expect(res.missing).toEqual([]);
    // 0.2 + 0.15 + 0.2 + 0.05 = 0.6 ⇒ INSIST
    expect(sec(res.insist)).toBe("0.6000");
    expect(res.verdict).toBe("INSIST");
  });

  it("默认权重来自实现侧，weightsSource 必须如实标注 fallback", () => {
    const res = resolveConflict(rec(), { trust: 0.5 });
    expect(res.weights).toEqual(DEFAULT_INSIST_WEIGHTS);
    expect(res.weightsSource).toBe("fallback");
  });

  it("规格将来补了 INSIST_WEIGHTS 时，调用方可整组覆盖并标 spec", () => {
    const specWeights: InsistWeights = { confidence: 0.6, self: 0.2, taboo: 0.1, trust: 0.1, threshold: 0.6 };
    const res = resolveConflict(rec({ confidence: 0.8, self_relevance: 0.4 }), { trust: 0.2 }, specWeights, "spec");
    expect(res.weightsSource).toBe("spec");
    // 0.48 + 0.08 + 0 + 0.08 = 0.64 > 0.6
    expect(sec(res.insist)).toBe("0.6400");
    expect(res.verdict).toBe("INSIST");
  });

  it("越界输入直接报错，不静默夹取", () => {
    expect(() => resolveConflict(rec({ confidence: 1.4 }), { trust: 0.5 })).toThrow(RangeError);
    expect(() => resolveConflict(rec(), { trust: -0.1 })).toThrow(RangeError);
    expect(() =>
      resolveConflict(rec(), { trust: 0.5 }, { confidence: NaN, self: 0, taboo: 0, trust: 0, threshold: 0.5 }),
    ).toThrow(RangeError);
  });

  it("同一输入两次调用结果一致（判定可复现）", () => {
    const m = rec({ confidence: 0.73, self_relevance: 0.41 });
    const a = resolveConflict(m, { trust: 0.37 });
    const b = resolveConflict(m, { trust: 0.37 });
    expect(a.insist).toBe(b.insist);
    expect(a.verdict).toBe(b.verdict);
  });

  it("conflictLine 把缺失字段与权重来源都写进一行", () => {
    const line = conflictLine(resolveConflict(rec({ confidence: 0.9, self_relevance: 0.9 }), { trust: 0.1 }), "m1");
    expect(line).toContain("[conflict] m1 verdict=INSIST");
    expect(line).toContain("weights=fallback");
    expect(line).toContain("missing=taboo_hit");
    expect(line).toContain("parts=confidence:0.3600");
  });
});
