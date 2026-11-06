import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { initialSState } from "../src/engine/state.js";
import { createStandalonePort } from "../src/autonomy/standalone.js";
import type { FetchLike, LlmConfig } from "../src/autonomy/llm.js";
import { SelftalkJournal } from "../src/maintenance/selftalk-journal.js";
import { pendingReview, raiseReview } from "../src/autonomy/review.js";
import { loadUsage } from "../src/autonomy/usage.js";

const cfg = loadConfig();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-standalone-"));
  dirs.push(dir);
  return dir;
}

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
  content: string;
}

function fakeRuntime(recs: FakeRec[] = []) {
  const map = new Map(recs.map((r) => [r.id, { ...r }]));
  const state = { ...initialSState(), valence: 0.6, arousal: 0.5 };
  const calls = { advance: 0, consolidate: 0 };
  const runtime = {
    advance: (h: number) => {
      calls.advance += 1;
      return { steps: Math.round(h * 12), faded: 0 };
    },
    consolidate: () => {
      calls.consolidate += 1;
      return { clusters: 1, written: 1, accepted: ["t1"], rejected: [] };
    },
    state,
    memoryStore: () => ({
      active: () => [...map.values()].filter((r) => !r.forgotten),
      get: (id: string) => map.get(id),
      mutate: (id: string, patch: Partial<FakeRec>) => {
        const rec = map.get(id);
        if (rec === undefined) return undefined;
        Object.assign(rec, patch);
        return rec;
      },
      touch: (id: string) => map.get(id),
    }),
  };
  return { runtime: runtime as never, calls, map };
}

function rec(over: Partial<FakeRec> = {}): FakeRec {
  return {
    id: "m1",
    tags: ["花"],
    vividness: 0.5,
    unresolved_score: 0.2,
    encode_state: { valence: 0.5 },
    last_accessed: 0,
    access_count: 1,
    base_activation: 0,
    forgotten: false,
    content: "窗台的花",
    ...over,
  };
}

const NOW = Date.parse("2026-10-29T03:00:00+08:00"); // 谷时

