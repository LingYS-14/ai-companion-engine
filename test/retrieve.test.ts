import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { lociMatch, retrieve, scoreMemory } from "../src/memory/retrieve.js";

const cfg = loadConfig();
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const mem = (over: Record<string, unknown> = {}) =>
  makeMemory({
    id: "m0",
    content: "她说她今天很累，但还是陪我聊了很久",
    source: "player",
    created_at: NOW,
    ...over,
  });

const ctx = (over: Record<string, unknown> = {}) => ({
  tags: ["tired"],
  semantic: {},
  state: { valence: 0.5 },
  now: NOW,
  ...over,
});

describe("§6.6 检索权重归一", () => {
  it("满分候选不超过 1（原始权重和 1.10 的坑已封）", () => {
    const m = mem({ tags: ["tired"], vividness: 1, access_count: 1000 });
    const s = scoreMemory(m, ctx(), cfg);
    expect(s.score).toBeLessThanOrEqual(1 + 1e-9);
    expect(s.penalties).toBe(0);
  });

  it("全部组件之和 = 归一权重 × 归一特征，不超过 1", () => {
    const m = mem({ tags: ["tired"], vividness: 1 });
    const s = scoreMemory(m, ctx(), cfg);
    const total = Object.values(s.components).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(s.score, 10);
    expect(total).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("§6.6 惩罚与预算", () => {
  it("污点记忆 −0.10、被压制的记忆 −0.30", () => {
    const base = scoreMemory(mem({ tags: ["tired"] }), ctx(), cfg).score;
    const tainted = scoreMemory(mem({ tags: ["tired"], retrieved_under_taint: true }), ctx(), cfg);
    const suppressed = scoreMemory({ ...mem({ tags: ["tired"] }), suppressed_by_stronger: true }, ctx(), cfg);
    expect(tainted.score).toBeCloseTo(base - 0.1, 10);
    expect(suppressed.score).toBeCloseTo(base - 0.3, 10);
  });

  it("污点记忆仍然参与排序（不是删除）", () => {
    const out = retrieve([mem({ id: "a", tags: ["tired"], retrieved_under_taint: true })], ctx(), cfg);
    expect(out).toHaveLength(1);
  });

  it("预算 = CAPACITY_BASE（5 条）", () => {
    const many = Array.from({ length: 9 }, (_, i) => mem({ id: `m${i}`, tags: ["tired"], vividness: 0.1 * i }));
    expect(retrieve(many, ctx(), cfg)).toHaveLength(5);
  });

  it("遗忘的记忆直接排除", () => {
    expect(retrieve([{ ...mem({ id: "f" }), forgotten: true }], ctx(), cfg)).toHaveLength(0);
  });
});

describe("§6.6 排序性质", () => {
  it("越鲜活、越近、越常被回忆的分越高", () => {
    const fresh = scoreMemory(mem({ id: "a", vividness: 0.9 }), ctx(), cfg).score;
    const stale = scoreMemory(mem({ id: "b", vividness: 0.1 }), ctx(), cfg).score;
    expect(fresh).toBeGreaterThan(stale);

    const recent = scoreMemory(mem({ id: "c" }), ctx(), cfg).score;
    const old = scoreMemory(mem({ id: "d", created_at: NOW - 30 * DAY }), ctx(), cfg).score;
    expect(recent).toBeGreaterThan(old);
  });

  it("同标签重复候选只留第一条，其余按 DEDUP_PENALTY 递减", () => {
    const recs = [
      mem({ id: "x1", tags: ["tired"], vividness: 0.9 }),
      mem({ id: "x2", tags: ["tired"], vividness: 0.8 }),
    ];
    const out = retrieve(recs, ctx(), cfg);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("x1");
    expect(out[1]!.score).toBeLessThan(out[0]!.score);
  });
});

describe("F32 对话连续性：刚说过的话要压过旧的高鲜明度记忆", () => {
  // 场景直接来自 docs/DEVELOPMENT.md 4.3：t1 刚写的「窗户擦干净了」sem 很高，
  // 却被两条 sem 很低、vividness=1.0 的旧记忆挤到第 3 —— 读起来像"她不记得我刚说的话"。
  const justSaid = mem({
    id: "fresh",
    content: "我把窗户擦干净了",
    vividness: 0.5,
    created_at: NOW,
    tags: ["chore"],
  });
  const oldVivid = (id: string) =>
    mem({ id, content: "很久以前的一件小事", vividness: 1, created_at: NOW - 40 * DAY, tags: [] });

  const semanticallyAware = () => ({
    tags: ["chore"],
    semantic: { fresh: 0.6537, ["old-1"]: 0.17, ["old-2"]: 0.07 },
    state: { valence: 0.5 },
    now: NOW,
  });

  it("权重表把 recency 放在 vividness 之前（SSOT 级断言）", () => {
    const w = cfg.knobs.RETRIEVAL_WEIGHTS!.value as Record<string, number>;
    expect(w["recency"]).toBeGreaterThan(w["vividness"]!);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("刚写的一条排在旧的高鲜明度记忆之前", () => {
    const out = retrieve([oldVivid("old-1"), oldVivid("old-2"), justSaid], semanticallyAware(), cfg);
    expect(out[0]!.id).toBe("fresh");
  });

  it("但 40 天前的旧记忆不会因此变成新记忆（recency 仍随时间衰减）", () => {
    const fresh = scoreMemory(justSaid, semanticallyAware(), cfg).score;
    const stale = scoreMemory(mem({ id: "fresh", content: "我把窗户擦干净了", vividness: 0.5, created_at: NOW - 40 * DAY, tags: ["chore"] }), semanticallyAware(), cfg).score;
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("v5.4-P1 §4.2/§4.3：冷热门 + loci boost（INV-5/INV-7）", () => {
  // ACT_R_DECAY = 0.25/天；96 h 仍是 warm（B=-1），97 h 变 cold。
  // 注意 `makeMemory` 不认 seed 里的 last_accessed（它固定等于 created_at），所以要在构造后覆盖。
  const stale = (m: MemoryRecord, hours: number): MemoryRecord => ({ ...m, last_accessed: NOW - hours * 3_600_000 });

  it("刚说过的记忆是 hot；97 小时没碰过的默认不进候选", () => {
    // vividness=0 且 valence=0.5 → emotionMatch 0.5（不触发特赦）；tags 不重合 → specificity 低
    const fresh = stale(mem({ id: "fresh", tags: ["tired"], vividness: 0 }), 1);
    const frozen = stale(mem({ id: "frozen", tags: ["cooking"], vividness: 0 }), 97);
    const out = retrieve([fresh, frozen], ctx(), cfg);
    expect(out.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("INV-7 特赦：cold 的记忆只要情绪匹配过 0.70 就能进候选", () => {
    // vividness 0.9 与当前 valence 0.9 一致 → emotionMatch = 1
    const frozen = stale(mem({ id: "frozen", tags: ["cooking"], vividness: 0.9 }), 97);
    const out = retrieve([frozen], ctx({ state: { valence: 0.9 } }), cfg);
    expect(out.map((s) => s.id)).toEqual(["frozen"]);
  });

  it("loci：同 path 相邻格满分，隔两格 0.5，不同 path 0", () => {
    expect(lociMatch({ path_id: 3, order: 10 }, { path_id: 3, order: 11 })).toBe(1);
    expect(lociMatch({ path_id: 3, order: 10 }, { path_id: 3, order: 12 })).toBe(0.5);
    expect(lociMatch({ path_id: 3, order: 10 }, { path_id: 4, order: 10 })).toBe(0);
  });

  it("loci boost 乘在最后：同格得分 = 原分 × (1+0.15)，且不改变权重和", () => {
    const m = { ...mem({ id: "a", tags: ["tired"] }), loci_path_id: 7, loci_order: 4 };
    const plain = scoreMemory(m, ctx(), cfg).score;
    const [boosted] = retrieve([m], ctx({ loci: { path_id: 7, order: 4 } }), cfg);
    expect(boosted!.score).toBeCloseTo(plain * 1.15, 10);
    const sum = Object.values(cfg.knobs["RETRIEVAL_WEIGHTS"]!.value as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("INV-5：基础分为负时不施加乘性 boost", () => {
    const m = {
      ...mem({ id: "neg", tags: ["cooking"], vividness: 0, retrieved_under_taint: true }),
      suppressed_by_stronger: true,
      loci_path_id: 7,
      loci_order: 4,
    };
    const base = scoreMemory(m, ctx(), cfg).score;
    expect(base).toBeLessThan(0);
    const [out] = retrieve([m], ctx({ loci: { path_id: 7, order: 4 } }), cfg);
    expect(out!.score).toBeCloseTo(base, 10);
  });
});
