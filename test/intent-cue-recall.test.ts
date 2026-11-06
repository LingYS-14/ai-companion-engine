import { describe, expect, it } from "vitest";

import {
  MISSING_FINGERPRINT_RATIO,
  SCORE_FLOOR_MULTIPLIER,
} from "../src/orchestrator/intent/episode-write.js";
import {
  buildRecallCue,
  cueMultiplier,
  describeCueRanking,
  rankByCue,
  readCueFingerprint,
} from "../src/orchestrator/intent/cue-recall.js";

function mem(
  topicDomain: string,
  place: string,
  affect: "positive" | "neutral" | "negative",
  timeOfDay?: "late_night" | "morning" | "afternoon" | "evening",
) {
  return {
    encode_ctx: {
      cue_fingerprint: {
        topicDomain,
        participants: ["用户"],
        place,
        affect,
        ...(timeOfDay === undefined ? {} : { timeOfDay }),
        goalId: null,
      },
    },
  };
}

describe("buildRecallCue：调用方知道什么就拼什么", () => {
  it("渠道 qq → 地点 QQ，渠道 gui → 本机，没给渠道 → unknown:no-channel", () => {
    expect(buildRecallCue({ channel: "qq", valence: 0.5 }).fingerprint.place).toBe("QQ");
    expect(buildRecallCue({ channel: "gui", valence: 0.5 }).fingerprint.place).toBe("本机");
    expect(buildRecallCue({ valence: 0.5 }).fingerprint.place).toBe("unknown:no-channel");
  });

  it("情绪底色按 valence 分桶（与写入同一套阈值）", () => {
    expect(buildRecallCue({ valence: 0.9 }).fingerprint.affect).toBe("positive");
    expect(buildRecallCue({ valence: 0.5 }).fingerprint.affect).toBe("neutral");
    expect(buildRecallCue({ valence: 0.1 }).fingerprint.affect).toBe("negative");
  });

  it("在场者/话题域/意图 id 原样进指纹；空字符串在场者被丢掉", () => {
    const cue = buildRecallCue({
      channel: "qq",
      participants: ["用户", ""],
      valence: 0.9,
      topicDomain: "游戏",
      goalId: "itn-reach_out-1",
    });
    expect(cue.fingerprint.participants).toEqual(["用户"]);
    expect(cue.fingerprint.topicDomain).toBe("游戏");
    expect(cue.fingerprint.goalId).toBe("itn-reach_out-1");
    expect(cue.source).toContain("channel=qq");
  });

  it("没给 goalId → null（不拿空串冒充）", () => {
    expect(buildRecallCue({ channel: "qq", valence: 0.5 }).fingerprint.goalId).toBeNull();
  });

  it("非法 valence 抛 RangeError（静默变 0.5 会掩盖 bug）", () => {
    expect(() => buildRecallCue({ valence: Number.NaN })).toThrow(RangeError);
  });
});

describe("readCueFingerprint：形状不对就当没有", () => {
  it("没有 encode_ctx / 没有 fingerprint → null", () => {
    expect(readCueFingerprint({})).toBeNull();
    expect(readCueFingerprint({ encode_ctx: { channel: "gui" } })).toBeNull();
  });

  it("字段类型不对 → null（不猜、不抛）", () => {
    expect(readCueFingerprint({ encode_ctx: { cue_fingerprint: { topicDomain: 1 } } })).toBeNull();
    expect(
      readCueFingerprint({ encode_ctx: { cue_fingerprint: mem("a", "b", "neutral").encode_ctx.cue_fingerprint } }),
    ).not.toBeNull();
  });
});

describe("cueMultiplier：有指纹才乘，没指纹不罚", () => {
  const cue = buildRecallCue({ channel: "qq", participants: ["用户"], valence: 0.9, topicDomain: "游戏" });

  it("没有指纹 → 乘数 1（旧记忆不因为没记而受罚）", () => {
    const m = cueMultiplier({ encode_ctx: {} }, cue);
    expect(m.multiplier).toBe(MISSING_FINGERPRINT_RATIO);
    expect(m.hasFingerprint).toBe(false);
  });

  it("全部对得上 → 1.0；一个都对不上 → 地板 0.5", () => {
    expect(cueMultiplier(mem("游戏", "QQ", "positive"), cue).multiplier).toBe(1);
    // 一个都对不上：话题/地点/情绪不同，在场者也是别人 → 0/4 → 地板 0.5
    const allOff = {
      encode_ctx: {
        cue_fingerprint: { topicDomain: "学习", participants: ["陌生人"], place: "本机", affect: "negative", goalId: null },
      },
    };
    const off = cueMultiplier(allOff, cue);
    expect(off.multiplier).toBe(SCORE_FLOOR_MULTIPLIER);
    expect(off.ratio).toBe(0);
  });

  it("部分对得上 → 落在 (0.5, 1) 之间", () => {
    const partial = cueMultiplier(mem("游戏", "本机", "neutral"), cue);
    expect(partial.multiplier).toBeGreaterThan(SCORE_FLOOR_MULTIPLIER);
    expect(partial.multiplier).toBeLessThan(1);
  });
});