describe("standalone port", () => {
  it("advance/consolidate 走 runtime；proactive 在 QQ 关闭时永远不放行", async () => {
    const { runtime, calls } = fakeRuntime();
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
    });
    expect(port.advance(0.5).ticks).toBe(6);
    expect(calls.advance).toBe(1);
    expect(await port.consolidate()).toEqual({ accepted: 1, rejected: 0 });
    expect((await port.proactive()).opened).toBe(false);
  });


  it("proactive：闸门没过（没生成台词）不记账，真生成才记一次", async () => {
    const { runtime } = fakeRuntime();
    const usageFile = join(tmp(), "usage.json");
    const off = await createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile,
      proactiveImpl: () => ({ opened: false, reason: "gap", generated: false }),
    }).proactive();
    expect(off.opened).toBe(false);
    expect(loadUsage(usageFile, NOW)).toEqual([]);

    const on = await createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile,
      proactiveImpl: () => ({ opened: true, reason: "ok", generated: true }),
    }).proactive();
    expect(on.opened).toBe(true);
    expect(loadUsage(usageFile, NOW)).toEqual([NOW]);
  });

  it("proactive：已有一小时上限内的调用时直接跳过，不生成也不记账", async () => {
    const { runtime } = fakeRuntime();
    const usageFile = join(tmp(), "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    let called = 0;
    const out = await createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile,
      proactiveImpl: () => {
        called += 1;
        return { opened: true, reason: "ok", generated: true };
      },
    }).proactive();
    expect(called).toBe(0);
    expect(out.opened).toBe(false);
    expect(out.reason).toMatch(/额度不够|hourly calls/);
  });

  it("裁决 A：这一格留给开口——已用 5/6 时主动开口仍可以跑（后台让路）", async () => {
    const { runtime } = fakeRuntime();
    const dir = tmp();
    const usageFile = join(dir, "usage.json");
    // 谷时（北京 03:00）上限 60/h；账本里已有 59 次 → 只剩 1 格，正是留给开口的那一格
    const peak = Date.parse("2026-10-29T19:00:00Z");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 59 }, (_, i) => peak - i * 1000) }));
    let called = 0;
    const out = await createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => peak,
      localHour: () => 20,
      tzOffsetMinutes: 0,
      usageFile,
      proactiveImpl: () => {
        called += 1;
        return { opened: true, reason: "ok", generated: true };
      },
    }).proactive();
    expect(called).toBe(1);
    expect(out.opened).toBe(true);
    expect(loadUsage(usageFile, peak).length).toBe(60);
  });

  it("proactive：有审核票据时不生成", async () => {
    const { runtime } = fakeRuntime();
    const dir = tmp();
    const reviewFile = join(dir, "autonomy-review.json");
    // 账本里也得真的超速，否则「回落自解」会立刻把票据解除（那是它的设计）
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    raiseReview(reviewFile, { at: NOW, reason: "test", calls: 61, maxCalls: 60 }, NOW);
    let called = 0;
    const out = await createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile: join(dir, "usage.json"),
      reviewFile,
      proactiveImpl: () => {
        called += 1;
        return { opened: true, reason: "ok", generated: true };
      },
    }).proactive();
    expect(called).toBe(0);
    expect(out.reason).toMatch(/审核/);
  });

  it("选的是谷时；第一次自言自语就落日志，间隔内再来一次被跳过", async () => {
    const { runtime } = fakeRuntime([rec()]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const port = createStandalonePort({ runtime, cfg, journal, now: () => NOW, localHour: () => 3 });
    const first = await port.selftalk();
    expect(port.pacing()?.phase).toBe("offpeak");
    expect(first.relation).toBe("unrelated"); // 没有模型 → 降级模板，不与材料相关
    expect(journal.size()).toBe(1);
    const second = await port.selftalk();
    expect(second.kind).toBe("wander");
    expect(journal.size()).toBe(1);
  });

  it("有 llm 时调用 chatComplete，并把调用计入频率（超限后退避）", async () => {
    const { runtime } = fakeRuntime([rec({ last_accessed: NOW })]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "窗台的花，又想起它了。" } }] })),
      });
    };
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      llm,
      fetchImpl,
    });
    const out = await port.selftalk();
    expect(calls).toBe(1);
    expect(out.relation).toBe("related");
    expect(journal.recent(1)[0]?.text).toContain("窗台");
  });

  it("两次生成都与最近 24h 的话高度相似时：不写日记、不发送，且落 skipReason 日志（F315 可观测）", async () => {
    const { runtime } = fakeRuntime([rec({ last_accessed: NOW })]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const text = "窗台那枝花，今天好像更蔫了。";
    journal.append(
      {
        id: "st_seed",
        at: NOW - 3_600_000,
        kind: "replay",
        seeds: [],
        text,
        relation: "unrelated",
        vividness: [],
        unresolvedRelief: 0,
        rewrite: undefined,
        source: "autonomy",
      },
      cfg,
    );
    const logs: string[] = [];
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: text } }] })),
      });
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      llm,
      fetchImpl,
      log: (line) => logs.push(line),
    });
    const out = await port.selftalk();
    expect(out.spoke).toBe(false);
    expect(journal.size()).toBe(1);
    expect(logs.join("\n")).toContain("skipReason=repeat");
  });

  it("P1 由头：注入 intentNoteImpl 时 system 提示词带「此刻的由头」，并每轮只取一次", async () => {
    const { runtime } = fakeRuntime([rec({ last_accessed: NOW })]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const bodies: string[] = [];
    const fetchImpl: FetchLike = (_input, init) => {
      bodies.push(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "窗台的花，又想起它了。" } }] })),
      });
    };
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    let noteCalls = 0;
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      llm,
      fetchImpl,
      intentNoteImpl: () => {
        noteCalls += 1;
        return { line: "我想找人说句话", whyLine: "因为想有人陪（缺口 0.62）" };
      },
    });
    await port.selftalk();
    expect(noteCalls).toBe(1);
    expect(bodies[0]).toContain("此刻的由头");
    expect(bodies[0]).toContain("我想找人说句话");
  });

  it("内部言语说出口：日记写下之后，真的发一句出去", async () => {
    const EVE = Date.parse("2026-10-29T20:00:00+08:00");
    const { runtime } = fakeRuntime([rec({ last_accessed: EVE })]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const sent: string[] = [];
    const fetchImpl: FetchLike = () => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "我刚刚想着，窗台那枝花今天好像更精神了" } }] })),
      });
    };
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => EVE,
      localHour: () => 20,
      llm,
      fetchImpl,
      speakImpl: (t) => {
        sent.push(t);
        return Promise.resolve({ ok: true, detail: "sent" });
      },
    });
    const out = await port.selftalk();
    expect(out.spoke).toBe(true);
    expect(sent).toHaveLength(1);
    // humanize 去掉了「我刚刚想着，」并补了句号
    expect(sent[0]).toBe("窗台那枝花今天好像更精神了。");
  });

  it("说出口失败不抛错，只是这一轮没说出来", async () => {
    const EVE = Date.parse("2026-10-29T20:00:00+08:00");
    const { runtime } = fakeRuntime([rec({ last_accessed: EVE })]);
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const fetchImpl: FetchLike = () => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "窗外起风了，不知道他那边冷不冷" } }] })),
      });
    };
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => EVE,
      localHour: () => 20,
      llm,
      fetchImpl,
      speakImpl: () => Promise.resolve({ ok: false, detail: "HTTP 500" }),
    });
    const out = await port.selftalk();
    expect(out.spoke).toBe(false);
  });

  it("节奏只在相位/上限变化时记一行（不刷屏）", async () => {
    const { runtime } = fakeRuntime();
    const logs: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      log: (line) => logs.push(line),
    });
    await port.selftalk();
    await port.selftalk();
    const pacingLines = logs.filter((l) => l.startsWith("[standalone] 节奏 "));
    expect(pacingLines).toHaveLength(1);
    expect(pacingLines[0]).toContain("phase=offpeak");
  });

  it("learn 未接线时诚实跳过；接线后再调", async () => {
    const { runtime } = fakeRuntime();
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const now = () => NOW;
    const port = createStandalonePort({ runtime, cfg, journal, now, localHour: () => 3 });
    expect(await port.learn()).toEqual({ topic: "skipped", keyword: "学习通路未接线" });
    const wired = createStandalonePort({
      runtime,
      cfg,
      journal,
      now,
      localHour: () => 3,
      learnImpl: () => Promise.resolve({ topic: "崩坏三", keyword: "AI助手" }),
    });
    // W1（task-94）：full 档多带一个 webPlan（allowSearch=false）；没有触发时不查网页，
    // 装配层读的仍是 allowSearch，行为与旧版一致。
    expect(await wired.learn()).toEqual({
      topic: "崩坏三",
      keyword: "AI助手",
      webPlan: { allowSearch: false, querySource: "hot-topic", keyword: "AI助手" },
    });
  });
});

