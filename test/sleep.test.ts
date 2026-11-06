import { describe, expect, it } from "vitest";
import type { EngineConfig } from "../src/engine/config.js";
import {
  DROWSY_PRESSURE,
  DROWSY_WINDOW_PRESSURE,
  QUIET_BEFORE_ASLEEP_MS,
  WAKE_BUFFER_MS,
  isSleepWindowOpen,
  nextSleepState,
  sleepPressureOf,
  sleepThresholdsFromConfig,
} from "../src/engine/sleep.js";
import type { SleepInput, SleepThresholds } from "../src/engine/sleep.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
// 2026-11-01 12:00 UTC（测试里固定时间，不依赖真实时钟）
const T0 = Date.UTC(2026, 10, 1, 12, 0);

const TH: SleepThresholds = {
  minWindowHours: 4,
  maxWindowHours: 9,
  wakeEnergy: 0.65,
  lazyEnergyMax: 0.2,
};

function input(over: Partial<SleepInput> = {}): SleepInput {
  return {
    nowMs: T0,
    localHour: 12,
    energy: 1,
    sleepHour: 3,
    lastSleepAt: null,
    lastWakeAt: null,
    previousPhase: "awake",
    peerMessagedAt: null,
    thresholds: TH,
    ...over,
  };
}

function run(over: Partial<SleepInput> = {}) {
  return nextSleepState(input(over));
}

function fakeCfg(over: Record<string, unknown> = {}): EngineConfig {
  return {
    knobs: {
      SLEEP_MIN_WINDOW_HOURS: { kind: "number", value: 4 },
      SLEEP_MAX_WINDOW_HOURS: { kind: "number", value: 9 },
      SLEEP_WAKE_ENERGY: { kind: "number", value: 0.65 },
      MODE_THRESHOLDS: { kind: "object", value: { lazy_energy_max: 0.2 } },
      ...over,
    },
  } as unknown as EngineConfig;
}

describe("睡眠窗", () => {
  it("跨午夜：睡点 23 点，窗口覆盖到次日 08 点之前", () => {
    expect(isSleepWindowOpen(2, 23, 9)).toBe(true);
    expect(isSleepWindowOpen(8, 23, 9)).toBe(false);
    expect(isSleepWindowOpen(22.98, 23, 9)).toBe(false);
  });

  it("同日：3 点开，11:59 仍开，12 点关", () => {
    expect(isSleepWindowOpen(3, 3, 9)).toBe(true);
    expect(isSleepWindowOpen(11.99, 3, 9)).toBe(true);
    expect(isSleepWindowOpen(12, 3, 9)).toBe(false);
  });

  it("长度为 0 时恒关，>= 24 时恒开", () => {
    expect(isSleepWindowOpen(3, 3, 0)).toBe(false);
    expect(isSleepWindowOpen(15, 3, 24)).toBe(true);
  });
});

describe("awake → drowsy", () => {
  it("压力超过 0.75 进入 drowsy", () => {
    const s = run({ energy: 0.2499 });
    expect(s.phase).toBe("drowsy");
    expect(s.reason).toBe("pressure");
    expect(s.sleepPressure).toBeCloseTo(0.7501, 10);
  });

  it("压力恰好 0.75 留在 awake（边界不越过）", () => {
    const s = run({ energy: 0.25 });
    expect(s.phase).toBe("awake");
    expect(s.reason).toBe("hold");
    expect(DROWSY_PRESSURE).toBe(0.75);
  });

  it("压力 0.6 以上且睡眠窗开着，也会入困", () => {
    const s = run({ energy: 0.39, localHour: 4 });
    expect(s.phase).toBe("drowsy");
    expect(s.reason).toBe("window");
    expect(s.windowOpen).toBe(true);
  });

  it("同样压力但窗口关着，留在 awake", () => {
    const s = run({ energy: 0.39, localHour: 13 });
    expect(s.phase).toBe("awake");
    expect(s.windowOpen).toBe(false);
  });

  it("压力恰好 0.6 不算入困（边界不越过）", () => {
    const s = run({ energy: 0.4, localHour: 4 });
    expect(s.phase).toBe("awake");
    expect(DROWSY_WINDOW_PRESSURE).toBe(0.6);
  });

  it("previousPhase 缺省按 awake 处理", () => {
    const s = run({ previousPhase: null, energy: 0.1 });
    expect(s.phase).toBe("drowsy");
  });

  it("睡眠压力与 drive.energy 同口径（1 - energy）", () => {
    expect(sleepPressureOf(0.18)).toBeCloseTo(0.82, 10);
    expect(run({ energy: 0.18 }).sleepPressure).toBeCloseTo(0.82, 10);
  });
});

