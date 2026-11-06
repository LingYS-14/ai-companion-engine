import { describe, it, expect } from "vitest";
import {
  ASK_WINDOW_MS,
  MAX_TRIED,
  askCounts,
  describeAskPlan,
  isoFromMs,
  needForGap,
  planAskHelp,
  type AskHistoryEntry,
  type PlanAskHelpInput,
} from "../src/orchestrator/intent/ask-help.js";

const NOW_MS = Date.parse("2026-10-31T04:00:00.000Z");

function input(overrides: Partial<PlanAskHelpInput> = {}): PlanAskHelpInput {
  return {
    gap: { missing: "想看她主页但要登录", kind: "permission" },
    intentionId: "itn-1",
    what: "我想看看她的主页，但每次都停在登录页",
    ask: "能帮我确认下这个账号还能不能登录吗",
    tried: ["直接打开主页", "换了一个浏览器"],
    attempts: 3,
    selfEfficacyEff: 0.4,
    empowermentGain: 0.5,
    stalled: true,
    history: [],
    nowMs: NOW_MS,
    ownerLastActiveMs: null,
    ...overrides,
  };
}

function entry(overrides: Partial<AskHistoryEntry> = {}): AskHistoryEntry {
  return { requestId: "grd-itn-9-1", intentionId: "itn-9", askedAtMs: NOW_MS - 60 * 60 * 1000, ...overrides };
}

describe("求助编排：缺口 → 求助类型", () => {
  it("五种缺口都有对应求助类型（不多不少，全部落在 HELP_NEEDS 里）", () => {
    expect(needForGap("knowledge")).toBe("knowledge");
    expect(needForGap("permission")).toBe("permission");
    expect(needForGap("api")).toBe("plugin");
    expect(needForGap("skill")).toBe("unknown");
    expect(needForGap("physical")).toBe("unknown");
  });
});

describe("求助编排：什么情况下不该问（理由必须具体，不能只说“不问”）", () => {
  it("没试过任何一步 → 不问，理由是“撒娇不是求助”", () => {
    const plan = planAskHelp(input({ tried: [] }));
    expect(plan.shouldAsk).toBe(false);
    expect(plan.request).toBeNull();
    expect(plan.guardian).toBeNull();
    expect(plan.reason).toContain("撒娇");
  });

  it("试的次数 <2 → 不问（规格：先自己试两次）", () => {
    const plan = planAskHelp(input({ attempts: 1 }));
    expect(plan.shouldAsk).toBe(false);
    expect(plan.reason).toContain("试的次数还不够");
  });

  it("试满 5 次 → 已放弃，不再问（放弃是规则不是情绪）", () => {
    const plan = planAskHelp(input({ attempts: 5 }));
    expect(plan.shouldAsk).toBe(false);
    expect(plan.reason).toContain("放弃");
  });

  it("同一缺口 24 小时内问过 → 不问，理由点明是这个缺口", () => {
    const plan = planAskHelp(input({ history: [entry({ intentionId: "itn-1" })] }));
    expect(plan.shouldAsk).toBe(false);
    expect(plan.reason).toContain("已经问过一次");
  });

  it("24 小时内全局问过 2 次（别的缺口）→ 不问，理由点明额度", () => {
    const plan = planAskHelp(
      input({
        history: [
          entry({ intentionId: "itn-9", askedAtMs: NOW_MS - 3 * 3600_000 }),
          entry({ intentionId: "itn-8", askedAtMs: NOW_MS - 1 * 3600_000 }),
        ],
      }),
    );
    expect(plan.shouldAsk).toBe(false);
    expect(plan.reason).toContain("额度");
  });

  it("刚问过别的缺口 1 小时前（全局只 1 次）→ 仍被 24 小时闸挡下，不连问", () => {
    const plan = planAskHelp(input({ history: [entry({ intentionId: "itn-9", askedAtMs: NOW_MS - 3600_000 })] }));
    expect(plan.shouldAsk).toBe(false);
    expect(plan.reason).toContain("hoursSinceLastAsk");
  });

  it("超过 24 小时的旧记录不进窗口，也不当作“刚问过”", () => {
    const old = entry({ intentionId: "itn-1", askedAtMs: NOW_MS - ASK_WINDOW_MS - 60_000 });
    const counts = askCounts([old], "itn-1", NOW_MS);
    expect(counts.global).toBe(0);
    expect(counts.forGap).toBe(0);
    expect(counts.hoursSinceLastAsk).toBeNull();
    expect(planAskHelp(input({ history: [old] })).shouldAsk).toBe(true);
  });
});