describe("P3-3：能量决定学习档位与计费", () => {
  function learnPort(energy: number, reply = { topic: "t", keyword: "k" }, deepReads?: number) {
    const { runtime } = fakeRuntime();
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const tiers: string[] = [];
    const costs: string[] = [];
    const logs: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      energy: () => energy,
      spendEnergy: (kind) => costs.push(kind),
      log: (line) => logs.push(line),
      learnImpl: (tier) => {
        tiers.push(tier);
        return Promise.resolve(deepReads === undefined ? reply : { ...reply, deepReads });
      },
    });
    return { port, tiers, costs, logs };
  }

  it("满电/高能量走 full：调一次学习，扣 learn", async () => {
    const { port, tiers, costs } = learnPort(0.9);
    await port.learn();
    expect(tiers).toEqual(["full"]);
    expect(costs).toEqual(["learn"]);
  });

  it("0.5 走 search：仍然扣 learn（只搜不深读）", async () => {
    const { port, tiers, costs } = learnPort(0.5);
    await port.learn();
    expect(tiers).toEqual(["search"]);
    expect(costs).toEqual(["learn"]);
  });

  it("0.3 走 hot：照调学习通路，但不扣 learn（热榜是兜底路径）", async () => {
    const { port, tiers, costs } = learnPort(0.3);
    await port.learn();
    expect(tiers).toEqual(["hot"]);
    expect(costs).toEqual([]);
  });

  it("0.2 走 skip：完全不调学习通路、不扣费、不占频率账，日志说明低能量", async () => {
    const { port, tiers, costs, logs } = learnPort(0.2);
    const out = await port.learn();
    expect(tiers).toEqual([]);
    expect(costs).toEqual([]);
    expect(out).toEqual({ topic: "skipped", keyword: "低能量" });
    expect(logs.some((l) => l.includes("跳过（低能量）"))).toBe(true);
  });

  it("深读条数 >0 时额外扣 learn_deep（full）", async () => {
    const { port, costs } = learnPort(0.9, { topic: "t", keyword: "k" }, 1);
    await port.learn();
    expect(costs).toEqual(["learn", "learn_deep"]);
  });

  it("深读 0 条只扣 learn", async () => {
    const { port, costs } = learnPort(0.9, { topic: "t", keyword: "k" }, 0);
    await port.learn();
    expect(costs).toEqual(["learn"]);
  });

  it("hot 档排在审核/频率门之前：有审核票据时仍拉热榜、返回非 skipped", async () => {
    const dir = tmp();
    const review = join(dir, "autonomy-review.json");
    const usage = join(dir, "usage.json");
    const calls = Array.from({ length: 61 }, (_, i) => NOW - i * 1000);
    writeFileSync(usage, JSON.stringify({ version: 1, calls }), "utf8");
    raiseReview(review, { at: NOW, reason: "测试", calls: 99, maxCalls: 60 }, NOW);
    const { runtime } = fakeRuntime();
    const tiers: string[] = [];
    const costs: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile: usage,
      reviewFile: review,
      energy: () => 0.3,
      spendEnergy: (kind) => costs.push(kind),
      learnImpl: (tier) => {
        tiers.push(tier);
        return Promise.resolve({ topic: "hot", keyword: "热榜", deepReads: 0 });
      },
    });
    const out = await port.learn();
    expect(tiers).toEqual(["hot"]);
    expect(out).toEqual({ topic: "hot", keyword: "热榜", deepReads: 0 });
    expect(costs).toEqual([]);
  });

  it("hot 档排在频率审核之前：用量已超限时仍拉热榜", async () => {
    const dir = tmp();
    const usage = join(dir, "usage.json");
    const calls = Array.from({ length: 61 }, (_, i) => NOW - i * 1000);
    writeFileSync(usage, JSON.stringify({ version: 1, calls }), "utf8");
    const { runtime } = fakeRuntime();
    const tiers: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile: usage,
      energy: () => 0.3,
      learnImpl: (tier) => {
        tiers.push(tier);
        return Promise.resolve({ topic: "hot", keyword: "热榜", deepReads: 0 });
      },
    });
    await port.learn();
    expect(tiers).toEqual(["hot"]);
  });

  it("睡眠硬跳仍在 hot 之前：睡着时即使低能量也不拉热榜", async () => {
    const { runtime } = fakeRuntime();
    const tiers: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      sleepState: () => ({ asleep: true, phase: "asleep" }),
      energy: () => 0.3,
      learnImpl: (tier) => {
        tiers.push(tier);
        return Promise.resolve({ topic: "hot", keyword: "热榜", deepReads: 0 });
      },
    });
    const out = await port.learn();
    expect(tiers).toEqual([]);
    expect(out).toEqual({ topic: "skipped", keyword: "睡眠中" });
  });

  it("explore 越阈改走 port.learn 后：低能量绝不 full，扣费只发生一次", async () => {
    // 装配层的 explore 路径现在与定时学习同一个入口；这里等价地验证三档。
    const low = learnPort(0.5, { topic: "t", keyword: "k" });
    await low.port.learn();
    expect(low.tiers).toEqual(["search"]);
    expect(low.costs).toEqual(["learn"]);

    const mid = learnPort(0.3, { topic: "hot", keyword: "热榜", deepReads: 0 });
    await mid.port.learn();
    expect(mid.tiers).toEqual(["hot"]);
    expect(mid.costs).toEqual([]);

    const none = learnPort(0.2);
    expect(await none.port.learn()).toEqual({ topic: "skipped", keyword: "低能量" });
    expect(none.tiers).toEqual([]);
    expect(none.costs).toEqual([]);

    const full = learnPort(0.9, { topic: "t", keyword: "k" }, 2);
    await full.port.learn();
    expect(full.tiers).toEqual(["full"]);
    expect(full.costs.filter((c) => c === "learn")).toHaveLength(1);
    expect(full.costs.filter((c) => c === "learn_deep")).toHaveLength(1);
  });
});

