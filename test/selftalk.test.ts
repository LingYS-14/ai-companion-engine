import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import {
  fallbackSelfTalk,
  pickSelfTalkSeeds,
  planSelfTalk,
  relateSelfTalk,
  selfTalkEffects,
  type SelfTalkSeed,
} from "../src/maintenance/selftalk.js";
import { SelftalkJournal } from "../src/maintenance/selftalk-journal.js";
import { humanize, SELF_TALK_TOPIC_COOLDOWN_MS, topicWasSpokenRecently } from "../src/maintenance/selftalk-voice.js";
import { runSelfTalk, selfTalkIntervalMs, seedsFor, selfTalkSystem } from "../src/maintenance/selftalk-runner.js";

const cfg = loadConfig();

const seed = (over: Partial<SelfTalkSeed> = {}): SelfTalkSeed => ({
  id: over.id ?? "m1",
  tags: over.tags ?? ["花", "窗台"],
  vividness: over.vividness ?? 0.6,
  unresolved: over.unresolved ?? 0.1,
  tier: over.tier ?? "hot",
  valence: over.valence ?? 0.6,
  ...(over.gist === undefined ? {} : { gist: over.gist }),
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-selftalk-"));
  dirs.push(dir);
  return dir;
}

describe("planSelfTalk", () => {
  it("冷记忆不进种子；hot 优先于 warm；最多 SELFTALK_MAX_SEEDS 条", () => {
    const plan = planSelfTalk({
      seeds: [
        seed({ id: "cold", tier: "cold", vividness: 1 }),
        seed({ id: "warm", tier: "warm", vividness: 0.5 }),
        seed({ id: "hot", tier: "hot", vividness: 0.4 }),
        seed({ id: "hot2", tier: "hot", vividness: 0.55 }),
        seed({ id: "hot3", tier: "hot", vividness: 0.1 }),
      ],
      mood: { valence: 0.5, arousal: 0.4 },
      cfg,
    });
    expect(plan.seeds).not.toContain("cold");
    expect(plan.seeds.length).toBeLessThanOrEqual(3);
    expect(plan.seeds[0]).toBe("hot2");
    expect(plan.kind).toBe("replay");
    expect(plan.topics.length).toBeGreaterThan(0);
  });

  it("没有可用材料时走 wander，且不编造话题", () => {
    const plan = planSelfTalk({ seeds: [seed({ tier: "cold" })], mood: { valence: 0.5, arousal: 0.5 }, cfg });
    expect(plan.kind).toBe("wander");
    expect(plan.seeds).toEqual([]);
    expect(plan.topics).toEqual([]);
  });

  it("未解决度高时定 reflect", () => {
    const plan = planSelfTalk({ seeds: [seed({ unresolved: 0.8 })], mood: { valence: 0.3, arousal: 0.6 }, cfg });
    expect(plan.kind).toBe("reflect");
    expect(plan.frame).toContain("情绪偏低");
  });
});

describe("relateSelfTalk", () => {
  const seeds = [seed({ tags: ["花", "窗台"] })];
  it("命中 tag → related", () => {
    expect(relateSelfTalk("窗台上的那枝花又蔫了一点。", seeds)).toBe("related");
  });
  it("有材料但没碰到 → divergent", () => {
    expect(relateSelfTalk("游戏新版本好像快开了。", seeds)).toBe("divergent");
  });
  it("没有材料 → unrelated", () => {
    expect(relateSelfTalk("随便说说。", [])).toBe("unrelated");
  });
});

describe("selfTalkEffects", () => {
  it("related：鲜活度↑、未解决松动、可进巩固", () => {
    const fx = selfTalkEffects("related", [seed({ unresolved: 0.6 })], { valence: 0.6, arousal: 0.5 }, cfg);
    expect(fx.vividness[0]?.[1]).toBeGreaterThan(0);
    expect(fx.unresolvedRelief).toBeGreaterThan(0);
    expect(fx.consolidate).toBe(true);
    expect(fx.interference).toBe(false);
  });

  it("divergent：鲜活度↓、有干扰代价", () => {
    const fx = selfTalkEffects("divergent", [seed()], { valence: 0.6, arousal: 0.5 }, cfg);
    expect(fx.vividness[0]?.[1]).toBeLessThan(0);
    expect(fx.interference).toBe(true);
    expect(fx.consolidate).toBe(false);
  });

  it("unrelated：不产生记忆效应", () => {
    const fx = selfTalkEffects("unrelated", [], { valence: 0.6, arousal: 0.5 }, cfg);
    expect(fx.vividness).toEqual([]);
    expect(fx.rewrite).toBeUndefined();
  });

  it("再巩固：心境与当初底色差得够远且唤醒度够高时，改写一条情绪底色且 ≤0.2", () => {
    const fx = selfTalkEffects("related", [seed({ valence: 0.2 })], { valence: 0.9, arousal: 0.7 }, cfg);
    expect(fx.rewrite?.id).toBe("m1");
    expect(Math.abs(fx.rewrite?.valenceShift ?? 0)).toBeLessThanOrEqual(0.2);
    const shy = selfTalkEffects("related", [seed({ valence: 0.2 })], { valence: 0.9, arousal: 0.1 }, cfg);
    expect(shy.rewrite).toBeUndefined();
  });
});

describe("fallbackSelfTalk / interval", () => {
  it("降级台词按关系类型给出，不说指令话", () => {
    const replay = fallbackSelfTalk({ kind: "replay", seeds: ["a"], frame: "", topics: ["花"], maxSeeds: 3 });
    expect(replay).toContain("花");
    const wander = fallbackSelfTalk({ kind: "wander", seeds: [], frame: "", topics: [], maxSeeds: 3 });
    expect(wander).toContain("坐着");
  });

  it("间隔来自注册表并被夹在 5 分钟–3 小时", () => {
    const ms = selfTalkIntervalMs(cfg);
    expect(ms).toBeGreaterThanOrEqual(300_000);
    expect(ms).toBeLessThanOrEqual(10_800_000);
  });

  it("selftalk 默认间隔是 3 小时（F313 用户裁决降频）", () => {
    expect(selfTalkIntervalMs(cfg)).toBe(10_800_000);
  });
});

describe("SelftalkJournal", () => {
  it("落盘后可重开，超过 cap 只留最近的", () => {
    const path = join(tmp(), "journal.json");
    const journal = SelftalkJournal.open(path);
    for (let i = 0; i < 505; i += 1) {
      journal.append(
        {
          id: `st_${String(i)}`,
          at: i,
          kind: "replay",
          seeds: [],
          text: `第${String(i)}句`,
          relation: "unrelated",
          vividness: [],
          unresolvedRelief: 0,
          rewrite: undefined,
          source: "autonomy",
        },
        cfg,
      );
    }
    expect(journal.size()).toBe(500);
    const reopened = SelftalkJournal.open(path);
    expect(reopened.size()).toBe(500);
    expect(reopened.all()[0]?.text).toBe("第5句");
  });

  it("说出口的那条回填 spoken 标记，重开后仍在；空日志返回 false", () => {
    const path = join(tmp(), "spoken.json");
    const journal = SelftalkJournal.open(path);
    expect(journal.markLastSpoken()).toBe(false);
    journal.append(
      {
        id: "st_1",
        at: 1,
        kind: "reflect",
        seeds: [],
        text: "在想晚上那杯茶。",
        relation: "related",
        vividness: [],
        unresolvedRelief: 0,
        rewrite: undefined,
        source: "autonomy",
      },
      cfg,
    );
    expect(journal.markLastSpoken()).toBe(true);
    const reopened = SelftalkJournal.open(path);
    expect(reopened.all()[0]?.spoken).toBe(true);
  });

  it("坏文件不抛错，从空日志继续", () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(path, "{not json", "utf8");
    expect(SelftalkJournal.open(path).size()).toBe(0);
  });
});

