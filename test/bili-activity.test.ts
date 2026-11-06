import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCIAL_ENERGY_FLOOR,
  planActivity,
  type SocialActivityInput,
} from "../src/bili/activity.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function input(over: Partial<SocialActivityInput> = {}): SocialActivityInput {
  const base: SocialActivityInput = {
    now: NOW,
    lastActionAt: null,
    todayActions: 0,
    todayDanmaku: 0,
    todayComments: 0,
    video: { bvid: "BV1xx411c7mD", durationSec: 100, liked: false, actedToday: false },
    energy: 0.8,
    asleep: false,
    hasSession: true,
    config: { intervalMs: 20 * MIN, dailyMax: 4, danmakuDailyMax: 2, commentDailyMax: 1, likeEnabled: true },
  };
  return { ...base, ...over, ...(over.video === undefined ? {} : { video: over.video }) };
}

describe("B 站互动决策：优先级", () => {
  it("有额度时先发弹幕，位置放在约 30%", () => {
    const plan = planActivity(input());
    expect(plan.action).toBe("danmaku");
    expect(plan.progressMs).toBe(30_000);
    expect(plan.reason).toContain("弹幕额度未满");
  });

  it("弹幕额度用完后轮到评论", () => {
    expect(planActivity(input({ todayDanmaku: 2 })).action).toBe("comment");
    expect(planActivity(input({ todayDanmaku: 2, todayComments: 1 })).action).toBe("like");
  });

  it("点赞只在没点过赞时做，且每视频一次", () => {
    const plan = planActivity(input({ todayDanmaku: 2, todayComments: 1, video: { bvid: "BV1", durationSec: 60, liked: false, actedToday: false } }));
    expect(plan.action).toBe("like");

    const liked = planActivity(input({ todayDanmaku: 2, todayComments: 1, video: { bvid: "BV1", durationSec: 60, liked: true, actedToday: false } }));
    expect(liked.action).toBe("watch");
    expect(liked.reason).toContain("只看不写");
  });

  it("likeEnabled=false 时不点赞，退到 watch", () => {
    const plan = planActivity(
      input({
        todayDanmaku: 2,
        todayComments: 1,
        config: { intervalMs: 20 * MIN, dailyMax: 4, danmakuDailyMax: 2, commentDailyMax: 1, likeEnabled: false },
      }),
    );
    expect(plan.action).toBe("watch");
  });
});

describe("B 站互动决策：预算与边界", () => {
  it("dailyMax=0 表示社交关闭，连匿名浏览也不做", () => {
    const plan = planActivity(
      input({ hasSession: false, config: { intervalMs: 20 * MIN, dailyMax: 0, danmakuDailyMax: 0, commentDailyMax: 0, likeEnabled: false } }),
    );
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("社交已关闭");
  });

  it("当天动作额度满了只浏览不写", () => {
    const plan = planActivity(input({ todayActions: 4, todayDanmaku: 2, todayComments: 1 }));
    expect(plan.action).toBe("watch");
    expect(plan.reason).toContain("额度已满");
  });

  it("没有登录态只能匿名浏览", () => {
    expect(planActivity(input({ hasSession: false })).action).toBe("watch");
    expect(planActivity(input({ hasSession: false })).reason).toContain("没有登录态");
  });

  it("冷却期内跳过，并说明还差几分钟", () => {
    const plan = planActivity(input({ lastActionAt: NOW - 5 * MIN }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("还差约 15 分钟");
  });

  it("今天已在这条视频下互动过就换一条", () => {
    const plan = planActivity(input({ video: { bvid: "BV1", durationSec: 100, liked: false, actedToday: true } }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("换一条");
  });

  it("非法计数回落到 0，不会因为 NaN 放行", () => {
    const plan = planActivity(
      input({ todayActions: Number.NaN, todayDanmaku: Number.NaN, todayComments: Number.NaN }),
    );
    // todayActions 回落 0，弹幕额度 2 仍可发
    expect(plan.action).toBe("danmaku");
  });
});

describe("B 站互动决策：状态门", () => {
  it("睡眠中不刷 B 站", () => {
    const plan = planActivity(input({ asleep: true }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("睡眠");
  });

  it("能量低于默认下限就休息", () => {
    const plan = planActivity(input({ energy: DEFAULT_SOCIAL_ENERGY_FLOOR - 0.01 }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("能量");
  });

  it("能量值非法按不足处理", () => {
    expect(planActivity(input({ energy: Number.NaN })).action).toBe("skip");
  });

  it("可以按配置覆盖能量下限", () => {
    const plan = planActivity(
      input({
        energy: 0.1,
        config: { intervalMs: 20 * MIN, dailyMax: 4, danmakuDailyMax: 2, commentDailyMax: 1, likeEnabled: true, energyFloor: 0.05 },
      }),
    );
    expect(plan.action).toBe("danmaku");
  });
});

describe("B 站互动决策：弹幕位置", () => {
  it("长视频取 30% 处", () => {
    const plan = planActivity(input({ video: { bvid: "BV1", durationSec: 1000, liked: false, actedToday: false } }));
    expect(plan.progressMs).toBe(300_000);
  });

  it("极短视频退回开头，且不会把弹幕放到片尾之外", () => {
    const one = planActivity(input({ video: { bvid: "BV1", durationSec: 1, liked: false, actedToday: false } }));
    expect(one.progressMs).toBe(0);
    const two = planActivity(input({ video: { bvid: "BV1", durationSec: 2, liked: false, actedToday: false } }));
    expect(two.progressMs).toBe(600);
  });

  it("时长未知时 progress=0", () => {
    const plan = planActivity(input({ video: { bvid: "BV1", durationSec: Number.NaN, liked: false, actedToday: false } }));
    expect(plan.progressMs).toBe(0);
  });
});