describe("P2a 收尾：timeOfDay 只两边知道才比较（检索零变化）", () => {
  it("buildRecallCue 传 localHour 才算 timeOfDay；不传为 null", () => {
    expect(buildRecallCue({ channel: "qq", valence: 0.5, localHour: 21 }).fingerprint.timeOfDay).toBe("evening");
    expect(buildRecallCue({ channel: "qq", valence: 0.5, localHour: 3 }).fingerprint.timeOfDay).toBe("late_night");
    expect(buildRecallCue({ channel: "qq", valence: 0.5 }).fingerprint.timeOfDay).toBeNull();
  });

  it("旧五键指纹读回 timeOfDay=null；新指纹读回原值；非法值当没有指纹", () => {
    const old = readCueFingerprint(mem("游戏", "QQ", "positive"));
    expect(old).not.toBeNull();
    expect(old?.timeOfDay).toBeNull();
    const fresh = readCueFingerprint(mem("游戏", "QQ", "positive", "evening"));
    expect(fresh?.timeOfDay).toBe("evening");
    const fiveKeys = { topicDomain: "游戏", participants: ["用户"], place: "QQ", affect: "positive", goalId: null };
    expect(readCueFingerprint({ encode_ctx: { cue_fingerprint: { ...fiveKeys, timeOfDay: "dawn" } } })).toBeNull();
    expect(readCueFingerprint({ encode_ctx: { cue_fingerprint: { ...fiveKeys, timeOfDay: 21 } } })).toBeNull();
  });

  it("当前 cue 不知道时间：新记忆的时间维度不参与（乘数与旧记忆逐位相同）", () => {
    const cue = buildRecallCue({ channel: "qq", participants: ["用户"], valence: 0.9, topicDomain: "游戏" });
    const fresh = cueMultiplier(mem("游戏", "QQ", "positive", "evening"), cue);
    const old = cueMultiplier(mem("游戏", "QQ", "positive"), cue);
    expect(fresh.multiplier).toBe(old.multiplier);
    expect(fresh.ratio).toBe(old.ratio);
    expect(fresh.multiplier).toBe(1);
  });

  it("两边都知道：同段满分；不同段少一个字段（4/5）", () => {
    const cue = buildRecallCue({ channel: "qq", participants: ["用户"], valence: 0.9, topicDomain: "游戏", localHour: 21 });
    const same = cueMultiplier(mem("游戏", "QQ", "positive", "evening"), cue);
    expect(same.ratio).toBe(1);
    const diff = cueMultiplier(mem("游戏", "QQ", "positive", "morning"), cue);
    expect(diff.ratio).toBeCloseTo(0.8, 10);
  });
});

describe("rankByCue：只重排，不改原数组", () => {
  const cue = buildRecallCue({ channel: "qq", participants: ["用户"], valence: 0.9, topicDomain: "游戏" });
  const memories = new Map([
    ["hit", mem("游戏", "QQ", "positive")],
    ["miss", mem("学习", "本机", "negative")],
    ["nofp", { encode_ctx: {} }],
  ]);
  const rows = [
    { id: "miss", score: 0.8 },
    { id: "nofp", score: 0.5 },
    { id: "hit", score: 0.4 },
  ];

  it("贴得上的记忆会因为乘数排到前面，但原始分数仍保留在 baseScore 里", () => {
    const ranked = rankByCue(rows, memories, cue);
    // miss 0.8×0.625=0.5、nofp 0.5×1=0.5（同分按原顺序）、hit 0.4×1=0.4
    expect(ranked.map((r) => r.id)).toEqual(["miss", "nofp", "hit"]);
    expect(ranked[0]?.baseScore).toBe(0.8);
    expect(ranked[0]?.score).toBeCloseTo(0.5, 6);
    expect(ranked[2]?.score).toBeCloseTo(0.4, 6);
  });

  it("同分保持原顺序（稳定排序）", () => {
    const tie = [
      { id: "miss", score: 0.5 },
      { id: "nofp", score: 0.5 },
    ];
    const ranked = rankByCue(tie, memories, cue);
    // 原始同分时保持原顺序（稳定排序）；乘数不同时才是乘数说了算
    expect(ranked.map((r) => r.id)).toEqual(["nofp", "miss"]);
  });

  it("不修改传入的数组", () => {
    const copy = rows.map((r) => ({ ...r }));
    rankByCue(rows, memories, cue);
    expect(rows).toEqual(copy);
  });

  it("一行诊断里能看到地板与命中数", () => {
    const line = describeCueRanking(rankByCue(rows, memories, cue));
    expect(line).toContain("地板=0.5");
    expect(line).toContain("fp=2/3");
  });
});