describe("runSelfTalk", () => {
  interface FakeRec {
    id: string;
    tags: string[];
    vividness: number;
    unresolved_score: number;
    encode_state: Record<string, number>;
    last_accessed: number;
    access_count: number;
    base_activation: number;
    forgotten: boolean;
  }

  function fakeStore(recs: FakeRec[]) {
    const map = new Map(recs.map((r) => [r.id, r]));
    const touched: string[] = [];
    return {
      touched,
      map,
      store: {
        active: () => [...map.values()].filter((r) => !r.forgotten) as never,
        get: (id: string) => map.get(id) as never,
        mutate: (id: string, patch: Partial<FakeRec>) => {
          const rec = map.get(id);
          if (rec === undefined) return undefined;
          const next = { ...rec, ...patch };
          map.set(id, next);
          return next as never;
        },
        touch: (id: string) => {
          touched.push(id);
          return map.get(id) as never;
        },
      },
    };
  }

  it("related：抬鲜活度、松未解决、touch 一次、写日志", async () => {
    const dir = tmp();
    const { store, map, touched } = fakeStore([
      {
        id: "m1",
        tags: ["花"],
        vividness: 0.5,
        unresolved_score: 0.6,
        encode_state: { valence: 0.3 },
        last_accessed: 0,
        access_count: 1,
        base_activation: 0,
        forgotten: false,
      },
    ]);
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 1_000_000,
      mood: { valence: 0.9, arousal: 0.7 },
      generate: () => Promise.resolve("窗台那枝花，今天好像更蔫了。"),
    });
    expect(out.relation).toBe("related");
    expect(map.get("m1")?.vividness).toBeGreaterThan(0.5);
    expect(map.get("m1")?.unresolved_score).toBeLessThan(0.6);
    expect(touched).toEqual(["m1"]);
    expect(journal.size()).toBe(1);
    // 再巩固：情绪底色被抬高（≤0.2）且写进 encode_state
    expect(map.get("m1")?.encode_state.valence).toBeGreaterThan(0.3);
    expect(map.get("m1")?.encode_state.valence).toBeLessThanOrEqual(0.5);
  });

  it("模型生成时置 generated：跑偏的言语吃干扰代价，且不标 degraded（F74）", async () => {
    const dir = tmp();
    const { store, map } = fakeStore([
      {
        id: "m1",
        tags: ["花"],
        vividness: 0.5,
        unresolved_score: 0.6,
        encode_state: { valence: 0.5 },
        last_accessed: 0,
        access_count: 1,
        base_activation: 0,
        forgotten: false,
      },
    ]);
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 3_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      generate: () => Promise.resolve("今天的云像一艘船，慢慢开走了。"),
    });
    // 与种子（花/窗台）无关 → 必须判成跑偏，而不是被"没生成"的旧逻辑强行判 related
    expect(out.relation).not.toBe("related");
    expect(out.entry.degraded).toBeUndefined();
    // 跑偏：不抬鲜活度，反而掉一点（干扰代价）
    expect(map.get("m1")?.vividness).toBeLessThanOrEqual(0.5);
  });

  it("没有模型/生成失败时日志标 degraded=true（模板不进巩固）", async () => {
    const dir = tmp();
    const { store } = fakeStore([]);
    const journal = SelftalkJournal.open(join(dir, "j2.json"));
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 4_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      generate: () => Promise.reject(new Error("boom")),
    });
    expect(out.entry.degraded).toBe(true);
    expect(journal.recent(1)[0]?.degraded).toBe(true);
  });

  it("生成失败时降级，不中断、不写空日志", async () => {
    const dir = tmp();
    const { store } = fakeStore([]);
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 2_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      generate: () => Promise.reject(new Error("boom")),
    });
    expect(out.written).toBe(true);
    expect(out.text.length).toBeGreaterThan(0);
    expect(journal.size()).toBe(1);
  });

  it("重复的句子不再写、不再说（F80：日记曾连续 5 条一字不差）", async () => {
    const dir = tmp();
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    journal.append(
      {
        id: "st_0",
        at: 1,
        kind: "reflect",
        seeds: [],
        text: "窗台那枝花，今天好像更蔫了。",
        relation: "related",
        vividness: [],
        unresolvedRelief: 0,
        rewrite: undefined,
        source: "autonomy",
      },
      cfg,
    );
    const { store } = fakeStore([]);
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 2_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      generate: () => Promise.resolve("窗台那枝花，今天好像更蔫了。"),
    });
    expect(out.written).toBe(false);
    expect(out.text).toBe("");
    expect(journal.size()).toBe(1);
  });

  it("seedsFor 把冷记忆标成 cold", async () => {
    const now = 200 * 3_600_000;
    const { store } = fakeStore([
      {
        id: "old",
        tags: ["旧事"],
        vividness: 0.5,
        unresolved_score: 0,
        encode_state: {},
        last_accessed: 0,
        access_count: 1,
        base_activation: 0,
        forgotten: false,
      },
    ]);
    const seeds = seedsFor(store, now, cfg);
    expect(seeds[0]?.tier).toBe("cold");
  });
});