describe("求助编排：该问的时候，请求长什么样、发给谁", () => {
  it("应开口：请求带 tried / need / ask，监护人请求 2 小时超时，用户不在就交给 Lead", () => {
    const plan = planAskHelp(input());
    expect(plan.shouldAsk).toBe(true);
    expect(plan.request).toMatchObject({
      blockedIntentionId: "itn-1",
      need: "permission",
      what: "我想看看她的主页，但每次都停在登录页",
      ask: "能帮我确认下这个账号还能不能登录吗",
    });
    expect(plan.request?.tried).toEqual(["直接打开主页", "换了一个浏览器"]);
    expect(plan.guardian?.timeoutMs).toBe(2 * 60 * 60_000);
    expect(plan.guardian?.tried).toEqual(["直接打开主页", "换了一个浏览器"]);
    expect(plan.target).toBe("lead");
    expect(plan.reason).toContain("Lead");
  });

  it("用户 30 分钟内活跃过 → 直接问他，而不是让 Lead 代收", () => {
    const plan = planAskHelp(input({ ownerLastActiveMs: NOW_MS - 5 * 60_000 }));
    expect(plan.shouldAsk).toBe(true);
    expect(plan.target).toBe("owner");
    expect(plan.reason).toContain("用户");
  });

  it("同一分钟重复规划 → 请求 id 相同（幂等落盘的基础）", () => {
    const first = planAskHelp(input());
    const second = planAskHelp(input());
    expect(first.guardian?.requestId).toBe(second.guardian?.requestId);
    expect(first.guardian?.requestId).toMatch(/^grd-itn-1-\d+$/);
  });

  it("真问出去后要追加的历史记录字段齐全（同缺口当天再问会被它挡住）", () => {
    const plan = planAskHelp(input());
    expect(plan.historyAdd).toEqual({
      requestId: plan.guardian?.requestId,
      intentionId: "itn-1",
      askedAtMs: NOW_MS,
    });
    const again = planAskHelp(input({ history: [plan.historyAdd!] }));
    expect(again.shouldAsk).toBe(false);
    expect(again.reason).toContain("已经问过一次");
  });
});

describe("求助编排：边界与守卫", () => {
  it("isoFromMs 输出 UTC 且不碰系统时钟；负值抛错", () => {
    expect(isoFromMs(NOW_MS)).toBe("2026-10-31T04:00:00Z");
    expect(() => isoFromMs(-1)).toThrow(RangeError);
  });

  it("非法输入抛 RangeError（配置错要当场炸，不能静默变成一次怪请求）", () => {
    expect(() => planAskHelp(input({ what: "  " }))).toThrow(RangeError);
    expect(() => planAskHelp(input({ ask: "" }))).toThrow(RangeError);
    expect(() => planAskHelp(input({ tried: new Array(MAX_TRIED + 1).fill("试") }))).toThrow(RangeError);
    expect(() => planAskHelp(input({ history: [{ requestId: "", intentionId: "x", askedAtMs: NOW_MS }] }))).toThrow(RangeError);
    expect(() => planAskHelp(input({ nowMs: -5 }))).toThrow(RangeError);
  });

  it("一行日志区分“开口”与“这次不问”，并且都带理由", () => {
    expect(describeAskPlan(planAskHelp(input()))).toContain("开口");
    expect(describeAskPlan(planAskHelp(input({ attempts: 1 })))).toContain("这次不问");
  });
});
