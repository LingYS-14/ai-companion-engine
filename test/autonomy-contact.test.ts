import { describe, expect, it } from "vitest";

import {
  lastContactMinutesFrom,
  lastContactMs,
  parseQQContact,
} from "../src/autonomy/contact.js";

const NOW = 1_793_500_000_000;

describe("A1 真实接触时间：从 QQ 状态文件取，而不是心跳", () => {
  it("收消息与回消息两个时间都在时，取较晚的那个", () => {
    const raw = { onebotLastEventAt: NOW - 5 * 60_000, lastReplyAt: NOW - 2 * 60_000 };
    expect(lastContactMs(raw)).toBe(NOW - 2 * 60_000);
    expect(lastContactMinutesFrom(raw, NOW)).toBe(2);
  });

  it("只有回消息时间时用它（还没收到新消息）", () => {
    expect(lastContactMs({ lastReplyAt: NOW - 90 * 60_000 })).toBe(NOW - 90 * 60_000);
    expect(parseQQContact({ lastReplyAt: NOW - 1 }).lastEventAt).toBeNull();
  });

  it("只有收消息时间时用它（回了消息但字段缺失的旧文件）", () => {
    expect(lastContactMs({ onebotLastEventAt: NOW - 7 * 60_000 })).toBe(NOW - 7 * 60_000);
    expect(lastContactMinutesFrom({ onebotLastEventAt: NOW - 7 * 60_000 }, NOW)).toBe(7);
  });

  it("没有可用时间时返回 null，而不是 0（0 会被当成刚刚聊过）", () => {
    expect(lastContactMs({})).toBeNull();
    expect(lastContactMs({ cursorEpochNs: NOW * 1_000_000 })).toBeNull();
    expect(lastContactMinutesFrom({}, NOW)).toBeNull();
  });

  it("坏字段当没有：字符串 / 0 / 负数 / NaN / Infinity 都不算时间", () => {
    expect(lastContactMs({ onebotLastEventAt: "1793412126000" })).toBeNull();
    expect(lastContactMs({ onebotLastEventAt: 0, lastReplyAt: -1 })).toBeNull();
    expect(lastContactMs({ onebotLastEventAt: Number.NaN })).toBeNull();
    expect(lastContactMs({ onebotLastEventAt: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("非对象内容不抛错，按没有记录处理", () => {
    expect(lastContactMs(null)).toBeNull();
    expect(lastContactMs("qq-assistant.json")).toBeNull();
    expect(lastContactMs([1, 2, 3])).toBeNull();
  });

  it("分钟数向下取整：差 59 秒算 0 分钟，差 60 秒算 1 分钟", () => {
    expect(lastContactMinutesFrom({ lastReplyAt: NOW - 59_999 }, NOW)).toBe(0);
    expect(lastContactMinutesFrom({ lastReplyAt: NOW - 60_000 }, NOW)).toBe(1);
  });

  it("时钟偏差导致「未来时间」时按 0 分钟算，不出负数", () => {
    expect(lastContactMinutesFrom({ lastReplyAt: NOW + 5 * 60_000 }, NOW)).toBe(0);
  });

  it("nowMs 非法直接抛错（装配点的 bug 不该静默变成 0 分钟）", () => {
    expect(() => lastContactMinutesFrom({ lastReplyAt: NOW }, Number.NaN)).toThrow(RangeError);
  });

  it("不改输入对象", () => {
    const raw = Object.freeze({ onebotLastEventAt: NOW, lastReplyAt: NOW });
    expect(() => lastContactMinutesFrom(raw, NOW + 1)).not.toThrow();
    expect(Object.keys(raw)).toEqual(["onebotLastEventAt", "lastReplyAt"]);
  });
});
