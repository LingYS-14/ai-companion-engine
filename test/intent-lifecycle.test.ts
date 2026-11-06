import { describe, expect, it } from "vitest";
import {
  SPEAK_REPEAT_WINDOW_MS,
  decideReRaise,
  dropExhaustedIntentions,
  exhaustedSpeakKinds,
  whyPhrase,
} from "../src/orchestrator/intent/intent-lifecycle.js";
import { newIntention } from "../src/orchestrator/intent/bus.js";
import type { CandidateCause, IntentionRecord } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T12:00:00Z";

function made(id: string, kind: IntentionRecord["kind"] = "reach_out"): IntentionRecord {
  return newIntention({ id, at: AT, kind, goal: "想问问他今天怎么样", why: "缺口变大" });
}

function withAttempts(record: IntentionRecord, n: number): IntentionRecord {
  return {
    ...record,
    attempts: Array.from({ length: n }, (_, i) => ({
      at: `2026-10-31T12:0${String(i)}:00Z`,
      act: "proactive_speak",
      outcome: "noop" as const,
      agency: 0.5,
    })),
  };
}

describe("A3 why 用真实的缺口维度拼人话（审计 §1 P1）", () => {
  it("按维度名 + 缺口数字拼，不用不存在的 cause.reason", () => {
    const because: CandidateCause[] = [
      { drive: "connection", gap: 0.62 },
      { drive: "energy", gap: 0.41 },
    ];
    expect(whyPhrase(because)).toBe("想说话（缺口 0.62）、累了（缺口 0.41）");
  });

  it("跳过零缺口与非有限值；全空时明说「缺口变大」而不是空串", () => {
    expect(whyPhrase([{ drive: "connection", gap: 0 }, { drive: "novelty", gap: Number.NaN }])).toBe("缺口变大");
    expect(whyPhrase([])).toBe("缺口变大");
  });
});

describe("A3 试满 5 次要真的放弃（dropIntention 接线）", () => {
  it("5 次 → dropped；4 次原样留着", () => {
    const five = withAttempts(made("itn-a"), 5);
    const four = withAttempts(made("itn-b"), 4);
    const out = dropExhaustedIntentions([five, four]);
    expect(out.dropped).toEqual(["itn-a"]);
    const byId = new Map(out.records.map((r) => [r.id, r]));
    expect(byId.get("itn-a")?.status).toBe("dropped");
    expect(byId.get("itn-b")?.status).toBe("pending");
    expect(byId.get("itn-b")?.attempts).toHaveLength(4);
  });

  it("blocked 也算未结：试满 5 次同样放弃", () => {
    const blocked = { ...withAttempts(made("itn-c"), 5), status: "blocked" as const, blocked_by: "quota" };
    const out = dropExhaustedIntentions([blocked]);
    expect(out.dropped).toEqual(["itn-c"]);
    expect(out.records[0]?.status).toBe("dropped");
  });

  it("done/dropped 不重复处理（历史不改写）", () => {
    const done = { ...withAttempts(made("itn-d"), 6), status: "done" as const };
    const dropped = { ...withAttempts(made("itn-e"), 6), status: "dropped" as const };
    const out = dropExhaustedIntentions([done, dropped]);
    expect(out.dropped).toEqual([]);
    expect(out.records.map((r) => r.status)).toEqual(["done", "dropped"]);
  });

  it("没有可放弃的：返回同一个数组（调用方据此不写盘）", () => {
    const input = [made("itn-f"), withAttempts(made("itn-g"), 2)];
    const out = dropExhaustedIntentions(input);
    expect(out.dropped).toEqual([]);
    expect(out.records).toBe(input);
  });

  it("放弃阈值可覆盖，但非法值抛 RangeError", () => {
    const input = [withAttempts(made("itn-h"), 3)];
    expect(dropExhaustedIntentions(input, 3).dropped).toEqual(["itn-h"]);
    expect(() => dropExhaustedIntentions(input, 0)).toThrow(RangeError);
    expect(() => dropExhaustedIntentions(input, 2.5)).toThrow(RangeError);
  });

  it("多条同时放弃：dropped 顺序跟输入一致", () => {
    const input = [withAttempts(made("itn-i"), 5), withAttempts(made("itn-j", "explore"), 6)];
    const out = dropExhaustedIntentions(input);
    expect(out.dropped).toEqual(["itn-i", "itn-j"]);
    expect(out.records.map((r) => r.id).sort()).toEqual(["itn-i", "itn-j"]);
  });
});

const NOW_MS = Date.UTC(2026, 10, 1, 12, 0, 0);

function withOkAttempts(record: IntentionRecord, atMsList: readonly number[]): IntentionRecord {
  return {
    ...record,
    attempts: atMsList.map((ms) => ({
      at: new Date(ms).toISOString(),
      act: "proactive_speak",
      outcome: "ok" as const,
      agency: 0.5,
    })),
  };
}

describe("F312：held 也计入试满 5 次放弃", () => {
  it("held 试满 5 次 → 放弃（此前被排除在外，机制永远不触发）", () => {
    const held = { ...withAttempts(made("itn-held"), 5), status: "held" as const };
    const out = dropExhaustedIntentions([held]);
    expect(out.dropped).toEqual(["itn-held"]);
    expect(out.records[0]?.status).toBe("dropped");
  });

  it("held 只有 4 次 → 原样留着（她还可以再想一次）", () => {
    const held = { ...withAttempts(made("itn-held-4"), 4), status: "held" as const };
    const input = [held];
    const out = dropExhaustedIntentions(input);
    expect(out.dropped).toEqual([]);
    expect(out.records).toBe(input);
    expect(out.records[0]?.status).toBe("held");
  });
});

