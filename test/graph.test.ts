/**
 * §4.7 关联图 / 扩散激活 + §4.4 巩固优先级 + §4.4 hub 持久化。
 *
 * 这些是"检索候选怎么来的"和"跨夜优先级怎么续的"规则：扩散只能**加候选**（不加分），
 * cold 邻居必须在扩散这一层就被挡住，hub 过期后不该再影响排序。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { buildAssociationGraph, consolidationPriority, spreadActivation } from "../src/memory/graph.js";
import { HubStore } from "../src/memory/hubs.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";

const cfg = loadConfig();
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

interface MemOver {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly created_at?: number;
  readonly last_accessed?: number;
  readonly base_activation?: number;
  readonly encode_state?: Readonly<Record<string, unknown>>;
  readonly loci_path_id?: number;
  readonly loci_order?: number;
}

/** makeMemory 只认 seed；这里在它之后覆盖"测试要摆的既有状态" */
function mem(over: MemOver): MemoryRecord {
  const base = makeMemory({
    id: over.id,
    content: over.id,
    source: "player",
    tags: over.tags ?? [],
    created_at: over.created_at ?? NOW,
    encode_state: over.encode_state,
  });
  return {
    ...base,
    last_accessed: over.last_accessed ?? base.last_accessed,
    base_activation: over.base_activation ?? base.base_activation,
    ...(over.loci_path_id === undefined ? {} : { loci_path_id: over.loci_path_id }),
    ...(over.loci_order === undefined ? {} : { loci_order: over.loci_order }),
  } as MemoryRecord;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-hubs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("§4.7 buildAssociationGraph：边只来自内容共现", () => {
  it("tags 完全一致 ⇒ 权重 1；完全无关 ⇒ 无边", () => {
    const a = mem({ id: "a", tags: ["月亮", "夜"] });
    const b = mem({ id: "b", tags: ["月亮", "夜"] });
    const c = mem({ id: "c", tags: ["工程", "日志"] });
    const g = buildAssociationGraph([a, b, c]);
    expect(g.weight("a", "b")).toBe(1);
    expect(g.weight("a", "c")).toBe(0);
    expect(g.neighbors("c")).toHaveLength(0);
  });

  it("participants 共现也能连边；loci 字段不产生边", () => {
    const a = mem({ id: "a", tags: [], encode_state: { participants: ["用户"] } });
    const b = mem({ id: "b", tags: [], encode_state: { participants: ["用户", "AI"] } });
    const c = mem({ id: "c", tags: [], loci_path_id: 3, loci_order: 0 });
    const d = mem({ id: "d", tags: [], loci_path_id: 3, loci_order: 1 });
    const g = buildAssociationGraph([a, b, c, d]);
    expect(g.weight("a", "b")).toBeGreaterThan(0);
    expect(g.weight("c", "d")).toBe(0);
  });
});

describe("§4.7 spreadActivation：cold 挡在扩散层", () => {
  it("热种子扩散出热邻居；cold 邻居被丢", () => {
    const seed = mem({ id: "seed", tags: ["月亮"] });
    const warm = mem({ id: "warm", tags: ["月亮"] });
    const cold = mem({
      id: "cold",
      tags: ["月亮"],
      base_activation: -5,
      last_accessed: NOW - 40 * HOUR,
      created_at: NOW - 400 * HOUR,
    });
    const byId = new Map([seed, warm, cold].map((m) => [m.id, m] as const));
    const g = buildAssociationGraph([seed, warm, cold]);
    const out = spreadActivation(seed, NOW, g, cfg, byId).map((m) => m.id);
    expect(out).toContain("warm");
    expect(out).not.toContain("cold");
  });

  it("cold 种子自己扩散不出东西", () => {
    const seed = mem({
      id: "seed",
      tags: ["月亮"],
      base_activation: -9,
      last_accessed: NOW - 40 * HOUR,
      created_at: NOW - 400 * HOUR,
    });
    const other = mem({ id: "other", tags: ["月亮"] });
    const byId = new Map([seed, other].map((m) => [m.id, m] as const));
    const g = buildAssociationGraph([seed, other]);
    expect(spreadActivation(seed, NOW, g, cfg, byId)).toHaveLength(0);
  });

  it("权重低于 MIN_GRAPH_WEIGHT 的弱边不扩（0.3 阈值，Jaccard 0.2 不够）", () => {
    // a: [t1..t5]，b: 只有 t1 → Jaccard 1/5 = 0.2 < 0.3
    const a = mem({ id: "a", tags: ["t1", "t2", "t3", "t4", "t5"] });
    const b = mem({ id: "b", tags: ["t1"] });
    const g = buildAssociationGraph([a, b]);
    const byId = new Map([a, b].map((m) => [m.id, m] as const));
    expect(spreadActivation(a, NOW, g, cfg, byId)).toHaveLength(0);
  });
});

describe("§4.4 consolidationPriority：加性 boost，高中心节点不归零", () => {
  it("schema_gap=0 时仍保留中心性", () => {
    expect(consolidationPriority(10, 0, 0, cfg)).toBe(10);
  });

  it("boost 被 cap 住（recency 0.3 / schema_gap 0.2）", () => {
    expect(consolidationPriority(10, 5, 5, cfg)).toBeCloseTo(15, 6);
  });

  it("负 boost clamp 到 0", () => {
    expect(consolidationPriority(2, -1, -1, cfg)).toBe(2);
  });
});

describe("§4.4 HubStore：唯一写入口 + TTL 过期", () => {
  it("update 落盘、重开能读回", () => {
    const file = join(dir, "hubs.json");
    const a = HubStore.open(file);
    a.update("m1", 0.8, NOW);
    const b = HubStore.open(file);
    expect(b.get("m1", NOW, cfg)).toBeCloseTo(0.8, 6);
    expect(b.size).toBe(1);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; hubs: Record<string, unknown> };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.hubs)).toEqual(["m1"]);
  });

  it("TTL（7 天）之后读回 0，但不删档", () => {
    const file = join(dir, "hubs.json");
    const a = HubStore.open(file);
    a.update("m1", 0.8, NOW);
    expect(a.get("m1", NOW + 8 * 24 * HOUR, cfg)).toBe(0);
    expect(a.size).toBe(1);
    expect(a.entries(NOW + 8 * 24 * HOUR, cfg).size).toBe(0);
  });

  it("坏档不致命（当空表重来）", () => {
    const store = HubStore.open(join(dir, "bad.json"));
    expect(store.size).toBe(0);
  });
});
