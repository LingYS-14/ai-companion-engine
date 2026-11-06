/**
 * P4-1（task-69）：夜间确定性 SWS 骨架——fade 锚点 / 冷归档 / WAL compact / 候选报告 /
 * F317 启动补巩固 / reset 清锚点。
 *
 * 这里只测「睡眠期编排」这一层：
 *   · fade 公式本身在 src/memory/lifecycle.ts（test/sleep.test.ts 覆盖）；
 *   · 能量 tick 在 test/energy.test.ts；
 *   · 相位状态机在 test/sleep.test.ts。
 * 本文件锁的是：**每睡点一次、顺序、失败不阻断、锚点落盘、补巩固幂等**。
 *
 * 用 FakeClock + 临时 data 目录，不碰真实 data/。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { loadConfig } from "../src/engine/config.js";
import { sleepHourFor } from "../src/engine/cycles.js";
import { initialSState } from "../src/engine/state.js";
import { SoulRuntime, type PersistedSleep } from "../src/plugin/runtime.js";

const cfg = loadConfig();
const DAY = 86_400_000;
/** 2026-10-28 12:00 UTC = 北京 20:00；localHour 固定 12，避免真实时间带进测试 */
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-sleep-work-"));
  dirs.push(dir);
  return dir;
}

async function open(clock = new FakeClock(NOW, 12), dir = tmp()): Promise<SoulRuntime> {
  return SoulRuntime.open({ characterId: "test", dataDir: dir, trace: false }, clock);
}

/** 预置状态文件：只写需要覆盖的字段，其余走 readPersisted 的默认值。 */
function writeState(dir: string, patch: Record<string, unknown>): void {
  const body = {
    version: 1,
    characterId: "test",
    s: initialSState(),
    bondProgress: 0,
    turns: 0,
    updatedAt: NOW,
    ...patch,
  };
  writeFileSync(join(dir, "state-test.json"), `${JSON.stringify(body)}\n`, "utf8");
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as Record<string, unknown>;
}

function walPath(dir: string): string {
  return join(dir, "memory-test.ndjson");
}