describe("isRepeatText", () => {
  it("同一句、或改个标点/换几个字但高度相似 → 判重复", async () => {
    const { isRepeatText } = await import("../src/maintenance/selftalk-runner.js");
    expect(isRepeatText("窗台那枝花，今天好像更蔫了。", ["窗台那枝花，今天好像更蔫了！"])).toBe(true);
    expect(isRepeatText("窗台那枝花，今天好像更蔫了。", ["窗台那枝花今天好像蔫了点。"])).toBe(true);
    expect(isRepeatText("今天的云像一艘船。", ["窗台那枝花今天好像更蔫了。"])).toBe(false);
    expect(isRepeatText("", [])).toBe(true);
  });
});

describe("内部言语的材料：不能只有标签", () => {
  it("frame 里带记忆正文，模型才有具体的可说", () => {
    const plan = planSelfTalk({
      seeds: [seed({ id: "m1", tags: ["conversation"], gist: "我回来了，刚才去楼下走了走。" })],
      mood: { valence: 0.5, arousal: 0.4 },
      cfg,
    });
    expect(plan.frame).toContain("我回来了，刚才去楼下走了走。");
    expect(plan.frame).toContain("材料");
  });

  it("没有中文标签时话题退到正文，而不是「刚才那件小事」", () => {
    const plan = planSelfTalk({
      seeds: [seed({ id: "m1", tags: ["conversation"], gist: "你看我今天拍的花 像不像你？" })],
      mood: { valence: 0.5, arousal: 0.4 },
      cfg,
    });
    expect(plan.topics[0]).not.toBe("刚才那件小事");
    expect(plan.topics[0]).toContain("你看我今天拍的花");
  });

  it("短到没有材料的记忆（在吗/嗯）不当种子", () => {
    const store = {
      active: () => [
        { id: "m1", content: "在吗", tags: [], vividness: 0.9, unresolved_score: 0.1, encode_state: { valence: 0.5 }, last_accessed: 0, base_activation: 0 },
        { id: "m2", content: "我回来了，刚才去楼下走了走。", tags: [], vividness: 0.5, unresolved_score: 0.1, encode_state: { valence: 0.5 }, last_accessed: 0, base_activation: 0 },
      ],
    };
    const seeds = seedsFor(store as never, 0, cfg);
    expect(seeds.map((s) => s.id)).toEqual(["m2"]);
    expect(seeds[0]?.gist).toBe("我回来了，刚才去楼下走了走。");
  });
});

