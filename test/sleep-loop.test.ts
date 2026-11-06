import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SleepPhase, SleepState, SleepThresholds } from "../src/engine/sleep.js";
import { nextSleepState } from "../src/engine/sleep.js";

/**
 * P3 睡眠死锁闭环测试（task-117）。
 *
 * 审计文档：`docs/DESIGN.md` 的能量与睡眠一节。
 * 线上形态：energy 0.399 时进入 drowsy → 装配层（`main.mjs`）只对 awake 扣能量 →
 * drowsy 期反而回血 → 睡压永远到不了 0.8 → 原状态机又没有 drowsy→awake 回退边 →
 * 永久卡在 drowsy（8.5h+，从未 asleep）。
 *
 * 这里不做单步纯函数验证，而是「连续多拍、energy 由状态机自己演化」的闭环：
 * 每一拍按装配层真实策略结算 energy（awake/drowsy 耗电、asleep 恢复、waking 只恢复），
 * 再把新 energy 喂回状态机。drowsy 是否耗电直接从 `main.mjs` 源码读取——修复前该
 * 正则不命中，闭环测试因此会红（而不是测试自己写一份「正确策略」自说自话）。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const HOUR_MS = 3_600_000;
const TICK_MS = 5 * 60_000;
const DT = TICK_MS / HOUR_MS;

/** 与 overlay/engine 现状一致：SLEEP_MIN_WINDOW_HOURS=4、MAX=9、WAKE_ENERGY=0.65、lazy_energy_max=0.2 */
const TH: SleepThresholds = {
  minWindowHours: 4,
  maxWindowHours: 9,
  wakeEnergy: 0.65,
  lazyEnergyMax: 0.2,
};

const RECOVERY_RATE = 1; // ENERGY_RECOVERY_RATE（per-hour）
const WAKE_COST = 1.04; // ENERGY_WAKE_COST（per-hour；F328 由 1.03125 调为 1.04）

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 生产装配层现在是否让 drowsy 也走 A 通道（task-117 ①）。 */
function drainsDrowsyInMain(): boolean {
  const main = read("scripts/autonomy/main.mjs");
  return /wakeDrain:\s*sl\.phase === "awake" \|\| sl\.phase === "drowsy"/.test(main);
}

interface Sim {
  nowMs: number;
  localHour: number;
  energy: number;
  phase: SleepPhase;
  lastSleepAt: number | null;
  lastWakeAt: number | null;
  peerMessagedAt: number | null;
}

function makeSim(over: Partial<Sim> = {}): Sim {
  return {
    nowMs: Date.UTC(2026, 10, 2, 0, 0),
    localHour: 12,
    energy: 1,
    phase: "awake",
    lastSleepAt: null,
    lastWakeAt: null,
    peerMessagedAt: null, // 长期静默：quietForMs = Infinity
    ...over,
  };
}

/** 推进一步：状态机决定相位 → 装配层按相位结算 energy（与 main.mjs 的真实策略同构）。 */
function tick(sim: Sim, sleepHour: number): SleepState {
  const state = nextSleepState({
    nowMs: sim.nowMs,
    localHour: sim.localHour,
    energy: sim.energy,
    sleepHour,
    lastSleepAt: sim.lastSleepAt,
    lastWakeAt: sim.lastWakeAt,
    previousPhase: sim.phase,
    peerMessagedAt: sim.peerMessagedAt,
    thresholds: TH,
  });
  const recovery = RECOVERY_RATE * DT;
  const drains = state.phase === "awake" || (state.phase === "drowsy" && drainsDrowsyInMain());
  if (state.asleep) {
    // 睡着：只恢复，不耗能（runSleepTick / sleepAdvance 口径）
    sim.energy = clamp01(sim.energy + recovery);
  } else if (drains) {
    // 醒着（awake）或困着（drowsy，task-117 ①）：恢复 − 清醒耗散；净变化约 −0.0026/拍
    sim.energy = clamp01(sim.energy + recovery - WAKE_COST * DT);
  } else {
    // waking：按 awake 处理但不扣 A（task-57 B4）
    sim.energy = clamp01(sim.energy + recovery);
  }
  // 相位迁移时刻与 runtime.applySleep 同构：进 asleep 记 lastSleepAt，进 waking 记 lastWakeAt
  if (state.phase === "asleep" && sim.phase !== "asleep") sim.lastSleepAt = sim.nowMs;
  if (state.phase === "waking" && sim.phase !== "waking") sim.lastWakeAt = sim.nowMs;
  sim.phase = state.phase;
  sim.nowMs += TICK_MS;
  sim.localHour = (sim.localHour + DT) % 24;
  return state;
}