describe("人工审核闸门", () => {
  it("有待审记录、窗口仍超限时：学习不动手，自言自语不调模型（只内省）", async () => {
    const dir = tmp();
    const path = join(dir, "autonomy-review.json");
    const usage = join(dir, "usage.json");
    const calls = Array.from({ length: 61 }, (_, i) => NOW - i * 1000);
    writeFileSync(usage, JSON.stringify({ version: 1, calls }), "utf8");
    raiseReview(path, { at: NOW, reason: "测试", calls: 99, maxCalls: 60 }, NOW);
    const { runtime } = fakeRuntime([rec()]);
    let learned = 0;
    let modeled = 0;
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile: usage,
      reviewFile: path,
      llm: { baseUrl: "https://example.invalid", apiKey: "k", model: "m", timeoutMs: 1000 },
      fetchImpl: async () => {
        modeled += 1;
        return { ok: true, status: 200, text: async () => "{}" };
      },
      learnImpl: async () => {
        learned += 1;
        return { topic: "t", keyword: "k" };
      },
    });
    const out = await port.learn();
    expect(out.keyword).toContain("人工审核");
    expect(learned).toBe(0);
    const talk = await port.selftalk();
    expect(["wander", "reflect", "related"]).toContain(talk.kind);
    expect(modeled).toBe(0);
  });

  it("窗口回落后，下一拍 advance 就把票据清掉（不必等 learn）", () => {
    const dir = tmp();
    const path = join(dir, "autonomy-review.json");
    const usage = join(dir, "usage.json");
    // 票据还在，但最近一小时只剩 3 次调用（尖峰已过去）
    const calls = Array.from({ length: 3 }, (_, i) => NOW - i * 60_000);
    writeFileSync(usage, JSON.stringify({ version: 1, calls }), "utf8");
    raiseReview(path, { at: NOW, reason: "测试尖峰", calls: 13, maxCalls: 12 }, NOW);
    const { runtime } = fakeRuntime([rec()]);
    const logs: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => NOW,
      localHour: () => 3,
      usageFile: usage,
      reviewFile: path,
      log: (line) => logs.push(line),
      learnImpl: async () => ({ topic: "t", keyword: "k" }),
    });
    port.advance(0.1);
    expect(pendingReview(path, NOW)).toBeNull();
    expect(logs.join("\n")).toContain("审核票据自动解除");
  });

  it("用量超上限时自动落审核记录，并停止本轮模型调用", async () => {
    const dir = tmp();
    const path = join(dir, "autonomy-review.json");
    const usage = join(dir, "usage.json");
    const now = NOW;
    const calls = Array.from({ length: 61 }, (_, i) => now - i * 1000);
    writeFileSync(usage, JSON.stringify({ version: 1, calls }), "utf8");
    const { runtime } = fakeRuntime([rec()]);
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(dir, "j.json")),
      now: () => now,
      localHour: () => 3,
      usageFile: usage,
      reviewFile: path,
      learnImpl: async () => ({ topic: "t", keyword: "k" }),
    });
    const out = await port.learn();
    expect(out.keyword).toContain("审核");
    expect(pendingReview(path, NOW)).not.toBeNull();
  });
});

