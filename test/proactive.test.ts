import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROACTIVE,
  decideProactive,
  inQuietHours,
  pickTopic,
  proactiveUserPrompt,
  type ProactiveInput,
} from "../src/dialogue/proactive.js";
import { wonderOf, type Wonder } from "../src/psychology/wonder.js";

function input(over: Partial<ProactiveInput> = {}): ProactiveInput {
  return {
    now: 1_000_000,
    localHour: 15,
    pressure: 0.2,
    rumination: 0,
    energy: 1,
    entropy: 0.2,
    lastAt: null,
    todayCount: 0,
    opts: DEFAULT_PROACTIVE,
    ...over,
  };
}

describe("inQuietHours", () => {
  it("普通区间与跨午夜区间", () => {
    expect(inQuietHours(3, 0, 7)).toBe(true);
    expect(inQuietHours(7, 0, 7)).toBe(false);
    expect(inQuietHours(23, 22, 6)).toBe(true);
    expect(inQuietHours(5, 22, 6)).toBe(true);
    expect(inQuietHours(12, 22, 6)).toBe(false);
  });

  it("起止相同表示不静默", () => {
    expect(inQuietHours(3, 5, 5)).toBe(false);
  });
});

describe("pickTopic（由状态挑话题，不用随机数）", () => {
  it("优先级：压着事 > 没说完 > 累了 > 心乱 > 都说不出", () => {
    expect(pickTopic(input({ pressure: 0.9 }))).toBe("held_back");
    expect(pickTopic(input({ pressure: 0.2, rumination: 0.5 }))).toBe("unfinished");
    expect(pickTopic(input({ energy: 0.2 }))).toBe("tired");
    expect(pickTopic(input({ entropy: 0.7 }))).toBe("restless");
    expect(pickTopic(input())).toBeNull();
  });
});

describe("pickTopic：wonder 优先（她此刻在乎什么，而不是被状态推着走）", () => {
  const wonder = (score: number, push: Wonder["push"]): Wonder => ({ score, push, reason: "测试" });

  it("wonder 分够高（≥0.65）时越过压力/疲惫，先说她在乎的事", () => {
    const high = input({ pressure: 0.9, energy: 0.2, wonder: wonder(0.9, "beauty") });
    expect(pickTopic(high)).toBe("beauty");
    // 门控仍然照旧决定"能不能开口"：这里只验证话题优先级
    const newborn = input({ pressure: 0.9, wonder: wonder(0.8, "newborn") });
    expect(pickTopic(newborn)).toBe("newborn");
  });

  it("wonder 分不够高时退回原来的 pressure→rumination→energy→entropy 顺序", () => {
    expect(pickTopic(input({ pressure: 0.9, wonder: wonder(0.4, null) }))).toBe("held_back");
    expect(pickTopic(input({ pressure: 0.2, rumination: 0.5, wonder: wonder(0.64, "beauty") }))).toBe("unfinished");
    expect(pickTopic(input({ entropy: 0.7, wonder: wonder(0.5, null) }))).toBe("restless");
    // 高分但没有方向（push null）时也不该硬说
    expect(pickTopic(input({ pressure: 0.9, wonder: wonder(0.9, null) }))).toBe("held_back");
  });

  it("wonderOf 算出的分数直接喂进 pickTopic 也能生效（端到端一条）", () => {
    const w = wonderOf({
      state: { valence: 0.6, arousal: 0.5, energy: 0.8, entropy: 0.2, dissonance: 0 },
      newKnowledge: 2,
      hoursSinceLearn: 0,
      localHour: 15,
    });
    expect(pickTopic(input({ pressure: 0.9, wonder: w }))).toBe("newborn");
  });
});