describe("task-117 ①：drowsy 也走 A 通道（装配层锁）", () => {
  it("main.mjs 的 wakeDrain 覆盖 awake 与 drowsy，waking 仍不扣", () => {
    const main = read("scripts/autonomy/main.mjs");
    // 修复后必须是这样一行；修复前只有 sl.phase === "awake"，此断言红。
    expect(main).toContain('wakeDrain: sl.phase === "awake" || sl.phase === "drowsy"');
    expect(main).not.toContain('wakeDrain: sl.phase === "awake" }');
  });
});

describe("task-117 ②：drowsy 的窗口关闭回退边", () => {
  it("窗口关闭且睡压不足（energy 0.5）→ 醒回 awake，不在 drowsy 卡死", () => {
    const state = nextSleepState({
      nowMs: Date.UTC(2026, 10, 2, 3, 0),
      localHour: 15, // sleepHour=3、窗长 9h：窗口 [3,12)，15 点已关
      energy: 0.5,
      sleepHour: 3,
      lastSleepAt: null,
      lastWakeAt: null,
      previousPhase: "drowsy",
      peerMessagedAt: null,
      thresholds: TH,
    });
    expect(state.windowOpen).toBe(false);
    expect(state.phase).toBe("awake");
    expect(state.reason).toBe("window");
  });

  it("窗口关闭但睡压已过入睡线（energy 0.1）→ 仍可入睡（过度疲惫打盹，允许）", () => {
    const state = nextSleepState({
      nowMs: Date.UTC(2026, 10, 2, 3, 0),
      localHour: 15,
      energy: 0.1,
      sleepHour: 3,
      lastSleepAt: null,
      lastWakeAt: null,
      previousPhase: "drowsy",
      peerMessagedAt: null,
      thresholds: TH,
    });
    expect(state.windowOpen).toBe(false);
    expect(state.phase).toBe("asleep");
    expect(state.reason).toBe("quiet");
  });
});

describe("task-117 ②-B1：回退与进入同线 0.75（严格不等号；恰为 0.75 零宽死区，不再每拍翻转）", () => {
  const base = {
    nowMs: Date.UTC(2026, 10, 2, 3, 0),
    localHour: 15, // sleepHour=3、窗长 9h：窗口 [3,12)，15 点已关
    sleepHour: 3,
    lastSleepAt: null,
    lastWakeAt: null,
    peerMessagedAt: null,
    thresholds: TH,
  };

  it("窗外 pressure=0.76（energy=0.24）进入 drowsy 后连续 20 拍保持，不再翻回 awake", () => {
    // 进入线 DROWSY_PRESSURE=0.75：pressure=0.76 > 0.75 → 第一拍进 drowsy。
    const first = nextSleepState({ ...base, energy: 0.24, previousPhase: "awake" });
    expect(first.windowOpen).toBe(false);
    expect(first.phase).toBe("drowsy");
    expect(first.reason).toBe("pressure");
    // 回退线也是 0.75：pressure 0.76 已越过进入线且未跌破回退线（<0.75 才退）→
    // 后续多拍保持 drowsy（0.75~0.8 区间从 awake 进入后不再翻转）。
    // 修复前（回退线 0.8）这里会在下一拍立刻回 awake，形成每 5 分钟一次的翻转。
    let phase: SleepPhase = "drowsy";
    for (let i = 0; i < 20; i += 1) {
      const state = nextSleepState({ ...base, energy: 0.24, previousPhase: phase });
      expect(state.phase).toBe("drowsy");
      expect(state.reason).toBe("hold");
      phase = state.phase;
    }
  });

  it("pressure 跌破 0.75（energy 0.26）时回退边仍生效：醒回 awake/window", () => {
    // 回退边不能被 B1 修法删掉：pressure=0.74 < 0.75 且窗外 → awake。
    const state = nextSleepState({ ...base, energy: 0.26, previousPhase: "drowsy" });
    expect(state.windowOpen).toBe(false);
    expect(state.phase).toBe("awake");
    expect(state.reason).toBe("window");
  });

  it("恰为 0.75 的精确边界：awake 不进入、drowsy 不退出（两方向都不触发，零宽死区）", () => {
    // pressure=0.75 ⇔ energy=0.25；进入线与回退线同值且同为严格不等号。
    const fromAwake = nextSleepState({ ...base, energy: 0.25, previousPhase: "awake" });
    expect(fromAwake.sleepPressure).toBe(0.75);
    expect(fromAwake.phase).toBe("awake");
    expect(fromAwake.reason).toBe("hold");

    const fromDrowsy = nextSleepState({ ...base, energy: 0.25, previousPhase: "drowsy" });
    expect(fromDrowsy.sleepPressure).toBe(0.75);
    expect(fromDrowsy.phase).toBe("drowsy");
    expect(fromDrowsy.reason).toBe("hold");
  });
});