describe("drowsy → asleep", () => {
  it("静默满 20 分钟且压力 > 0.8 才入睡", () => {
    const s = run({
      previousPhase: "drowsy",
      energy: 0.19,
      peerMessagedAt: T0 - QUIET_BEFORE_ASLEEP_MS,
    });
    expect(s.phase).toBe("asleep");
    expect(s.reason).toBe("quiet");
    expect(s.asleep).toBe(true);
  });

  it("差 1 毫秒没满 20 分钟不睡", () => {
    const s = run({
      previousPhase: "drowsy",
      energy: 0.19,
      peerMessagedAt: T0 - QUIET_BEFORE_ASLEEP_MS + 1,
    });
    expect(s.phase).toBe("drowsy");
    expect(s.reason).toBe("hold");
  });

  it("压力恰好 0.8 不睡（边界不越过）", () => {
    const s = run({
      previousPhase: "drowsy",
      energy: 0.2,
      peerMessagedAt: T0 - QUIET_BEFORE_ASLEEP_MS,
    });
    expect(s.phase).toBe("drowsy");
  });

  it("没有任何消息记录 = 长期静默，可以入睡", () => {
    const s = run({ previousPhase: "drowsy", energy: 0.19, peerMessagedAt: null });
    expect(s.phase).toBe("asleep");
  });
});

describe("asleep → waking", () => {
  it("睡满最短窗且 energy >= wakeEnergy", () => {
    const s = run({ previousPhase: "asleep", energy: 0.65, lastSleepAt: T0 - 4 * HOUR });
    expect(s.phase).toBe("waking");
    expect(s.reason).toBe("min-window");
    expect(s.sleptHours).toBeCloseTo(4, 10);
  });

  it("没睡满最短窗、压力也没松懈，继续睡", () => {
    const s = run({ previousPhase: "asleep", energy: 0.64, lastSleepAt: T0 - 3 * HOUR });
    expect(s.phase).toBe("asleep");
    expect(s.reason).toBe("hold");
  });

  it("能量回满也不提前醒：睡 48 分钟（energy=1.0）仍 asleep（最短窗 4h 是硬条件）", () => {
    const s = run({ previousPhase: "asleep", energy: 1, lastSleepAt: T0 - 48 * MINUTE });
    expect(s.phase).toBe("asleep");
    expect(s.reason).toBe("hold");
    expect(s.sleptHours).toBeCloseTo(0.8, 10);
  });

  it("睡满 4h 且 energy≥0.65 才自然醒", () => {
    const s = run({ previousPhase: "asleep", energy: 0.65, lastSleepAt: T0 - 4 * HOUR });
    expect(s.phase).toBe("waking");
    expect(s.reason).toBe("min-window");
  });

  it("能量还在低位时继续睡（起始 energy < 1，避免 1 - 1 = 0 的假通过）", () => {
    const s = run({ previousPhase: "asleep", energy: 0.5, lastSleepAt: T0 - 0.5 * HOUR });
    expect(s.phase).toBe("asleep");
    expect(s.reason).toBe("hold");
    expect(s.sleepPressure).toBeCloseTo(0.5, 10);
  });

  it("对方消息把睡着叫到 waking", () => {
    const s = run({
      previousPhase: "asleep",
      energy: 0.2,
      lastSleepAt: T0 - HOUR,
      peerMessagedAt: T0 - MINUTE,
    });
    expect(s.phase).toBe("waking");
    expect(s.reason).toBe("peer-message");
  });

  it("入睡之前的旧消息不算叫醒", () => {
    const s = run({
      previousPhase: "asleep",
      energy: 0.2,
      lastSleepAt: T0 - HOUR,
      peerMessagedAt: T0 - 2 * HOUR,
    });
    expect(s.phase).toBe("asleep");
  });

  it("睡满最长窗兜底醒来", () => {
    const s = run({ previousPhase: "asleep", energy: 0.3, lastSleepAt: T0 - 9 * HOUR });
    expect(s.phase).toBe("waking");
    expect(s.reason).toBe("max-window");
  });

  it("最长窗优先于最短窗（顺序固定）", () => {
    const s = run({ previousPhase: "asleep", energy: 0.9, lastSleepAt: T0 - 9 * HOUR });
    expect(s.reason).toBe("max-window");
  });

  it("睡着时 asleep 字段为 true", () => {
    const s = run({ previousPhase: "asleep", energy: 0.5, lastSleepAt: T0 - 0.5 * HOUR });
    expect(s.asleep).toBe(true);
  });
});

