import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ROLLBACK_FILE_KINDS,
  analyzeList,
  buildRollback,
  collectReferences,
  diceSimilarity,
  evaluatePlan,
  formatList,
  formatPlan,
  generateOps,
  generatePlan,
  normalizeContent,
  readConsumed,
  readIntentFile,
  readJournal,
  readMemoryStore,
  readRepoHead,
  buildMergedMemory,
  checkDaemonStopped,
  executeApply,
  formatApplySummary,
  mergeJournal,
  serializeMemory,
  writeFileAtomicRetry,
} from "../tools/maintenance/edit-memory.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(ROOT, "tools", "maintenance", "edit-memory.mjs");
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const paths = { dataDir: join(ROOT, "data"), character: "assistant" };
const tempDirs = [];

function rec(id, source, content, over = {}) {
  return {
    id,
    content,
    source,
    created_at: T0,
    last_accessed: T0,
    access_count: 1,
    vividness: 0.5,
    unresolved_score: 0.4,
    self_relevance: 0.6,
    tags: ["tag"],
    encode_ctx: { mode: "NORMAL" },
    source_chain: [source],
    ...over,
  };
}

function storeLines(records) {
  return `${records.map((record) => JSON.stringify({ op: "put", rec: record })).join("\n")}\n`;
}

function mkJournal(entries, missingSeeds) {
  const normalized = entries.map((entry) => ({ ...entry, seeds: Array.isArray(entry.seeds) ? entry.seeds : [] }));
  return {
    path: "journal.json",
    entries: normalized,
    error: null,
    exists: true,
    missingSeeds: missingSeeds ?? entries.filter((entry) => !Array.isArray(entry.seeds)).length,
  };
}

function mkIntent(records) {
  return { path: "intent.json", records, error: null, exists: true };
}

function mkConsumed(lastConsumedAt) {
  return { path: "consumed.json", lastConsumedAt, error: null, exists: true };
}

function emptyIntent() {
  return mkIntent([]);
}

const S1 = rec("s1", "selftalk", "今天也想跟你多聊一会儿。", { created_at: T0 });
const S2 = rec("s2", "selftalk", "今天也想跟你多聊两句。", { created_at: T0 + 1 });
const S3 = rec("s3", "selftalk", "我回来了。", { created_at: T0 + 2 });
const S4 = rec("s4", "selftalk", "我回来了。", { created_at: T0 + 3 });
const P1 = rec("p1", "proactive", "我主动开口说：「周末玩得好不好？」", { created_at: T0 + 4 });
const P2 = rec("p2", "proactive", "我主动开口说：「周末玩得好不好？」", { created_at: T0 + 5 });

function fixtureRecords() {
  return [S1, S2, S3, S4, P1, P2];
}

function fixtureJournal() {
  return mkJournal([
    { id: "j1", at: T0 - 5000, text: "早先的一句话。", kind: "replay", seeds: ["s1"] },
    { id: "j2", at: T0 - 4000, text: "同义的一句话。", kind: "replay", seeds: ["s2"] },
    { id: "j3", at: T0 + 5000, text: "另一句相似的话。", kind: "replay", seeds: ["s4"] },
    { id: "j4", at: T0 + 7000, text: "没有 seeds 的一句。", kind: "replay" },
  ]);
}

function fixturePlan(over = {}) {
  return {
    generatedAt: 123,
    repoHead: "abc1234",
    dataSnapshot: { memoryLines: 1, memoryUnique: 1, journalEntries: 0, pendingJournal: 0 },
    ops: [],
    references: [],
    refusals: [],
    applyAllowed: false,
    rollback: buildRollback(paths),
    ...over,
  };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    ...options,
  });
}

function mkDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "edit-memory-"));
  tempDirs.push(dir);
  t.onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const files = {
    memory: join(dir, "memory-assistant.ndjson"),
    journal: join(dir, "selftalk-assistant.json"),
    intent: join(dir, "intent-assistant.json"),
    consumed: join(dir, "selftalk-consumed-assistant.json"),
    state: join(dir, "state-assistant.json"),
  };
  writeFileSync(files.memory, `${storeLines(fixtureRecords())}${JSON.stringify({ op: "put", rec: fixtureRecords()[0] })}
`, "utf8");
  writeFileSync(files.journal, JSON.stringify(fixtureJournal().entries), "utf8");
  writeFileSync(files.intent, JSON.stringify({ version: 1, savedAtMs: T0, records: [{ id: "itn-1", source_ids: ["s4"] }] }), "utf8");
  writeFileSync(files.consumed, JSON.stringify({ version: 1, lastConsumedAt: T0 + 1000 }), "utf8");
  writeFileSync(files.state, JSON.stringify({ version: 1 }), "utf8");
  return { dir, files };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("读取：WAL 去重、坏行、journal/intent/consumed", () => {
  it("WAL 按 id 回放 put/del，保留坏行计数", () => {
    const raw = [
      JSON.stringify({ op: "put", rec: rec("m1", "selftalk", "一句话") }),
      "坏行",
      JSON.stringify({ op: "put", rec: rec("m1", "selftalk", "第二版") }),
      JSON.stringify({ op: "del", id: "m2" }),
      JSON.stringify({ op: "put", rec: { id: "m3", content: "x", source: "qq_contact_verified", created_at: T0, vividness: 0.5, access_count: 1, tags: [] } }),
    ].join("\n");
    const result = readMemoryStore(raw);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].content).toBe("第二版");
    expect(result.corrupt).toBe(1);
    expect(result.putLines).toBe(3);
    expect(result.lines).toBe(5);
    expect(result.duplicateLines).toBe(1);
  });

  it("journal 缺 seeds 不丢、坏 JSON 不抛", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "edit-memory-journal-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "j.json");
    writeFileSync(path, JSON.stringify([{ id: "j1", at: 1, text: "a", seeds: ["m1"] }, { id: "j2", at: 2, text: "b" }]), "utf8");
    const ok = readJournal(path);
    expect(ok.error).toBeNull();
    expect(ok.entries).toHaveLength(2);
    expect(ok.missingSeeds).toBe(1);
    expect(ok.entries[1].seeds).toEqual([]);

    writeFileSync(path, "{坏", "utf8");
    const broken = readJournal(path);
    expect(broken.entries).toEqual([]);
    expect(broken.error).toContain("journal 解析失败");
  });

  it("intent 与 consumed 读取容错", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "edit-memory-intent-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const intentPath = join(dir, "i.json");
    writeFileSync(intentPath, JSON.stringify({ version: 1, records: [{ id: "i1", source_ids: ["m1"] }] }), "utf8");
    expect(readIntentFile(intentPath).records).toHaveLength(1);
    writeFileSync(intentPath, JSON.stringify({ version: 1 }), "utf8");
    expect(readIntentFile(intentPath).error).toContain("records");

    const consumedPath = join(dir, "c.json");
    writeFileSync(consumedPath, JSON.stringify({ lastConsumedAt: 42 }), "utf8");
    expect(readConsumed(consumedPath).lastConsumedAt).toBe(42);
    writeFileSync(consumedPath, "坏", "utf8");
    expect(readConsumed(consumedPath).lastConsumedAt).toBeNull();
    expect(readConsumed(consumedPath).error).toContain("consumed 解析失败");
  });

  it("readRepoHead 返回 sha 或 null（不抛）", () => {
    const head = readRepoHead(ROOT);
    expect(head === null || /^[0-9a-f]{7,40}$/i.test(head)).toBe(true);
  });
});

describe("归一化与相似度", () => {
  it("normalizeContent 去掉标点/空白并小写", () => {
    expect(normalizeContent("我 回来 了～")).toBe("我回来了");
    expect(normalizeContent("ABC，。！")).toBe("abc");
    expect(normalizeContent(undefined)).toBe("");
  });

  it("diceSimilarity 对同义句/不同句给出合理区间", () => {
    expect(diceSimilarity("我回来了～", "我回来了——")).toBe(1);
    const near = diceSimilarity("今天也想跟你多聊一会儿。", "今天也想跟你多聊两句。");
    expect(near).toBeGreaterThanOrEqual(0.65);
    expect(near).toBeLessThan(0.8);
    expect(diceSimilarity("完全不一样", "另外一句")).toBeLessThan(0.3);
    expect(diceSimilarity("", "任何")).toBe(0);
  });
});

describe("analyzeList：清单与候选分组", () => {
  it("统计引用、exact/near/journalExact、missingSeeds 与 deleteCandidates 组信息", () => {
    const records = fixtureRecords();
    const result = analyzeList({
      records,
      journal: fixtureJournal(),
      intent: mkIntent([{ id: "itn-1", source_ids: ["s4"] }]),
      consumed: mkConsumed(T0 + 1000),
      corrupt: 0,
      tombstones: 0,
      lines: records.length,
    });

    expect(result.counts.memoryUnique).toBe(6);
    expect(result.counts.journalMissingSeeds).toBe(1);
    expect(result.counts.journalEntries).toBe(4);
    expect(result.counts.pendingJournal).toBe(2);
    expect(result.counts.bySource.selftalk).toBe(4);

    const s4 = result.records.find((item) => item.id === "s4");
    expect(s4.refs.journalEntries).toBe(1);
    expect(s4.refs.intentRecords).toBe(1);

    // 2 个 exact 组：s3=s4（selftalk）、p1=p2（proactive）
    expect(result.candidates.exactGroups).toHaveLength(2);
    expect(result.candidates.nearPairs.some((pair) => pair.strategy === "selftalk-near")).toBe(true);
    expect(result.candidates.nearPairs.every((pair) => pair.strategy === "selftalk-near")).toBe(true);

    // journal 跨 cursor exact 组：j2（pending）与 j3（pending）文本不同；j1/j2 不同。
    // 这里构造的是“同义”不是完全相同，故 journalExactGroups 为空；下面单独用例锁跨 cursor 完全相同。
    expect(result.candidates.journalExactGroups).toEqual([]);

    const selftalkDup = result.candidates.deleteCandidates.find((item) => item.id === "s4");
    expect(selftalkDup.members).toEqual(["s3", "s4"]);
    expect(selftalkDup.keepSuggestion).toBe("s3");
    expect(selftalkDup.note).toContain("整组");
  });

  it("journal 唯一 exact 组标出 consumed/pending 两侧", () => {
    const entries = [
      { id: "j1", at: T0 - 5000, text: "我回来了～嗯哼", kind: "replay", seeds: [] },
      { id: "j2", at: T0 + 5000, text: "我回来了——嗯哼", kind: "replay", seeds: [] },
    ];
    const result = analyzeList({
      records: [S1],
      journal: mkJournal(entries),
      intent: emptyIntent(),
      consumed: mkConsumed(T0),
      corrupt: 0,
      tombstones: 0,
      lines: 1,
    });
    expect(result.candidates.journalExactGroups).toHaveLength(1);
    expect(result.candidates.journalExactGroups[0].consumedCount).toBe(1);
    expect(result.candidates.journalExactGroups[0].pendingCount).toBe(1);
  });

  it("metadata 异常进入 fixMetadata", () => {
    const bad = rec("bad", "selftalk", "", { vividness: 2, access_count: 1 });
    const result = analyzeList({ records: [bad], journal: mkJournal([]), intent: emptyIntent(), consumed: mkConsumed(null), corrupt: 0, tombstones: 0, lines: 1 });
    const item = result.candidates.fixMetadata.find((entry) => entry.id === "bad");
    expect(item.issues).toContain("empty-content");
    expect(item.issues).toContain("bad-vividness");
  });
});