/**
 * 这两条是 2026-10-30 凌晨的真事故：23:37 / 23:52 / 23:57 她连发三句「刚才那件小事」。
 * 根因不是措辞，而是**配额与间隔存在进程内存里**——那一夜我为部署重启了她十几次，
 * 每次归零，于是 90 分钟间隔与「每天 2 句」两个闸都失效了。
 * 现在配额从日记（spoken=true 的条目）回推，重启不再清零。
 */
describe("内部言语说出口：跨重启仍然守规矩", () => {
  const EVE = Date.parse("2026-10-29T20:00:00+08:00");

  function seededJournal(entry: Record<string, unknown>): SelftalkJournal {
    const dir = tmp();
    const file = join(dir, "j.json");
    writeFileSync(file, JSON.stringify([entry]), "utf8");
    return SelftalkJournal.open(file);
  }

  it("十分钟前说过同一段记忆：换句措辞也不再开口", async () => {
    const journal = seededJournal({
      id: "e0",
      at: EVE - 10 * 60_000,
      kind: "reflect",
      text: "用户，刚才那件小事，我还记得。",
      seeds: ["m1"],
      relation: "unrelated",
      vividness: [],
      unresolvedRelief: 0,
      source: "autonomy",
      spoken: true,
    });
    const lines: string[] = [];
    let sent = 0;
    const { runtime } = fakeRuntime([rec({ last_accessed: EVE })]);
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => EVE,
      localHour: () => 20,
      // 有模型（不是降级）才能走到"最近说过"这道闸
      llm: { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 },
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "用户，那件小事我一直记着。" } }] })),
        } as unknown as Response),
      speakImpl: (): Promise<{ ok: boolean; detail: string }> => {
        sent += 1;
        return Promise.resolve({ ok: true, detail: "sent" });
      },
      log: (line) => lines.push(line),
    });
    const out = await port.selftalk();
    expect(sent).toBe(0);
    expect(out.spoke).toBe(false);
    expect(lines.some((l) => l.includes("这个话题最近说过了"))).toBe(true);
  });

  it("A9：没有模型时的降级模板只写日记、不发送", async () => {
    const journal = SelftalkJournal.open(join(tmp(), "jdegraded.json"));
    const lines: string[] = [];
    let sent = 0;
    const { runtime } = fakeRuntime([rec({ last_accessed: EVE })]);
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => EVE,
      localHour: () => 20,
      // 故意不传 generate：走 fallbackSelfTalk（降级模板）
      speakImpl: (): Promise<{ ok: boolean; detail: string }> => {
        sent += 1;
        return Promise.resolve({ ok: true, detail: "sent" });
      },
      log: (line) => lines.push(line),
    });
    const out = await port.selftalk();
    expect(sent).toBe(0);
    expect(out.spoke).toBe(false);
    expect(lines.some((l) => l.includes("降级模板，不发送"))).toBe(true);
  });

  it("十分钟前说过别的话题：被 90 分钟间隔拦住（不再因重启而重置）", async () => {
    const journal = seededJournal({
      id: "e1",
      at: EVE - 10 * 60_000,
      kind: "wander",
      text: "窗外风好像小了点。",
      seeds: ["m9"],
      relation: "unrelated",
      vividness: [],
      unresolvedRelief: 0,
      source: "autonomy",
      spoken: true,
    });
    const lines: string[] = [];
    let sent = 0;
    const { runtime } = fakeRuntime([rec({ last_accessed: EVE })]);
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => EVE,
      localHour: () => 20,
      llm: { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 },
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "灯下那杯茶凉得比昨天快。" } }] })),
        } as unknown as Response),
      speakImpl: (): Promise<{ ok: boolean; detail: string }> => {
        sent += 1;
        return Promise.resolve({ ok: true, detail: "sent" });
      },
      log: (line) => lines.push(line),
    });
    await port.selftalk();
    expect(sent).toBe(0);
    expect(lines.some((l) => l.includes("距上次开口不足 90 分钟"))).toBe(true);
  });
});