describe("decideProactive（什么时候可以自己开口）", () => {
  it("关掉时不开口", () => {
    const d = decideProactive(input({ opts: { ...DEFAULT_PROACTIVE, enabled: false } }));
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("disabled");
  });

  it("静默时段不开口，且先于间隔判断", () => {
    const d = decideProactive(input({ localHour: 3, pressure: 0.9 }));
    expect(d.verdict).toBe("quiet");
  });

  it("间隔不足不开口（DEFAULT 30 分钟）", () => {
    const d = decideProactive(input({ lastAt: 1_000_000 - 60_000, pressure: 0.9 }));
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("gap");
  });

  it("一天超过上限就不开口", () => {
    const d = decideProactive(input({ todayCount: DEFAULT_PROACTIVE.maxPerDay, pressure: 0.9 }));
    expect(d.verdict).toBe("daily");
  });

  it("状态平稳时也不硬找话说", () => {
    const d = decideProactive(input());
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("calm");
  });

  it("压力高且各种门都通过时才开口，并给出话题", () => {
    const d = decideProactive(input({ pressure: 0.8 }));
    expect(d.act).toBe(true);
    expect(d.verdict).toBe("speak");
    expect(d.topic).toBe("held_back");
    expect(d.note.length).toBeGreaterThan(0);
  });

  it("刚过间隔边界就算可以", () => {
    const d = decideProactive(input({ lastAt: 1_000_000 - DEFAULT_PROACTIVE.minGapMs, pressure: 0.8 }));
    expect(d.act).toBe(true);
  });

  it("DEFAULT 是温和兜底：30 分钟间隔 / 每天 10 条（用户 2026-11-01 裁决）", () => {
    expect(DEFAULT_PROACTIVE.minGapMs).toBe(30 * 60_000);
    expect(DEFAULT_PROACTIVE.maxPerDay).toBe(10);
    // 静默时段仍保留为事实（情境/诊断用），但不再由常量本身充当开关
    expect(DEFAULT_PROACTIVE.quietFrom).toBe(23);
    expect(DEFAULT_PROACTIVE.quietTo).toBe(7);
  });
});

describe("proactiveUserPrompt", () => {
  it("明确是主动开口、带上话题、要求一句；时钟与称呼不再写进提示词（P1 时间观）", () => {
    const p = proactiveUserPrompt({ topic: "missing", history: [] });
    expect(p).toContain("主动");
    expect(p).toContain("想打个招呼");
    expect(p).toContain("只输出你要发的那一句");
    // DESIGN v0.2 §2.4：时间事实交给「此刻的处境」；称呼归人格卡 speech，
    // 提示词里硬写会让她每条都以同一个称呼开头（审计 86% 的「用户，」）。
    expect(p).not.toContain("现在是");
    expect(p).not.toContain("称呼对方为");
  });

  it("有历史时把历史带进去，避免复读", () => {
    const p = proactiveUserPrompt({
      topic: "tired",
      history: ["用户：今天有点累", "我：那早点休息呀"],
    });
    expect(p).toContain("今天有点累");
    expect(p).toContain("那早点休息呀");
  });
});

describe("v5.4-P1 §4.9 状态门：energy / trust / 安全话术", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    now: 100,
    localHour: 12,
    pressure: 0.6,
    rumination: 0,
    energy: 0.8,
    entropy: 0,
    lastAt: null,
    todayCount: 0,
    opts: DEFAULT_PROACTIVE,
    ...over,
  });
  const gates = { energyFloor: 0.5, trustFloor: 0.3, trustSafeMin: 0.4 };

  it("太累不主动开口（energy ≤ 阈值）", () => {
    const d = decideProactive(base({ energy: 0.4, trust: 0.8, gates }));
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("energy");
  });

  it("不够信任不主动开口（trust ≤ 下限）", () => {
    const d = decideProactive(base({ trust: 0.2, gates }));
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("distrust");
  });

  it("刚够开口但没过安全线 → 只能说安全话术", () => {
    const d = decideProactive(base({ trust: 0.35, gates }));
    expect(d.act).toBe(true);
    expect(d.strategy).toBe("initiate_meme");
  });

  it("过了安全线 → 走策略选择", () => {
    const d = decideProactive(base({ trust: 0.5, gates }));
    expect(d.act).toBe(true);
    expect(d.strategy).toBe("select");
  });

  it("不给 gates 时不做状态门（旧调用点行为不变）", () => {
    const d = decideProactive(base({ energy: 0.01, trust: 0, gates: undefined }));
    expect(d.act).toBe(true);
    expect(d.strategy).toBeUndefined();
  });
});
