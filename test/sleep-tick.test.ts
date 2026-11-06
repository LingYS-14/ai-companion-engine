/**
 * P3-1c：sleep-tick 纯编排模块测试。
 * 时间在测试里用 Date.UTC 造常量（src 侧禁时间 API，test 侧不受限）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SLEEP_NIGHT_BUDGET,
  consumeNightBudget,
  nightKeyOf,
  normalizeNightBudget,
  remainingNightBudget,
  runSleepTick,
  type NightBudget,
  type SleepPhase,
  type SleepTickDeps,
  type SleepTickInput,
} from "../src/autonomy/sleep-tick.js";

const TICK = 1 / 12; // 5 分钟
const TZ = 480; // UTC+8

function input(over: Partial<SleepTickInput> = {}): SleepTickInput {
  return {
    nowMs: Date.UTC(2026, 10, 1, 0, 0),
    dtHours: TICK,
    sleep: { phase: "asleep", asleep: true },
    budget: { nightKey: "2026-11-01", used: 2 },
    ...over,
  };
}

function deps(): { deps: SleepTickDeps; recoveries: number[]; lines: string[] } {
  const recoveries: number[] = [];
  const lines: string[] = [];
  return {
    recoveries,
    lines,
    deps: {
      recoverEnergy: (dtHours) => recoveries.push(dtHours),
      log: (line) => lines.push(line),
    },
  };
}

describe("nightKeyOf：本地日期（纯算术）", () => {
  it("epoch 起点 / 东八区 / 负偏移", () => {
    expect(nightKeyOf(Date.UTC(1970, 0, 1, 0, 0), 0)).toBe("1970-01-01");
    expect(nightKeyOf(Date.UTC(2026, 9, 31, 20, 0), TZ)).toBe("2026-11-01");
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 2, 0), -300)).toBe("2026-10-31");
  });

  it("跨午夜：UTC 0 点前后分属两天（东八区同样在 16:00 UTC 换日）", () => {
    expect(nightKeyOf(Date.UTC(2026, 9, 31, 23, 59), 0)).toBe("2026-10-31");
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 0, 0), 0)).toBe("2026-11-01");
    // 东八区：当地 23:59 / 00:00
    expect(nightKeyOf(Date.UTC(2026, 9, 31, 15, 59), TZ)).toBe("2026-10-31");
    expect(nightKeyOf(Date.UTC(2026, 9, 31, 16, 0), TZ)).toBe("2026-11-01");
  });

  it("闰日与跨年", () => {
    expect(nightKeyOf(Date.UTC(2024, 1, 29, 12, 0), 0)).toBe("2024-02-29");
    expect(nightKeyOf(Date.UTC(2024, 1, 28, 20, 0), TZ)).toBe("2024-02-29");
    expect(nightKeyOf(Date.UTC(2026, 11, 31, 23, 30), 60)).toBe("2027-01-01");
  });

  it("半小时时区（+05:30）不取整到整点", () => {
    // UTC 18:00 → 当地 23:30（仍是 11-01）；UTC 18:30 → 次日 00:00
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 18, 0), 330)).toBe("2026-11-01");
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 18, 30), 330)).toBe("2026-11-02");
  });

  it("非法入参抛 RangeError", () => {
    expect(() => nightKeyOf(Number.NaN, 0)).toThrow(RangeError);
    expect(() => nightKeyOf(Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
    expect(() => nightKeyOf(0, Number.NaN)).toThrow(RangeError);
    expect(() => nightKeyOf(0, Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("runSleepTick：非 asleep 不恢复、不写日志", () => {
  for (const phase of ["awake", "drowsy", "waking"] as const) {
    it(`${phase}：recoverEnergy/log 都不调，账本原样透传`, () => {
      const { deps: d, recoveries, lines } = deps();
      const out = runSleepTick(
        input({ sleep: { phase, asleep: false }, budget: { nightKey: "2026-11-01", used: 3 } }),
        d,
      );
      expect(recoveries).toEqual([]);
      expect(lines).toEqual([]);
      expect(out).toEqual({
        asleep: false,
        recovered: false,
        budgetUsed: 3,
        budgetLeft: SLEEP_NIGHT_BUDGET - 3,
        nightKey: "2026-11-01",
      });
    });
  }

  it("非 asleep 的 dtHours=0 不算非法（不推进时间）", () => {
    const { deps: d, recoveries } = deps();
    const out = runSleepTick(input({ dtHours: 0, sleep: { phase: "awake", asleep: false } }), d);
    expect(out.recovered).toBe(false);
    expect(recoveries).toEqual([]);
  });
});

describe("runSleepTick：asleep 只恢复一次 + 一条日志", () => {
  it("调一次 recoverEnergy，dt 原样传入；used 不被消耗", () => {
    const { deps: d, recoveries, lines } = deps();
    const out = runSleepTick(input({ budget: { nightKey: "2026-11-01", used: 2 } }), d);
    expect(recoveries).toEqual([TICK]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[sleep-tick]");
    expect(lines[0]).toContain(`dt=${TICK}`);
    expect(lines[0]).toContain("budget=2/8");
    expect(lines[0]).toContain("night=2026-11-01");
    expect(out).toEqual({
      asleep: true,
      recovered: true,
      budgetUsed: 2,
      budgetLeft: 6,
      nightKey: "2026-11-01",
    });
  });

  it("used 已满 8：仍不消耗，budgetLeft=0", () => {
    const { deps: d, recoveries } = deps();
    const out = runSleepTick(input({ budget: { nightKey: "2026-11-01", used: 8 } }), d);
    expect(recoveries).toEqual([TICK]);
    expect(out.budgetUsed).toBe(8);
    expect(out.budgetLeft).toBe(0);
    expect(out.recovered).toBe(true);
  });

  it("日志可省略（deps.log 不传也不抛）", () => {
    const recoveries: number[] = [];
    const out = runSleepTick(input(), { recoverEnergy: (dt) => recoveries.push(dt) });
    expect(recoveries).toEqual([TICK]);
    expect(out.recovered).toBe(true);
  });

  it("dtHours 边界：(0,1] 内通过；0 与 >1 抛错", () => {
    const { deps: d, recoveries } = deps();
    expect(runSleepTick(input({ dtHours: 1 }), d).recovered).toBe(true);
    expect(recoveries).toEqual([1]);
    expect(() => runSleepTick(input({ dtHours: 0 }), d)).toThrow(RangeError);
    expect(() => runSleepTick(input({ dtHours: -TICK }), d)).toThrow(RangeError);
    expect(() => runSleepTick(input({ dtHours: 1.0000001 }), d)).toThrow(RangeError);
    expect(() => runSleepTick(input({ dtHours: Number.NaN }), d)).toThrow(RangeError);
  });
});

describe("runSleepTick：非法入参", () => {
  it("nowMs / dtHours 非有限", () => {
    const { deps: d } = deps();
    expect(() => runSleepTick(input({ nowMs: Number.NaN }), d)).toThrow(RangeError);
    expect(() => runSleepTick(input({ nowMs: Number.POSITIVE_INFINITY }), d)).toThrow(RangeError);
    expect(() => runSleepTick(input({ dtHours: Number.NaN }), d)).toThrow(RangeError);
  });

  it("相位非法 / asleep 与相位不一致", () => {
    const { deps: d } = deps();
    expect(() =>
      runSleepTick(input({ sleep: { phase: "sleeping" as SleepPhase, asleep: false } }), d),
    ).toThrow(RangeError);
    expect(() =>
      runSleepTick(input({ sleep: { phase: "awake", asleep: true } }), d),
    ).toThrow(RangeError);
    expect(() =>
      runSleepTick(input({ sleep: { phase: "asleep", asleep: false } }), d),
    ).toThrow(RangeError);
  });

  it("账本非法：nightKey 格式 / used 越界", () => {
    const { deps: d } = deps();
    expect(() =>
      runSleepTick(input({ budget: { nightKey: "2026/11/01", used: 0 } }), d),
    ).toThrow(RangeError);
    expect(() => runSleepTick(input({ budget: { nightKey: "", used: 0 } }), d)).toThrow(RangeError);
    expect(() =>
      runSleepTick(input({ budget: { nightKey: "2026-11-01", used: -1 } }), d),
    ).toThrow(RangeError);
    expect(() =>
      runSleepTick(input({ budget: { nightKey: "2026-11-01", used: 1.5 } }), d),
    ).toThrow(RangeError);
    expect(() =>
      runSleepTick(input({ budget: { nightKey: "2026-11-01", used: SLEEP_NIGHT_BUDGET + 1 } }), d),
    ).toThrow(RangeError);
  });

  it("deps 非法：recoverEnergy 缺失 / log 非函数", () => {
    expect(() => runSleepTick(input(), {} as SleepTickDeps)).toThrow(RangeError);
    expect(() =>
      runSleepTick(input(), { recoverEnergy: () => {}, log: "x" as unknown as (l: string) => void }),
    ).toThrow(RangeError);
  });
});

describe("runSleepTick：确定性", () => {
  it("同输入同输出（副作用逐次发生，结果不含随机/时间）", () => {
    const a = deps();
    const b = deps();
    const once = runSleepTick(input(), a.deps);
    const twice = runSleepTick(input(), b.deps);
    expect(once).toEqual(twice);
    expect(a.recoveries).toEqual(b.recoveries);
    expect(a.lines).toEqual(b.lines);
  });

  it("账本左值 = 8 − used，且不因 asleep 改变", () => {
    const { deps: d } = deps();
    for (const used of [0, 1, 4, 7, 8]) {
      const out = runSleepTick(input({ budget: { nightKey: "2026-11-01", used } }), d);
      expect(out.budgetUsed).toBe(used);
      expect(out.budgetLeft).toBe(SLEEP_NIGHT_BUDGET - used);
    }
  });
});

describe("normalizeNightBudget：跨夜重置 / 同夜保留", () => {
  it("无旧账本 → used 0；同夜保留；跨夜重置", () => {
    const now = Date.UTC(2026, 10, 1, 12, 0); // 东八区 2026-11-01 20:00
    expect(normalizeNightBudget(now, TZ)).toEqual({ nightKey: "2026-11-01", used: 0 });
    expect(normalizeNightBudget(now, TZ, { nightKey: "2026-11-01", used: 5 })).toEqual({
      nightKey: "2026-11-01",
      used: 5,
    });
    expect(normalizeNightBudget(now, TZ, { nightKey: "2026-10-31", used: 5 })).toEqual({
      nightKey: "2026-11-01",
      used: 0,
    });
  });

  it("时区边界：UTC+480 的 00:30 归本地当天（跨午夜即新夜账）", () => {
    // 本地 2026-11-02 00:30 = UTC 2026-11-01 16:30
    const at0030 = Date.UTC(2026, 10, 1, 16, 30);
    expect(nightKeyOf(at0030, TZ)).toBe("2026-11-02");
    expect(normalizeNightBudget(at0030, TZ, { nightKey: "2026-11-01", used: 7 })).toEqual({
      nightKey: "2026-11-02",
      used: 0,
    });
    // 本地 2026-11-01 23:59 仍是旧夜
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 15, 59), TZ)).toBe("2026-11-01");
    // 时区由调用方给：tz=0 时 00:30 就是 UTC 当天
    expect(nightKeyOf(Date.UTC(2026, 10, 1, 0, 30), 0)).toBe("2026-11-01");
  });

  it("nightKey 格式与非法入参", () => {
    expect(normalizeNightBudget(Date.UTC(2026, 10, 1, 12, 0), TZ).nightKey).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(() => normalizeNightBudget(Number.NaN, TZ)).toThrow(RangeError);
    expect(() => normalizeNightBudget(0, Number.NaN)).toThrow(RangeError);
    expect(() =>
      normalizeNightBudget(0, 0, { nightKey: "2026/11/01", used: 0 }),
    ).toThrow(RangeError);
    expect(() => normalizeNightBudget(0, 0, { nightKey: "2026-11-01", used: -1 })).toThrow(
      RangeError,
    );
    expect(() => normalizeNightBudget(0, 0, { nightKey: "2026-11-01", used: 9 })).toThrow(
      RangeError,
    );
  });
});

describe("remainingNightBudget / consumeNightBudget（P4 原语）", () => {
  it("剩余额度 = max(0, 8 − used)", () => {
    for (const used of [0, 1, 4, 7, 8]) {
      expect(remainingNightBudget({ nightKey: "2026-11-01", used })).toBe(
        SLEEP_NIGHT_BUDGET - used,
      );
    }
  });

  it("consumeNightBudget 默认 +1，显式 count 累加，返回新对象不改入参", () => {
    const before: NightBudget = { nightKey: "2026-11-01", used: 2 };
    const after = consumeNightBudget(before);
    expect(after).toEqual({ nightKey: "2026-11-01", used: 3 });
    expect(before.used).toBe(2);
    expect(consumeNightBudget({ nightKey: "2026-11-01", used: 2 }, 3)).toEqual({
      nightKey: "2026-11-01",
      used: 5,
    });
  });

  it("越界与非正整数 count 抛错", () => {
    expect(() => consumeNightBudget({ nightKey: "2026-11-01", used: 8 })).toThrow(RangeError);
    expect(() => consumeNightBudget({ nightKey: "2026-11-01", used: 7 }, 2)).toThrow(RangeError);
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expect(() => consumeNightBudget({ nightKey: "2026-11-01", used: 1 }, count)).toThrow(
        RangeError,
      );
    }
    expect(() => remainingNightBudget({ nightKey: "bad", used: 1 })).toThrow(RangeError);
  });
});

describe("账本原语与白天额度隔离（不接收 quota/usage）", () => {
  it("模块源码（去注释后）不出现 quota / rph / usage 字段", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "src", "autonomy", "sleep-tick.ts"), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/quota/i);
    expect(code).not.toMatch(/\brph\b/i);
    expect(code).not.toMatch(/usage/i);
  });

  it("返回值只有夜间账本字段（无 quota）", () => {
    const { deps: d } = deps();
    const out = runSleepTick(input(), d);
    expect(Object.keys(out).sort()).toEqual(
      ["asleep", "budgetLeft", "budgetUsed", "nightKey", "recovered"].sort(),
    );
    expect(out).not.toHaveProperty("quota");
    expect(Object.keys(normalizeNightBudget(0, 0))).toEqual(["nightKey", "used"]);
  });
});
