/**
 * §5.3/§5.6 写入侧 episode 信封：`src/orchestrator/intent/episode-write.ts`
 *
 * 这些测试守的是三条底线：
 *   1. 写的时候不知道的字段必须标 `unknown:`，不能编（否则读取端会把推断当事实）；
 *   2. 情境指纹的每个字段都要能被读取端解释（渠道→地点、来源→在场者、tag→话题域）；
 *   3. 线索重合的乘法不能把"线索对不上"变成"这条记忆永远想不起来"（地板 0.5）。
 */

import { describe, expect, it } from "vitest";

import {
  AFFECT_NEGATIVE_MAX,
  AFFECT_POSITIVE_MIN,
  EPISODE_WRITE_VERSION,
  UNKNOWN_PREFIX,
  VIEWPOINT_SELF,
  affectOf,
  buildCueFingerprint,
  buildEpisodeWrite,
  channelForSource,
  cueOverlap,
  dayPartOfHour,
  describeEpisodeWrite,
  participantsFor,
  placeForChannel,
  scoreWithCueOverlap,
  topicDomainOf,
  type CueFingerprint,
  type EpisodeWriteInput,
} from "../src/orchestrator/intent/episode-write.js";

function input(overrides: Partial<EpisodeWriteInput> = {}): EpisodeWriteInput {
  return {
    text: "用户说今天风很大，我想起上次桂花落进茶里。",
    source: "player",
    channel: "gui",
    mode: "normal",
    tags: ["conversation"],
    valence: 0.7,
    arousal: 0.5,
    createdAtMs: 1793407200000,
    ...overrides,
  };
}

describe("§5.3 episode 写入：五元组只写知道的，其余标 unknown", () => {
  it("affect 分桶：≥0.62 正面、≤0.38 负面、中间中性", () => {
    expect(affectOf(0.62, 0.5)).toBe("positive");
    expect(affectOf(1, 1)).toBe("positive");
    expect(affectOf(0.38, 0.5)).toBe("negative");
    expect(affectOf(0, 0)).toBe("negative");
    expect(affectOf(0.5, 0.9)).toBe("neutral");
    expect(AFFECT_POSITIVE_MIN).toBeGreaterThan(AFFECT_NEGATIVE_MAX);
  });

  it("话题域取第一个非空 tag，没有就是 conversation", () => {
    expect(topicDomainOf(["episode", "聊天"])).toBe("episode");
    expect(topicDomainOf(["  ", "聊天"])).toBe("聊天");
    expect(topicDomainOf([])).toBe("conversation");
    expect(topicDomainOf(["", "  "])).toBe("conversation");
  });

  it("在场者：只有能确认是用户的来源才写用户，其余不编", () => {
    expect(participantsFor("player")).toEqual(["用户"]);
    expect(participantsFor("qq_contact_verified")).toEqual(["用户"]);
    expect(participantsFor("web")).toEqual([]);
    expect(participantsFor("parasocial")).toEqual([]);
  });

  it("地点按渠道映射，未知渠道保留原值（不猜某个地方）", () => {
    expect(placeForChannel("gui")).toBe("本机");
    expect(placeForChannel("qq")).toBe("QQ");
    expect(placeForChannel("bili")).toBe("B站");
    expect(placeForChannel("irc")).toBe("irc");
    expect(placeForChannel("  ")).toBe(`${UNKNOWN_PREFIX}no-channel`);
  });

  it("写的时候不知道 goal_at_time 就写 unknown 前缀，并进 missing", () => {
    const payload = buildEpisodeWrite(input());
    expect(payload.encodeCtx.goal_at_time).toBe(`${UNKNOWN_PREFIX}no-goal-at-write`);
    expect(payload.missing).toEqual(["goalAtTime"]);
    expect(payload.complete).toBe(false);
    expect(payload.encodeCtx.viewpoint).toBe(VIEWPOINT_SELF);
    expect(payload.encodeCtx.place).toBe("本机");
  });

  it("给了 goal 就完整（在场者也在）", () => {
    const payload = buildEpisodeWrite(input({ goalAtTime: "想把这段对话记下来" }));
    expect(payload.encodeCtx.goal_at_time).toBe("想把这段对话记下来");
    expect(payload.missing).toEqual([]);
    expect(payload.complete).toBe(true);
    expect(payload.participants).toEqual(["用户"]);
  });

  it("空在场者意味着这条不完整（哪怕 goal 给了）", () => {
    const payload = buildEpisodeWrite(input({ source: "web", goalAtTime: "想搜一下那个梗" }));
    expect(payload.participants).toEqual([]);
    expect(payload.complete).toBe(false);
  });

  it("encodeCtx 带上 schema 版本与指纹，participants 走正式字段", () => {
    const payload = buildEpisodeWrite(input({ tags: ["episode"], goalId: "itn-1" }));
    expect(EPISODE_WRITE_VERSION).toBe(3);
    expect(payload.encodeCtx.episode_write_version).toBe(EPISODE_WRITE_VERSION);
    expect(payload.encodeCtx.episode_missing).toEqual(["goalAtTime"]);
    const fp = payload.encodeCtx.cue_fingerprint as CueFingerprint;
    expect(fp.topicDomain).toBe("episode");
    expect(fp.goalId).toBe("itn-1");
    // 正式字段由调用方写进 MemoryRecord，不在 encodeCtx 里重复
    expect(payload.encodeCtx.participants).toBeUndefined();
  });

  it("空字符串 goalId/goalAtTime 等同于没给", () => {
    const payload = buildEpisodeWrite(input({ goalAtTime: "   ", goalId: "  " }));
    expect(payload.encodeCtx.goal_at_time).toBe(`${UNKNOWN_PREFIX}no-goal-at-write`);
    expect((payload.encodeCtx.cue_fingerprint as CueFingerprint).goalId).toBeNull();
  });
});

