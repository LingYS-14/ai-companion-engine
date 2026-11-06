/**
 * 睡眠状态机（P3-1a）：awake / drowsy / asleep / waking。
 *
 * 纯函数模块：零 IO、零副作用，不读系统时钟——"现在几点、上一次睡是什么时候"
 * 全部由调用方通过入参给出。这样状态机可以穷举测试，也避免时间来自两处。
 *
 * 睡眠压力与 `src/orchestrator/intent/drive.ts` 的 `drive.energy` 保持同一口径：
 * `sleepPressure = 1 - energy`。这里只做换算，不另外发明一套语义。
 *
 * 阈值不在本模块写死：`nextSleepState` 只接收 `SleepThresholds`；
 * 唯一读配置的入口是 `sleepThresholdsFromConfig`（相关旋钮由 P3-2a 注册进 overlay）。
 *
 * 睡眠窗：`[sleepHour, sleepHour + maxWindowHours)`，跨午夜按 24 取模。
 * 窗口长度复用 `maxWindowHours`，不另设"窗口结束"常量（v2.2 §4.3）。
 */

import { knobNumber, knobObject } from "./config.js";
import { clamp01 } from "./state.js";
import type { EngineConfig } from "./config.js";

export type SleepPhase = "awake" | "drowsy" | "asleep" | "waking";

/** 本拍为什么停在这个相位；直接进日志，不要写自由文本。 */
export type SleepReason =
  | "hold"
  | "pressure"
  | "window"
  | "quiet"
  | "min-window"
  | "peer-message"
  | "max-window"
  | "wake-buffer";

export interface SleepThresholds {
  /** 睡着后至少睡这么久才可能自然醒（小时） */
  readonly minWindowHours: number;
  /** 最长睡眠兜底（小时）；同时用作睡眠窗长度 */
  readonly maxWindowHours: number;
  /** 自然唤醒所需的能量下限（0..1） */
  readonly wakeEnergy: number;
  /** 与 `MODE_THRESHOLDS.lazy_energy_max` 同源；入睡门槛 = 1 - 它 */
  readonly lazyEnergyMax: number;
}

export interface SleepInput {
  readonly nowMs: number;
  /** 本地小时（0..24 的浮点，调用方给；本模块不读时钟） */
  readonly localHour: number;
  /** 当前能量（0..1）；睡眠压力 = 1 - energy */
  readonly energy: number;
  /** 每天几点开始困（0..24，来自 cycles 的 sleepHourFor） */
  readonly sleepHour: number;
  /** 入睡时刻；没睡过为 null */
  readonly lastSleepAt?: number | null;
  /** 进入 waking 的时刻（缓冲起点）；未知为 null */
  readonly lastWakeAt?: number | null;
  /** 上一拍的相位；缺省按 awake 处理 */
  readonly previousPhase?: SleepPhase | null;
  /** 对方最近一条消息的时刻；从没收到过为 null */
  readonly peerMessagedAt?: number | null;
  readonly thresholds: SleepThresholds;
}

export interface SleepState {
  readonly phase: SleepPhase;
  readonly asleep: boolean;
  /** 睡眠压力 = 1 - energy，与 drive.energy 同口径 */
  readonly sleepPressure: number;
  /** 睡眠窗是否开着 */
  readonly windowOpen: boolean;
  readonly reason: SleepReason;
  /** 距离 lastSleepAt 的小时数；没睡过为 0 */
  readonly sleptHours: number;
}

/** awake→drowsy 的高压线 */
export const DROWSY_PRESSURE = 0.75;

/** 在睡眠窗内，压力超过这条线也可以入困 */
export const DROWSY_WINDOW_PRESSURE = 0.6;

/** drowsy→asleep 需要的静默时长（毫秒） */
export const QUIET_BEFORE_ASLEEP_MS = 20 * 60_000;

/** waking→awake 的缓冲（毫秒） */
export const WAKE_BUFFER_MS = 5 * 60_000;

const HOUR_MS = 3_600_000;

const PHASES: readonly SleepPhase[] = ["awake", "drowsy", "asleep", "waking"];

function fail(message: string): never {
  throw new RangeError(`sleep：${message}`);
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) fail(`${name} 必须是有限数（收到 ${String(value)}）`);
  return value;
}