describe("waking → awake", () => {
  it("醒来满 5 分钟缓冲回到 awake", () => {
    const s = run({ previousPhase: "waking", lastWakeAt: T0 - WAKE_BUFFER_MS });
    expect(s.phase).toBe("awake");
    expect(s.reason).toBe("wake-buffer");
  });

  it("差 1 毫秒留在 waking", () => {
    const s = run({ previousPhase: "waking", lastWakeAt: T0 - WAKE_BUFFER_MS + 1 });
    expect(s.phase).toBe("waking");
    expect(s.reason).toBe("hold");
  });

  it("没有醒来时刻时按已醒处理，避免永久卡在 waking", () => {
    const s = run({ previousPhase: "waking", lastWakeAt: null });
    expect(s.phase).toBe("awake");
  });
});

describe("确定性与输入校验", () => {
  it("同一输入给出完全相同的输出", () => {
    const a = run({ previousPhase: "drowsy", energy: 0.19 });
    const b = run({ previousPhase: "drowsy", energy: 0.19 });
    expect(b).toEqual(a);
  });

  it("非法能量 / 时间 / 阈值抛 RangeError", () => {
    expect(() => run({ energy: 1.2 })).toThrow(RangeError);
    expect(() => run({ energy: -0.1 })).toThrow(RangeError);
    expect(() => run({ energy: Number.NaN })).toThrow(RangeError);
    expect(() => run({ nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => run({ peerMessagedAt: Number.NaN })).toThrow(RangeError);
    expect(() => run({ thresholds: { ...TH, maxWindowHours: 2 } })).toThrow(RangeError);
    expect(() => run({ thresholds: { ...TH, wakeEnergy: 2 } })).toThrow(RangeError);
  });
});

describe("sleepThresholdsFromConfig", () => {
  it("从配置读 4 个阈值（3 个 SLEEP_* + MODE_THRESHOLDS.lazy_energy_max）", () => {
    expect(sleepThresholdsFromConfig(fakeCfg())).toEqual(TH);
  });

  it("缺少 SLEEP_* 键时抛「未注册的旋钮」", () => {
    const broken = fakeCfg({ SLEEP_WAKE_ENERGY: undefined });
    expect(() => sleepThresholdsFromConfig(broken)).toThrow(/未注册的旋钮/);
  });

  it("lazy_energy_max 不是数字时抛错", () => {
    const broken = fakeCfg({
      MODE_THRESHOLDS: { kind: "object", value: { lazy_energy_max: "0.2" } },
    });
    expect(() => sleepThresholdsFromConfig(broken)).toThrow(/lazy_energy_max/);
  });
});