describe("v3（P2a）：direction 只在知道时写入，缺键 = unknown", () => {
  it("版本号升到 3（v3 唯一新增字段是 direction）", () => {
    expect(EPISODE_WRITE_VERSION).toBe(3);
    expect(buildEpisodeWrite(input()).encodeCtx.episode_write_version).toBe(3);
  });

  it("传了 direction 就写进 encodeCtx（inbound / outbound 原样）", () => {
    expect(buildEpisodeWrite(input({ direction: "inbound" })).encodeCtx.direction).toBe("inbound");
    expect(buildEpisodeWrite(input({ direction: "outbound" })).encodeCtx.direction).toBe("outbound");
  });

  it("没传 direction 就不写这个键（不伪造 'unknown' 字符串假值）", () => {
    const ctx = buildEpisodeWrite(input()).encodeCtx;
    expect("direction" in ctx).toBe(false);
    expect(ctx["direction"]).toBeUndefined();
  });
});

describe("§5.6 线索重合：字段级比对，不把「不知道」算成「不匹配」", () => {
  const written: CueFingerprint = {
    topicDomain: "episode",
    participants: ["用户"],
    place: "QQ",
    affect: "positive",
    timeOfDay: null,
    goalId: "itn-1",
  };

  it("全对上 = 1", () => {
    expect(cueOverlap(written, { ...written }).ratio).toBe(1);
  });

  it("只有话题域和在场者对 = 2/5", () => {
    const current: CueFingerprint = { ...written, place: "本机", affect: "neutral", goalId: "itn-2" };
    const overlap = cueOverlap(written, current);
    expect(overlap.matched).toBe(2);
    expect(overlap.total).toBe(5);
    expect(overlap.ratio).toBeCloseTo(0.4, 10);
  });

  it("goalId 只有两边都知道时才参与，全不知道时 4 个字段比较", () => {
    const current: CueFingerprint = { ...written, goalId: null };
    const overlap = cueOverlap(written, current);
    expect(overlap.total).toBe(4);
    expect(overlap.ratio).toBe(1); // 其余四项全等
  });

  it("没有任何可比字段时 ratio=1（没有信息 ≠ 不匹配）", () => {
    const empty: CueFingerprint = { topicDomain: "", participants: [], place: "", affect: "neutral", timeOfDay: null, goalId: null };
    expect(cueOverlap(empty, empty).ratio).toBe(1);
  });

  it("乘法有 0.5 地板：线索全不对也留一半，不清零", () => {
    const overlap = cueOverlap(written, { ...written, topicDomain: "other", participants: [], place: "本机", affect: "negative" });
    const scored = scoreWithCueOverlap(0.8, overlap);
    expect(scored).toBeGreaterThanOrEqual(0.4);
    expect(scored).toBeCloseTo(0.8 * (0.5 + 0.5 * overlap.ratio), 10);
    // 全对时不再是地板，而是完整分数
    expect(scoreWithCueOverlap(0.8, cueOverlap(written, written))).toBeCloseTo(0.8, 10);
  });

  it("非法 baseScore 原样返回（不把 NaN 变成 0 混过去）", () => {
    const overlap = cueOverlap(written, written);
    expect(Number.isNaN(scoreWithCueOverlap(Number.NaN, overlap))).toBe(true);
    expect(scoreWithCueOverlap(-1, overlap)).toBe(-1);
  });
});

