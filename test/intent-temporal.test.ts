import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTemporalSnapshot,
  localPartsAt,
  localTimeOf,
  type TemporalInput,
} from "../src/orchestrator/intent/temporal.js";

// 固定时间口径：2026-11-01T01:42:00Z → 北京 2026-11-01 09:42（周日）
const NOW = Date.UTC(2026, 10, 1, 1, 42);
const TZ = 480;

function snap(over: Partial<TemporalInput> = {}) {
  return buildTemporalSnapshot({ nowMs: NOW, tzOffsetMinutes: TZ, ...over });
}

describe("时间观 P1：本地时间纯算术（不碰 Date）", () => {
  it("东八区：日期/时刻/小时/分钟/星期都对", () => {
    const parts = localPartsAt(NOW, TZ);
    expect(parts.localDate).toBe("2026-11-01");
    expect(parts.localTime).toBe("09:42");
    expect(parts.localHour).toBe(9);
    expect(parts.localMinute).toBe(42);
    expect(parts.weekday).toBe(7);
    expect(parts.weekdayLabel).toBe("周日");
  });

  it("UTC 与西五区口径不同（同一 nowMs 不串时区）", () => {
    expect(localPartsAt(NOW, 0).localTime).toBe("01:42");
    const west = localPartsAt(NOW, -300);
    expect(west.localDate).toBe("2026-10-31");
    expect(west.localTime).toBe("20:42");
    expect(west.weekdayLabel).toBe("周六");
  });

  it("闰日与跨年边界", () => {
    expect(localPartsAt(Date.UTC(2024, 1, 29, 12, 0), 0).localDate).toBe("2024-02-29");
    const newYear = localPartsAt(Date.UTC(2025, 11, 31, 23, 30), TZ);
    expect(newYear.localDate).toBe("2026-01-01");
    expect(newYear.localTime).toBe("07:30");
    expect(newYear.weekdayLabel).toBe("周四");
  });

  it("localTimeOf 与 localPartsAt 同口径", () => {
    expect(localTimeOf(Date.UTC(2026, 9, 31, 19, 0), TZ)).toBe("03:00");
  });
});