describe("insight：睡眠巩固后的洞见生成也要过审核与额度", () => {
  function makePort(over: {
    usageFile?: string;
    reviewFile?: string;
    now?: number;
    insightImpl?: () => Promise<{ tag: string; stored: boolean; reason: string }>;
    drainFunnel?: () => { drained: number; ingested: number };
    log?: (line: string) => void;
  }) {
    const { runtime } = fakeRuntime();
    return createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => over.now ?? NOW,
      localHour: () => 3,
      ...(over.usageFile === undefined ? {} : { usageFile: over.usageFile }),
      ...(over.reviewFile === undefined ? {} : { reviewFile: over.reviewFile }),
      ...(over.insightImpl === undefined ? {} : { insightImpl: over.insightImpl }),
      ...(over.drainFunnel === undefined ? {} : { drainFunnel: over.drainFunnel }),
      ...(over.log === undefined ? {} : { log: over.log }),
    });
  }

  it("睡眠缓冲在巩固之后消化一次，结果只影响日志、不改巩固返回值", async () => {
    const lines: string[] = [];
    let drained = 0;
    const out = await makePort({
      drainFunnel: () => {
        drained += 1;
        return { drained: 3, ingested: 2 };
      },
      log: (line) => lines.push(line),
    }).consolidate();
    expect(drained).toBe(1);
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(lines.some((l) => l.includes("funnel drained=3 ingested=2"))).toBe(true);
  });

  it("缓冲消化抛错不拖垮巩固（知识晚一晚写没关系）", async () => {
    const lines: string[] = [];
    const out = await makePort({
      drainFunnel: () => {
        throw new Error("缓冲文件坏了");
      },
      log: (line) => lines.push(line),
    }).consolidate();
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(lines.some((l) => l.includes("funnel 消化失败") && l.includes("缓冲文件坏了"))).toBe(true);
  });

  it("没有接线就不做（未注入 insightImpl 时结果里没有 insight 字段）", async () => {
    const out = await makePort({}).consolidate();
    expect(out.insight).toBeUndefined();
  });

  it("写成一次就记一次账、结果里带回 tag", async () => {
    const usageFile = join(tmp(), "usage.json");
    let called = 0;
    const out = await makePort({
      usageFile,
      insightImpl: async () => {
        called += 1;
        return { tag: "花", stored: true, reason: "" };
      },
    }).consolidate();
    expect(called).toBe(1);
    expect(out.insight).toEqual({ tag: "花", stored: true, reason: "" });
    expect(loadUsage(usageFile, NOW)).toEqual([NOW]);
  });

  it("额度已经用完就不调模型（凌晨三点也不许冲上限）", async () => {
    const usageFile = join(tmp(), "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    let called = 0;
    const out = await makePort({
      usageFile,
      insightImpl: async () => {
        called += 1;
        return { tag: "花", stored: true, reason: "" };
      },
    }).consolidate();
    expect(called).toBe(0);
    expect(out.insight?.reason).toMatch(/额度/);
  });

  it("有审核票据就不动模型（她整小时哑着的时候也别偷偷调）", async () => {
    const dir = tmp();
    const reviewFile = join(dir, "review.json");
    // 票据 + 窗口里确实超速的调用记录：只看票据不给账本，releaseReviewIfRecovered 会立刻把票撤掉
    const usageFile = join(dir, "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    raiseReview(reviewFile, { at: NOW, reason: "hourly calls=61 > cap=60", calls: 61, maxCalls: 60 });
    expect(pendingReview(reviewFile, NOW)).not.toBeNull();
    let called = 0;
    const out = await makePort({
      usageFile,
      reviewFile,
      insightImpl: async () => {
        called += 1;
        return { tag: "花", stored: true, reason: "" };
      },
    }).consolidate();
    expect(called).toBe(0);
    expect(out.insight?.reason).toMatch(/审核/);
  });

  it("insightImpl 抛错只记日志，不让整个巩固失败", async () => {
    const out = await makePort({
      insightImpl: async () => {
        throw new Error("模型 429");
      },
    }).consolidate();
    expect(out.accepted).toBe(1);
    expect(out.insight?.stored).toBe(false);
    expect(out.insight?.reason).toContain("429");
  });

  it("裁决 A：后台让路——谷时剩 1 格（已用 59/60）时洞见跳过，理由写明给开口留额度", async () => {
    const usageFile = join(tmp(), "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 59 }, (_, i) => NOW - i * 1000) }));
    let called = 0;
    const lines: string[] = [];
    const out = await makePort({
      usageFile,
      log: (line) => lines.push(line),
      insightImpl: async () => {
        called += 1;
        return { tag: "花", stored: true, reason: "" };
      },
    }).consolidate();
    expect(called).toBe(0);
    expect(out.insight?.reason).toMatch(/给开口留额度/);
    expect(lines.some((l) => l.includes("insight 跳过") && l.includes("给开口留额度"))).toBe(true);
  });

  it("裁决 A：自言自语让路——谷时剩 1 格时不生成、不写日记", async () => {
    const { runtime } = fakeRuntime([rec({ last_accessed: NOW })]);
    const dir = tmp();
    const usageFile = join(dir, "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 59 }, (_, i) => NOW - i * 1000) }));
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "窗台的花，又想起它了。" } }] })),
      });
    };
    const llm: LlmConfig = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };
    const lines: string[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      usageFile,
      llm,
      fetchImpl,
      log: (line) => lines.push(line),
    });
    const out = await port.selftalk();
    expect(calls).toBe(0);
    expect(out.kind).toBe("wander");
    expect(journal.size()).toBe(0);
    expect(lines.some((l) => l.includes("跳过生成") && l.includes("给开口留额度"))).toBe(true);
  });
});

describe("P1：意图节拍从装配点注入（可选，不注入 = 旧行为）", () => {
  it("注入 intentTickImpl 后 port.intentTick 会转调一次", async () => {
    let called = 0;
    const port = createStandalonePort({
      runtime: fakeRuntime() as never,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      intentTickImpl: () => {
        called += 1;
      },
    });
    expect(port.intentTick).toBeDefined();
    await port.intentTick?.();
    expect(called).toBe(1);
  });

  it("不注入时 port.intentTick 不存在（循环不会白跑）", () => {
    const port = createStandalonePort({
      runtime: fakeRuntime() as never,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
    });
    expect(port.intentTick).toBeUndefined();
  });
});