describe("F312：同一类话说够次数就暂停（窗口内 ok 笔数）", () => {
  it("窗口内 5 笔 ok → 这一类被压；4 笔不压", () => {
    const five = withOkAttempts(made("itn-a"), [0, 1, 2, 3, 4].map((i) => NOW_MS - i * 60_000));
    expect(exhaustedSpeakKinds([five], NOW_MS)).toEqual(["reach_out"]);
    const four = withOkAttempts(made("itn-b"), [0, 1, 2, 3].map((i) => NOW_MS - i * 60_000));
    expect(exhaustedSpeakKinds([four], NOW_MS)).toEqual([]);
  });

  it("窗口外的旧账不算：5 笔里有 2 笔超过 6 小时 → 不压", () => {
    const record = withOkAttempts(
      made("itn-c"),
      [NOW_MS - 7 * 3_600_000, NOW_MS - 8 * 3_600_000, NOW_MS - 60_000, NOW_MS - 120_000, NOW_MS - 180_000],
    );
    expect(exhaustedSpeakKinds([record], NOW_MS)).toEqual([]);
    expect(SPEAK_REPEAT_WINDOW_MS).toBe(6 * 3_600_000);
  });

  it("noop/held 的尝试不算「说够」；不同类别分别统计", () => {
    const noopOnly = withAttempts(made("itn-d"), 6);
    const reach = withOkAttempts(made("itn-e"), [0, 1, 2, 3, 4].map((i) => NOW_MS - i * 60_000));
    const repair = withOkAttempts(made("itn-f", "repair"), [0, 1, 2, 3, 4].map((i) => NOW_MS - i * 60_000));
    expect(exhaustedSpeakKinds([noopOnly, reach, repair], NOW_MS)).toEqual(["reach_out", "repair"]);
  });

  it("非开口类别（explore/create）不参与这个刹车", () => {
    const explore = withOkAttempts(made("itn-g", "explore"), [0, 1, 2, 3, 4].map((i) => NOW_MS - i * 60_000));
    expect(exhaustedSpeakKinds([explore], NOW_MS)).toEqual([]);
  });

  it("非法参数抛 RangeError", () => {
    expect(() => exhaustedSpeakKinds([], -1)).toThrow(RangeError);
    expect(() => exhaustedSpeakKinds([], NOW_MS, { windowMs: 0 })).toThrow(RangeError);
    expect(() => exhaustedSpeakKinds([], NOW_MS, { limit: 0 })).toThrow(RangeError);
  });
});

describe("F312 复核（supervisor）：生产形状 + 重提纯函数", () => {
  it("生产形状：批次1B 的「每次开口一条独立记录」——5 条各 1 笔 ok，同类也该被压", () => {
    const records = [0, 1, 2, 3, 4].map((i) =>
      withOkAttempts(made(`itn-shape-${i}`), [NOW_MS - i * 60_000]),
    );
    // 单条记录永远只有 1 笔 attempts（成功即 done），但同类 6 小时里说满 5 次就该停
    expect(records.every((record) => record.attempts.length === 1)).toBe(true);
    expect(exhaustedSpeakKinds(records, NOW_MS)).toEqual(["reach_out"]);
  });

  it("被同类刹车压着的记录不能从重提后门漏出去（blocked=suppressed）", () => {
    const candidate = made("itn-r1");
    const out = decideReRaise({
      candidate,
      suppressedKinds: ["reach_out"],
      minutesSinceLastProactive: null,
      reRaiseQuietMin: 10,
    });
    expect(out.speakable).toBeNull();
    expect(out.blocked).toBe("suppressed");
  });

  it("刚开口不到 10 分钟 → 先放着（blocked=recently-spoke）", () => {
    const candidate = made("itn-r2");
    const out = decideReRaise({
      candidate,
      suppressedKinds: [],
      minutesSinceLastProactive: 3,
      reRaiseQuietMin: 10,
    });
    expect(out.speakable).toBeNull();
    expect(out.blocked).toBe("recently-spoke");
  });

  it("两条都满足时以「同类说够了」优先（说够比刚说过更硬）", () => {
    const out = decideReRaise({
      candidate: made("itn-r3"),
      suppressedKinds: ["reach_out"],
      minutesSinceLastProactive: 1,
      reRaiseQuietMin: 10,
    });
    expect(out.blocked).toBe("suppressed");
  });

  it("放行时原样返回同一条记录；没有候选时返回 null 且不报错", () => {
    const candidate = made("itn-r4");
    expect(
      decideReRaise({ candidate, suppressedKinds: [], minutesSinceLastProactive: null, reRaiseQuietMin: 10 }),
    ).toEqual({ speakable: candidate, blocked: null });
    expect(
      decideReRaise({ candidate, suppressedKinds: [], minutesSinceLastProactive: 10, reRaiseQuietMin: 10 }),
    ).toEqual({ speakable: candidate, blocked: null });
    expect(
      decideReRaise({ candidate: null, suppressedKinds: ["reach_out"], minutesSinceLastProactive: null, reRaiseQuietMin: 10 }),
    ).toEqual({ speakable: null, blocked: null });
  });

  it("非法 quiet 参数抛 RangeError", () => {
    expect(() =>
      decideReRaise({
        candidate: made("itn-r5"),
        suppressedKinds: [],
        minutesSinceLastProactive: null,
        reRaiseQuietMin: Number.NaN,
      }),
    ).toThrow(RangeError);
  });
});
