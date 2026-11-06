import { describe, expect, it } from "vitest";

import {
  SPEECH_RESERVE,
  describeSpeechReserve,
  remainingCalls,
  shouldYieldForSpeech,
} from "../src/autonomy/speech-reserve.js";

describe("speech-reserve：本小时剩几格、后台要不要让路", () => {
  it("默认预留 1 格；峰时 6 格用掉 5 次就该让路", () => {
    expect(SPEECH_RESERVE).toBe(1);
    expect(shouldYieldForSpeech({ usedCalls: 5, maxCalls: 6 })).toBe(true);
    expect(shouldYieldForSpeech({ usedCalls: 4, maxCalls: 6 })).toBe(false);
  });

  it("谷时 12 格：用掉 11 次才让路（剩 1 格给开口）", () => {
    expect(shouldYieldForSpeech({ usedCalls: 11, maxCalls: 12 })).toBe(true);
    expect(shouldYieldForSpeech({ usedCalls: 10, maxCalls: 12 })).toBe(false);
  });

  it("额度已经用完时也让路（剩 0 ≤ 1），不会出现负数", () => {
    expect(remainingCalls({ usedCalls: 9, maxCalls: 6 })).toBe(0);
    expect(shouldYieldForSpeech({ usedCalls: 9, maxCalls: 6 })).toBe(true);
  });

  it("reserve 可覆盖：reserve=0 只在本小时真没额度时让路", () => {
    expect(shouldYieldForSpeech({ usedCalls: 5, maxCalls: 6, reserve: 0 })).toBe(false);
    expect(shouldYieldForSpeech({ usedCalls: 6, maxCalls: 6, reserve: 0 })).toBe(true);
  });

  it("描述只在让路时给一句话，且带已用/上限/剩余", () => {
    expect(describeSpeechReserve({ usedCalls: 4, maxCalls: 6 })).toBeNull();
    const note = describeSpeechReserve({ usedCalls: 5, maxCalls: 6 });
    expect(note).toContain("给开口留额度");
    expect(note).toContain("5/6");
    expect(note).toContain("还剩 1 格");
  });

  it("非法输入抛 RangeError，不静默算成 0", () => {
    expect(() => remainingCalls({ usedCalls: -1, maxCalls: 6 })).toThrow(RangeError);
    expect(() => remainingCalls({ usedCalls: 1, maxCalls: Number.NaN })).toThrow(RangeError);
    expect(() => shouldYieldForSpeech({ usedCalls: 1, maxCalls: 6, reserve: 1.5 })).toThrow(RangeError);
    expect(() => describeSpeechReserve({ usedCalls: 1, maxCalls: 6, reserve: -1 })).toThrow(RangeError);
  });
});