describe("再巩固（§5.4）：巩固之后可以调一次模型，但只写版本链", () => {
  function makePort(over: {
    usageFile?: string;
    now?: number;
    insightImpl?: () => Promise<{ tag: string; stored: boolean; reason: string }>;
    reconsolidateImpl?: () => Promise<{ patched: number; reason: string; memoryId?: string }>;
    log?: (line: string) => void;
  }) {
    const { runtime } = fakeRuntime();
    return createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => over.now ?? NOW,
      localHour: () => 3,
      ...(over.usageFile === undefined ? {} : { usageFile: over.usageFile }),
      ...(over.insightImpl === undefined ? {} : { insightImpl: over.insightImpl }),
      ...(over.reconsolidateImpl === undefined ? {} : { reconsolidateImpl: over.reconsolidateImpl }),
      ...(over.log === undefined ? {} : { log: over.log }),
    });
  }

  it("没有接线就不做（结果里没有 reconsolidated 字段）", async () => {
    const out = await makePort({}).consolidate();
    expect(out.reconsolidated).toBeUndefined();
  });

  it("只注入再巩固（没有洞见）也会跑——不能被洞见的早退挡掉", async () => {
    let called = 0;
    const usageFile = join(tmp(), "usage.json");
    const out = await makePort({
      usageFile,
      reconsolidateImpl: async () => {
        called += 1;
        return { patched: 1, reason: "", memoryId: "m1" };
      },
    }).consolidate();
    expect(called).toBe(1);
    expect(out.reconsolidated).toEqual({ patched: 1, reason: "", memoryId: "m1" });
    expect(loadUsage(usageFile, NOW)).toEqual([NOW]);
  });

  it("抛错只记日志、原因带回结果，不拖垮巩固", async () => {
    const lines: string[] = [];
    const out = await makePort({
      reconsolidateImpl: async () => {
        throw new Error("模型 503");
      },
      log: (line) => lines.push(line),
    }).consolidate();
    expect(out.accepted).toBe(1);
    expect(out.reconsolidated?.patched).toBe(0);
    expect(out.reconsolidated?.reason).toContain("503");
    expect(lines.some((l) => l.includes("再巩固 失败"))).toBe(true);
  });
});

describe("W1：学习计划里的网页触发（spec v2.3 §5.3）", () => {
  function learnPort(energy: number, reply: { biliEmpty?: boolean } = {}) {
    const { runtime } = fakeRuntime();
    const journal = SelftalkJournal.open(join(tmp(), "j.json"));
    const tiers: string[] = [];
    const inputs: ({ exploreNow?: boolean } | undefined)[] = [];
    const port = createStandalonePort({
      runtime,
      cfg,
      journal,
      now: () => NOW,
      localHour: () => 3,
      energy: () => energy,
      learnImpl: (tier, input) => {
        tiers.push(tier);
        inputs.push(input);
        return Promise.resolve({ topic: "崩坏三", keyword: "AI助手", deepReads: 0, ...reply });
      },
    });
    return { port, tiers, inputs };
  }

  it("explore-only 入口：exploreNow 透传给 learnImpl，full 档产出 learning-plan 计划", async () => {
    const { port, tiers, inputs } = learnPort(0.7);
    const out = await port.learn({ exploreNow: true });
    expect(tiers).toEqual(["full"]);
    expect(inputs).toEqual([{ exploreNow: true }]);
    expect(out.webPlan).toEqual({ allowSearch: true, querySource: "learning-plan", keyword: "AI助手" });
  });

  it("普通拍不传 input：第二参 undefined、无触发 → allowSearch=false（旧行为不变）", async () => {
    const { port, inputs } = learnPort(0.7);
    const out = await port.learn();
    expect(inputs).toEqual([undefined]);
    expect(out.webPlan).toEqual({ allowSearch: false, querySource: "hot-topic", keyword: "AI助手" });
  });

  it("B 站搜索真正执行且为空：biliEmpty 走 hot-topic 分支", async () => {
    const { port } = learnPort(0.7, { biliEmpty: true });
    const out = await port.learn();
    expect(out.webPlan).toEqual({ allowSearch: true, querySource: "hot-topic", keyword: "AI助手" });
  });

  it("search/hot 档不带 webPlan（只有 full 才可能查网页）", async () => {
    for (const energy of [0.5, 0.3]) {
      const { port } = learnPort(energy);
      const out = await port.learn();
      expect(out.webPlan, String(energy)).toBeUndefined();
    }
  });

  it("hot 档也把 input 原样透传（但计划仍不产生）", async () => {
    const { port, tiers, inputs } = learnPort(0.3);
    const out = await port.learn({ exploreNow: true });
    expect(tiers).toEqual(["hot"]);
    expect(inputs).toEqual([{ exploreNow: true }]);
    expect(out.webPlan).toBeUndefined();
  });
});

