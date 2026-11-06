import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTemporalSnapshot, type TemporalInput, type TemporalSnapshot } from "../src/orchestrator/intent/temporal.js";
import {
  buildSituationNote,
  describeMinutesAgo,
  describeSituation,
  INFERENCE_WORDS,
  presenceOf,
  situationLineStats,
} from "../src/orchestrator/intent/situation-note.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// 固定口径：2026-11-01T01:42:00Z → 北京 2026-11-01 09:42（周日）
const NOW = Date.UTC(2026, 10, 1, 1, 42);
const TZ = 480;
const LAST_SLEEP = Date.UTC(2026, 9, 31, 19, 0); // 北京 11-01 03:00

function snapshot(over: Partial<TemporalInput> = {}): TemporalSnapshot {
  return buildTemporalSnapshot({ nowMs: NOW, tzOffsetMinutes: TZ, ...over });
}

function text(over: Partial<TemporalInput> = {}): string {
  return buildSituationNote(snapshot(over)).lines.join("；");
}

describe("时间观 P1：此刻的处境只写事实（纯函数）", () => {
  it("第一行就是本地时间与星期，不写成「现在是 N 点」这种不带日期的钟", () => {
    const lines = buildSituationNote(snapshot()).lines;
    expect(lines[0]).toBe("现在是 2026-11-01 09:42（周日）");
  });

  it("醒了多久：有睡点记录就给事实；P1 没有睡眠时长就不编", () => {
    expect(text({ lastSleepAt: LAST_SLEEP })).toContain("你已经醒了 6.7 小时（上一次睡是 03:00）");
    expect(text({ lastSleepAt: LAST_SLEEP, lastSleepHours: 5 })).toContain("上一次睡了 5 小时");
  });

  it("没有睡点记录就不说「醒了多久」", () => {
    expect(text()).not.toContain("醒了");
  });

  it("他上次说话：没有线索就承认不知道，不编「他很久没来」", () => {
    expect(text({ sinceLastUserMsgMin: null })).toContain("你还不知道他上一次说话是什么时候");
    expect(text({ sinceLastUserMsgMin: 1 })).toContain("他刚刚还在跟你说话");
    expect(text({ sinceLastUserMsgMin: 45 })).toContain("他上一次说话是 45 分钟前");
    expect(text({ sinceLastUserMsgMin: 1341 })).toContain("他上一次说话是 22 小时 21 分钟前");
  });

  it("主动说了几句没回：照实数，不劝、不拦", () => {
    expect(text({ unansweredOwnMsgs: 0 })).not.toContain("他都没有回");
    expect(text({ unansweredOwnMsgs: 3 })).toContain("这之后你主动开口了 3 次，他都没有回");
  });

  it("上一次主动开口：有时就给，没有就不提", () => {
    expect(text({ sinceLastOwnMsgMin: 5 })).toContain("你上一次主动开口是 5 分钟前");
    expect(text({ sinceLastOwnMsgMin: null })).not.toContain("主动开口是");
  });

  it("在场信号：新鲜才用，过期等于不知道", () => {
    const fresh = text({ presence: { atMs: NOW - 60_000, active: true, ttlMs: 600_000 } });
    expect(fresh).toContain("他就在电脑前");
    const away = text({ presence: { atMs: NOW - 60_000, active: false, ttlMs: 600_000 } });
    expect(away).toContain("他刚离开电脑");
    const stale = text({ presence: { atMs: NOW - 3_600_000, active: true, ttlMs: 60_000 } });
    expect(stale).not.toContain("电脑前");
  });

  it("他什么时候常在：有统计就给事实，没有就承认还不了解；30–99 档必须标样本少", () => {
    expect(text()).toContain("我还不了解他的作息");
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
    expect(text({ hisRhythm: rhythm })).toContain(
      "你观察到他最常在 9:00 前后出现（30 条记录，覆盖 7 天）（样本还少，先当参考）",
    );
  });

  it("样本 100 条起不再标「样本少」（DESIGN:134 只要求 30≤n<100 标注）", () => {
    const rhythm = {
      sampleCount: 100,
      distinctLocalDates: 20,
      workdayDays: 10,
      restdayDays: 10,
      byLocalHour: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 100 : 0)),
      peakLocalHour: 9,
      confidence: 0.85,
      firstLocalDate: "2026-10-01",
      lastLocalDate: "2026-10-20",
    };
    const out = text({ hisRhythm: rhythm });
    expect(out).toContain("覆盖 20 天）");
    expect(out).not.toContain("样本还少");
  });

  it("说与不说由她定：holdAllowed 恒为 true（不产生否决）", () => {
    expect(buildSituationNote(snapshot()).holdAllowed).toBe(true);
    expect(buildSituationNote(snapshot({ unansweredOwnMsgs: 5 })).holdAllowed).toBe(true);
  });

  it("只写事实：不出现推断词、建议词与命令词（P1 验收口径）", () => {
    const full = text({
      lastSleepAt: LAST_SLEEP,
      sinceLastUserMsgMin: 1341,
      sinceLastOwnMsgMin: 5,
      unansweredOwnMsgs: 3,
      presence: { atMs: NOW - 60_000, active: false, ttlMs: 600_000 },
      hisRhythm: {
        sampleCount: 30,
        distinctLocalDates: 7,
        workdayDays: 4,
        restdayDays: 3,
        byLocalHour: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 30 : 0)),
        peakLocalHour: 9,
        confidence: 0.45,
        firstLocalDate: "2026-10-20",
        lastLocalDate: "2026-10-26",
      },
    });
    for (const banned of ["多半", "也许", "可能", "大概", "好像", "应该", "必须", "不许", "禁止", "别一直", "先等", "很想", "等一等"]) {
      expect(full).not.toContain(banned);
    }
  });
});