function requireUnit(value: number, name: string): number {
  requireFinite(value, name);
  if (value < 0 || value > 1) fail(`${name} 必须在 [0, 1] 内（收到 ${String(value)}）`);
  return value;
}

function optionalFinite(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  return requireFinite(value, name);
}

/**
 * 睡眠压力：与 `drive.energy` 同一个定义（`1 - energy`）。
 * 能量越低保真度越高；不在别处再算一份。
 */
export function sleepPressureOf(energy: number): number {
  requireUnit(energy, "energy");
  return clamp01(1 - energy);
}

/**
 * 睡眠窗是否开着：`[sleepHour, sleepHour + lengthHours)`，跨午夜取模。
 * `lengthHours` 为 0 时恒关；>= 24 时恒开。
 */
export function isSleepWindowOpen(localHour: number, sleepHour: number, lengthHours: number): boolean {
  requireFinite(localHour, "localHour");
  requireFinite(sleepHour, "sleepHour");
  requireFinite(lengthHours, "maxWindowHours");
  if (lengthHours < 0) fail(`maxWindowHours 不能为负（收到 ${String(lengthHours)}）`);
  const delta = (((localHour - sleepHour) % 24) + 24) % 24;
  return delta < lengthHours;
}

function validatedThresholds(input: SleepThresholds): SleepThresholds {
  if (input === null || typeof input !== "object") fail("thresholds 必填");
  const minWindowHours = requireFinite(input.minWindowHours, "minWindowHours");
  const maxWindowHours = requireFinite(input.maxWindowHours, "maxWindowHours");
  if (minWindowHours < 0) fail(`minWindowHours 不能为负（收到 ${String(minWindowHours)}）`);
  if (maxWindowHours < minWindowHours) {
    fail(`maxWindowHours（${String(maxWindowHours)}）不能小于 minWindowHours（${String(minWindowHours)}）`);
  }
  return {
    minWindowHours,
    maxWindowHours,
    wakeEnergy: requireUnit(input.wakeEnergy, "wakeEnergy"),
    lazyEnergyMax: requireUnit(input.lazyEnergyMax, "lazyEnergyMax"),
  };
}

/**
 * 推进一步睡眠状态机（纯函数）。
 *
 * 转移（v2.2 §3/§4.3，表值为准）：
 * - awake → drowsy：pressure > 0.75，或 pressure > 0.6 且睡眠窗开着（>= 也按"超过"理解，边界留在原相位）。
 * - drowsy → asleep：pressure > 1 - lazyEnergyMax（默认 0.8），且静默 >= 20 分钟。
 * - drowsy → awake：睡眠窗已关且 pressure 回落到 DROWSY_PRESSURE（0.75）以下（task-117 ②/B1：
 *   回退与进入同用 0.75、均为严格不等号——恰为 0.75 时两方向都不触发（零宽死区），
 *   0.75~0.8 之间从 awake 进入 drowsy 后保持，不每拍翻转）。
 * - asleep → waking：对方消息（覆盖最短窗）；或睡满最长窗兜底；
 *   或睡满最短窗且 energy >= wakeEnergy。`0.35` 只是 `energy >= 0.65` 的等价写法，
 *   不构成独立分支——否则睡 48 分钟回满就会醒，最短睡眠窗形同虚设。
 * - waking → awake：醒来满 5 分钟缓冲。
 *
 * `lastWakeAt` 未知时按"已经醒了"处理，避免状态机卡在 waking 里出不来。
 */