describe("跑偏判定：用材料但换了说法不算跑偏", () => {
  it("正文二元组命中 → related（不再每轮吃干扰代价）", () => {
    const seeds = [
      seed({ id: "m1", tags: ["conversation"], gist: "今天也想跟你多聊一会儿，有你在真好" }),
      seed({ id: "m2", tags: ["聊天"], gist: "我回来了，刚才去楼下走了走。" }),
    ];
    const relation = relateSelfTalk("今天也想跟你多聊一会儿，有你在真好。我从楼下走了走回来。", seeds);
    expect(relation).toBe("related");
  });

  it("完全无关的言语仍是 divergent", () => {
    const seeds = [seed({ id: "m1", tags: ["flower"], gist: "我回来了，刚才去楼下走了走。" })];
    expect(relateSelfTalk("今天云很多，风也凉。", seeds)).toBe("divergent");
  });
});

describe("种子轮换（不要每半小时重播同一个念头）", () => {
  const mood = (): { valence: number } => ({ valence: 0.6 });
  const testCfg = (): typeof cfg => cfg;
  it("最近想过的那条先让路，选到另一条", () => {
    const a = seed({ id: "m_a", tags: ["花"], vividness: 0.9 });
    const b = seed({ id: "m_b", tags: ["雨"], vividness: 0.5 });
    const plan = planSelfTalk({ seeds: [a, b], mood: mood(), cfg, avoid: ["m_a"] });
    expect(plan.seeds[0]).toBe("m_b");
  });

  it("全都被想过时按最久未用轮换，不再按鲜活度重播（F311）", () => {
    const cfg = testCfg();
    const a = seed({ id: "m_a", tags: ["花"], vividness: 0.1 });
    const b = seed({ id: "m_b", tags: ["雨"], vividness: 0.5 });
    const c = seed({ id: "m_c", tags: ["风"], vividness: 0.9 });
    const plan = planSelfTalk({
      seeds: [a, b, c],
      mood: mood(),
      cfg,
      avoid: ["m_a", "m_b", "m_c"],
      recent: ["m_c", "m_b", "m_a"],
    });
    expect(plan.kind).not.toBe("wander");
    expect(plan.pick).toBe("rotate");
    expect(plan.seeds).toEqual(["m_c", "m_b", "m_a"]);
  });
});

