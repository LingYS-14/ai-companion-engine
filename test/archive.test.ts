/**
 * 冷归档（§6.9）+ 硬删除的规则测试。
 *
 * 这里测的是**我们自拟的物理形态**（见 src/memory/archive.ts 文件头，F29）：
 * 记忆要么在热档、要么在冷档，绝不两边都有；硬删只能显式触发。
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { loadConfig, DEFAULT_CONFIG_URL } from "../src/engine/config.js";
import { ArchiveStore } from "../src/memory/archive.js";
import { shouldColdArchive } from "../src/memory/lifecycle.js";
import { makeMemory } from "../src/memory/types.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const DAY = 86_400_000;
const cfg = loadConfig(DEFAULT_CONFIG_URL);

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-archive-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ArchiveStore：冷档文件本身", () => {
  it("重开能读回，坏行不致命只计数", () => {
    const path = join(dir, "cold.ndjson");
    const store = new ArchiveStore(path).open();
    const rec = makeMemory({ id: "a", content: "窗边", source: "player", created_at: 1 });
    store.put({ record: rec, archived_at: 2, reason: "test" });

    appendFileSync(path, "{坏行\n", "utf8");

    const reopened = new ArchiveStore(path).open();
    expect(reopened.size()).toBe(1);
    expect(reopened.get("a")?.archived_at).toBe(2);
    expect(reopened.stats(0, cfg).corrupt).toBe(1);
  });

  it("take 会真的从文件里移除（不是只改内存）", () => {
    const path = join(dir, "cold.ndjson");
    const store = new ArchiveStore(path).open();
    store.put({ record: makeMemory({ id: "a", content: "x", source: "player", created_at: 1 }), archived_at: 2, reason: "t" });
    expect(store.take("a")?.record.id).toBe("a");
    expect(new ArchiveStore(path).open().size()).toBe(0);
  });

  it("purgeable 按 archived_at 起算，不是按 last_accessed", () => {
    const now = 100 * DAY;
    const store = new ArchiveStore(join(dir, "cold.ndjson")).open();
    const rec = makeMemory({ id: "old", content: "x", source: "player", created_at: 0, last_accessed: 0 });
    // 保留期 7 天：归档才 1 天的不可删，归档 8 天的可删
    store.put({ record: rec, archived_at: now - 1 * DAY, reason: "t" });
    store.put({ record: { ...rec, id: "ancient" }, archived_at: now - 8 * DAY, reason: "t" });
    const stats = store.stats(now, cfg);
    expect(stats.size).toBe(2);
    expect(stats.purgeable).toBe(1);
    expect(readFileSync(join(dir, "cold.ndjson"), "utf8").split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
  });
});

describe("shouldColdArchive：四个条件缺一不可（§6.9）", () => {
  const base = { forgotten: true, is_obsession: false, vividness: 0.05, last_accessed: 0 };
  const now = 100 * DAY;

  it("遗忘 + 非执念 + 鲜明度过低 + 超窗口 ⇒ 可归档", () => {
    expect(shouldColdArchive(base, now, cfg)).toBe(true);
  });

  it("没遗忘 ⇒ 不归档（普通记忆不能因为旧就被搬走）", () => {
    expect(shouldColdArchive({ ...base, forgotten: false }, now, cfg)).toBe(false);
  });

  it("执念 ⇒ 永不归档（§6.8 要它一直能被闯入）", () => {
    expect(shouldColdArchive({ ...base, is_obsession: true }, now, cfg)).toBe(false);
  });

  it("鲜明度还没掉到阈值以下 ⇒ 不归档", () => {
    expect(shouldColdArchive({ ...base, vividness: 0.5 }, now, cfg)).toBe(false);
  });
});

describe("SoulRuntime：归档 / 取回 / 硬删除", () => {
  async function openRt(): Promise<SoulRuntime> {
    return SoulRuntime.open(conf, clock);
  }

  /** 造一条"已经忘掉很久"的记忆：鲜明度低到遗忘线以下，且 last_accessed 在 40 天前 */
  async function makeForgotten(rt: SoulRuntime, content: string) {
    const m = rt.remember({ content, source: "player", tags: ["旧事"], vividness: 0.02 });
    // 用引擎自己的褪色结算把它判成 forgotten（不手动改字段，走的还是生产路径）
    rt.fade(60);
    clock.advance(40 * DAY);
    return m;
  }

  it("归档把记录搬出热档、写进冷档文件：只搬不删，取回还在", async () => {
    const rt = await openRt();
    const m = await makeForgotten(rt, "很久以前的一件小事。");

    const res = rt.archiveCold();
    expect(res.archived).toBe(1);
    expect(rt.memoryById(m.id)).toBeUndefined();
    expect(rt.memoryStats().cold).toBe(1);
    expect(existsSync(join(dir, "cold-test.ndjson"))).toBe(true);

    const rows = rt.coldRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.record.id).toBe(m.id);

    const restored = rt.restoreCold(m.id);
    expect(restored?.id).toBe(m.id);
    expect(restored?.forgotten).toBe(false);
    expect(rt.memoryById(m.id)?.id).toBe(m.id);
    expect(rt.memoryStats().cold).toBe(0);
  });

  it("不足条件的记忆不会被搬走", async () => {
    const rt = await openRt();
    rt.remember({ content: "刚刚发生的事。", source: "player", tags: ["新事"] });
    clock.advance(40 * DAY);
    expect(rt.archiveCold().archived).toBe(0);
    expect(rt.memoryStats().cold).toBe(0);
  });

  it("硬删除必须显式确认，且只删过保留期的条目", async () => {
    const rt = await openRt();
    const m = await makeForgotten(rt, "该被忘掉的事。");
    expect(m.id).toBeDefined();
    rt.archiveCold();

    expect(() => rt.purgeCold(false)).toThrow(/必须显式确认/);
    // 刚归档 0 天，保留期 7 天 ⇒ 还不可删
    expect(rt.purgeCold(true).purged).toBe(0);

    clock.advance(8 * DAY);
    expect(rt.memoryStats().purgeable).toBe(1);
    const purged = rt.purgeCold(true);
    expect(purged.purged).toBe(1);
    expect(rt.memoryStats().cold).toBe(0);
    expect(rt.coldRows()).toHaveLength(0);
  });

  it("advance 跨睡点时会顺手归档（睡着时整理）", async () => {
    const rt = await openRt();
    await makeForgotten(rt, "很久以前的一件小事。");
    // 12:00 推 20 小时 ⇒ 越过次日 08:00 睡点（characterId="test" 的睡点由哈希错峰到 8 点）
    const res = rt.advance(20);
    expect(res.sleep?.ran).toBe(true);
    expect(res.sleep?.archived).toBe(1);
    expect(rt.memoryStats().cold).toBe(1);
  });
});
