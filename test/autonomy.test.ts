import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY, resolveAutonomyConfig } from "../src/autonomy/config.js";
import { advanceHistory, dayKey, EMPTY_HISTORY, planTick } from "../src/autonomy/tick-plan.js";
import { acquireWriterLock, heartbeatWriterLock, readWriterLock, releaseWriterLock } from "../src/autonomy/lock.js";
import { AutonomyLoop } from "../src/autonomy/loop.js";
import { createDryRunPort, createPortActions } from "../src/autonomy/port.js";
import { runDryTick } from "../src/autonomy/dryrun.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("自主运行：配置", () => {
  it("缺省关闭，节奏用默认值", () => {
    const cfg = resolveAutonomyConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.stateIntervalMs).toBe(5 * MIN);
    expect(cfg.learnIntervalMs).toBe(45 * MIN);
    expect(cfg.consolidateHour).toBe(3);
  });

  it("非法值回落到默认，小时夹在 0–23", () => {
    const cfg = resolveAutonomyConfig({ enabled: true, stateIntervalMs: -1, consolidateHour: 99, lockStaleMs: 0 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.stateIntervalMs).toBe(DEFAULT_AUTONOMY.stateIntervalMs);
    expect(cfg.consolidateHour).toBe(3);
    expect(cfg.lockStaleMs).toBe(DEFAULT_AUTONOMY.lockStaleMs);
  });
});

describe("自主运行：tick 规划", () => {
  const base = { now: 12 * HOUR, localHour: 12, localDay: "2026-10-29" };

  it("全都没到期就什么都不做", () => {
    const recent = 12 * HOUR - MIN;
    const history = { lastStateAt: recent, lastLearnAt: recent, lastProactiveAt: recent, lastSelfTalkAt: recent, lastConsolidateDay: "2026-10-29" };
    expect(planTick({ ...base, history, config: { ...DEFAULT_AUTONOMY, enabled: true } }).actions).toEqual([]);
  });

  it("到期才做；巩固每天一次且只在指定小时", () => {
    const cfg = { ...DEFAULT_AUTONOMY, enabled: true };
    const plan = planTick({ ...base, localHour: 3, history: { ...EMPTY_HISTORY, lastConsolidateDay: "2026-10-28" }, config: cfg });
    expect(plan.actions).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    const again = planTick({ now: 3 * HOUR + 6 * MIN, localHour: 3, localDay: "2026-10-29", history: { lastStateAt: 3 * HOUR + 2 * MIN, lastLearnAt: 3 * HOUR + 2 * MIN, lastProactiveAt: 3 * HOUR + 2 * MIN, lastSelfTalkAt: 3 * HOUR + 2 * MIN, lastConsolidateDay: "2026-10-29" }, config: cfg });
    expect(again.actions).toEqual([]);
  });

  it("推进历史只记真正跑过的动作", () => {
    const h = advanceHistory(EMPTY_HISTORY, ["tick", "proactive"], 1000, "2026-10-29");
    expect(h.lastStateAt).toBe(1000);
    expect(h.lastProactiveAt).toBe(1000);
    expect(h.lastLearnAt).toBe(0);
    expect(h.lastConsolidateDay).toBe("");
  });

  it("dayKey 按给定时区偏移取本地日期", () => {
    const t = Date.UTC(2026, 9, 28, 17, 30); // 北京时间 10-29 01:30
    expect(dayKey(t, 480)).toBe("2026-10-29");
    expect(dayKey(t, 0)).toBe("2026-10-28");
  });
});

describe("自主运行：单写者锁", () => {
  const dirs: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "autonomy-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("拿到锁写文件；别的进程心跳还新时拿不到", () => {
    const path = join(fresh(), "w.lock");
    // 用父进程当"另一个活着的进程"：假 pid（1/2/9）现在会被判为持有者已死，锁可被接管
    const other = process.ppid;
    const lock = acquireWriterLock({ path, pid: other, owner: "a", now: 1000, staleMs: 100 });
    expect(lock).not.toBeNull();
    expect(readWriterLock(path)?.pid).toBe(other);
    expect(acquireWriterLock({ path, pid: process.pid, owner: "b", now: 1050, staleMs: 100 })).toBeNull();
  });

  it("陈旧锁可接管；本进程再拿视为续心跳", () => {
    const path = join(fresh(), "w.lock");
    writeFileSync(path, JSON.stringify({ version: 2, pid: 9, owner: "old", heartbeatAt: 0, note: "" }));
    const taken = acquireWriterLock({ path, pid: 3, owner: "c", now: 10_000, staleMs: 100 });
    expect(taken).not.toBeNull();
    expect(readWriterLock(path)?.pid).toBe(3);
    expect(readWriterLock(path)?.note).toContain("takeover");
    const again = acquireWriterLock({ path, pid: 3, owner: "c", now: 10_050, staleMs: 100 });
    expect(again).not.toBeNull();
  });

  it("释放只删自己的锁，心跳会更新写入时间", () => {
    const path = join(fresh(), "w.lock");
    const lock = acquireWriterLock({ path, pid: 4, owner: "d", now: 1000, staleMs: 100 });
    expect(lock).not.toBeNull();
    if (lock === null) return;
    heartbeatWriterLock(lock, 2000, "alive");
    expect(readWriterLock(path)?.heartbeatAt).toBe(2000);
    const foreign = { path, pid: 5, owner: "e" };
    releaseWriterLock(foreign);
    expect(readWriterLock(path)?.pid).toBe(4);
    releaseWriterLock(lock);
    expect(readWriterLock(path)).toBeNull();
  });
});

