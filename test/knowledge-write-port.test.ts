/**
 * F257：知识写入闸的测试。
 *
 * 这里测的是"闸"本身，不是 `KnowledgeStore`：clean 照写、rejected 不落库、
 * quarantined 落库但记污点侧车；观察模式行为不变、只多记 would-*。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { KnowledgeStore, type KnowledgeRecord } from "../src/memory/knowledge.js";
import {
  createKnowledgeWritePort,
  parseKnowledgeGuardMode,
  KNOWLEDGE_GUARD_ENV,
  KNOWLEDGE_GUARD_MODES,
} from "../src/memory/knowledge-write.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);

function record(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: "kn_test1",
    content: "AI助手是前文明逐火十三英桀的第二位。",
    knowledge_type: "lore",
    source: "bili",
    source_credibility: 0.7,
    freshness: 1,
    ingested_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("知识写入闸（F257）", () => {
  let dir: string;
  let store: KnowledgeStore;
  let taintPath: string;
  let journalPath: string;

  const lines = (path: string): readonly string[] =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0) : [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kn-guard-"));
    store = new KnowledgeStore(join(dir, "knowledge-assistant.ndjson")).open();
    taintPath = join(dir, "knowledge-taint-assistant.ndjson");
    journalPath = join(dir, "knowledge-guard-assistant.ndjson");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const port = (mode: "observe" | "enforce") =>
    createKnowledgeWritePort({
      store,
      cfg,
      now: () => 1_800_000_000_000,
      mode,
      taintPath,
      journalPath,
    });

  it("clean 来源照常落库，不记日志", () => {
    const p = port("enforce");
    p.put(record());
    expect(store.has("kn_test1")).toBe(true);
    expect(p.stats().clean).toBe(1);
    expect(lines(journalPath)).toEqual([]);
    expect(lines(taintPath)).toEqual([]);
  });

  it("rejected（内容为空）不落库，并在 guard 日志里记 dropped", () => {
    const p = port("enforce");
    p.put(record({ content: "   " }));
    expect(store.has("kn_test1")).toBe(false);
    expect(p.stats().rejected).toBe(1);
    expect(p.stats().dropped).toBe(1);
    const rows = lines(journalPath).map((line) => JSON.parse(line) as { action: string; reason: string });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("dropped");
    expect(rows[0]?.reason).toContain("内容为空");
  });

  it("quarantined（不可信来源）落库但打污点，同一 id 不重复记", () => {
    const p = port("enforce");
    p.put(record({ source: "web", ingested_at: 1_700_000_000_000 }));
    p.put(record({ source: "web", ingested_at: 1_700_000_000_000, content: "改过内容也还是同一条" }));
    expect(store.has("kn_test1")).toBe(true);
    expect(p.stats().quarantined).toBe(2);
    expect(p.stats().tainted).toBe(1);
    expect(p.taintedIds()).toEqual(["kn_test1"]);
    const rows = lines(taintPath).map(
      (line) => JSON.parse(line) as { id: string; source: string; reason: string; at: number },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "kn_test1", source: "web", at: 1_700_000_000_000 });
    expect(rows[0]?.reason).toContain("不可信来源");
    const journalRows = lines(journalPath).map((line) => JSON.parse(line) as { action: string });
    expect(journalRows.map((row) => row.action)).toContain("tainted");
  });

  it("观察模式下 rejected 只记 would-reject，行为不变（照样落库）", () => {
    const p = port("observe");
    p.put(record({ content: "" }));
    expect(store.has("kn_test1")).toBe(true);
    expect(p.stats().dropped).toBe(0);
    const rows = lines(journalPath).map((line) => JSON.parse(line) as { action: string });
    expect(rows.map((row) => row.action)).toEqual(["would-reject"]);
  });

  it("观察模式下 quarantined 只记 would-quarantine，不写污点侧车", () => {
    const p = port("observe");
    p.put(record({ source: "parasocial" }));
    expect(store.has("kn_test1")).toBe(true);
    expect(p.taintedIds()).toEqual([]);
    expect(existsSync(taintPath)).toBe(false);
    const rows = lines(journalPath).map((line) => JSON.parse(line) as { action: string });
    expect(rows.map((row) => row.action)).toEqual(["would-quarantine"]);
  });

  it("has / idFor 透传底层 store", () => {
    const p = port("enforce");
    p.put(record());
    expect(p.has("kn_test1")).toBe(true);
    expect(p.has("kn_absent")).toBe(false);
    expect(p.idFor("bili:BV1xx411c7mD")).toBe(store.idFor("bili:BV1xx411c7mD"));
  });

  it("ingested_at 不合法时用 now() 作观察时间", () => {
    const p = port("enforce");
    p.put(record({ source: "web", ingested_at: Number.NaN }));
    const rows = lines(journalPath).map((line) => JSON.parse(line) as { at: number });
    expect(rows[0]?.at).toBe(1_800_000_000_000);
  });

  it("journal/taint 路径写不进去也不影响知识落库（记账失败不能拖垮写入）", () => {
    const p = createKnowledgeWritePort({
      store,
      cfg,
      now: () => 1_800_000_000_000,
      mode: "enforce",
      taintPath: join(dir, "no-such-dir-as-file", "taint.ndjson"),
      journalPath: join(dir, "no-such-dir-as-file", "journal.ndjson"),
    });
    expect(() => p.put(record({ source: "web" }))).not.toThrow();
    expect(store.has("kn_test1")).toBe(true);
  });

  it("开关解析：只认 observe / enforce，其余回落 null", () => {
    expect(parseKnowledgeGuardMode(undefined)).toBeNull();
    expect(parseKnowledgeGuardMode("")).toBeNull();
    expect(parseKnowledgeGuardMode("  Observe ")).toBe("observe");
    expect(parseKnowledgeGuardMode("ENFORCE")).toBe("enforce");
    expect(parseKnowledgeGuardMode("yes")).toBeNull();
    expect(KNOWLEDGE_GUARD_ENV).toBe("ACE_KNOWLEDGE_WRITE_GUARD");
    expect(KNOWLEDGE_GUARD_MODES).toEqual(["observe", "enforce"]);
  });
});