function walLines(dir: string): number {
  try {
    return readFileSync(walPath(dir), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

/** 把实例推进到 asleep（低能量 + 连续两拍判定；静默视为无限长）。 */
async function enterAsleep(rt: SoulRuntime): Promise<void> {
  rt.state.energy = 0.1;
  rt.sleepState();
  rt.sleepState();
  expect(rt.sleepInfo().phase).toBe("asleep");
}

/** 把时钟拨到睡点前 0.2h，再推 0.5h —— 必然跨过今晚的睡点。 */
async function crossSleepPoint(rt: SoulRuntime, clock: FakeClock) {
  const sleepHour = sleepHourFor("test", cfg);
  clock.setLocalHour((sleepHour - 0.2 + 24) % 24);
  await enterAsleep(rt);
  return rt.sleepAdvance(0.5);
}

describe("P4-1 fade：每睡点一次、锚点落盘、升级首跑只写锚点", () => {
  it("睡点后 fade 恰好一次：vividness 下降、forgotten 计数对齐、第二次同睡点不重复", async () => {
    const dir = tmp();
    writeState(dir, { lastFadeAt: NOW - 3 * DAY, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const bright = rt.remember({ content: "凌晨三点的雨声", source: "player", vividness: 0.9 });
    const faint = rt.remember({ content: "走廊尽头那盆快枯死的绿萝", source: "player", vividness: 0.01 });
    const before = rt.memoryStore().get(bright.id)?.vividness ?? 0;
    expect(before).toBeGreaterThan(0);

    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.fade.firstAnchor).toBe(false);
    expect(r.fade.days).toBeCloseTo(3, 5);
    expect(r.fade.faded).toBeGreaterThan(0);
    const after = rt.memoryStore().get(bright.id)?.vividness ?? 0;
    expect(after).toBeLessThan(before);
    // 极低鲜明度的记忆在 3 天衰减后跌破 FORGET_VIVIDNESS_THRESHOLD → 计数与标记一致
    expect(r.fade.forgotten).toBeGreaterThan(0);
    expect(rt.memoryStore().get(faint.id)?.forgotten).toBe(true);
    // 锚点已落盘
    expect(readState(dir)["lastFadeAt"]).toBe(NOW);

    // 同一睡点（20h 去重内）再推：不重复 fade
    const second = rt.sleepAdvance(0.1);
    expect(second.consolidated).toBe(false);
    expect(second.fade.days).toBe(0);
    expect(second.fade.faded).toBe(0);
  });

  it("老存档首跑只写锚点、不补扣（vividness 原样，日志可回放 first-anchor）", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const mem = rt.remember({ content: "她说过会记得的那句话", source: "player", vividness: 0.9 });
    const before = rt.memoryStore().get(mem.id)?.vividness ?? 0;

    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.fade.firstAnchor).toBe(true);
    expect(r.fade.days).toBe(0);
    // 老存档回退链最后一级：没有 lastSleepAt → 用本进程启动时刻（FakeClock 的 NOW）
    expect(r.fade.anchor).toBe(NOW);
    expect(rt.memoryStore().get(mem.id)?.vividness).toBe(before);
    expect(readState(dir)["lastFadeAt"]).toBe(NOW);
  });
});

describe("P4-1 archiveCold：睡点后搬冷档、可 restore", () => {
  it("满足冷归档条件的记忆搬进冷档，热档减少且能 restore 回来", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const mem = rt.remember({ content: "很久以前的旧事", source: "player", vividness: 0.05 });
    rt.memoryStore().mutate(mem.id, {
      forgotten: true,
      vividness: 0.05,
      last_accessed: NOW - 40 * DAY,
    });
    const coldBefore = rt.memoryStats().cold;

    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.archived).toBeGreaterThan(0);
    expect(rt.memoryStats().cold).toBe(coldBefore + r.archived);
    expect(rt.memoryStore().get(mem.id)).toBeUndefined();
    expect(rt.coldRows().some((entry) => entry.record.id === mem.id)).toBe(true);

    const restored = rt.restoreCold(mem.id);
    expect(restored).not.toBeNull();
    expect(rt.memoryStore().get(mem.id)?.forgotten).toBe(false);
  });
});