describe("自主运行：循环", () => {
  const baseDeps = (over: Partial<Parameters<typeof makeLoop>[0]> = {}) => makeLoop(over);

  function makeLoop(over: {
    config?: Partial<ReturnType<typeof resolveAutonomyConfig>>;
    now?: () => number;
    lockPath?: string;
    actions?: Record<string, unknown>;
  } = {}) {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loop-"));
    const config = { ...DEFAULT_AUTONOMY, enabled: true, ...(over.config ?? {}) } as ReturnType<typeof resolveAutonomyConfig>;
    const loop = new AutonomyLoop({
      config,
      actions: {
        stateTick: () => calls.push("tick"),
        learn: () => calls.push("learn"),
        consolidate: () => calls.push("consolidate"),
        proactive: () => calls.push("proactive"),
        selftalk: () => calls.push("selftalk"),
        log: () => undefined,
      },
      lockPath: over.lockPath ?? join(dir, "w.lock"),
      pid: 1,
      now: over.now ?? (() => 3 * HOUR),
      localHour: () => 3,
      tzOffsetMinutes: 480,
    });
    return { loop, calls, dir };
  }

  it("未启用时什么都不做，也不写锁", async () => {
    const { loop, calls, dir } = baseDeps({ config: { enabled: false } });
    const plan = await loop.runOnce();
    expect(plan.reason).toBe("disabled");
    expect(calls).toEqual([]);
    expect(readWriterLock(join(dir, "w.lock"))).toBeNull();
  });

  it("启用后执行到期的动作并推进历史", async () => {
    const { loop, calls } = baseDeps();
    const plan = await loop.runOnce();
    expect(plan.actions).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(calls).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(loop.snapshot().history.lastLearnAt).toBe(3 * HOUR);
    expect(loop.snapshot().running).toBe(false);
  });

  it("上一拍未结束时跳过重入的一拍（F352 B1：共享的每拍快照不能被下一拍覆写）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-reentry-"));
    const calls: string[] = [];
    let release!: () => void;
    const tickGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intentRuns = 0;
    const loop = new AutonomyLoop({
      config: { ...DEFAULT_AUTONOMY, enabled: true } as ReturnType<typeof resolveAutonomyConfig>,
      actions: {
        stateTick: () => calls.push("tick"),
        learn: () => calls.push("learn"),
        consolidate: () => calls.push("consolidate"),
        proactive: () => calls.push("proactive"),
        selftalk: () => calls.push("selftalk"),
        intentTick: () => {
          intentRuns += 1;
          return tickGate;
        },
        log: () => undefined,
      },
      lockPath: join(dir, "w.lock"),
      pid: 1,
      now: () => 3 * HOUR,
      localHour: () => 3,
      tzOffsetMinutes: 480,
    });

    const first = loop.runOnce();
    await Promise.resolve();
    expect(intentRuns).toBe(1);

    // 第一拍还卡在 intentTick 的 await 上——第二拍必须被重入闸挡住，不能动共享快照/动作。
    const second = await loop.runOnce();
    expect(second.reason).toBe("busy");
    expect(second.actions).toEqual([]);
    expect(intentRuns).toBe(1);

    release();
    const firstPlan = await first;
    expect(firstPlan.actions).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(calls).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
  });

  it("另一个进程持有新锁时跳过，不执行动作", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop2-"));
    const path = join(dir, "w.lock");
    // 用还活着的进程（父进程）当持有者；假 pid 会被判为"持有者已死"从而接管
    const other = process.ppid;
    writeFileSync(path, JSON.stringify({ version: 2, pid: other, owner: "other", heartbeatAt: 3 * HOUR, note: "" }));
    const { loop, calls } = baseDeps({ lockPath: path });
    const plan = await loop.runOnce();
    expect(plan.reason).toBe("locked");
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(other);
    expect(loop.snapshot().history.lastStateAt).toBe(0);
  });
});