export function nextSleepState(input: SleepInput): SleepState {
  if (input === null || typeof input !== "object") fail("input 必填");
  const nowMs = requireFinite(input.nowMs, "nowMs");
  const localHour = requireFinite(input.localHour, "localHour");
  const energy = requireUnit(input.energy, "energy");
  const sleepHour = requireFinite(input.sleepHour, "sleepHour");
  const lastSleepAt = optionalFinite(input.lastSleepAt, "lastSleepAt");
  const lastWakeAt = optionalFinite(input.lastWakeAt, "lastWakeAt");
  const peerMessagedAt = optionalFinite(input.peerMessagedAt, "peerMessagedAt");
  const thresholds = validatedThresholds(input.thresholds);
  const previousPhase = input.previousPhase ?? "awake";
  if (!PHASES.includes(previousPhase)) fail(`previousPhase 非法：${String(previousPhase)}`);

  const sleepPressure = clamp01(1 - energy);
  const windowOpen = isSleepWindowOpen(localHour, sleepHour, thresholds.maxWindowHours);
  const sleptHours = lastSleepAt === null ? 0 : Math.max(0, (nowMs - lastSleepAt) / HOUR_MS);
  const quietForMs =
    peerMessagedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - peerMessagedAt);
  // 消息发生在入睡之后才算"叫醒"；睡前的旧消息不算。
  const peerWoke =
    peerMessagedAt !== null && (lastSleepAt === null || peerMessagedAt >= lastSleepAt);

  let phase: SleepPhase;
  let reason: SleepReason;

  switch (previousPhase) {
    case "drowsy": {
      const asleepPressure = 1 - thresholds.lazyEnergyMax;
      if (sleepPressure > asleepPressure && quietForMs >= QUIET_BEFORE_ASLEEP_MS) {
        phase = "asleep";
        reason = "quiet";
      } else if (!windowOpen && sleepPressure < DROWSY_PRESSURE) {
        // task-117 ②（B1 修正）：睡压回落到 DROWSY_PRESSURE（0.75）以下、睡眠窗也已关 ——
        // 不困了，醒回 awake。回退与进入同用 0.75、都是严格不等号：
        // 恰为 0.75 时两方向都不触发（零宽死区，不会翻转）；0.75~0.8 之间从 awake
        // 进入 drowsy 后保持（不再每 5 分钟 awake↔drowsy 翻转，supervisor B1）。
        // 没有这条回退边时，能量一旦在 drowsy 期回升（如装配层停止耗能、或参数变动），
        // 她既睡不着也醒不来，会永久卡在 drowsy（审计 §1.3 缺陷 B）。
        // 注：睡眠窗开着时不走这条边——留在 drowsy 继续等入睡，避免窗内反复入困/醒。
        phase = "awake";
        reason = "window";
      } else {
        phase = "drowsy";
        reason = "hold";
      }
      break;
    }
    case "asleep": {
      if (peerWoke) {
        phase = "waking";
        reason = "peer-message";
      } else if (sleptHours >= thresholds.maxWindowHours) {
        phase = "waking";
        reason = "max-window";
      } else if (sleptHours >= thresholds.minWindowHours && energy >= thresholds.wakeEnergy) {
        phase = "waking";
        reason = "min-window";
      } else {
        phase = "asleep";
        reason = "hold";
      }
      break;
    }
    case "waking": {
      if (lastWakeAt === null || nowMs - lastWakeAt >= WAKE_BUFFER_MS) {
        phase = "awake";
        reason = "wake-buffer";
      } else {
        phase = "waking";
        reason = "hold";
      }
      break;
    }
    case "awake":
    default: {
      if (sleepPressure > DROWSY_PRESSURE) {
        phase = "drowsy";
        reason = "pressure";
      } else if (sleepPressure > DROWSY_WINDOW_PRESSURE && windowOpen) {
        phase = "drowsy";
        reason = "window";
      } else {
        phase = "awake";
        reason = "hold";
      }
      break;
    }
  }

  return {
    phase,
    asleep: phase === "asleep",
    sleepPressure,
    windowOpen,
    reason,
    sleptHours,
  };
}

/**
 * 从配置读睡眠阈值。
 *
 * 3 个 `SLEEP_*` 键由 P3-2a 注册（本模块是它们的消费点）；`lazy_energy_max`
 * 复用 `MODE_THRESHOLDS`，与 LAZY 模式门同源，不复制常量。
 */
export function sleepThresholdsFromConfig(cfg: EngineConfig): SleepThresholds {
  const mode = knobObject<{ lazy_energy_max?: unknown }>(cfg, "MODE_THRESHOLDS");
  const lazyEnergyMax = mode.lazy_energy_max;
  if (typeof lazyEnergyMax !== "number" || !Number.isFinite(lazyEnergyMax)) {
    fail(`MODE_THRESHOLDS.lazy_energy_max 不是有限数字：${JSON.stringify(lazyEnergyMax)}`);
  }
  return validatedThresholds({
    minWindowHours: knobNumber(cfg, "SLEEP_MIN_WINDOW_HOURS"),
    maxWindowHours: knobNumber(cfg, "SLEEP_MAX_WINDOW_HOURS"),
    wakeEnergy: knobNumber(cfg, "SLEEP_WAKE_ENERGY"),
    lazyEnergyMax,
  });
}
