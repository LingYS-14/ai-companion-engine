/**
 * §6.3 知识新鲜度（`computeFreshness` 从来没有调用者，V52-GAP M6-05）。
 *
 * 两段：纯函数与半衰期表对得上；store 的重算真的把变化写回 WAL（不是只改内存）。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_URL, loadConfig, knobObject } from "../src/engine/config.js";
import { computeFreshness, type KnowledgeRecord as FreshnessInput } from "../src/memory/lifecycle.js";
import { KnowledgeStore, type KnowledgeRecord } from "../src/memory/knowledge.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-fresh-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(over: Partial<KnowledgeRecord>): KnowledgeRecord {
  return {
    id: "k1",
    content: "一条知识",
    knowledge_type: "trend",
    source: "bili",
    freshness: 1,
    ingested_at: NOW,
    access_count: 0,
    social_freshness: 1,
    ...over,
  };
}

describe("computeFreshness", () => {
  it("半衰期到了就是一半（表里的值本身就是天，不再多套一层）", () => {
    const hl = knobObject<Record<string, number>>(cfg, "KNOWLEDGE_HALFLIFE");
    const days = hl["trend"];
    expect(days).toBeDefined();
    const got = computeFreshness(
      { knowledge_type: "trend", ingested_at: NOW - days! * DAY, access_count: 0, social_freshness: 1 },
      NOW,
      cfg,
    );
    expect(got).toBeCloseTo(0.5, 6);
  });

  it("访问次数会加成，但结果必须归一到 [0,1]", () => {
    const got = computeFreshness(
      { knowledge_type: "trend", ingested_at: NOW, access_count: 100, social_freshness: 1 },
      NOW,
      cfg,
    );
    expect(got).toBeLessThanOrEqual(1);
  });

  it("没有这一类的半衰期就抛错（不静默给个默认值）", () => {
    expect(() =>
      computeFreshness({ knowledge_type: "不存在的类型", ingested_at: NOW, access_count: 0, social_freshness: 1 }, NOW, cfg),
    ).toThrow();
  });
});

describe("KnowledgeStore.recomputeFreshness", () => {
  it("旧知识真的降下来了，而且落进了文件（重开还在）", () => {
    const path = join(dir, "knowledge-test.ndjson");
    const store = new KnowledgeStore(path).open();
    const hl = knobObject<Record<string, number>>(cfg, "KNOWLEDGE_HALFLIFE");
    store.put(record({ id: "old", ingested_at: NOW - 3 * hl["trend"]! * DAY }));
    store.put(record({ id: "new" }));

    const changed = store.recomputeFreshness((rec) =>
      computeFreshness(
        {
          knowledge_type: rec.knowledge_type,
          ingested_at: rec.ingested_at ?? NOW,
          access_count: rec.access_count ?? 0,
          social_freshness: rec.social_freshness ?? 1,
        },
        NOW,
        cfg,
      ),
    );

    expect(changed).toBe(1);
    expect(store.get("old")?.freshness).toBeCloseTo(0.125, 3);
    expect(store.get("new")?.freshness).toBeCloseTo(1, 6);
    expect(readFileSync(path, "utf8")).toContain('"id":"old"');
  });

  it("变化小于阈值就不重写（睡眠每天跑一次，不该把全库重写一遍）", () => {
    const path = join(dir, "knowledge-stable.ndjson");
    const store = new KnowledgeStore(path).open();
    store.put(record({ id: "k", ingested_at: NOW }));
    const changed = store.recomputeFreshness(() => 0.995);
    expect(changed).toBe(0);
  });

  it("打分函数抛错/返回 null 时那一条跳过，不影响其他条", () => {
    const path = join(dir, "knowledge-mixed.ndjson");
    const store = new KnowledgeStore(path).open();
    store.put(record({ id: "a" }));
    store.put(record({ id: "b" }));
    const changed = store.recomputeFreshness((rec) => (rec.id === "a" ? null : 0.4));
    expect(changed).toBe(1);
    expect(store.get("a")?.freshness).toBe(1);
    expect(store.get("b")?.freshness).toBeCloseTo(0.4, 6);
  });
});