describe("generateOps：只合 selftalk，exact 与 0.65–0.8 近重复", () => {
  it("并查集合并两个分量，keep 取最早，proactive 不进 ops", () => {
    const ops = generateOps(fixtureRecords());
    expect(ops).toHaveLength(2);
    const near = ops.find((op) => op.drop.length === 1);
    expect(near.keep).toBe("s1");
    expect(near.drop).toEqual(["s2"]);
    expect(near.reason).toBe("dice");
    expect(near.dice).toBeGreaterThanOrEqual(0.65);
    const exact = ops.find((op) => op.drop.length === 1 && op.keep === "s3");
    expect(exact.reason).toBe("exact");
    expect(exact.drop).toEqual(["s4"]);
    expect(ops.flatMap((op) => op.drop)).not.toContain("p1");
    expect(ops.flatMap((op) => op.drop)).not.toContain("p2");
  });
});

describe("generatePlan：schema、引用映射、rollback、pending", () => {
  it("从数据生成计划并映射 journal/intent 引用", () => {
    const records = fixtureRecords();
    const plan = generatePlan({
      records,
      journal: fixtureJournal(),
      intent: mkIntent([{ id: "itn-1", source_ids: ["s4"] }]),
      consumed: mkConsumed(T0 + 1000),
      paths,
      nowMs: 123,
      repoHead: "abc1234",
      memoryLines: 7,
    });

    expect(plan.generatedAt).toBe(123);
    expect(plan.repoHead).toBe("abc1234");
    expect(plan.dataSnapshot.memoryLines).toBe(7);
    expect(plan.dataSnapshot.memoryUnique).toBe(6);
    expect(plan.dataSnapshot.journalEntries).toBe(4);
    expect(plan.dataSnapshot.pendingJournal).toBe(2);
    expect(plan.ops).toHaveLength(2);
    expect(plan.rollback.files).toEqual([
      "memory-assistant.ndjson",
      "selftalk-assistant.json",
      "selftalk-consumed-assistant.json",
      "state-assistant.json",
    ]);
    expect(plan.rollback.commands[0]).toBe("npm run stop");
    expect(plan.rollback.commands.at(-1)).toBe("npm run start");
    expect(plan.rollback.commands.some((command) => command.includes("copy /Y"))).toBe(true);

    const references = plan.references.filter((ref) => ref.status === "mapped");
    expect(references.some((ref) => ref.old === "s2" && ref.new === "s1")).toBe(true);
    expect(references.some((ref) => ref.old === "s4" && ref.new === "s3")).toBe(true);
    expect(references.every((ref) => ref.new !== null && typeof ref.new === "string")).toBe(true);
    expect(plan.refusals).toEqual([]);
    expect(plan.applyAllowed).toBe(true);
  });

  it("计划无 op 时 applyAllowed=true 且 schema 完整", () => {
    const plan = generatePlan({
      records: [S1],
      journal: mkJournal([]),
      intent: emptyIntent(),
      consumed: mkConsumed(null),
      paths,
      nowMs: 1,
      repoHead: null,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.applyAllowed).toBe(true);
    for (const key of ["generatedAt", "repoHead", "dataSnapshot", "ops", "references", "refusals", "applyAllowed", "rollback"]) {
      expect(plan).toHaveProperty(key);
    }
  });
});

describe("B2 引用完整性（整批拒绝）", () => {
  const records = [rec("m1", "selftalk", "一。"), rec("m2", "selftalk", "二。"), rec("m3", "selftalk", "三。")];
  const base = () => ({
    records,
    journal: mkJournal([]),
    intent: emptyIntent(),
    paths,
  });

  it("keep 被同批 delete：KEEP_REMOVED", () => {
    const plan = fixturePlan({ ops: [{ kind: "merge", keep: "m2", drop: ["m3"] }, { kind: "delete", drop: ["m2"] }] });
    const result = evaluatePlan({ ...base(), plan });
    expect(result.refusals.some((refusal) => refusal.code === "KEEP_REMOVED")).toBe(true);
    expect(result.applyAllowed).toBe(false);
  });

  it("链式 merge：CHAINED_MERGE 且映射目标不可为已移除", () => {
    const plan = fixturePlan({
      ops: [
        { kind: "merge", keep: "m2", drop: ["m3"] },
        { kind: "merge", keep: "m1", drop: ["m2"] },
      ],
    });
    const result = evaluatePlan({ ...base(), plan });
    expect(result.refusals.some((refusal) => refusal.code === "CHAINED_MERGE")).toBe(true);
    expect(result.applyAllowed).toBe(false);
  });

  it("同一 id 重复移除：DUPLICATE_REMOVAL", () => {
    const plan = fixturePlan({
      ops: [
        { kind: "merge", keep: "m1", drop: ["m3"] },
        { kind: "merge", keep: "m2", drop: ["m3"] },
      ],
    });
    const result = evaluatePlan({ ...base(), plan });
    expect(result.refusals.some((refusal) => refusal.code === "DUPLICATE_REMOVAL")).toBe(true);
    expect(result.applyAllowed).toBe(false);
  });

  it("未知 id：UNKNOWN_ID", () => {
    const plan = fixturePlan({ ops: [{ kind: "merge", keep: "mX", drop: [] }] });
    const result = evaluatePlan({ ...base(), plan });
    expect(result.refusals.some((refusal) => refusal.code === "UNKNOWN_ID")).toBe(true);
  });

  it("非 selftalk 来源不允许自动合并：NON_SELFTALK_MERGE", () => {
    const other = [rec("m1", "proactive", "我主动开口说：「周末」", { created_at: T0 }), rec("m2", "proactive", "我主动开口说：「周末」", { created_at: T0 + 1 })];
    const result = evaluatePlan({
      records: other,
      journal: mkJournal([]),
      intent: emptyIntent(),
      paths,
      plan: fixturePlan({ ops: [{ kind: "merge", keep: "m1", drop: ["m2"] }] }),
    });
    expect(result.refusals.some((refusal) => refusal.code === "NON_SELFTALK_MERGE")).toBe(true);
  });

  it("引用点无映射：DANGLING_REFERENCE 且 references 标 refuse", () => {
    const plan = fixturePlan({ ops: [{ kind: "delete", drop: ["m2"] }] });
    const result = evaluatePlan({
      records,
      journal: mkJournal([{ id: "j1", at: T0, text: "x", seeds: ["m2"] }]),
      intent: emptyIntent(),
      paths,
      plan,
    });
    expect(result.refusals.some((refusal) => refusal.code === "DANGLING_REFERENCE")).toBe(true);
    expect(result.references.some((ref) => ref.status === "refuse" && ref.old === "m2")).toBe(true);
    expect(result.applyAllowed).toBe(false);
  });

  it("结构非法 plan 抛 RangeError", () => {
    expect(() => evaluatePlan({ ...base(), plan: 42 })).toThrow(RangeError);
    expect(Array.isArray(collectReferences({ records, journal: mkJournal([]), intent: emptyIntent() }))).toBe(true);
  });
});

describe("buildRollback：文件集与命令", () => {
  it("files 锁为 memory/journal/consumed/state（不含 intent）", () => {
    const rollback = buildRollback(paths);
    expect(rollback.files).toEqual([
      "memory-assistant.ndjson",
      "selftalk-assistant.json",
      "selftalk-consumed-assistant.json",
      "state-assistant.json",
    ]);
    expect(ROLLBACK_FILE_KINDS).toEqual(["memory", "journal", "consumed", "state"]);
    expect(rollback.backupDir).toContain(".bak-hygiene");
    expect(rollback.commands[0]).toBe("npm run stop");
    expect(rollback.commands.at(-1)).toBe("npm run start");
  });
});

describe("格式化输出", () => {
  it("formatList 与 formatPlan 含关键事实", () => {
    const result = analyzeList({
      records: fixtureRecords(),
      journal: fixtureJournal(),
      intent: mkIntent([{ id: "itn-1", source_ids: ["s4"] }]),
      consumed: mkConsumed(T0 + 1000),
      corrupt: 0,
      tombstones: 0,
      lines: 6,
    });
    const listText = formatList(result);
    expect(listText).toContain("记忆事实清单");
    expect(listText).toContain("s4");
    expect(listText).toContain("候选分组");

    const plan = generatePlan({
      records: fixtureRecords(),
      journal: fixtureJournal(),
      intent: mkIntent([{ id: "itn-1", source_ids: ["s4"] }]),
      consumed: mkConsumed(T0 + 1000),
      paths,
      nowMs: 1,
      repoHead: null,
    });
    const planText = formatPlan(plan);
    expect(planText).toContain("merge");
    expect(planText).toContain("mapped");
    expect(planText).toContain("applyAllowed：true");
    expect(planText).toContain("memory-assistant.ndjson");
  });
});

describe("CLI：只读、计划生成、--out 与 --apply 闸门", () => {
  it("--list --json 输出结构，且不改动 data", (t) => {
    const { dir, files } = mkDataDir(t);
    const before = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, readFileSync(path, "utf8")]));
    const result = runCli(["--list", "--json", `--data-dir=${dir}`]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tool).toBe("edit-memory");
    expect(parsed.counts.memoryUnique).toBe(6);
    expect(parsed.counts.memoryLines).toBe(7);
    expect(parsed.candidates.exactGroups).toHaveLength(2);
    for (const [key, path] of Object.entries(files)) expect(readFileSync(path, "utf8")).toBe(before[key]);
    expect(readdirSync(dir).filter((name) => name.includes(".bak"))).toEqual([]);
  });

  it("--plan 从真实数据生成计划：schema、引用映射、退出码 0", (t) => {
    const { dir } = mkDataDir(t);
    const result = runCli(["--plan", "--json", `--data-dir=${dir}`, `--now-ms=${123}`]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.planVersion).toBe(1);
    expect(parsed.mode).toBe("A0-readonly");
    expect(parsed.generatedAt).toBe(123);
    expect(parsed.dataSnapshot.memoryLines).toBe(7);
    expect(parsed.dataSnapshot.memoryUnique).toBe(6);
    expect(Array.isArray(parsed.ops)).toBe(true);
    expect(parsed.ops.length).toBe(2);
    expect(parsed.references.some((ref) => ref.status === "mapped")).toBe(true);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.applyAllowed).toBe(true);
    expect(parsed.rollback.files).toContain("state-assistant.json");
  });

  it("--dry-run 与 --plan 输出同构（同一 now-ms）", (t) => {
    const { dir } = mkDataDir(t);
    const plan = runCli(["--plan", "--json", `--data-dir=${dir}`, "--now-ms=7"]);
    const dry = runCli(["--dry-run", "--json", `--data-dir=${dir}`, "--now-ms=7"]);
    expect(plan.status).toBe(0);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toBe(plan.stdout);
  });

  it("--plan --out 只能写 .tmp/，且内容与 stdout 一致", (t) => {
    const { dir, files } = mkDataDir(t);
    const before = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, readFileSync(path, "utf8")]));
    const outPath = join(ROOT, ".tmp", "handover", "edit-memory-test-out.json");
    rmSync(outPath, { force: true });
    try {
      const result = runCli(["--plan", `--data-dir=${dir}`, `--out=${outPath}`]);
      expect(result.status).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const file = JSON.parse(readFileSync(outPath, "utf8"));
      expect(file.applyAllowed).toBe(true);
      expect(file.rollback.files).toContain("memory-assistant.ndjson");
      for (const [key, path] of Object.entries(files)) expect(readFileSync(path, "utf8")).toBe(before[key]);
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it("--out 在 .tmp 外被拒绝且不落盘", (t) => {
    const { dir } = mkDataDir(t);
    const outside = join(ROOT, "edit-memory-outside.json");
    rmSync(outside, { force: true });
    const result = runCli(["--plan", `--data-dir=${dir}`, `--out=${outside}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".tmp");
    expect(existsSync(outside)).toBe(false);
  });

  it("--apply 闸门：无 --confirm exit 2；--apply=x 拒绝；与只读动作互斥 exit 3", (t) => {
    const { dir } = mkDataDir(t);
    const bare = runCli([`--data-dir=${dir}`, "--apply"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("A1 需要 --confirm");

    const withValue = runCli([`--data-dir=${dir}`, "--apply=true"]);
    expect(withValue.status).toBe(2);
    expect(withValue.stderr).toContain("不支持 --apply=");

    const mixed = runCli([`--data-dir=${dir}`, "--apply", "--confirm", "--list"]);
    expect(mixed.status).toBe(3);
    expect(mixed.stderr).toContain("不能与 --list");
  });

  it("--plan=<file> 被拒绝（A0 计划由工具生成）", (t) => {
    const { dir } = mkDataDir(t);
    const result = runCli([`--plan=${join(dir, "plan.json")}`, `--data-dir=${dir}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("不接受外部计划文件");
  });

  it("只读：--list/--plan 前后 mtime 与文件列表不变", (t) => {
    const { dir, files } = mkDataDir(t);
    const before = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, { mtime: statSync(path).mtimeMs, names: readdirSync(dir).sort() }]));
    runCli(["--list", `--data-dir=${dir}`]);
    runCli(["--plan", `--data-dir=${dir}`]);
    for (const [key, path] of Object.entries(files)) {
      expect(statSync(path).mtimeMs).toBe(before[key].mtime);
    }
    expect(readdirSync(dir).sort()).toEqual(before.memory.names);
  });

  it("坏 journal 不阻断 --list（有告警）", (t) => {
    const { dir, files } = mkDataDir(t);
    writeFileSync(files.journal, "坏", "utf8");
    const result = runCli(["--list", "--json", `--data-dir=${dir}`]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.journalError).toContain("journal 解析失败");
    expect(parsed.counts.journalEntries).toBe(0);
  });
});