describe("P4-1 compact：阈 max(120, records*3)，行数降唯一不变，失败只记 error", () => {
  it("超过阈值的 WAL 在睡点被压实：行数降、唯一记录数不变、每行可读", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const mem = rt.remember({ content: "会被反复 touch 的那条记忆", source: "player", vividness: 0.8 });
    for (let i = 0; i < 140; i += 1) {
      rt.memoryStore().mutate(mem.id, { vividness: 0.8 - (i % 10) * 0.01 });
    }
    const linesBefore = walLines(dir);
    expect(linesBefore).toBeGreaterThan(120);
    const uniqueBefore = rt.memoryStore().stats().size;

    const r = await crossSleepPoint(rt, clock);
    expect(r.compact.ran).toBe(true);
    expect(r.compact.error).toBeNull();
    expect(r.compact.linesBefore).toBeGreaterThanOrEqual(linesBefore);
    expect(r.compact.linesAfter).toBeLessThan(r.compact.linesBefore);
    expect(walLines(dir)).toBe(r.compact.linesAfter);
    expect(rt.memoryStore().stats().size).toBe(uniqueBefore);
    for (const line of readFileSync(walPath(dir), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("compact 抛错（rename EPERM 类）不阻断 sleepAdvance：返回 error、能量照常恢复", async () => {
    const dir = tmp();
    writeState(dir, { lastFadeAt: NOW - DAY, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const mem = rt.remember({ content: "为了把 WAL 撑过阈值", source: "player", vividness: 0.8 });
    for (let i = 0; i < 130; i += 1) rt.memoryStore().mutate(mem.id, { vividness: 0.8 });
    vi.spyOn(rt.memoryStore(), "compact").mockImplementationOnce(() => {
      throw new Error("EPERM: rename 失败（测试注入）");
    });

    clock.setLocalHour((sleepHourFor("test", cfg) - 0.2 + 24) % 24);
    await enterAsleep(rt);
    const energyBefore = rt.state.energy;
    const r = rt.sleepAdvance(0.5);
    // F340/v3 §3.4：consolidated 收窄为 work.error === null——compact 失败只回 error 不抛，
    // 所以这里必须是 false（dream 不调度），而不是旧实现的「没抛错就算成功」。
    expect(r.consolidated).toBe(false);
    expect(r.compact.ran).toBe(false);
    expect(r.compact.error).toContain("EPERM");
    expect(r.error).toContain("EPERM");
    // 失败不影响恢复（tick 已经跑过）
    expect(rt.state.energy).toBeGreaterThan(energyBefore);
  });
});

describe("P4-1 hardDelete 候选：只报告 purgeable，不自动删", () => {
  it("冷档里有超过保留期的条目 → purgeable 计数，但删完/恢复前冷档大小不变", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const first = await open(clock, dir);
    const mem = first.remember({ content: "过期到可以被硬删的旧事", source: "player", vividness: 0.05 });
    const record = first.memoryStore().get(mem.id);
    expect(record).toBeDefined();
    // 手工造一个「早就归档」的冷档条目（archived_at 超过 HARD_DELETE_RETENTION_DAYS）
    writeFileSync(
      join(dir, "cold-test.ndjson"),
      `${JSON.stringify({ record, archived_at: NOW - 10 * DAY, reason: "cold_archive" })}\n`,
      "utf8",
    );

    const rt = await open(clock, dir);
    const coldSizeBefore = rt.memoryStats().cold;
    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.purgeable).toBeGreaterThan(0);
    // task-74 B3：不只计数，候选清单里要看得到 id；仍然只报告、不自动删
    expect(r.purgeableIds).toContain(mem.id);
    expect(rt.memoryStats().cold).toBe(coldSizeBefore);
  });
});

describe("P4-1 F317：启动补巩固（deterministic only）", () => {
  it("lastSleepAt > 20h 且跨过睡点 → 补一次巩固并更新锚点；连续第二次启动不再补", async () => {
    const dir = tmp();
    writeState(dir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      lastFadeAt: NOW - 3 * DAY,
      // F340：backfill 的 episode = 醒着时的 lastSleepMs；没有它只会 no-episode 跳过。
      sleep: { phase: "awake", wokeAtMs: NOW - 21 * 3_600_000, asleepSince: null, lastSleepMs: NOW - 21 * 3_600_000 },
    });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const r = rt.backfillSleepWork();
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("ran");
    expect(r.consolidated).toBe(true);
    expect(r.missed).toBeGreaterThanOrEqual(1);
    expect(rt.sleepInfo().lastSleepAt).toBe(NOW);
    expect(readState(dir)["lastSleepAt"]).toBe(NOW);

    // 第二次启动：episode key 已落 → already-worked 跳过（不会重复做功课）
    const rt2 = await open(new FakeClock(NOW, 12), dir);
    const again = rt2.backfillSleepWork();
    expect(again.ran).toBe(false);
    expect(again.reason).toBe("already-worked");
  });

  it("<20h 不补；>20h 但期间没跨睡点也不补", async () => {
    const recentDir = tmp();
    writeState(recentDir, {
      lastSleepAt: NOW - 3_600_000,
      sleep: { phase: "awake", wokeAtMs: NOW - 3_600_000, asleepSince: null, lastSleepMs: NOW - 3_600_000 },
    });
    const recent = await open(new FakeClock(NOW, 12), recentDir);
    expect(recent.backfillSleepWork()).toMatchObject({ ran: false, reason: "recent" });

    // localHour=6：21h 前的 startHour=9 → 到醒时覆盖 (9,30]，唯独漏掉 8 点睡点
    const noCrossDir = tmp();
    writeState(noCrossDir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      sleep: { phase: "awake", wokeAtMs: NOW - 21 * 3_600_000, asleepSince: null, lastSleepMs: NOW - 21 * 3_600_000 },
    });
    const noCross = await open(new FakeClock(NOW, 6), noCrossDir);
    expect(noCross.backfillSleepWork()).toMatchObject({ ran: false, reason: "no-crossing" });
  });

  it("补巩固异常不阻断启动：key/锚点先落、consolidated=false、本段不重试", async () => {
    const dir = tmp();
    writeState(dir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      lastFadeAt: NOW - 3 * DAY,
      sleep: { phase: "awake", wokeAtMs: NOW - 21 * 3_600_000, asleepSince: null, lastSleepMs: NOW - 21 * 3_600_000 },
    });
    const rt = await open(new FakeClock(NOW, 12), dir);
    vi.spyOn(rt, "consolidate").mockImplementationOnce(() => {
      throw new Error("巩固失败（测试注入）");
    });
    const r = rt.backfillSleepWork();
    // v3 §3.3：先写 key+lastSleepAt 再工作；异常保留 key、本段不重试。
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("ran");
    expect(r.consolidated).toBe(false);
    expect(r.error).toContain("巩固失败");
    expect(rt.sleepInfo().lastSleepAt).toBe(NOW);
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(NOW - 21 * 3_600_000);
  });

  it("reset 清两个锚点：reset 后第一次跨睡点必巩固（不被旧锚点挡住）", async () => {
    const dir = tmp();
    writeState(dir, { lastSleepAt: NOW - 2 * 3_600_000, lastFadeAt: NOW - DAY });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    rt.reset(true);
    expect(rt.sleepInfo().lastSleepAt).toBeNull();
    expect(rt.sleepInfo().lastFadeAt).toBeNull();
    expect(readState(dir)["lastSleepAt"]).toBeNull();
    expect(readState(dir)["lastFadeAt"]).toBeNull();

    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.fade.firstAnchor).toBe(true);
  });
});

