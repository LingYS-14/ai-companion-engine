/**
 * 面板数据层测试（`src/assembly/panel-payload.ts`，F295 从工具层搬走）。
 *
 * 为什么要单独测：面板是"用户唯一会盯着看的东西"，而它最容易在**契约层**坏掉——
 * 字段改名、数组变空、象限算错，类型都过得去，但用户看到的是空白或错的脸。
 * 所以这里的断言分三类：① 心情/用词的分档边界；② payload 的字段与长度契约；
 * ③ 与 engine 的单一真源对齐（关系四段必须覆盖 [0,1]，不得出现未覆盖区间）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { moodOf, panelPayload, taglineOf, wordFor } from "../src/assembly/panel-payload.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-panel-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("moodOf", () => {
  it("高唤醒 + 高愉悦是雀跃，低唤醒 + 高愉悦是安稳", () => {
    expect(moodOf(0.8, 0.8).label).toBe("雀跃");
    expect(moodOf(0.8, 0.8).tone).toBe("warm");
    expect(moodOf(0.8, 0.2).label).toBe("安稳");
    expect(moodOf(0.8, 0.2).tone).toBe("calm");
  });

  it("愉悦但唤醒居中只是心情不错", () => {
    expect(moodOf(0.6, 0.5).label).toBe("心情不错");
  });

  it("愉悦低但唤醒高是心跳有点快，中间值是平静", () => {
    expect(moodOf(0.5, 0.8).label).toBe("心跳有点快");
    expect(moodOf(0.5, 0.3).label).toBe("平静");
    expect(moodOf(0.5, 0.3).tone).toBe("flat");
  });

  it("低落分烦躁与低落两支，中间是有点拧", () => {
    expect(moodOf(0.2, 0.8).label).toBe("烦躁");
    expect(moodOf(0.2, 0.2).label).toBe("低落");
    expect(moodOf(0.39, 0.5).label).toBe("有点拧");
  });

  it("不返回 emoji：面板用色点 + 文字（用户反馈表情破坏观感）", () => {
    for (const [v, a] of [
      [0, 0],
      [1, 1],
      [0.42, 0.42],
      [0.62, 0.62],
    ] as const) {
      const mood = moodOf(v, a);
      expect(mood.label.length).toBeGreaterThan(0);
      expect(mood.color).toMatch(/^#[0-9a-f]{6}$/);
      // 不许有 emoji：emoji 的码点都在 0x1F000 以上，且不在 BMP 内
      for (const ch of mood.label + mood.color) {
        expect(ch.codePointAt(0) ?? 0).toBeLessThan(0x1f000);
      }
    }
  });
});

describe("wordFor", () => {
  it("三档边界", () => {
    expect(wordFor(0)).toBe("低");
    expect(wordFor(0.29)).toBe("低");
    expect(wordFor(0.3)).toBe("中");
    expect(wordFor(0.59)).toBe("中");
    expect(wordFor(0.6)).toBe("高");
    expect(wordFor(1)).toBe("高");
  });
});

describe("panelPayload", () => {
  it("空运行时也给出完整骨架，不抛错", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.name).toBe("test");
    expect(p.turns).toBe(0);
    expect(p.bond.stage).toBe("stranger");
    expect(p.bond.stageLabel).toBe("陌生");
    expect(p.vitals).toHaveLength(4);
    expect(p.recent).toEqual([]);
    expect(p.knowledge).toEqual([]);
    expect(typeof p.updatedAt).toBe("number");
  });

  it("F274：有新鲜快照时用快照的值，没有时退回本进程的值", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const stale = panelPayload(rt, conf);
    const fresh = panelPayload(rt, conf, null, {
      atMs: Date.now(),
      turns: 321,
      mode: "NIGHT",
      valence: 0.95,
      energy: 0.11,
      pressure: 0.77,
      maskIntegrity: 0.33,
    });
    expect(fresh.turns).toBe(321);
    expect(fresh.mode).toBe("NIGHT");
    expect(fresh.vitals.find((v) => v.key === "valence")?.value).toBe(0.95);
    expect(fresh.vitals.find((v) => v.key === "mask")?.value).toBe(0.33);
    // 没有快照时仍是本进程的值（测试起点 turns=0，且与 fake runtime 一致）
    expect(stale.turns).toBe(panelPayload(rt, conf, null, null).turns);
    expect(stale.vitals.find((v) => v.key === "valence")?.value).toBe(
      panelPayload(rt, conf, null, null).vitals.find((v) => v.key === "valence")?.value,
    );
  });

  it("关系四段首尾相接并覆盖 [0,1]", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.stageTrack).toHaveLength(4);
    expect(p.stageTrack[0]?.from).toBe(0);
    expect(p.stageTrack[3]?.to).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < p.stageTrack.length; i += 1) {
      expect(p.stageTrack[i]?.from).toBeCloseTo(p.stageTrack[i - 1]?.to ?? NaN, 9);
    }
    expect(p.stageTrack.map((s) => s.label)).toEqual(["陌生", "熟悉", "亲近", "挚爱"]);
  });

  it("四根条的顺序、颜色与 key 稳定（面板靠 key 对齐）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.vitals.map((v) => v.key)).toEqual(["valence", "energy", "pressure", "mask"]);
    expect(p.vitals.map((v) => v.label)).toEqual(["心情", "精力", "压力", "面具"]);
    expect(p.vitals.map((v) => v.color)).toEqual(["#e78ab0", "#5fbf8f", "#ef7f6b", "#7ea9ef"]);
    for (const v of p.vitals) {
      expect(v.value).toBeGreaterThanOrEqual(0);
      expect(v.value).toBeLessThanOrEqual(1);
      expect(["低", "中", "高"]).toContain(v.word);
    }
  });

  it("最近记忆按时间倒序、内容截断到 42 字、标签最多 3 个", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "第一句话", source: "player", tags: ["a", "b", "c", "d"] });
    clock.advance(60_000);
    rt.remember({ content: "第二句话", source: "player", tags: ["x"] });
    clock.advance(60_000);
    rt.remember({ content: "第三句话", source: "player" });
    clock.advance(60_000);
    rt.remember({ content: "第四句话", source: "player" });

    const p = panelPayload(rt, conf);
    expect(p.recent).toHaveLength(3);
    expect(p.recent[0]?.content).toBe("第四句话");
    expect(p.recent[2]?.content).toBe("第二句话");
    expect(p.memory.total).toBe(4);
    expect(p.memory.active).toBe(4);

    rt.remember({ content: "这条特别长".repeat(20), source: "player" });
    const q = panelPayload(rt, conf);
    expect(q.recent[0]?.content.length).toBeLessThanOrEqual(42);
    expect(q.recent.some((m) => m.content.endsWith("…"))).toBe(true);
  });

  it("标签超过 3 个时只留前 3 个", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "带很多标签", source: "player", tags: ["t1", "t2", "t3", "t4"] });
    const p = panelPayload(rt, conf);
    expect(p.recent[0]?.tags).toEqual(["t1", "t2", "t3"]);
  });

  it("心情与引擎状态同源（不是面板自己算的另一套）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.mood).toEqual(moodOf(rt.state.valence, rt.state.arousal));

    // 连续负面输入把 valence 压下去之后，标签必须跟着变（而不是永远"平静"）
    const startLabel = p.mood.label;
    for (let i = 0; i < 12; i += 1) {
      rt.turn(
        {
          text: "你是不是根本不在乎我，每次都这样。",
          appraisal: {
            goal_congruence: -0.9,
            goal_relevance: 0.95,
            coping_potential: 0.2,
            novelty: 0.4,
            legitimacy: 0.1,
          },
        },
        { source: "player", eventType: "争吵", audiencePresent: 0 },
      );
    }
    const after = panelPayload(rt, conf);
    expect(after.mood.label).not.toBe(startLabel);
    expect(after.mood).toEqual(moodOf(rt.state.valence, rt.state.arousal));
  });

  it("F326：没有 persona 卡时，名字用 displayName（缺省回落 characterId）", async () => {
    const rt = await SoulRuntime.open({ ...conf, displayName: "AI助手" }, clock);
    const p = panelPayload(rt, { ...conf, displayName: "AI助手" });
    expect(p.name).toBe("AI助手");
    // 副标题不再从人格卡推导：卡已删除，没有设定可背。
    expect(p.tagline).toBeNull();
  });

  it("F326：displayName 缺省时回落 characterId，头像按 characterId 找资源", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.name).toBe("test");
    expect(p.tagline).toBeNull();
    expect(p.avatarUrl).toBe("/plugins/ai-companion-engine/avatar?f=test");
  });

  it("退回描述首句时不留悬空引号、按句末标点切", () => {
    expect(taglineOf({ description: "一位在旧城区经营书店的年轻人，习惯先听人把话说完。「剩下的」」「」" })).toBe(
      "一位在旧城区经营书店的年轻人，习惯先听人把话说完",
    );
    expect(taglineOf({ description: "短句♪后面还有" })).toBe("短句");
    expect(taglineOf(null)).toBeNull();
  });
});
