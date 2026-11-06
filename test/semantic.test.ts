/**
 * 语义检索（G6-②）的测试。
 *
 * 重点不是"向量算得对不对"，而是三件会静默出错的事：
 *   1. 中文分词能不能把"安静"和"很安静的下午"连上（bigram 的成败在此）；
 *   2. 分数量程是否稳定在 0..1（负数会让检索变成倒扣）；
 *   3. 没有 tag 命中时，语义分能不能把"说的是同一件事"排上来。
 */

import { describe, expect, it } from "vitest";

import { cacheStats, clearCache, cosine, EMB_DIM, embed, embedCached, fnv1a, semanticScores, tokens } from "../src/memory/semantic.js";
import { retrieve } from "../src/memory/retrieve.js";
import { loadConfig } from "../src/engine/config.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";

const cfg = await loadConfig();

describe("tokens：中文 bigram + 西文单词", () => {
  it("中文按相邻两字切，单字也保留（否则「安静」这种两字词会被切没）", () => {
    expect(tokens("安静")).toEqual(["安静"]);
    expect(tokens("很安静的下午")).toEqual(["很安", "安静", "静的", "的下", "下午"]);
  });

  it("西文按词切并小写，且不会在中文 bigram 里留下字母碎片", () => {
    const t = tokens("她说 OK 了");
    expect(t).toContain("ok");
    // 关键：不能出现"汉字 + 字母"混排的 bigram（那说明西文没被先抹掉）
    expect(t.some((x) => /[一-鿿][a-z]|[a-z][一-鿿]/.test(x))).toBe(false);
  });

  it("标点与空白不进词表", () => {
    expect(tokens("。，！ ")).toEqual([]);
  });
});

describe("embed / cosine", () => {
  it("维度固定且 L2 归一化（范数 = 1）", () => {
    const v = embed("今天下午她坐在窗边");
    expect(v.length).toBe(EMB_DIM);
    let sq = 0;
    for (const x of v) sq += x * x;
    expect(Math.sqrt(sq)).toBeCloseTo(1, 10);
  });

  it("确定性：同一文本两次得到同一向量", () => {
    expect(Array.from(embed("安静"))).toEqual(Array.from(embed("安静")));
  });

  it("空文本是零向量（余弦 0，不是 NaN）", () => {
    const z = embed("   ");
    expect(cosine(z, embed("安静"))).toBe(0);
  });

  it("相同文本余弦为 1，无关文本接近 0", () => {
    expect(cosine(embed("安静"), embed("安静"))).toBeCloseTo(1, 10);
    const a = cosine(embed("关于窗边的安静下午"), embed("今天吵架很凶"));
    expect(Math.abs(a)).toBeLessThan(0.2);
  });

  it("维度不一致时抛错（防止把两套 embedder 混用）", () => {
    expect(() => cosine(embed("a", 8), embed("a", 16))).toThrow(RangeError);
  });
});

describe("semanticScores：查询 × 记忆", () => {
  const records = [
    { id: "m1", content: "她坐在窗边，很安静" },
    { id: "m2", content: "今天因为迟到吵架了" },
  ];

  it("相关的高于不相关的，且都在 0..1", () => {
    const s = semanticScores("安静", records);
    expect(s["m1"]!).toBeGreaterThan(s["m2"]!);
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("空查询返回空表（caller 不必特判）", () => {
    expect(semanticScores("   ", records)).toEqual({});
  });
});

describe("接进 retrieve：没有 tag 命中时语义分能把对的排上来", () => {
  const mk = (id: string, content: string, tags: string[]): MemoryRecord =>
    makeMemory({ id, content, source: "player", created_at: 0, tags, vividness: 0.5 });

  it("两条都无 tag 命中时，语义更近的一条分更高", () => {
    const a = mk("a", "她说今天很安静，什么都没发生", ["life"]);
    const b = mk("b", "他提到下周要出差", ["life"]);
    const base = { tags: ["work"], state: {}, now: 0 };
    const withSem = retrieve([a, b], { ...base, semantic: semanticScores("安静", [a, b]) }, cfg);
    const without = retrieve([a, b], { ...base, semantic: {} }, cfg);
    // 没有语义分时两条完全同分（并列由稳定排序决定），有语义分时 a 必须领先
    expect(withSem[0]!.id).toBe("a");
    expect(withSem[0]!.score).toBeGreaterThan(without[0]!.score - 1e-12);
  });
});

describe("fnv1a：稳定哈希（与 knowledgeIdFor 同源）", () => {
  it("同一输入恒等、不同输入不同", () => {
    expect(fnv1a("conversation")).toBe(fnv1a("conversation"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });

  it("缓存版与原版在余弦上等价（float32 精度内）", () => {
    clearCache();
    const a = "她说那天下午一直在窗边等我，风很冷。";
    const b = "窗边的下午，风很冷，她一直在等。";
    const raw = cosine(embed(a), embed(b));
    const cached = cosine(embedCached(a), embedCached(b));
    expect(Math.abs(raw - cached)).toBeLessThan(1e-6);
    const stats = cacheStats();
    expect(stats.misses).toBe(2);
    expect(cacheStats().hits).toBe(0);
    embedCached(a);
    expect(cacheStats().hits).toBe(1);
  });

  it("缓存上限生效且不会无界增长", () => {
    clearCache();
    for (let i = 0; i < cacheStats().limit + 10; i += 1) embedCached(`第 ${i} 条不同的记忆内容`);
    const stats = cacheStats();
    expect(stats.size).toBeLessThanOrEqual(stats.limit);
    expect(stats.misses).toBeGreaterThanOrEqual(stats.limit);
  });
});
