import { describe, expect, it } from "vitest";

import {
  SELFTALK_SPEAK_DAILY_CAP,
  SELFTALK_SPOKEN_MAX,
  humanize,
  selftalkMood,
  shouldSpeak,
} from "../src/maintenance/selftalk-voice.js";

const base = {
  valence: 0.5,
  arousal: 0.3,
  pressure: 0.2,
  rumination: 0.1,
  affection: 0.3,
  energy: 0.8,
};

describe("selftalkMood：先把状态读成一个词", () => {
  it("压着的事/反刍 → 低落（优先级最高）", () => {
    expect(selftalkMood({ ...base, pressure: 0.7 })).toBe("低落");
    expect(selftalkMood({ ...base, rumination: 0.6 })).toBe("低落");
  });

  it("亲近 + 微激动 → 黏人", () => {
    expect(selftalkMood({ ...base, affection: 0.6, arousal: 0.5 })).toBe("黏人");
  });

  it("心情好又精神 → 雀跃", () => {
    expect(selftalkMood({ ...base, valence: 0.7, arousal: 0.55 })).toBe("雀跃");
  });

  it("只是有点兴奋 → 好奇；什么都很平 → 平静", () => {
    expect(selftalkMood({ ...base, arousal: 0.6 })).toBe("好奇");
    expect(selftalkMood(base)).toBe("平静");
  });
});

describe("humanize：心里话改成能发出去的一句话", () => {
  it("去掉开头的自我叙述与括号动作，保留内容", () => {
    expect(humanize("我刚刚想着，窗台那枝花今天好像更精神了")).toBe("窗台那枝花今天好像更精神了。");
    expect(humanize("（想了想）他今天说话好轻，像怕吵到谁。")).toBe("他今天说话好轻，像怕吵到谁。");
  });

  it("元叙述（记忆库/检索/条目…）整句作废，宁可不发", () => {
    expect(humanize("我从记忆库里检索到一条条目")).toBeNull();
    expect(humanize("这条标签是「花」")).toBeNull();
    // A10：自述里的词也不能漏出去（由头/意图/引擎/缺口/机制）
    expect(humanize("这个由头是我自己想起来的")).toBeNull();
    expect(humanize("我的意图是先说一句")).toBeNull();
    expect(humanize("她的引擎还在转")).toBeNull();
    expect(humanize("缺口 0.52，还不够大")).toBeNull();
    expect(humanize("这套机制挺复杂")).toBeNull();
  });

  it("太短、空串、只有括号 → null", () => {
    expect(humanize("")).toBeNull();
    expect(humanize("嗯。")).toBeNull();
    expect(humanize("（叹气）")).toBeNull();
  });

  it("超长时在标点处收尾，并带上省略号/句号", () => {
    const long = "今天。".repeat(40);
    const out = humanize(long);
    expect(out).not.toBeNull();
    expect(Array.from(out as string).length).toBeLessThanOrEqual(SELFTALK_SPOKEN_MAX + 1);
  });

  it("外层引号去掉、结尾补句号", () => {
    expect(humanize("「今晚的月亮真好看呀」")).toBe("今晚的月亮真好看呀。");
    expect(humanize("今晚的月亮真好看呀")).toBe("今晚的月亮真好看呀。");
  });

  it("「我刚在心里念了一句：…」这类旁白框架不能发出去（F80）", () => {
    expect(humanize("我刚在心里念了一句：窗台那枝花，今天精神多了～")).toBe("窗台那枝花，今天精神多了～");
    expect(humanize("嗯……我在心里想了想，要不要给他发个消息。")).toBe("要不要给他发个消息。");
    // 正常中文的「心里」保留
    expect(humanize("这几天想起那件事，心里还是有点在意。")).toBe("这几天想起那件事，心里还是有点在意。");
  });
});

describe("shouldSpeak：该不该真的开口", () => {
  const ok = {
    nowMs: 1_000_000_000,
    localHour: 20,
    quietFrom: 0,
    quietTo: 7,
    energy: 0.8,
    mood: "平静" as const,
    spokenToday: 0,
    lastSpokeAt: 0,
  };

  it("四条都过才放行", () => {
    expect(shouldSpeak(ok)).toEqual({ speak: true, reason: "mood=平静" });
  });

  it("静默时段不打扰", () => {
    expect(shouldSpeak({ ...ok, localHour: 3 }).speak).toBe(false);
  });

  it("精力不足 / 配额用完 / 间隔太近 / 低落，都不开口", () => {
    expect(shouldSpeak({ ...ok, energy: 0.2 }).speak).toBe(false);
    expect(shouldSpeak({ ...ok, spokenToday: SELFTALK_SPEAK_DAILY_CAP }).speak).toBe(false);
    expect(shouldSpeak({ ...ok, lastSpokeAt: ok.nowMs - 60_000 }).speak).toBe(false);
    expect(shouldSpeak({ ...ok, mood: "低落" }).speak).toBe(false);
  });

  it("间隔够了就放行", () => {
    expect(shouldSpeak({ ...ok, lastSpokeAt: ok.nowMs - 91 * 60_000 }).speak).toBe(true);
  });
});