describe("做不到的承诺不出口", () => {
  it("「这张图给你」这类话被 humanize 拦下", () => {
    expect(humanize("用户，我今天拍的花，你看像不像你？这张图给你，你认得吗？")).toBeNull();
    expect(humanize("等下我拍张照，稍后发你照片看。")).toBeNull();
  });

  it("「给你看看」这种不含交付承诺的说法照常放行", () => {
    expect(humanize("窗台那枝花又开了，给你看看也好，不过也就那样。")).not.toBeNull();
  });
});

describe("话题用正文而不是标签", () => {
  it("正文与标签都在时，frame 念正文，不念「聊天」这种分类名", () => {
    const cfg = loadConfig();
    const plan = planSelfTalk({
      seeds: [
        { id: "m1", tags: ["聊天"], vividness: 0.8, unresolved: 0.2, tier: "hot", gist: "在吗？今天有点累，想跟你说说话。" },
      ],
      mood: { valence: 0.5, arousal: 0.4, pressure: 0.2, rumination: 0.1, affection: 0.4 },
      cfg,
    });
    expect(plan.frame).toContain("今天有点累");
    expect(plan.frame).not.toContain("「聊天」");
  });
});

describe("同话题冷却", () => {
  it("同一个种子最近说过 → true；换种子或超过 6 小时 → false", () => {
    const spoken = [{ seeds: ["m1"], at: 1000 }];
    expect(topicWasSpokenRecently(["m1"], spoken, 2000)).toBe(true);
    expect(topicWasSpokenRecently(["m2"], spoken, 2000)).toBe(false);
    expect(topicWasSpokenRecently(["m1"], spoken, 1000 + SELF_TALK_TOPIC_COOLDOWN_MS)).toBe(false);
    expect(topicWasSpokenRecently([], spoken, 2000)).toBe(false);
  });
});

/**
 * F92 根因回归：审计（tools/audit/check-voice.mjs）按 24h 窗口扫日记，
 * 而旧写口的抑制只看「最近 6 条」——在 ~40 分钟一轮的节奏下只覆盖约 4 小时。
 * 真事故：同一句「你看我今天拍的花，像不像你？」在 07:18:40 与 21:38:52 各写了一条，
 * 中间隔着约 20 条别的念头，于是 gate 的第 5 道 check-voice 报 repeat。
 */