describe("task-117 ③：闭环时序（连续多拍，energy 自演化）", () => {
  it("回归：高能量 drowsy（0.99）不再回血，有限拍内必然入睡——修复前能量反升、永远到不了 asleep", () => {
    const sim = makeSim({ phase: "drowsy", energy: 0.99, localHour: 12 });
    const energies: number[] = [sim.energy];
    let asleepAt: number | null = null;
    for (let i = 0; i < 400; i += 1) {
      const state = tick(sim, 3);
      energies.push(sim.energy);
      if (state.asleep && asleepAt === null) asleepAt = i;
    }
    // 修复后：drowsy 也耗电 → 前 5 拍能量严格下降（修复前会涨到 1.0）
    for (let i = 1; i <= 5; i += 1) {
      expect(energies[i]).toBeLessThan(energies[i - 1] as number);
    }
    // 并且不会永久困在 drowsy：有限拍内进入 asleep
    expect(asleepAt).not.toBeNull();
    expect(asleepAt as number).toBeLessThan(400);
  });

  it("一晚内走通：awake → drowsy → asleep，睡满最短窗、在最长窗内醒", () => {
    // 20:00、energy 0.3（睡压 0.7）出发：耗电 → 约 23 点入睡 → 次日约 3 点醒
    const sim = makeSim({ phase: "awake", energy: 0.3, localHour: 20 });
    let asleepAtTick: number | null = null;
    let wakeState: SleepState | null = null;
    let energyAtSleep = 0;
    let energyAfterSleepTick = 0;
    for (let i = 0; i < 24 * 12; i += 1) {
      const before = sim.energy;
      const state = tick(sim, 3);
      if (state.asleep) {
        if (asleepAtTick === null) {
          asleepAtTick = i;
          energyAtSleep = before;
          energyAfterSleepTick = sim.energy;
        }
      } else if (state.phase === "waking" && asleepAtTick !== null) {
        wakeState = state;
        break;
      }
    }
    expect(asleepAtTick).not.toBeNull();
    // asleep 期能量是恢复的（不是继续掉）
    expect(energyAfterSleepTick).toBeGreaterThan(energyAtSleep);
    expect(wakeState).not.toBeNull();
    const woke = wakeState as SleepState;
    expect(["min-window", "max-window"]).toContain(woke.reason);
    // 睡眠时长落在 [minWindow, maxWindow]（含 5 分钟拍粒度）
    expect(woke.sleptHours).toBeGreaterThanOrEqual(TH.minWindowHours);
    expect(woke.sleptHours).toBeLessThanOrEqual(TH.maxWindowHours);
  });

  it("任何时刻都不会永久停在 drowsy：drowsy 连续段有界，且最终要么入睡要么醒着", () => {
    // 窗外 pressure 落在 0.75~0.8 时，从 awake 进入 drowsy 后会保持（而不是每拍翻回 awake）；
    // 只要 drowsy 耗电，睡压继续涨，最终越线入睡——不允许超过 20 拍连续 drowsy
    // （0.75→0.8 约需 (0.8-0.75)/0.0026 ≈ 19.2 拍，取整 20 为理论上界）。
    const sim = makeSim({ phase: "drowsy", energy: 0.25, localHour: 15 });
    let run = 0;
    let maxRun = 0;
    let sawAsleep = false;
    for (let i = 0; i < 400; i += 1) {
      const state = tick(sim, 3);
      if (state.phase === "drowsy") {
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
      if (state.asleep) {
        sawAsleep = true;
        break;
      }
    }
    expect(sawAsleep).toBe(true);
    // 上界按算术取整：0.75→0.8 需 0.05/(0.03125/12h÷12) ≈ 19.2 拍，取 20 为理论上界；
    // 超过 20 拍说明回退/耗电逻辑变坏（会远离入睡线），不是「等到入睡」的正常阶段。
    expect(maxRun).toBeLessThanOrEqual(20);
  });
});
