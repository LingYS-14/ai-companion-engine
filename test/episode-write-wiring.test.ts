/**
 * §5.3/§5.6 写入层接线：真的走一遍 `SoulRuntime.turn`，确认落盘的记忆带着
 * episode 五元组与情境指纹（不是只在单元测试里成立）。
 *
 * 守的是一条"接线有没有断"的底线：`episode-write.ts` 的单元测试只证明函数对，
 * 这里证明**回合路径真的调用了它**，而且写进的是正式字段 participants + encode_ctx。
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const HAPPY = {
  text: "我升职了，晚上想和你一起吃饭。",
  appraisal: { goal_congruence: 0.9, goal_relevance: 0.8, coping_potential: 0.8, novelty: 0.3, legitimacy: 0.9 },
};

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-episode-"));
  clock = new FakeClock(Date.UTC(2026, 9, 31, 0, 50, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readWal(): readonly Record<string, unknown>[] {
  const path = join(dir, "memory-test.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("§5.3 写入层接线：回合落盘的记忆带五元组与指纹", () => {
  it("真实回合写下的记忆：participants 是正式字段，encode_ctx 带 place/viewpoint/goal_at_time", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const result = rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal }, { source: "player" });
    expect(result.memory.wrote).toBe(1);

    const lines = readWal();
    // WAL 是 upsert 记录：找最后一条 put
    const puts = lines.filter((line) => line["op"] === "put");
    expect(puts.length).toBeGreaterThan(0);
    const rec = puts[puts.length - 1] as { rec: Record<string, unknown> };
    const memory = rec.rec;

    expect(memory["participants"]).toEqual(["用户"]);
    const ctx = memory["encode_ctx"] as Record<string, unknown>;
    expect(ctx["channel"]).toBe("gui");
    expect(ctx["place"]).toBe("本机");
    expect(ctx["viewpoint"]).toContain("第一人称");
    // 插件回合拿不到意向上下文，因此必须诚实地标 unknown，而不是编一个目标
    expect(String(ctx["goal_at_time"])).toMatch(/^unknown:no-goal-at-write$/);
    expect(ctx["episode_write_version"]).toBe(3);
    expect(ctx["episode_missing"]).toEqual(["goalAtTime"]);

    const fp = ctx["cue_fingerprint"] as Record<string, unknown>;
    expect(fp["topicDomain"]).toBe("conversation");
    expect(fp["place"]).toBe("本机");
    expect(fp["goalId"]).toBeNull();
    expect(["positive", "neutral", "negative"]).toContain(fp["affect"]);
  });

  it("非用户来源不编在场者（空数组 → 不完整，但照样写）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "随便看看。", appraisal: HAPPY.appraisal }, { source: "web" });

    const puts = readWal().filter((line) => line["op"] === "put");
    const memory = (puts[puts.length - 1] as { rec: Record<string, unknown> }).rec;
    expect(memory["participants"]).toEqual([]);
    const ctx = memory["encode_ctx"] as Record<string, unknown>;
    expect(ctx["episode_missing"]).toEqual(["goalAtTime"]);
  });

  it("显式 remember（soul_remember 路径）也带五元组与指纹（F197）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const res = rt.remember({ content: "用户说过周末想去看海。", source: "player", tags: ["约定"] });
    expect(res.stored).toBe(true);

    const rec = rt.memoryStore().all().find((m) => m.id === res.id);
    expect(rec).toBeDefined();
    expect(rec?.participants).toEqual(["用户"]);
    const ctx = rec?.encode_ctx ?? {};
    expect(ctx["channel"]).toBe("gui");
    expect(ctx["episode_write_version"]).toBe(3);
    expect(ctx["goal_at_time"]).toBe("unknown:no-goal-at-write");
    const fp = ctx["cue_fingerprint"] as Record<string, unknown>;
    expect(fp["place"]).toBe("本机");
    expect(fp["topicDomain"]).toBe("约定");
  });

  it("QQ 来源的回合：渠道写成 qq、地点写成 QQ（F199 修 channel 硬编码 gui）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "在吗？刚看到你发的消息。", appraisal: HAPPY.appraisal }, { source: "qq_contact_verified" });

    const puts = readWal().filter((line) => line["op"] === "put");
    const memory = (puts[puts.length - 1] as { rec: Record<string, unknown> }).rec;
    expect(memory["participants"]).toEqual(["用户"]);
    const ctx = memory["encode_ctx"] as Record<string, unknown>;
    expect(ctx["channel"]).toBe("qq");
    expect(ctx["place"]).toBe("QQ");
    const fp = ctx["cue_fingerprint"] as Record<string, unknown>;
    expect(fp["place"]).toBe("QQ");
  });

  it("P2a：turn 路径的记忆方向是 inbound（turn 只处理收到的消息）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal }, { source: "player" });

    const puts = readWal().filter((line) => line["op"] === "put");
    const memory = (puts[puts.length - 1] as { rec: Record<string, unknown> }).rec;
    const ctx = memory["encode_ctx"] as Record<string, unknown>;
    expect(ctx["direction"]).toBe("inbound");
  });

  it("P2a：remember 传 direction 就落盘，不传就没有这个键（缺键 = unknown）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const out = rt.remember({ content: "我主动说了句晚安。", source: "proactive", direction: "outbound" });
    const outRec = rt.memoryStore().all().find((m) => m.id === out.id);
    expect((outRec?.encode_ctx ?? {})["direction"]).toBe("outbound");

    const unknown = rt.remember({ content: "用户说过周末想去看海。", source: "player" });
    const unknownRec = rt.memoryStore().all().find((m) => m.id === unknown.id);
    const ctx = unknownRec?.encode_ctx ?? {};
    expect("direction" in ctx).toBe(false);
  });

  it("批次1B/T2：remember 的 localHour 来自 Clock（21 点 → evening），turn 同源", async () => {
    const evening = new FakeClock(Date.UTC(2026, 9, 31, 0, 50, 0), 21);
    const rt = await SoulRuntime.open(conf, evening);

    const res = rt.remember({ content: "窗外的风有一点凉。", source: "player" });
    const rec = rt.memoryStore().all().find((m) => m.id === res.id);
    const fp = (rec?.encode_ctx ?? {})["cue_fingerprint"] as Record<string, unknown>;
    expect(fp["timeOfDay"]).toBe("evening");
    // 插件路径没有意图上下文：目标仍必须诚实标 unknown，不能编
    expect((rec?.encode_ctx ?? {})["goal_at_time"]).toBe("unknown:no-goal-at-write");
    expect(fp["goalId"]).toBeNull();

    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal }, { source: "player" });
    const puts = readWal().filter((line) => line["op"] === "put");
    const turnCtx = (puts[puts.length - 1] as { rec: Record<string, unknown> }).rec["encode_ctx"] as Record<string, unknown>;
    expect((turnCtx["cue_fingerprint"] as Record<string, unknown>)["timeOfDay"]).toBe("evening");
    expect(turnCtx["goal_at_time"]).toBe("unknown:no-goal-at-write");
  });

  it("批次1B/T2：remember 传 goalAtTime/goalId 就落进 encode_ctx（装配层知晓时）", async () => {
    const rt = await SoulRuntime.open(conf, new FakeClock(Date.UTC(2026, 9, 31, 0, 50, 0), 21));
    const res = rt.remember({
      content: "我主动开口说：「窗外的风有一点凉。」",
      source: "proactive",
      direction: "outbound",
      goalAtTime: "想问她今天过得怎么样",
      goalId: "itn-reach_out-1",
    });
    const rec = rt.memoryStore().all().find((m) => m.id === res.id);
    const ctx = rec?.encode_ctx ?? {};
    expect(ctx["goal_at_time"]).toBe("想问她今天过得怎么样");
    expect((ctx["cue_fingerprint"] as Record<string, unknown>)["goalId"]).toBe("itn-reach_out-1");
  });
});