describe("P4-1 夜间账本：Persisted.sleep.nightBudget 落盘与重载", () => {
  it("写回后落进状态文件；重开实例读回同一本账；合法值原样保留", async () => {
    const dir = tmp();
    const rt = await open(new FakeClock(NOW, 12), dir);
    rt.setNightBudget({ nightKey: "2026-10-28", used: 3 });
    const persisted = readState(dir)["sleep"] as PersistedSleep;
    expect(persisted.nightBudget).toEqual({ nightKey: "2026-10-28", used: 3 });

    const rt2 = await open(new FakeClock(NOW, 12), dir);
    expect(rt2.sleepInfo().nightBudget).toEqual({ nightKey: "2026-10-28", used: 3 });
    // 同值写回早退（不破坏已有账本）
    rt2.setNightBudget({ nightKey: "2026-10-28", used: 3 });
    expect(rt2.sleepInfo().nightBudget).toEqual({ nightKey: "2026-10-28", used: 3 });
  });

  it("坏账本按 null 读：used 越界 / nightKey 格式不对都不让实例起不来", async () => {
    const dir = tmp();
    writeState(dir, {
      sleep: { phase: "awake", wokeAtMs: NOW, asleepSince: null, lastSleepMs: null, nightBudget: { nightKey: "not-a-date", used: 3 } },
    });
    const rt = await open(new FakeClock(NOW, 12), dir);
    expect(rt.sleepInfo().nightBudget).toBeNull();
  });
});