describe("P2a 收尾：timeOfDay 四桶（本批只写不检索）", () => {
  it("小时归四桶：边界 [0,6) 深夜 / [6,12) 上午 / [12,18) 下午 / [18,24) 晚上", () => {
    expect(dayPartOfHour(0)).toBe("late_night");
    expect(dayPartOfHour(5)).toBe("late_night");
    expect(dayPartOfHour(6)).toBe("morning");
    expect(dayPartOfHour(11)).toBe("morning");
    expect(dayPartOfHour(12)).toBe("afternoon");
    expect(dayPartOfHour(17)).toBe("afternoon");
    expect(dayPartOfHour(18)).toBe("evening");
    expect(dayPartOfHour(23)).toBe("evening");
  });

  it("非整数/越界/NaN → null（不抛、不猜）", () => {
    expect(dayPartOfHour(21.5)).toBeNull();
    expect(dayPartOfHour(-1)).toBeNull();
    expect(dayPartOfHour(24)).toBeNull();
    expect(dayPartOfHour(Number.NaN)).toBeNull();
  });

  it("localHour 写进 fingerprint 与 encode_ctx；缺省为 null", () => {
    const payload = buildEpisodeWrite(input({ localHour: 21 }));
    expect(payload.fingerprint.timeOfDay).toBe("evening");
    const fp = payload.encodeCtx.cue_fingerprint as CueFingerprint;
    expect(fp.timeOfDay).toBe("evening");
    expect(buildEpisodeWrite(input()).fingerprint.timeOfDay).toBeNull();
  });

  it("cueOverlap：timeOfDay 只有两边都知道才计入 total", () => {
    const base: CueFingerprint = {
      topicDomain: "episode",
      participants: ["用户"],
      place: "QQ",
      affect: "positive",
      timeOfDay: null,
      goalId: "itn-1",
    };
    const writtenEvening: CueFingerprint = { ...base, timeOfDay: "evening" };
    const noTime = cueOverlap(writtenEvening, { ...writtenEvening, timeOfDay: null });
    expect(noTime.total).toBe(5); // 话题/在场者/地点/情绪/goalId；时间不比较
    const same = cueOverlap(writtenEvening, { ...writtenEvening });
    expect(same.total).toBe(6);
    expect(same.matched).toBe(6);
    const diff = cueOverlap(writtenEvening, { ...writtenEvening, timeOfDay: "morning" });
    expect(diff.total).toBe(6);
    expect(diff.matched).toBe(5);
  });
});

describe("来源 → 渠道（F199：QQ 的回合不能再写成 gui）", () => {
  it("已知来源映射固定：player→gui、qq_contact_verified→qq、web→web、parasocial→bili", () => {
    expect(channelForSource("player")).toBe("gui");
    expect(channelForSource("qq_contact_verified")).toBe("qq");
    expect(channelForSource("web")).toBe("web");
    expect(channelForSource("parasocial")).toBe("bili");
  });

  it("未知来源保留原值、空来源返回空串（交给 placeForChannel 标 unknown）", () => {
    expect(channelForSource("system")).toBe("system");
    expect(channelForSource("  ")).toBe("");
    expect(placeForChannel(channelForSource(""))).toBe(`${UNKNOWN_PREFIX}no-channel`);
  });

  it("QQ 来源的地点写成 QQ，不再是本机", () => {
    const write = buildEpisodeWrite(input({ source: "qq_contact_verified", channel: channelForSource("qq_contact_verified") }));
    expect(write.fingerprint.place).toBe("QQ");
    expect(write.fingerprint.participants).toEqual(["用户"]);
  });
});

describe("一行摘要", () => {
  it("完整与缺字段两种措辞", () => {
    const complete = buildEpisodeWrite(input({ goalAtTime: "记下来" }));
    expect(describeEpisodeWrite(complete)).toContain("完整");
    const partial = buildEpisodeWrite(input());
    expect(describeEpisodeWrite(partial)).toContain("缺 goalAtTime");
    expect(describeEpisodeWrite(partial)).toContain("episode(conversation/本机/positive)");
  });
});
