/**
 * §4.10 内部言语 → 睡眠巩固的消费端。
 *
 * 盯三件事：游标只消费一次、坏文件不阻断睡眠、言语落进同一套记忆基础设施（能被 consolidate 聚类）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { loadConfig } from "../src/engine/config.js";
import {
  consumedPathFor,
  journalPathFor,
  journalSeeds,
  loadConsumedAt,
  readJournal,
  saveConsumedAt,
  seedsFromJournal,
} from "../src/maintenance/selftalk-consumer.js";
import type { JournalEntry } from "../src/maintenance/selftalk-journal.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-selftalk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(id: string, at: number, text: string, kind: JournalEntry["kind"] = "reflect"): JournalEntry {
  return {
    id,
    at,
    kind,
    seeds: [],
    text,
    relation: "related",
    vividness: [],
    unresolvedRelief: 0,
    rewrite: undefined,
    source: "autonomy",
  };
}

describe("seedsFromJournal", () => {
  it("只取游标之后的，按时间升序，且 id 带 st- 前缀", () => {
    const seeds = seedsFromJournal([entry("a", 10, "想花"), entry("b", 20, "想风"), entry("c", 30, "想雨")], 15);
    expect(seeds.map((s) => s.id)).toEqual(["st-b", "st-c"]);
    expect(seeds[0]).toMatchObject({ source: "selftalk", created_at: 20, vividness: 0.35 });
    expect(seeds[0]?.tags).toEqual(["selftalk", "reflect"]);
  });

  it("降级模板产物不进巩固（否则没 key 的一晚会往人格记忆里塞复读）", () => {
    const degraded: JournalEntry = { ...entry("t", 20, "又绕回「刚才那件小事」上了。"), degraded: true };
    const seeds = seedsFromJournal([entry("a", 10, "想花"), degraded, entry("c", 30, "想风")], 0);
    expect(seeds.map((s) => s.id)).toEqual(["st-a", "st-c"]);
  });

  it("空文本/非法时间被丢掉，limit 只留最近的几条", () => {
    const seeds = seedsFromJournal(
      [entry("a", 10, "  "), { ...entry("b", 20, "好"), at: Number.NaN }, entry("c", 30, "一"), entry("d", 40, "二")],
      0,
      { limit: 1 },
    );
    expect(seeds.map((s) => s.id)).toEqual(["st-d"]);
  });
});

describe("游标", () => {
  it("缺失/损坏都按 0，写后可读回", () => {
    const file = consumedPathFor(dir, "test");
    expect(loadConsumedAt(file)).toBe(0);
    saveConsumedAt(file, 123);
    expect(loadConsumedAt(file)).toBe(123);
    writeFileSync(file, "{bad json", "utf8");
    expect(loadConsumedAt(file)).toBe(0);
  });
});

describe("journalSeeds + readJournal", () => {
  it("坏日志不抛错，返回空", () => {
    writeFileSync(journalPathFor(dir, "test"), "{not json", "utf8");
    expect(readJournal(journalPathFor(dir, "test"))).toEqual([]);
    expect(journalSeeds(dir, "test").seeds).toEqual([]);
  });

  it("读真实日志并给出 latestAt", () => {
    writeFileSync(journalPathFor(dir, "test"), JSON.stringify([entry("a", 10, "想花"), entry("b", 20, "想风")]), "utf8");
    const r = journalSeeds(dir, "test");
    expect(r.seeds).toHaveLength(2);
    expect(r.latestAt).toBe(20);
    saveConsumedAt(consumedPathFor(dir, "test"), 20);
    expect(journalSeeds(dir, "test").seeds).toEqual([]);
  });
});

describe("runtime.consolidate 消费言语", () => {
  it("言语以 selftalk 记忆落盘，第二次不再重复写", async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 29, 12, 0, 0), 12);
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: false };
    const rt = await SoulRuntime.open(conf, clock);
    writeFileSync(
      journalPathFor(dir, "test"),
      JSON.stringify([entry("a", clock.now() - 1000, "窗台那枝花好像有点蔫")]),
      "utf8",
    );
    const first = rt.consolidate();
    expect(first.selftalk).toBe(1);
    const second = rt.consolidate();
    expect(second.selftalk).toBe(0);
    expect(rt.recall("窗台花", 5).some((r) => r.content.includes("窗台那枝花"))).toBe(true);
  });

  it("degraded 条目即使未消费也不落记忆、不推游标", async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 29, 13, 0, 0), 13);
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: false };
    const rt = await SoulRuntime.open(conf, clock);
    const degraded: JournalEntry = { ...entry("t", clock.now() - 1000, "又绕回「刚才那件小事」上了。"), degraded: true };
    writeFileSync(journalPathFor(dir, "test"), JSON.stringify([degraded]), "utf8");
    const res = rt.consolidate();
    expect(res.selftalk).toBe(0);
    expect(rt.recall("刚才那件小事", 5)).toEqual([]);
  });
});