describe("时间观 P1：TemporalSnapshot 只装事实、不编", () => {
  it("本地时刻拼成给人看的一行", () => {
    const s = snap();
    expect(s.localIso).toBe("2026-11-01 09:42");
    expect(s.localDate).toBe("2026-11-01");
    expect(s.localHour).toBe(9);
    expect(s.weekday).toBe(7);
    expect(s.weekdayLabel).toBe("周日");
  });

  it("没有输入就不编：未知字段为 null / 0", () => {
    const s = snap();
    expect(s.awakeForHours).toBeNull();
    expect(s.lastSleep).toBeNull();
    expect(s.sinceLastUserMsgMin).toBeNull();
    expect(s.sinceLastOwnMsgMin).toBeNull();
    expect(s.unansweredOwnMsgs).toBe(0);
    expect(s.nextSleepInHours).toBeNull();
    expect(s.presence).toBeNull();
    expect(s.hisRhythm).toBeNull(); // 没注入节律 → 不知道（P2a 起可由 rhythm.ts 注入）
  });

  it("节律透传：P2a 注入什么就带什么（本层不加推断、不改算术）", () => {
    const rhythm = {
      sampleCount: 30,
      distinctLocalDates: 7,
      workdayDays: 4,
      restdayDays: 3,
      byLocalHour: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 30 : 0)),
      peakLocalHour: 9,
      confidence: 0.45,
      firstLocalDate: "2026-10-20",
      lastLocalDate: "2026-10-26",
    };
    const withRhythm = snap({ hisRhythm: rhythm });
    expect(withRhythm.hisRhythm).toEqual(rhythm);
    expect(withRhythm.localIso).toBe("2026-11-01 09:42");
    expect(withRhythm.awakeForHours).toBeNull();
  });

  it("节律形状不对 → 当作没给（null），不编半个统计", () => {
    const broken = {
      sampleCount: 30,
      distinctLocalDates: 7,
      workdayDays: 4,
      restdayDays: 3,
      byLocalHour: [1, 2],
      peakLocalHour: 9,
      confidence: 0.45,
      firstLocalDate: "2026-10-20",
      lastLocalDate: "2026-10-26",
    };
    expect(snap({ hisRhythm: broken }).hisRhythm).toBeNull();
    const badPeak = { ...broken, byLocalHour: new Array<number>(24).fill(0), peakLocalHour: 24 };
    expect(snap({ hisRhythm: badPeak }).hisRhythm).toBeNull();
  });

  it("上一次睡：给的是时刻与醒来小时数，睡眠时长 P1 不编", () => {
    const s = snap({ lastSleepAt: Date.UTC(2026, 9, 31, 19, 0) });
    expect(s.awakeForHours).toBe(6.7);
    expect(s.lastSleep?.localTime).toBe("03:00");
    expect(s.lastSleep?.hours).toBeNull();
  });

  it("P3 才有睡眠时长：传了才填", () => {
    const s = snap({ lastSleepAt: Date.UTC(2026, 9, 31, 19, 0), lastSleepHours: 5.5 });
    expect(s.lastSleep?.hours).toBe(5.5);
  });

  it("B1：awakeForHours 优先从「上次醒来」算起，lastSleep 仍指向入睡那一刻", () => {
    const sleptAt = Date.UTC(2026, 9, 31, 19, 0);
    const wokeAt = Date.UTC(2026, 10, 1, 0, 42);
    const s = snap({ awakeSinceMs: wokeAt, lastSleepAt: sleptAt, lastSleepHours: 5.7 });
    expect(s.awakeForHours).toBe(1);
    expect(s.lastSleep?.atMs).toBe(sleptAt);
    expect(s.lastSleep?.hours).toBe(5.7);
  });

  it("B1：没有醒来时刻就回退上次睡点；醒来时刻非法也不编", () => {
    const sleptAt = Date.UTC(2026, 9, 31, 19, 0);
    expect(snap({ awakeSinceMs: null, lastSleepAt: sleptAt }).awakeForHours).toBe(6.7);
    expect(snap({ awakeSinceMs: Number.NaN, lastSleepAt: sleptAt }).awakeForHours).toBe(6.7);
    expect(snap({ awakeSinceMs: 0 }).awakeForHours).toBeNull();
  });

  it("负数/非法时间戳当作没有记录", () => {
    const s = snap({ lastSleepAt: 0 });
    expect(s.lastSleep).toBeNull();
    expect(s.awakeForHours).toBeNull();
  });

  it("负数分钟按 0 处理（不出现「-3 分钟前」）", () => {
    const s = snap({ sinceLastUserMsgMin: -3, sinceLastOwnMsgMin: -5 });
    expect(s.sinceLastUserMsgMin).toBe(0);
    expect(s.sinceLastOwnMsgMin).toBe(0);
  });

  it("在场信号：形状对才透传，ttl 被夹到非负", () => {
    const fresh = snap({ presence: { atMs: NOW - 60_000, active: true, ttlMs: 600_000 } });
    expect(fresh.presence?.active).toBe(true);
    const weird = snap({ presence: { atMs: NOW, active: true, ttlMs: -5 } });
    expect(weird.presence?.ttlMs).toBe(0);
    const bad = snap({ presence: { atMs: Number.NaN, active: true, ttlMs: 1 } });
    expect(bad.presence).toBeNull();
  });

  it("非法输入当场抛（不把 NaN 带进提示词）", () => {
    expect(() => buildTemporalSnapshot({ nowMs: Number.NaN, tzOffsetMinutes: TZ })).toThrow(RangeError);
    expect(() => buildTemporalSnapshot({ nowMs: NOW, tzOffsetMinutes: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => snap({ unansweredOwnMsgs: -1 })).toThrow(RangeError);
    expect(() => snap({ unansweredOwnMsgs: 1.5 })).toThrow(RangeError);
  });

  it("源码不使用 Date 构造 / Date.now（lint:writers 规则 2 的语义兜底）", () => {
    const file = fileURLToPath(new URL("../src/orchestrator/intent/temporal.ts", import.meta.url));
    // 注释里会提到这两个名字（说明为什么不用），先剥注释再查代码本身。
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/new Date\s*\(/);
    expect(source).not.toMatch(/Date\.now\s*\(/);
  });
});