describe("时间观 P1：分钟/小时的写法", () => {
  it("describeMinutesAgo：刚刚 / 分钟 / 小时 / 小时+分钟", () => {
    expect(describeMinutesAgo(0)).toBe("刚刚");
    expect(describeMinutesAgo(1)).toBe("1 分钟前");
    expect(describeMinutesAgo(59)).toBe("59 分钟前");
    expect(describeMinutesAgo(60)).toBe("1 小时前");
    expect(describeMinutesAgo(90)).toBe("1 小时 30 分钟前");
    expect(describeMinutesAgo(-3)).toBe("刚刚");
  });
});

describe("时间观 P1：非法输入与坏信号", () => {
  it("非法快照当场抛（不把 NaN 带进提示词）", () => {
    const base = snapshot();
    expect(() => buildSituationNote({ ...base, nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => buildSituationNote({ ...base, localHour: 24 })).toThrow(RangeError);
    expect(() => buildSituationNote({ ...base, localHour: -1 })).toThrow(RangeError);
    expect(() => buildSituationNote({ ...base, localHour: 3.5 })).toThrow(RangeError);
    expect(() => buildSituationNote({ ...base, unansweredOwnMsgs: -1 })).toThrow(RangeError);
    expect(() => buildSituationNote({ ...base, localIso: "" })).toThrow(RangeError);
  });

  it("presenceOf：形状不对/过期返回 null，不抛", () => {
    expect(presenceOf(null, NOW)).toBeNull();
    expect(presenceOf("x", NOW)).toBeNull();
    expect(presenceOf({ atMs: "1793" }, NOW)).toBeNull();
    expect(presenceOf({ atMs: NOW - 60_000, active: true, ttlMs: 600_000 }, NOW)).not.toBeNull();
    expect(presenceOf({ atMs: NOW - 3_600_000, active: true, ttlMs: 60_000 }, NOW)).toBeNull();
  });

  it("摘要一行，空处境明说没有线索", () => {
    expect(describeSituation({ lines: [], holdAllowed: true })).toContain("没有可说的线索");
    expect(describeSituation(buildSituationNote(snapshot({ sinceLastUserMsgMin: 10 })))).toContain("处境：");
  });
});

describe("S3a：M1 处境行事实率（situationLineStats 纯函数）", () => {
  it("事实行：inferred=0、byWord 为空", () => {
    const note = buildSituationNote(snapshot());
    const stats = situationLineStats(note);
    expect(stats.lines).toBe(note.lines.length);
    expect(stats.lines).toBeGreaterThan(0);
    expect(stats.inferred).toBe(0);
    expect(stats.byWord).toEqual({});
  });

  it("注入推断词：按命中行计，byWord 逐词精确", () => {
    const stats = situationLineStats({
      lines: ["现在是 09:42（周日）", "他也许快睡了", "你差不多该醒了"],
    });
    expect(stats.lines).toBe(3);
    expect(stats.inferred).toBe(2);
    expect(stats.byWord).toEqual({ 也许: 1, 差不多: 1 });
  });

  it("一行多词：inferred 只计 1 行，byWord 各词各 1", () => {
    const stats = situationLineStats({ lines: ["他也许大概快睡了"] });
    expect(stats.lines).toBe(1);
    expect(stats.inferred).toBe(1);
    expect(stats.byWord).toEqual({ 也许: 1, 大概: 1 });
  });

  it("同一行重复同一词只计 1（按行统计）", () => {
    const stats = situationLineStats({ lines: ["大概左右都差不多，左右不过半小时"] });
    expect(stats.lines).toBe(1);
    expect(stats.inferred).toBe(1);
    expect(stats.byWord).toEqual({ 大概: 1, 差不多: 1, 左右: 1 });
  });

  it("空 lines：0/0/{}", () => {
    expect(situationLineStats({ lines: [] })).toEqual({ lines: 0, inferred: 0, byWord: {} });
  });

  it("词表 14 个、顺序固定（byWord 顺序依赖它）", () => {
    expect([...INFERENCE_WORDS]).toEqual([
      "多半",
      "也许",
      "可能",
      "大概",
      "应该",
      "估计",
      "似乎",
      "好像",
      "像是",
      "说不定",
      "或许",
      "恐怕",
      "差不多",
      "左右",
    ]);
  });
});

describe("S3a：插桩源码锁", () => {
  it("daemon 每拍只落计数（不落处境行文本）", () => {
    const main = readFileSync(join(HERE, "..", "scripts", "autonomy", "main.mjs"), "utf8");
    expect(main).toContain("situationLineStats(");
    expect(main).toContain("[situation] lines=");
    expect(main).toContain("inferred=");
    expect(main).toContain("[situation] stats-failed");
  });

  it("采集器含 SITUATION_RE 且 M1 走 computeM1", () => {
    const collector = readFileSync(join(HERE, "..", "tools", "observe", "acceptance-metrics.mjs"), "utf8");
    expect(collector).toContain("const SITUATION_RE");
    expect(collector).toContain("function computeM1");
    expect(collector).toContain("computeM1(day, tz, ctx)");
  });
});
