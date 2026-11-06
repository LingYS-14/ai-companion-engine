/**
 * F247：DSH 方向一（在场信号）——把 Windows 的"最后一次键鼠输入"变成她能用的三态。
 *
 * 为什么需要这一层：A5 的处境里她只知道"他上一次说话是 N 小时前"。那不等于
 * "他不在电脑前"——他不说话也可能坐着。用户 m09313 要的是"让她意识到我可能有事"，
 * 而不是让她以为"沉默 = 离开"。
 *
 * 这里钉住三件容易做错的事：
 * - 信号太旧不许采信（进程停摆后不能拿旧值骗她"他在"）；
 * - 2–10 分钟的中间地带返回 null（说不准就不说，不硬猜）；
 * - 探测失败返回 null 而不是 active=false（"没测到"≠"他走了"）。
 */
import { describe, expect, it } from "vitest";
import {
  PRESENCE_ACTIVE_MAX_IDLE_MS,
  PRESENCE_AWAY_MIN_IDLE_MS,
  PRESENCE_MAX_AGE_MS,
  PRESENCE_TTL_MS,
  describeInputActivity,
  parseInputActivity,
  presenceFromActivity,
} from "../src/autonomy/input-activity.js";

const NOW = 1_793_440_000_000;

describe("F247 parseInputActivity：只认形状对的事实", () => {
  it("正常输出解析成功，秒数向下取整", () => {
    expect(parseInputActivity({ idleSeconds: 47.9, atMs: NOW - 1000 })).toEqual({
      idleSeconds: 47,
      atMs: NOW - 1000,
    });
  });

  it("缺字段/类型不对/负数/时间戳非正 → null（不抛）", () => {
    expect(parseInputActivity(null)).toBeNull();
    expect(parseInputActivity({})).toBeNull();
    expect(parseInputActivity({ idleSeconds: "10", atMs: NOW })).toBeNull();
    expect(parseInputActivity({ idleSeconds: -1, atMs: NOW })).toBeNull();
    expect(parseInputActivity({ idleSeconds: 10, atMs: 0 })).toBeNull();
    expect(parseInputActivity({ idleSeconds: Number.NaN, atMs: NOW })).toBeNull();
  });
});

describe("F247 presenceFromActivity：三态映射", () => {
  it("刚动过键鼠（≤2 分钟）→ active=true，带 TTL", () => {
    const signal = presenceFromActivity({ idleSeconds: 30, atMs: NOW }, NOW);
    expect(signal).toEqual({ atMs: NOW, active: true, ttlMs: PRESENCE_TTL_MS });
  });

  it("离开（>10 分钟）→ active=false", () => {
    const signal = presenceFromActivity({ idleSeconds: 11 * 60, atMs: NOW }, NOW);
    expect(signal).toEqual({ atMs: NOW, active: false, ttlMs: PRESENCE_TTL_MS });
  });

  it("2–10 分钟中间地带 → null（说不准就不说）", () => {
    expect(presenceFromActivity({ idleSeconds: 5 * 60, atMs: NOW }, NOW)).toBeNull();
  });

  it("信号过旧（超过 PRESENCE_MAX_AGE_MS）→ null，不拿旧事实当现在", () => {
    const stale = NOW - PRESENCE_MAX_AGE_MS - 1;
    expect(presenceFromActivity({ idleSeconds: 0, atMs: stale }, NOW)).toBeNull();
  });

  it("边界：恰好 2 分钟算在，恰好 10 分钟算离开", () => {
    expect(presenceFromActivity({ idleSeconds: PRESENCE_ACTIVE_MAX_IDLE_MS / 1000, atMs: NOW }, NOW)?.active).toBe(true);
    expect(presenceFromActivity({ idleSeconds: PRESENCE_AWAY_MIN_IDLE_MS / 1000, atMs: NOW }, NOW)?.active).toBe(false);
  });

  it("非法 nowMs 抛 RangeError（装配层写错不该静默）", () => {
    expect(() => presenceFromActivity({ idleSeconds: 0, atMs: NOW }, Number.NaN)).toThrow(RangeError);
  });
});

describe("F247 describeInputActivity：日志人话", () => {
  it("没有测得时明说没测得，不冒充'他不在'", () => {
    expect(describeInputActivity(null)).toContain("没有测得");
    expect(describeInputActivity(null)).not.toContain("离开");
  });

  it("一分钟内/数分钟无输入两种文案", () => {
    expect(describeInputActivity({ idleSeconds: 20, atMs: NOW })).toContain("1 分钟内有输入");
    expect(describeInputActivity({ idleSeconds: 600, atMs: NOW })).toContain("10 分钟无输入");
  });
});

describe("F249 探针比这一拍晚几百毫秒：负年龄不能当成「不知道」", () => {
  it("atMs 比 nowMs 晚 800ms（探针刚跑完）→ 仍按「刚刚」算", () => {
    const signal = presenceFromActivity({ idleSeconds: 3, atMs: NOW + 800 }, NOW);
    expect(signal).toEqual({ atMs: NOW + 800, active: true, ttlMs: PRESENCE_TTL_MS });
  });

  it("来自未来的时间戳（超过最大年龄）→ 不可信，返回 null", () => {
    expect(presenceFromActivity({ idleSeconds: 0, atMs: NOW + PRESENCE_MAX_AGE_MS + 1 }, NOW)).toBeNull();
  });
});