describe("P4-1 修复（task-74）：fade 锚点推进量 / fade 错误聚合 / 候选 id", () => {
  it("不跨睡点的睡眠不让锚点跳到 now：advance 只推进自己 fade 的 hours，下一睡点补回空隙", async () => {
    const dir = tmp();
    // 2h 前 fade 过一次；上次巩固在 21h 前（>20h 去重窗口，允许这一睡点再巩固）
    writeState(dir, { lastFadeAt: NOW - 2 * 3_600_000, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);

    // ① 一段「不跨睡点」的睡眠（localHour 12 → 睡点 8，2h 内跨不过去）
    await enterAsleep(rt);
    const nap = rt.sleepAdvance(2);
    expect(nap.consolidated).toBe(false);
    expect(rt.sleepInfo().lastFadeAt).toBe(NOW - 2 * 3_600_000);

    // ② 醒来后走 5 分钟醒着分支：锚点只能前移 5 分钟，不能跳到 now
    rt.advance(5 / 60, { wakeDrain: false });
    const nowAfterAdvance = clock.now();
    expect(nowAfterAdvance).toBe(NOW + 5 * 60_000);
    const anchorAfterAdvance = rt.sleepInfo().lastFadeAt;
    expect(anchorAfterAdvance).toBe(NOW - 2 * 3_600_000 + 5 * 60_000);
    expect(anchorAfterAdvance).not.toBe(nowAfterAdvance);

    // ③ 随后跨睡点：这次 fade 必须覆盖那 2h 空隙（旧实现把锚点设成 now 时 days=0）
    clock.setLocalHour((sleepHourFor("test", cfg) - 0.2 + 24) % 24);
    const r = rt.sleepAdvance(0.5);
    expect(r.consolidated).toBe(true);
    expect(r.fade.firstAnchor).toBe(false);
    expect(r.fade.days).toBeCloseTo(2 / 24, 6);
  });

  it("fade 抛错也进聚合 error（[sleep-work]/[sleep-backfill] 能显示，不阻断恢复）", async () => {
    const dir = tmp();
    writeState(dir, { lastFadeAt: NOW - DAY, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    vi.spyOn(rt, "fade").mockImplementation(() => {
      throw new Error("fade 失败（测试注入）");
    });

    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(false);
    expect(r.fade.error).toContain("fade 失败");
    expect(r.error).toContain("fade 失败");
    // 恢复照常：fade 失败不阻断能量
    expect(rt.state.energy).toBeGreaterThan(0.1);

    // 启动补巩固同理：聚合 error 里能看见 fade 的失败
    const dir2 = tmp();
    writeState(dir2, {
      lastFadeAt: NOW - DAY,
      lastSleepAt: NOW - 21 * 3_600_000,
      sleep: { phase: "awake", wokeAtMs: NOW - 21 * 3_600_000, asleepSince: null, lastSleepMs: NOW - 21 * 3_600_000 },
    });
    const rt2 = await open(new FakeClock(NOW, 12), dir2);
    vi.spyOn(rt2, "fade").mockImplementation(() => {
      throw new Error("fade 失败（补巩固注入）");
    });
    const backfill = rt2.backfillSleepWork();
    expect(backfill.ran).toBe(true);
    expect(backfill.consolidated).toBe(false);
    expect(backfill.fade.error).toContain("fade 失败");
    expect(backfill.error).toContain("fade 失败");
  });

  it("候选 id 只报告前 20 条（PURGEABLE_ID_LIMIT），计数仍是全量，且不自动删", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const seed = await open(new FakeClock(NOW, 12), dir);
    const records = Array.from({ length: 25 }, (_, i) => {
      const mem = seed.remember({ content: `过期旧事 ${i}`, source: "player", vividness: 0.05 });
      const record = seed.memoryStore().get(mem.id);
      expect(record).toBeDefined();
      return record;
    });
    writeFileSync(
      join(dir, "cold-test.ndjson"),
      `${records.map((record) => JSON.stringify({ record, archived_at: NOW - 10 * DAY, reason: "cold_archive" })).join("\n")}\n`,
      "utf8",
    );

    const rt = await open(clock, dir);
    const coldSizeBefore = rt.memoryStats().cold;
    const r = await crossSleepPoint(rt, clock);
    expect(r.purgeable).toBe(25);
    expect(r.purgeableIds).toHaveLength(20);
    expect(new Set(r.purgeableIds).size).toBe(20);
    expect(rt.memoryStats().cold).toBe(coldSizeBefore);
  });
});

describe("P4-1 数值断言（Lead 提醒：别只锁键存在）", () => {
  it("fade 天数 clamp 到 7：锚点在 30 天前也只按 7 天衰减（不一次抹掉历史）", async () => {
    const dir = tmp();
    writeState(dir, { lastFadeAt: NOW - 30 * DAY, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.fade.days).toBe(7);
  });

  it("compact 阈值是 max(120, records*3)：没超过阈值不压实（行数原样返回）", async () => {
    const dir = tmp();
    writeState(dir, { lastFadeAt: NOW - DAY, lastSleepAt: NOW - 21 * 3_600_000 });
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    const mem = rt.remember({ content: "行数还没到阈值的记忆", source: "player", vividness: 0.8 });
    for (let i = 0; i < 50; i += 1) rt.memoryStore().mutate(mem.id, { vividness: 0.8 });
    const r = await crossSleepPoint(rt, clock);
    expect(r.consolidated).toBe(true);
    expect(r.compact.ran).toBe(false);
    expect(r.compact.linesBefore).toBeGreaterThan(50);
    expect(r.compact.linesBefore).toBeLessThanOrEqual(120);
    expect(r.compact.linesAfter).toBe(r.compact.linesBefore);
  });
});

describe("F340（task-179）：入睡首拍触发 + episode 去重 + backfill at-most-once", () => {
  it("首拍按 episode 触发一次；同 episode 第二拍不重跑；新 episode 再触发", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    await enterAsleep(rt);
    const episode = rt.sleepInfo().asleepSince;
    expect(episode).not.toBeNull();
    const spy = vi.spyOn(rt, "consolidate");

    const first = rt.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(first.trigger).toBe("onset");
    expect(first.consolidated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // key 在功课之前已经落盘（先 key 再工作）
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(episode);

    const second = rt.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(second.consolidated).toBe(false);
    expect(second.trigger).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);

    // 新睡眠段（asleepSince 不同）→ 再触发一次
    const third = rt.sleepAdvance(0.1, { episodeMs: (episode ?? 0) + 3_600_000 });
    expect(third.trigger).toBe("onset");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("no-episode：没有 asleepSince 时不跑、不写假 key", async () => {
    const dir = tmp();
    const rt = await open(new FakeClock(NOW, 12), dir);
    const spy = vi.spyOn(rt, "consolidate");
    const r = rt.sleepAdvance(0.1);
    expect(r.consolidated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const persisted = readState(dir)["sleep"] as PersistedSleep | undefined;
    expect(persisted?.lastSleepWorkEpisode ?? null).toBeNull();
  });

  it("F348：装配层从 sleepState() 拿得到 asleepSince（F340 线上失效回归）", async () => {
    // 线上事实（2026-11-04 06:21）：main.mjs 读 `sl.asleepSince` 喂 episodeMs，
    // 而 sleepState() 当时直接返回 engine 的 SleepState（无 asleepSince）→ 恒 undefined，
    // onset 路径从未触发。这里用真实 runtime 锁「读投影里有这个字段」，再把取到的值
    // 原样喂回 sleepAdvance，确认 onset 真的跑起来。
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    await enterAsleep(rt);
    const sl = rt.sleepState();
    expect(sl.asleep).toBe(true);
    expect(typeof sl.asleepSince).toBe("number");
    expect(sl.asleepSince).toBe(rt.sleepInfo().asleepSince);
    const r = rt.sleepAdvance(0.1, { episodeMs: sl.asleepSince ?? undefined });
    expect(r.trigger).toBe("onset");
    expect(r.consolidated).toBe(true);
  });

  it("跨重启：episode key 已落盘 → 同一段不再重跑", async () => {
    const dir = tmp();
    const rt = await open(new FakeClock(NOW, 12), dir);
    await enterAsleep(rt);
    const episode = rt.sleepInfo().asleepSince ?? 0;
    rt.sleepAdvance(0.1, { episodeMs: episode });

    const rt2 = await open(new FakeClock(NOW, 12), dir);
    const spy = vi.spyOn(rt2, "consolidate");
    const again = rt2.sleepAdvance(0.1, { episodeMs: episode });
    expect(again.consolidated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("work.error 非 null：consolidated=false、key 已落、本段不重试", async () => {
    const dir = tmp();
    const rt = await open(new FakeClock(NOW, 12), dir);
    const mem = rt.remember({ content: "为了把 WAL 撑过阈值（onset）", source: "player", vividness: 0.8 });
    for (let i = 0; i < 130; i += 1) rt.memoryStore().mutate(mem.id, { vividness: 0.8 });
    vi.spyOn(rt.memoryStore(), "compact").mockImplementationOnce(() => {
      throw new Error("EPERM（onset 注入）");
    });
    await enterAsleep(rt);
    const episode = rt.sleepInfo().asleepSince;
    const r = rt.sleepAdvance(0.5, { episodeMs: episode ?? undefined });
    expect(r.error).toContain("EPERM");
    expect(r.consolidated).toBe(false);
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(episode);

    const spy = vi.spyOn(rt, "consolidate");
    const again = rt.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(again.consolidated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("consolidate 抛错：consolidated=false、key/锚点已落、本段不重试", async () => {
    const dir = tmp();
    const rt = await open(new FakeClock(NOW, 12), dir);
    await enterAsleep(rt);
    const episode = rt.sleepInfo().asleepSince;
    const spy = vi.spyOn(rt, "consolidate").mockImplementationOnce(() => {
      throw new Error("巩固失败（onset 注入）");
    });
    const r = rt.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(r.consolidated).toBe(false);
    expect(r.error).toContain("巩固失败");
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(episode);
    expect(rt.sleepInfo().lastSleepAt).toBe(NOW);

    const second = rt.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(second.consolidated).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("backfill 睡着：写 asleepSince；随后 onset 同 episode 跳过", async () => {
    const dir = tmp();
    const asleepSince = NOW - 2 * 3_600_000;
    writeState(dir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      lastFadeAt: NOW - 3 * DAY,
      sleep: { phase: "asleep", wokeAtMs: NOW - 21 * 3_600_000, asleepSince, lastSleepMs: asleepSince },
    });
    const rt = await open(new FakeClock(NOW, 12), dir);
    const r = rt.backfillSleepWork();
    expect(r.ran).toBe(true);
    expect(r.reason).toBe("ran");
    expect(r.consolidated).toBe(true);
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(asleepSince);

    const spy = vi.spyOn(rt, "consolidate");
    const again = rt.sleepAdvance(0.1, { episodeMs: asleepSince });
    expect(again.consolidated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("backfill 醒着：写 lastSleepMs；下一次入睡新 episode 正常触发", async () => {
    const dir = tmp();
    const lastSleepMs = NOW - 6 * 3_600_000;
    writeState(dir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      lastFadeAt: NOW - 3 * DAY,
      sleep: { phase: "awake", wokeAtMs: lastSleepMs, asleepSince: null, lastSleepMs },
    });
    const rt = await open(new FakeClock(NOW, 12), dir);
    const r = rt.backfillSleepWork();
    expect(r.ran).toBe(true);
    expect((readState(dir)["sleep"] as PersistedSleep).lastSleepWorkEpisode).toBe(lastSleepMs);

    await enterAsleep(rt);
    const newEpisode = rt.sleepInfo().asleepSince;
    expect(newEpisode).not.toBeNull();
    expect(newEpisode).not.toBe(lastSleepMs);
    const spy = vi.spyOn(rt, "consolidate");
    const onset = rt.sleepAdvance(0.1, { episodeMs: newEpisode ?? undefined });
    expect(onset.trigger).toBe("onset");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("backfill work 后显式落盘 lastFadeAt（不依赖 archiveCold 副作用）：reload 后不重复 fade", async () => {
    const dir = tmp();
    const lastSleepMs = NOW - 6 * 3_600_000;
    writeState(dir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      lastFadeAt: NOW - 3 * DAY,
      sleep: { phase: "awake", wokeAtMs: lastSleepMs, asleepSince: null, lastSleepMs },
    });
    const rt = await open(new FakeClock(NOW, 12), dir);
    // 内存里没有可冷归档的记忆：archiveCold 搬 0 条，不会顺带 save。
    const r = rt.backfillSleepWork();
    expect(r.ran).toBe(true);
    expect(r.archived).toBe(0);
    // B1：work 后显式落盘，磁盘锚点必须是 NOW（若只在 work 前 save，这里仍是 3 天前）。
    expect(readState(dir)["lastFadeAt"]).toBe(NOW);

    // 重启（从磁盘恢复）：下一段睡眠只按 NOW→NOW+1h 的 0.04 天衰减，不能从 3 天前重放。
    const clock2 = new FakeClock(NOW + 3_600_000, 12);
    const rt2 = await open(clock2, dir);
    await enterAsleep(rt2);
    const episode = rt2.sleepInfo().asleepSince;
    expect(episode).not.toBeNull();
    const next = rt2.sleepAdvance(0.1, { episodeMs: episode ?? undefined });
    expect(next.trigger).toBe("onset");
    expect(next.fade.days).toBeGreaterThan(0);
    expect(next.fade.days).toBeLessThan(0.1);
  });

  it("backfill 已完成段 → already-worked；no-episode（醒着无 lastSleepMs / 睡着无 asleepSince）", async () => {
    const doneDir = tmp();
    const lastSleepMs = NOW - 6 * 3_600_000;
    writeState(doneDir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      sleep: { phase: "awake", wokeAtMs: lastSleepMs, asleepSince: null, lastSleepMs, lastSleepWorkEpisode: lastSleepMs },
    });
    const done = await open(new FakeClock(NOW, 12), doneDir);
    const spy = vi.spyOn(done, "consolidate");
    expect(done.backfillSleepWork()).toMatchObject({ ran: false, reason: "already-worked" });
    expect(spy).not.toHaveBeenCalled();

    const noEpDir = tmp();
    const noEp = await open(new FakeClock(NOW, 12), noEpDir);
    expect(noEp.backfillSleepWork()).toMatchObject({ ran: false, reason: "no-episode" });

    const asleepNoEpDir = tmp();
    writeState(asleepNoEpDir, {
      lastSleepAt: NOW - 21 * 3_600_000,
      sleep: { phase: "asleep", wokeAtMs: NOW - 21 * 3_600_000, asleepSince: null, lastSleepMs: NOW - 3_600_000 },
    });
    const asleepNoEp = await open(new FakeClock(NOW, 12), asleepNoEpDir);
    expect(asleepNoEp.backfillSleepWork()).toMatchObject({ ran: false, reason: "no-episode" });
  });

  it("同一拍 crossing 与 onset 不双跑：只跑一次 consolidate", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await open(clock, dir);
    clock.setLocalHour((sleepHourFor("test", cfg) - 0.2 + 24) % 24);
    await enterAsleep(rt);
    const episode = rt.sleepInfo().asleepSince;
    const spy = vi.spyOn(rt, "consolidate");
    const r = rt.sleepAdvance(0.5, { episodeMs: episode ?? undefined });
    expect(r.trigger).toBe("onset");
    expect(r.consolidated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