describe("写口去重：同一句不会进日记两次", () => {
  const entryAt = (text: string, at: number) => ({
    id: `st_${String(at)}`,
    at,
    kind: "replay" as const,
    seeds: [] as string[],
    text,
    relation: "unrelated" as const,
    vividness: [] as [string, number][],
    unresolvedRelief: 0,
    rewrite: undefined,
    source: "autonomy" as const,
  });
  const FILLERS = [
    "风把窗帘吹起来又落下。",
    "杯子里的茶凉了，我没去热。",
    "楼下的猫今天没来，台阶上空的。",
    "云压得低，像要下雨又没下。",
    "路灯亮的时候我才发现天黑了。",
    "书翻到一半，忘了前面讲了什么。",
    "海那边的事，我大概想不明白。",
  ];

  it("同一文本连写两次，日记只多一条（第二次被挡下并返回 false）", () => {
    const journal = SelftalkJournal.open(join(tmp(), "dedup.json"));
    expect(journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg)).toBe(true);
    expect(journal.append(entryAt("你看我今天拍的花，像不像你？", 1_300_000), cfg)).toBe(false);
    expect(journal.size()).toBe(1);
  });

  it("换标点、改几个字的近重复也挡（Dice ≥ 0.65）", () => {
    const journal = SelftalkJournal.open(join(tmp(), "near.json"));
    journal.append(entryAt("窗台那枝花，今天好像更蔫了。", 1_000_000), cfg);
    expect(journal.wouldRepeat("窗台那枝花今天好像蔫了点。", 1_300_000)).toBe(true);
    expect(journal.wouldRepeat("今天的云像一艘船，慢慢开走了。", 1_300_000)).toBe(false);
  });

  it("阈值是 0.65：改几个字的近重复（实测 Dice 0.667）也挡下（F311）", () => {
    const journal = SelftalkJournal.open(join(tmp(), "threshold.json"));
    journal.append(entryAt("用户回来啦。AI在玩呢，周末嘛，当然要玩个痛快～", 1_000_000), cfg);
    // 真实日记里的一对（Dice 0.667）：旧阈值 0.8 会放行，0.65 拦下
    expect(journal.wouldRepeat("你回来啦～AI在玩呢，周末嘛。", 1_300_000)).toBe(true);
  });

  it("14 小时后再说同一句也算重复：窗口是 24h 时间窗，不是最近几条", () => {
    const journal = SelftalkJournal.open(join(tmp(), "window.json"));
    journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg);
    for (const [i, text] of FILLERS.entries()) {
      journal.append(entryAt(text, 1_000_000 + (i + 1) * 2_400_000), cfg);
    }
    expect(journal.size()).toBe(8);
    // 14 小时后（中间隔着 7 条别的念头）：旧的「最近 6 条」窗口根本看不见第一句
    expect(journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000 + 14 * 3_600_000), cfg)).toBe(false);
    expect(journal.size()).toBe(8);
  });

  it("超过 24h 的同一句不再算重复：窗口有边界，不是永久封禁", () => {
    const journal = SelftalkJournal.open(join(tmp(), "expire.json"));
    journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg);
    expect(journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000 + 24 * 3_600_000 + 1), cfg)).toBe(true);
    expect(journal.size()).toBe(2);
  });

  it("runSelfTalk 走的是同一扇门：14 小时后同一句不再写（接线回归）", async () => {
    const journal = SelftalkJournal.open(join(tmp(), "runner.json"));
    journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg);
    for (const [i, text] of FILLERS.entries()) {
      journal.append(entryAt(text, 1_000_000 + (i + 1) * 2_400_000), cfg);
    }
    const store = {
      active: () => [],
      get: () => undefined,
      mutate: () => undefined,
      touch: () => undefined,
    } as unknown as Parameters<typeof runSelfTalk>[0]["store"];
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 1_000_000 + 14 * 3_600_000,
      mood: { valence: 0.5, arousal: 0.5 },
      generate: () => Promise.resolve("你看我今天拍的花，像不像你？"),
    });
    expect(out.written).toBe(false);
    expect(journal.size()).toBe(8);
  });
});