describe("A1 预检：daemon 心跳与 confirm", () => {
  it("checkDaemonStopped：信号文件不存在视为已停；beat 新鲜/pid 存活视为未停", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "edit-memory-daemon-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const paths = { dataDir: dir, character: "assistant" };

    const quiet = checkDaemonStopped(paths, T0);
    expect(quiet.stopped).toBe(true);
    expect(quiet.blockers).toEqual([]);

    writeFileSync(join(dir, "autonomy-assistant.beat"), "beat", "utf8");
    const fresh = checkDaemonStopped(paths, Date.now());
    expect(fresh.stopped).toBe(false);
    expect(fresh.blockers.map((item) => item.kind)).toContain("beat");

    // B1：真实 daemon 写的是 JSON（src/assembly/lifecycle.ts），且 mtime 可能很旧；
    // 只看 mtime 会把活着的 daemon 判成已停——必须按 pid 存活判断。
    const pidPath = join(dir, "autonomy-assistant.pid");
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, startedAt: 1, characterId: "assistant" }), "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(pidPath, old, old);
    const alive = checkDaemonStopped(paths, T0);
    expect(alive.stopped).toBe(false);
    const pidBlocker = alive.blockers.find((item) => item.kind === "pid");
    expect(pidBlocker?.pidStatus).toBe("alive");
  });

  it("executeApply：缺少 confirm → exit 2，且不改文件", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    const before = readFileSync(fx.files.memory, "utf8");
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000 });
    expect(result.exitCode).toBe(2);
    expect(readFileSync(fx.files.memory, "utf8")).toBe(before);
  });

  it("executeApply：refusals>0 → exit 3", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    const result = executeApply({
      paths: fx.paths,
      nowMs: 1000,
      confirm: true,
      plan: { ...plan, refusals: [{ code: "DANGLING_REFERENCE", id: "a2", at: "journal:0" }], applyAllowed: false },
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("refusals=");
  });

  it("executeApply：快照不一致 → exit 3", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    const result = executeApply({
      paths: fx.paths,
      nowMs: 1000,
      confirm: true,
      plan: { ...plan, dataSnapshot: { ...plan.dataSnapshot, memoryLines: plan.dataSnapshot.memoryLines + 1 } },
    });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("快照与 plan 不一致");
  });

  it("executeApply：daemon 心跳新鲜 → exit 3", (t) => {
    const fx = mkA1DataDir(t);
    writeFileSync(join(fx.dir, "autonomy-assistant.beat"), "beat", "utf8");
    const plan = myPlan(fx);
    const result = executeApply({ paths: fx.paths, plan, nowMs: Date.now(), confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("daemon 心跳仍新鲜");
  });

  it("executeApply：plan 与重算结果不一致 → exit 3", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    const tampered = {
      ...plan,
      ops: [
        { kind: "merge", keep: "a1", drop: ["a2"], reason: "dice" },
        { kind: "merge", keep: "q1", drop: ["e2"], reason: "dice" },
      ],
    };
    const result = executeApply({ paths: fx.paths, plan: tampered, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("重算结果不一致");
  });
});

describe("A1 合并：memory/journal/引用/备份/回滚/幂等", () => {
  it("正常合并：只合 selftalk，保留最早 id、最新正文、计数合并、put-only", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    expect(plan.applyAllowed).toBe(true);
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(0);

    const store = readMemoryStore(readFileSync(fx.files.memory, "utf8"));
    expect(store.records.length).toBe(3);
    expect(store.tombstones).toBe(0);
    const a1 = store.records.find((record) => record.id === "a1");
    expect(a1.content).toBe(A1_RECORD.a2.content);
    expect(a1.created_at).toBe(A1_RECORD.a1.created_at);
    expect(a1.access_count).toBe((A1_RECORD.a1.access_count ?? 0) + (A1_RECORD.a2.access_count ?? 0));
    expect(a1.source_chain).toContain("a1");
    expect(a1.source_chain).not.toContain("a2");
    expect(store.records.some((record) => record.id === "a2" || record.id === "e2")).toBe(false);

    const lines = readFileSync(fx.files.memory, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(3);
    expect(lines.every((line) => JSON.parse(line).op === "put")).toBe(true);
    expect(lines.join("\n")).not.toContain('"op":"del"');
  });

  it("journal exact 跨 cursor：保留较早、正文以保留条目为准、consumed 继承、pending 1→0、cursor 不变", (t) => {
    const fx = mkA1DataDir(t);
    const result = executeApply({ paths: fx.paths, plan: myPlan(fx), nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(0);
    expect(result.summary.pendingJournalBefore).toBe(1);
    expect(result.summary.pendingJournalAfter).toBe(0);

    const entries = JSON.parse(readFileSync(fx.files.journal, "utf8"));
    expect(entries).toHaveLength(2);
    const merged = entries.find((entry) => entry.id === "jc1");
    expect(merged.crossCursor).toBe(true);
    expect(merged.consumedInherited).toBe(true);
    expect(merged.at).toBe(A1_JOURNAL.jc1.at);
    expect(merged.text).toBe(A1_JOURNAL.jc1.text);
    expect(merged.seeds).toEqual(["e1"]);
    expect(entries.some((entry) => entry.id === "jc2")).toBe(false);

    const consumed = JSON.parse(readFileSync(fx.files.consumed, "utf8"));
    expect(consumed.lastConsumedAt).toBe(A1_CURSOR);
  });

  it("引用映射三处：journal.seeds / intent.source_ids / memory source_chain", (t) => {
    const fx = mkA1DataDir(t);
    executeApply({ paths: fx.paths, plan: myPlan(fx), nowMs: 1000, confirm: true });

    const entries = JSON.parse(readFileSync(fx.files.journal, "utf8"));
    expect(entries.find((entry) => entry.id === "j1").seeds).toEqual(["a1"]);
    const intent = JSON.parse(readFileSync(fx.files.intent, "utf8"));
    expect(intent.records[0].source_ids).toEqual(["a1", "q1"]);
    const store = readMemoryStore(readFileSync(fx.files.memory, "utf8"));
    expect(store.records.find((record) => record.id === "a1").source_chain).toContain("a1");
  });

  it("备份：目录 + manifest sha256 + 计划摘要，且备份内容等于运行前字节", (t) => {
    const fx = mkA1DataDir(t);
    const before = readFileSync(fx.files.memory, "utf8");
    const result = executeApply({ paths: fx.paths, plan: myPlan(fx), nowMs: 2000, confirm: true });
    expect(result.exitCode).toBe(0);
    expect(result.summary.backupDir).toBe(join(fx.dir, ".bak-hygiene-2000"));

    const manifest = JSON.parse(readFileSync(join(result.summary.backupDir, "manifest.json"), "utf8"));
    expect(manifest.plan.applyAllowed).toBe(true);
    expect(manifest.plan.ops.length).toBeGreaterThan(0);
    const memoryName = "memory-assistant.ndjson";
    expect(manifest.files[memoryName].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(result.summary.backupDir, memoryName), "utf8")).toBe(before);
    expect(manifest.files["selftalk-assistant.json"]).toBeDefined();
    expect(manifest.files["selftalk-consumed-assistant.json"]).toBeDefined();
    expect(manifest.files["state-assistant.json"]).toBeDefined();
  });

  it("写盘失败：回滚到备份并 exit 4", (t) => {
    const fx = mkA1DataDir(t);
    const before = Object.fromEntries(Object.entries(fx.files).map(([key, path]) => [key, readFileSync(path, "utf8")]));
    const deps = {
      writeFile: (path, text) => {
        if (String(path).includes("selftalk-assistant.json")) {
          const error = new Error("注入写盘失败");
          error.code = "EPERM";
          throw error;
        }
        writeFileSync(path, text, "utf8");
      },
    };
    const result = executeApply({ paths: fx.paths, plan: myPlan(fx), nowMs: 3000, confirm: true, deps });
    expect(result.exitCode).toBe(4);
    expect(result.summary.rolledBack).toBe(true);
    for (const [key, path] of Object.entries(fx.files)) {
      expect(readFileSync(path, "utf8")).toBe(before[key]);
    }
  });

  it("幂等：合并后再生成计划为 0 op，二次执行不改文件", (t) => {
    const fx = mkA1DataDir(t);
    const first = executeApply({ paths: fx.paths, plan: myPlan(fx), nowMs: 4000, confirm: true });
    expect(first.exitCode).toBe(0);
    const before = Object.fromEntries(Object.entries(fx.files).map(([key, path]) => [key, readFileSync(path, "utf8")]));
    const again = myPlan(fx);
    expect(again.ops).toEqual([]);
    const second = executeApply({ paths: fx.paths, plan: again, nowMs: 5000, confirm: true });
    expect(second.exitCode).toBe(0);
    expect(second.summary.mergedMemoryGroups).toBe(0);
    for (const [key, path] of Object.entries(fx.files)) {
      expect(readFileSync(path, "utf8")).toBe(before[key]);
    }
  });

  it("formatApplySummary 含 A1 完成、备份与 cursor 未推进", () => {
    const text = formatApplySummary({
      recordsBefore: 5,
      recordsAfter: 3,
      mergedMemoryGroups: 2,
      journalEntriesBefore: 4,
      journalEntriesAfter: 3,
      mergedJournalGroups: 1,
      pendingJournalBefore: 1,
      pendingJournalAfter: 0,
      referencesMapped: 3,
      backupDir: "data/.bak-hygiene-1",
      backupFiles: ["memory-assistant.ndjson"],
      manifestMissing: [],
      intentChanged: true,
    });
    expect(text).toContain("A1 完成");
    expect(text).toContain("备份");
    expect(text).toContain("cursor 未推进");
  });
});

describe("A1 CLI：--apply --confirm 全链路", () => {
  it("--apply 不带 --confirm exit 2；带 --list 互斥 exit 3", (t) => {
    const fx = mkA1DataDir(t);
    const noConfirm = runCli([`--data-dir=${fx.dir}`, "--apply"]);
    expect(noConfirm.status).toBe(2);
    expect(noConfirm.stderr).toContain("A1 需要 --confirm");
    const mixed = runCli([`--data-dir=${fx.dir}`, "--apply", "--confirm", "--list"]);
    expect(mixed.status).toBe(3);
    expect(mixed.stderr).toContain("不能与 --list");
  });

  it("--apply --confirm 成功合并，并生成备份", (t) => {
    const fx = mkA1DataDir(t);
    // B2：--apply 不接受 --now-ms（执行期用真实时钟），备份目录名由 Date.now() 生成。
    const result = runCli([`--data-dir=${fx.dir}`, "--apply", "--confirm"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("A1 完成");
    const store = readMemoryStore(readFileSync(fx.files.memory, "utf8"));
    expect(store.records.length).toBe(3);
    const backups = readdirSync(fx.dir).filter((name) => name.startsWith(".bak-hygiene-"));
    expect(backups.length).toBe(1);
    expect(existsSync(join(fx.dir, backups[0], "manifest.json"))).toBe(true);
  });

  it("--apply --confirm 在新鲜 beat 下 exit 3", (t) => {
    const fx = mkA1DataDir(t);
    writeFileSync(join(fx.dir, "autonomy-assistant.beat"), "beat", "utf8");
    const result = runCli([`--data-dir=${fx.dir}`, "--apply", "--confirm"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("daemon 心跳仍新鲜");
  });

  it("--dry-run 不写文件", (t) => {
    const fx = mkA1DataDir(t);
    const before = Object.fromEntries(Object.entries(fx.files).map(([key, path]) => [key, readFileSync(path, "utf8")]));
    const result = runCli([`--data-dir=${fx.dir}`, "--dry-run", "--json"]);
    expect(result.status).toBe(0);
    for (const [key, path] of Object.entries(fx.files)) expect(readFileSync(path, "utf8")).toBe(before[key]);
  });
});

function a1Rec(id, source, content, created, over = {}) {
  return {
    id,
    content,
    source,
    created_at: created,
    last_accessed: created,
    access_count: 1,
    vividness: 0.5,
    unresolved_score: 0.4,
    self_relevance: 0.6,
    tags: ["tag", id],
    encode_ctx: { mode: "NORMAL" },
    source_chain: [source, id],
    ...over,
  };
}

const A1_CURSOR = T0 - 1000;
const A1_RECORD = {
  a1: a1Rec("a1", "selftalk", "今天也想跟你多聊一会儿。", T0, { source_chain: ["selftalk", "a2"] }),
  a2: a1Rec("a2", "selftalk", "今天也想跟你多聊两句。", T0 + 1),
  e1: a1Rec("e1", "selftalk", "我回来了——嗯哼。", T0 + 2),
  e2: a1Rec("e2", "selftalk", "我回来了——嗯哼。", T0 + 3),
  q1: a1Rec("q1", "qq_contact_verified", "用户说晚安。", T0 + 4),
};
const A1_JOURNAL = {
  j1: { id: "j1", at: T0 - 9000, text: "早先的一句。", kind: "replay", seeds: ["a2"], spoken: false },
  jc1: { id: "jc1", at: T0 - 5000, text: "我回来了——嗯哼，AI在玩呢。", kind: "replay", seeds: ["e2"], spoken: true },
  jc2: { id: "jc2", at: T0 + 5000, text: "我回来了～嗯哼，AI在玩呢。", kind: "replay", seeds: ["e1"], spoken: false },
};

function mkA1DataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "edit-memory-a1-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    memory: join(dir, "memory-assistant.ndjson"),
    journal: join(dir, "selftalk-assistant.json"),
    intent: join(dir, "intent-assistant.json"),
    consumed: join(dir, "selftalk-consumed-assistant.json"),
    state: join(dir, "state-assistant.json"),
  };
  writeFileSync(
    files.memory,
    `${Object.values(A1_RECORD)
      .map((record) => JSON.stringify({ op: "put", rec: record }))
      .join("\n")}\n`,
    "utf8",
  );
  writeFileSync(files.journal, JSON.stringify(Object.values(A1_JOURNAL)), "utf8");
  writeFileSync(files.intent, JSON.stringify({ version: 1, savedAtMs: T0, records: [{ id: "itn-1", source_ids: ["a2", "q1"] }] }), "utf8");
  writeFileSync(files.consumed, JSON.stringify({ version: 1, lastConsumedAt: A1_CURSOR }), "utf8");
  writeFileSync(files.state, JSON.stringify({ version: 1 }), "utf8");
  const paths = {
    dataDir: dir,
    character: "assistant",
    memoryPath: files.memory,
    journalPath: files.journal,
    intentPath: files.intent,
    consumedPath: files.consumed,
    statePath: files.state,
  };
  return { dir, files, paths };
}

function myPlan(fx) {
  const store = readMemoryStore(readFileSync(fx.files.memory, "utf8"));
  return generatePlan({
    records: store.records,
    journal: readJournal(fx.files.journal),
    intent: readIntentFile(fx.files.intent),
    consumed: readConsumed(fx.files.consumed),
    paths: fx.paths,
    nowMs: 999,
    repoHead: "abc1234",
    memoryLines: store.lines,
  });
}


describe("A1 fail-closed（task-115 B1–B3）", () => {
  function snapshotFiles(fx) {
    return [fx.files.memory, fx.files.journal, fx.files.intent, fx.files.consumed, fx.files.state].map((file) =>
      readFileSync(file, "utf8"),
    );
  }

  it("坏 JSON pid / 非数字 pid → unknown，按未停处理（fail-closed）", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "edit-memory-pid-bad-"));
    t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const pidPath = join(dir, "autonomy-assistant.pid");
    const old = new Date(Date.now() - 10 * 60_000);

    writeFileSync(pidPath, "{bad json", "utf8");
    utimesSync(pidPath, old, old);
    const badJson = checkDaemonStopped({ dataDir: dir, character: "assistant" }, Date.now());
    expect(badJson.stopped).toBe(false);
    expect(badJson.blockers.find((item) => item.kind === "pid")?.pidStatus).toBe("unknown");

    writeFileSync(pidPath, "not-a-pid", "utf8");
    utimesSync(pidPath, old, old);
    const badText = checkDaemonStopped({ dataDir: dir, character: "assistant" }, Date.now());
    expect(badText.stopped).toBe(false);
    expect(badText.blockers.find((item) => item.kind === "pid")?.pidStatus).toBe("unknown");
  });

  it("executeApply：pid 文件坏 JSON → exit 3 且文件字节不变", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    const pidPath = join(fx.dir, "autonomy-assistant.pid");
    writeFileSync(pidPath, "{bad json", "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(pidPath, old, old);
    const before = snapshotFiles(fx);
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("daemon");
    expect(snapshotFiles(fx)).toEqual(before);
  });

  it("CLI：--apply 配 --now-ms → exit 2（心跳必须真实时钟）", (t) => {
    const fx = mkA1DataDir(t);
    const result = runCli(["--apply", "--confirm", `--now-ms=${Date.now() + 86_400_000}`, `--data-dir=${fx.dir}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("不接受 --now-ms");
  });

  it("executeApply：坏 journal → exit 3 且不把它写成空文件", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    writeFileSync(fx.files.journal, "{bad journal", "utf8");
    const before = snapshotFiles(fx);
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("journal 解析失败");
    expect(snapshotFiles(fx)).toEqual(before);
  });

  it("executeApply：corrupt WAL → exit 3 且文件字节不变", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    writeFileSync(fx.files.memory, `${readFileSync(fx.files.memory, "utf8")}这不是合法 WAL 行
`, "utf8");
    const before = snapshotFiles(fx);
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("corrupt");
    expect(snapshotFiles(fx)).toEqual(before);
  });

  it("executeApply：坏 intent → exit 3 且文件字节不变", (t) => {
    const fx = mkA1DataDir(t);
    const plan = myPlan(fx);
    writeFileSync(fx.files.intent, "{bad intent", "utf8");
    const before = snapshotFiles(fx);
    const result = executeApply({ paths: fx.paths, plan, nowMs: 1000, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("intent");
    expect(snapshotFiles(fx)).toEqual(before);
  });
});
