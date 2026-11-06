/**
 * A2 删除执行器测试（tools/maintenance/delete-memory.mjs）。
 *
 * 全部在临时目录里造数据：不碰仓库 data/；不联网、不 build、不 gate。
 * 重点锁：只读计划、玩家原话保护、引用移除、put-only 无墓碑、备份+回滚、预检 fail-closed。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeDelete, generateDeletePlan } from "../tools/maintenance/delete-memory.mjs";

const tempDirs = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "delete-memory-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makePaths() {
  const dataDir = makeTempDir();
  const character = "assistant";
  return {
    dataDir,
    character,
    memoryPath: join(dataDir, "memory-assistant.ndjson"),
    journalPath: join(dataDir, "selftalk-assistant.json"),
    intentPath: join(dataDir, "intent-assistant.json"),
    consumedPath: join(dataDir, "selftalk-consumed-assistant.json"),
    statePath: join(dataDir, "state-assistant.json"),
  };
}

function put(op, rec) {
  return JSON.stringify({ op, rec });
}

function seedFixture(paths) {
  const records = [
    { id: "mem-selftalk-1", source: "selftalk", content: "窗边的光真好", created_at: 1 },
    { id: "mem-selftalk-2", source: "selftalk", content: "周末别排太满", created_at: 2 },
    { id: "mem-proactive-1", source: "proactive", content: "我回来了", created_at: 3 },
    { id: "mem-player-1", source: "qq_contact_verified", content: "嗯哼", created_at: 4 },
    { id: "mem-other", source: "selftalk", content: "保留项", created_at: 5, source_chain: ["mem-selftalk-1"] },
  ];
  writeFileSync(paths.memoryPath, `${records.map((rec) => put("put", rec)).join("\n")}\n`, "utf8");
  const journal = [
    { id: "j1", at: 10, text: "日记一", seeds: ["mem-selftalk-1", "mem-other"], vividness: [["mem-selftalk-1", 0.02]] },
    { id: "j2", at: 20, text: "日记二（未消费，引用待删）", seeds: ["mem-proactive-1"], vividness: [["mem-proactive-1", 0.03]] },
    { id: "j3", at: 30, text: "日记三", seeds: ["mem-other"], vividness: [] },
    { id: "j4", at: 40, text: "日记四（未消费，无引用）", seeds: [], vividness: [] },
  ];
  writeFileSync(paths.journalPath, JSON.stringify(journal), "utf8");
  const intent = {
    version: 1,
    records: [
      { id: "itn-1", source_ids: ["mem-selftalk-1", "mem-other"], threads: [{ id: "t1", memoryIds: ["mem-selftalk-2"] }] },
    ],
  };
  writeFileSync(paths.intentPath, JSON.stringify(intent, null, 2), "utf8");
  writeFileSync(paths.consumedPath, JSON.stringify({ lastConsumedAt: 15 }), "utf8");
  writeFileSync(paths.statePath, JSON.stringify({ energy: 1 }), "utf8");
  return { records, journal, intent };
}

function readPlan(paths, ids, extra = {}) {
  const memory = readFileSync(paths.memoryPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line).rec);
  const journal = { entries: JSON.parse(readFileSync(paths.journalPath, "utf8")) };
  const intent = JSON.parse(readFileSync(paths.intentPath, "utf8"));
  const consumed = JSON.parse(readFileSync(paths.consumedPath, "utf8"));
  const plan = generateDeletePlan({ records: memory, journal, intent, paths, ids, lastConsumedAt: consumed.lastConsumedAt, ...extra });
  plan.dataSnapshot.memoryLines = memory.length;
  return plan;
}

describe("A2：计划（只读）", () => {
  it("列出可删项、引用计数、refusals；不写 data/", () => {
    const paths = makePaths();
    seedFixture(paths);
    const before = readFileSync(paths.memoryPath, "utf8");
    const plan = readPlan(paths, ["mem-selftalk-1", "mem-selftalk-2"]);
    expect(plan.deletable.map((item) => item.id)).toEqual(["mem-selftalk-1", "mem-selftalk-2"]);
    expect(plan.refusals).toEqual([]);
    expect(plan.applyAllowed).toBe(true);
    expect(plan.references.journalSeedsRemoved).toBe(1);
    expect(plan.references.journalVividnessRemoved).toBe(1);
    expect(plan.references.journalPendingDropped).toBe(0);
    expect(plan.references.journalPendingDroppedIds).toEqual([]);
    // intent 里 source_ids 与 threads.memoryIds 各一条指向被删 id → 2 处
    expect(plan.references.intentRefsRemoved).toBe(2);
    expect(plan.references.chainRefsRemoved).toBe(1);
    expect(readFileSync(paths.memoryPath, "utf8")).toBe(before);
  });

  it("玩家原话默认拒绝，--allow-player 才放行", () => {
    const paths = makePaths();
    seedFixture(paths);
    const refused = readPlan(paths, ["mem-player-1"]);
    expect(refused.applyAllowed).toBe(false);
    expect(refused.refusals[0].code).toBe("protected-player");
    const allowed = readPlan(paths, ["mem-player-1"], { allowPlayer: true });
    expect(allowed.applyAllowed).toBe(true);
  });

  it("找不到的 id 报 not-found；--allow-missing 幂等跳过", () => {
    const paths = makePaths();
    seedFixture(paths);
    expect(readPlan(paths, ["nope"]).refusals[0].code).toBe("not-found");
    expect(readPlan(paths, ["nope"], { allowMissing: true }).applyAllowed).toBe(false); // 无可删项
  });
});

describe("A2：执行（apply）", () => {
  it("缺 --confirm 拒绝", () => {
    const paths = makePaths();
    seedFixture(paths);
    const plan = readPlan(paths, ["mem-selftalk-1"]);
    const result = executeDelete({ paths, plan, confirm: false });
    expect(result.exitCode).toBe(2);
  });

  it("daemon 心跳新鲜时拒绝", () => {
    const paths = makePaths();
    seedFixture(paths);
    writeFileSync(join(paths.dataDir, ".writer-lock"), "x");
    const plan = readPlan(paths, ["mem-selftalk-1"]);
    const result = executeDelete({ paths, plan, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("心跳仍新鲜");
  });

  it("真实删除：put-only 无墓碑、引用移除、备份落盘、幂等快照校验", () => {
    const paths = makePaths();
    seedFixture(paths);
    const plan = readPlan(paths, ["mem-selftalk-1", "mem-proactive-1"]);
    expect(plan.applyAllowed).toBe(true);
    const result = executeDelete({ paths, plan, confirm: true, nowMs: 1793000000000 });
    expect(result.exitCode).toBe(0);
    expect(result.summary.deleted).toBe(2);
    expect(result.summary.journalVividnessRemoved).toBe(2);
    expect(result.summary.journalPendingDropped).toBe(1);

    const text = readFileSync(paths.memoryPath, "utf8");
    expect(text).not.toContain("mem-selftalk-1");
    expect(text).not.toContain("mem-proactive-1");
    expect(text).toContain("mem-other");
    expect(text).not.toContain('"op":"del"');

    const journal = JSON.parse(readFileSync(paths.journalPath, "utf8"));
    expect(journal.find((entry) => entry.id === "j1").seeds).toEqual(["mem-other"]);
    expect(journal.find((entry) => entry.id === "j1").vividness).toEqual([]);
    // j2 未消费且引用被删 id → 整条丢弃，避免下次巩固换 id 写回
    expect(journal.find((entry) => entry.id === "j2")).toBeUndefined();
    expect(journal.find((entry) => entry.id === "j3")).toBeDefined();

    const intent = JSON.parse(readFileSync(paths.intentPath, "utf8"));
    expect(intent.records[0].source_ids).toEqual(["mem-other"]);

    const memory = JSON.parse(text.trim().split("\n").find((line) => line.includes("mem-other")).trim()).rec;
    expect(memory.source_chain).toEqual([]);

    const backups = readdirSync(paths.dataDir).filter((name) => name.startsWith(".bak-hygiene-"));
    expect(backups).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(paths.dataDir, backups[0], "manifest.json"), "utf8"));
    expect(Object.keys(manifest.files).sort()).toEqual(["intent-assistant.json", "memory-assistant.ndjson", "selftalk-assistant.json", "selftalk-consumed-assistant.json", "state-assistant.json"].sort());
    // P2.1：备份 manifest 不再继承 A1 的 edit-memory/A1-apply 标签，且带删除计划摘要
    expect(manifest.tool).toBe("delete-memory");
    expect(manifest.mode).toBe("A2-apply");
    expect([...manifest.plan.deletedIds].sort()).toEqual(["mem-proactive-1", "mem-selftalk-1"]);
    expect(manifest.plan.deletable).toBe(2);
    expect(manifest.plan.dropConsumed).toBe(false);
    expect(manifest.plan.references.journalSeedsRemoved).toBeGreaterThan(0);
  });

  it("快照与磁盘不一致时拒绝（防并发/旧计划）", () => {
    const paths = makePaths();
    seedFixture(paths);
    const plan = readPlan(paths, ["mem-selftalk-1"]);
    plan.dataSnapshot.memoryUnique = 999;
    const result = executeDelete({ paths, plan, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("快照");
  });

  it("坏 WAL（corrupt）拒绝", () => {
    const paths = makePaths();
    seedFixture(paths);
    const plan = readPlan(paths, ["mem-selftalk-1"]);
    writeFileSync(paths.memoryPath, `${readFileSync(paths.memoryPath, "utf8")}{bad json\n`, "utf8");
    const result = executeDelete({ paths, plan, confirm: true });
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("无法解析");
  });


  it("B 口径：--drop-consumed 计划计数已消费条目", () => {
    const paths = makePaths();
    seedFixture(paths);
    const without = readPlan(paths, ["mem-selftalk-1"]);
    expect(without.references.journalConsumedDropped).toBe(0);
    const withFlag = readPlan(paths, ["mem-selftalk-1"], { dropConsumed: true });
    // j1（at=10，已消费）seeds/vividness 都引用被删 id → 整条计入丢弃
    expect(withFlag.references.journalConsumedDropped).toBe(1);
    expect(withFlag.references.journalConsumedDroppedIds).toEqual(["j1"]);
    expect(withFlag.dropConsumed).toBe(true);
  });

  it("B 口径：apply 时已消费条目整条丢弃（不再只清引用）", () => {
    const paths = makePaths();
    seedFixture(paths);
    const plan = readPlan(paths, ["mem-selftalk-1"], { dropConsumed: true });
    const result = executeDelete({ paths, plan, confirm: true });
    expect(result.exitCode).toBe(0);
    expect(result.summary.journalConsumedDropped).toBe(1);
    const journal = JSON.parse(readFileSync(paths.journalPath, "utf8"));
    expect(journal.find((entry) => entry.id === "j1")).toBeUndefined();
    expect(journal.find((entry) => entry.id === "j3")).toBeDefined();
  });

  it("旧心跳（mtime 早于 60s）不拦", () => {
    const paths = makePaths();
    seedFixture(paths);
    const lock = join(paths.dataDir, ".writer-lock");
    writeFileSync(lock, "x");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const plan = readPlan(paths, ["mem-selftalk-1"]);
    const result = executeDelete({ paths, plan, confirm: true });
    expect(result.exitCode).toBe(0);
  });
});