describe("standalone port：social 门（睡眠/审核/额度/能耗）", () => {
  function make(over: {
    socialImpl?: () => { action: "watch" | "like" | "danmaku" | "comment" | "skip"; ok: boolean; reason: string; generated?: boolean; bvid?: string };
    usageFile?: string;
    reviewFile?: string;
    asleep?: boolean;
    spent?: string[];
  } = {}) {
    const { runtime } = fakeRuntime();
    const spent = over.spent ?? [];
    return createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "j.json")),
      now: () => NOW,
      localHour: () => 3,
      ...(over.socialImpl === undefined ? {} : { socialImpl: over.socialImpl }),
      ...(over.usageFile === undefined ? {} : { usageFile: over.usageFile }),
      ...(over.reviewFile === undefined ? {} : { reviewFile: over.reviewFile }),
      ...(over.asleep === undefined ? {} : { sleepState: () => ({ asleep: over.asleep === true, phase: "deep" }) }),
      spendEnergy: (kind) => spent.push(kind),
    });
  }

  it("睡眠中连匿名浏览都不做", async () => {
    let called = 0;
    const out = await make({ asleep: true, socialImpl: () => { called += 1; return { action: "watch", ok: true, reason: "x" }; } }).social();
    expect(called).toBe(0);
    expect(out).toMatchObject({ action: "skip", ok: false, reason: "睡眠中" });
  });

  it("未接线时返回 skip，不抛异常", async () => {
    const out = await make().social();
    expect(out).toMatchObject({ action: "skip", ok: false, reason: "社交通路未接线" });
  });

  it("有一小时额度上限内的调用时直接跳过，不调 socialImpl", async () => {
    const usageFile = join(tmp(), "usage.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    let called = 0;
    const out = await make({ usageFile, socialImpl: () => { called += 1; return { action: "danmaku", ok: true, reason: "x" }; } }).social();
    expect(called).toBe(0);
    expect(out.reason).toMatch(/额度不够|hourly calls/);
  });

  it("审核票据未解除时不进入社交", async () => {
    const dir = tmp();
    const usageFile = join(dir, "usage.json");
    const reviewFile = join(dir, "autonomy-review.json");
    writeFileSync(usageFile, JSON.stringify({ version: 1, calls: Array.from({ length: 61 }, (_, i) => NOW - i * 1000) }));
    raiseReview(reviewFile, { at: NOW, reason: "test", calls: 61, maxCalls: 60 }, NOW);
    let called = 0;
    const out = await make({ usageFile, reviewFile, socialImpl: () => { called += 1; return { action: "comment", ok: true, reason: "x" }; } }).social();
    expect(called).toBe(0);
    expect(out.reason).toMatch(/审核/);
  });

  it("真发出一条弹幕：记账一次并扣 social 能耗", async () => {
    const usageFile = join(tmp(), "usage.json");
    const spent: string[] = [];
    const out = await make({
      usageFile,
      spent,
      socialImpl: () => ({ action: "danmaku", ok: true, reason: "弹幕额度未满", generated: true, bvid: "BV1" }),
    }).social();
    expect(out.action).toBe("danmaku");
    expect(loadUsage(usageFile, NOW)).toEqual([NOW]);
    expect(spent).toEqual(["social"]);
  });

  it("只看不写（watch）成功也不扣能、不记模型额度", async () => {
    const usageFile = join(tmp(), "usage.json");
    const spent: string[] = [];
    const out = await make({
      usageFile,
      spent,
      socialImpl: () => ({ action: "watch", ok: true, reason: "只看不写" }),
    }).social();
    expect(out.action).toBe("watch");
    expect(loadUsage(usageFile, NOW)).toEqual([]);
    expect(spent).toEqual([]);
  });

  it("点赞成功扣能，但没有生成文案就不占模型额度", async () => {
    const usageFile = join(tmp(), "usage.json");
    const spent: string[] = [];
    await make({ usageFile, spent, socialImpl: () => ({ action: "like", ok: true, reason: "留一个赞" }) }).social();
    expect(loadUsage(usageFile, NOW)).toEqual([]);
    expect(spent).toEqual(["social"]);
  });

  it("生成了文案但平台拒绝：记模型额度、不扣写作能耗", async () => {
    const usageFile = join(tmp(), "usage.json");
    const spent: string[] = [];
    const out = await make({
      usageFile,
      spent,
      socialImpl: () => ({ action: "comment", ok: false, reason: "B 站写接口 code=12002", generated: true }),
    }).social();
    expect(out.ok).toBe(false);
    expect(loadUsage(usageFile, NOW)).toEqual([NOW]);
    expect(spent).toEqual([]);
  });

  it("socialImpl 抛错只记日志并返回 skip，不打断循环", async () => {
    const spent: string[] = [];
    const out = await make({ spent, socialImpl: () => { throw new Error("网络断了"); } }).social();
    expect(out).toMatchObject({ action: "skip", ok: false });
    expect(out.reason).toContain("网络断了");
    expect(spent).toEqual([]);
  });
});