describe("pickSelfTalkSeeds：选材去同质", () => {
  it("recent 里出现越多越降权（不排除，只是让位）", () => {
    const hot = seed({ id: "hot_a", vividness: 0.9, unresolved: 0 });
    const mild = seed({ id: "mild_b", vividness: 0.5, unresolved: 0 });
    const picked = pickSelfTalkSeeds({
      seeds: [hot, mild],
      maxSeeds: 2,
      recent: ["hot_a", "hot_a", "hot_a"],
    });
    expect(picked.reason).toBe("fresh");
    expect(picked.seeds[0]?.id).toBe("mild_b");
  });

  it("全都被想过时不按鲜活度回落，按最久未用轮换", () => {
    const a = seed({ id: "a", vividness: 0.1, unresolved: 0 });
    const b = seed({ id: "b", vividness: 0.5, unresolved: 0 });
    const c = seed({ id: "c", vividness: 0.9, unresolved: 0 });
    const picked = pickSelfTalkSeeds({
      seeds: [a, b, c],
      maxSeeds: 3,
      avoid: ["a", "b", "c"],
      recent: ["a", "b", "c"],
    });
    expect(picked.reason).toBe("rotate");
    expect(picked.seeds.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("没有材料时返回 none，不硬凑", () => {
    const picked = pickSelfTalkSeeds({ seeds: [seed({ tier: "cold" })], maxSeeds: 2 });
    expect(picked.reason).toBe("none");
    expect(picked.seeds).toEqual([]);
  });
});

describe("frame 与提示词：材料是方向，不是照抄", () => {
  it("frame 带开口角度与「不要照抄」的材料说明", () => {
    const plan = planSelfTalk({
      seeds: [seed({ gist: "窗台那枝花今天更蔫了" })],
      mood: { valence: 0.5, arousal: 0.4 },
      cfg,
      variant: 1,
    });
    expect(plan.pick).toBe("fresh");
    expect(typeof plan.angle).toBe("string");
    expect(plan.frame).toContain("这一轮这样开口：");
    expect(plan.frame).toContain("不是给你照抄的句子");
  });

  it("系统提示词要求 40–80 字、换开头、不逐字重复材料", () => {
    const sys = selfTalkSystem("AI助手");
    expect(sys).toContain("40 到 80 字");
    expect(sys).toContain("不要逐字重复材料里的说法");
    expect(sys).toContain("不要总用「你回来了」「用户」「今天」起头");
    expect(sys).toContain("现在是没人跟你说话的时候");
  });
});

describe("生成端去重：近重复先重生成，两次仍像才跳过", () => {
  const entryAt = (text: string, at: number) => ({
    id: `st_${String(at)}`,
    at,
    kind: "replay" as const,
    seeds: [] as string[],
    text,
    relation: "unrelated" as const,
    vividness: [] as [string, number][],
    unresolvedRelief: 0,
    rewrite: undefined,
    source: "autonomy" as const,
  });
  const noopStore = {
    active: () => [],
    get: () => undefined,
    mutate: () => undefined,
    touch: () => undefined,
  } as unknown as Parameters<typeof runSelfTalk>[0]["store"];

  it("第一次撞近重复 → 追加重生成指令，第二次采纳", async () => {
    const journal = SelftalkJournal.open(join(tmp(), "regen.json"));
    journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg);
    const calls: { role: string; content: string }[][] = [];
    const logs: string[] = [];
    const out = await runSelfTalk({
      store: noopStore,
      journal,
      cfg,
      now: 2_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      log: (line) => logs.push(line),
      generate: (messages) => {
        calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return Promise.resolve(
          calls.length === 1 ? "你看我今天拍的花，像不像你？" : "窗外风把树摇得很响，我想起你说过怕冷。",
        );
      },
    });
    expect(calls.length).toBe(2);
    expect(calls[0]?.length).toBe(2);
    expect(calls[1]?.length).toBe(3);
    expect(calls[1]?.[2]?.content).toContain("太像了");
    expect(logs.some((l) => l.includes("近重复：换开头重生成"))).toBe(true);
    expect(out.written).toBe(true);
    expect(journal.size()).toBe(2);
  });

  it("两次都近重复 → 跳过这一轮：不写日记、不落效应", async () => {
    const journal = SelftalkJournal.open(join(tmp(), "skip.json"));
    journal.append(entryAt("你看我今天拍的花，像不像你？", 1_000_000), cfg);
    const logs: string[] = [];
    const out = await runSelfTalk({
      store: noopStore,
      journal,
      cfg,
      now: 2_000_000,
      mood: { valence: 0.5, arousal: 0.5 },
      log: (line) => logs.push(line),
      generate: () => Promise.resolve("你看我今天拍的花，像不像你？"),
    });
    expect(out.written).toBe(false);
    expect(out.skipReason).toBe("repeat");
    expect(out.text).toBe("");
    expect(journal.size()).toBe(1);
    expect(logs.some((l) => l.includes("跳过：与最近 24h 的话高度相似"))).toBe(true);
  });
});