describe("P1 意图节拍挂在循环上（可选、失败隔离）", () => {
  function make(extra: { intentTick?: (now: number) => void | Promise<void> } = {}) {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loop-intent-"));
    const loop = new AutonomyLoop({
      config: { ...DEFAULT_AUTONOMY, enabled: true } as ReturnType<typeof resolveAutonomyConfig>,
      actions: {
        stateTick: () => calls.push("tick"),
        learn: () => calls.push("learn"),
        consolidate: () => calls.push("consolidate"),
        proactive: () => calls.push("proactive"),
        selftalk: () => calls.push("selftalk"),
        ...(extra.intentTick === undefined ? {} : { intentTick: extra.intentTick }),
        log: () => undefined,
      },
      lockPath: join(dir, "w.lock"),
      pid: 1,
      now: () => 3 * HOUR,
      localHour: () => 3,
      tzOffsetMinutes: 480,
    });
    return { loop, calls, dir };
  }

  it("注入后每拍跑一次，但不改 plan.actions（意图不是计划动作）", async () => {
    const seen: number[] = [];
    const { loop, calls, dir } = make({ intentTick: (now) => seen.push(now) });
    const plan = await loop.runOnce();
    expect(plan.actions).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(calls).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(seen).toEqual([3 * HOUR]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("A7：意图节拍跑在计划动作之前（proactive/selftalk 用同一拍的事实）", async () => {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loop-intent3-"));
    const loop = new AutonomyLoop({
      config: { ...DEFAULT_AUTONOMY, enabled: true } as ReturnType<typeof resolveAutonomyConfig>,
      actions: {
        stateTick: () => calls.push("tick"),
        learn: () => calls.push("learn"),
        consolidate: () => calls.push("consolidate"),
        proactive: () => calls.push("proactive"),
        selftalk: () => calls.push("selftalk"),
        intentTick: () => calls.push("intent"),
        log: () => undefined,
      },
      lockPath: join(dir, "w.lock"),
      pid: 1,
      now: () => 3 * HOUR,
      localHour: () => 3,
      tzOffsetMinutes: 480,
    });
    await loop.runOnce();
    expect(calls.indexOf("intent")).toBe(0);
    expect(calls.indexOf("intent")).toBeLessThan(calls.indexOf("proactive"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("intentTick 抛错只记账，不打断已跑完的动作与心跳", async () => {
    const logs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "loop-intent2-"));
    const loop = new AutonomyLoop({
      config: { ...DEFAULT_AUTONOMY, enabled: true } as ReturnType<typeof resolveAutonomyConfig>,
      actions: {
        stateTick: () => undefined,
        learn: () => undefined,
        consolidate: () => undefined,
        proactive: () => undefined,
        selftalk: () => undefined,
        intentTick: () => {
          throw new Error("boom");
        },
        log: (line) => logs.push(line),
      },
      lockPath: join(dir, "w.lock"),
      pid: 1,
      now: () => 3 * HOUR,
      localHour: () => 3,
      tzOffsetMinutes: 480,
    });
    const plan = await loop.runOnce();
    expect(plan.actions).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    expect(logs.some((l) => l.includes("intentTick 失败") && l.includes("boom"))).toBe(true);
    expect(loop.snapshot().running).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("不注入时完全回到旧行为（零副作用）", async () => {
    const { loop, calls, dir } = make();
    await loop.runOnce();
    expect(calls).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("自主运行：dry-run", () => {
  it("走完整装配跑一轮：四个动作都执行、日志齐全、锁已释放", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dry-"));
    const lockPath = join(dir, "dry.lock");
    const result = await runDryTick({ now: 3 * HOUR, localHour: 3, lockPath, tzOffsetMinutes: 480, pid: 7 });
    expect(result.ran).toEqual(["tick", "learn", "consolidate", "proactive", "selftalk"]);
    // 第一拍没有基准时间：只记基准、不推进（advance 拒绝 0 小时），也不该报错
    expect(result.log.join(String.fromCharCode(10))).not.toContain("hours 必须是正的有限数");
    expect(result.log.join("\n")).toContain("learn dry-run");
    expect(result.log.join("\n")).toContain("consolidate accepted=0");
    expect(result.log.join("\n")).toContain("proactive opened=false");
    expect(result.lockLeft).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("第一拍只记基准，第二拍按真实间隔推进", () => {
    const lines: string[] = [];
    const seen: number[] = [];
    const actions = createPortActions(
      {
        advance: (dt) => {
          seen.push(dt);
          return { ticks: 0 };
        },
        learn: () => ({ topic: "t", keyword: "k" }),
        consolidate: () => ({ accepted: 0, rejected: 0 }),
        proactive: () => ({ opened: false, reason: "r" }),
      },
      (line) => lines.push(line),
    );
    actions.stateTick(0);
    actions.stateTick(2 * HOUR);
    expect(seen[0]).toBeCloseTo(2, 5);
    expect(lines.length).toBe(1);
  });

  it("dry-run 端口不产生副作用，且显式 enabled=false 也会被强制启用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dry2-"));
    const lockPath = join(dir, "dry.lock");
    const result = await runDryTick({ now: 3 * HOUR, localHour: 3, lockPath, config: { enabled: false }, pid: 8 });
    expect(result.ran.length).toBe(5);
    expect(createDryRunPort().consolidate()).toEqual({ accepted: 0, rejected: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});
