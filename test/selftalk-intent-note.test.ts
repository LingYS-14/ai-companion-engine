import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { SelftalkJournal } from "../src/maintenance/selftalk-journal.js";
import { runSelfTalk, selfTalkSystem } from "../src/maintenance/selftalk-runner.js";

const cfg = loadConfig();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-selftalk-note-"));
  dirs.push(dir);
  return dir;
}

interface FakeRec {
  id: string;
  content: string;
  tags: string[];
  vividness: number;
  unresolved_score: number;
  encode_state: Record<string, number>;
  last_accessed: number;
  access_count: number;
  base_activation: number;
  forgotten: boolean;
}

const rec = (over: Partial<FakeRec> = {}): FakeRec => ({
  id: over.id ?? "m1",
  content: over.content ?? "今天那杯茶凉了才想起来喝。",
  tags: over.tags ?? ["茶"],
  vividness: over.vividness ?? 0.6,
  unresolved_score: over.unresolved_score ?? 0.2,
  encode_state: over.encode_state ?? { valence: 0.55 },
  last_accessed: over.last_accessed ?? 0,
  access_count: over.access_count ?? 1,
  base_activation: over.base_activation ?? 0,
  forgotten: over.forgotten ?? false,
});

function fakeStore(recs: FakeRec[]) {
  const map = new Map(recs.map((r) => [r.id, r]));
  return {
    store: {
      active: () => [...map.values()].filter((r) => !r.forgotten) as never,
      get: (id: string) => map.get(id) as never,
      mutate: (id: string, patch: Partial<FakeRec>) => {
        const found = map.get(id);
        if (found === undefined) return undefined;
        const next = { ...found, ...patch };
        map.set(id, next);
        return next as never;
      },
      touch: (id: string) => map.get(id) as never,
    },
  };
}

const NOTE = {
  line: "我想找人说句话",
  whyLine: "因为想有人陪（缺口 0.62）、精力也够（0.41）",
  statusLine: "现在还没开始。",
};

describe("selfTalkSystem", () => {
  it("不给由头时与旧提示词一致：含名字与「没人跟你说话」，不含由头段", () => {
    const system = selfTalkSystem("AI助手");
    expect(system).toContain("你叫AI助手。");
    expect(system).toContain("现在是没人跟你说话的时候");
    expect(system).not.toContain("此刻的由头");
  });

  it("给由头时追加「我想做什么 / 为什么 / 状态」，并明确允许不围绕它说", () => {
    const system = selfTalkSystem("AI助手", NOTE);
    expect(system).toContain("【此刻的由头】我想找人说句话");
    expect(system).toContain("为什么是这个由头：因为想有人陪");
    expect(system).toContain("现在还没开始。");
    expect(system).toContain("如果这个由头正是你现在想说的，就围绕它说");
    expect(system).toContain("不要复述这段说明");
    // 旧规则一条不少
    expect(system).toContain("不要提到「检索」「记忆库」「条目」这些词");
  });

  it("状态句缺省时不出现 undefined", () => {
    const system = selfTalkSystem("AI助手", { line: "想去看看窗外", whyLine: "好奇最近发生的事（缺口 0.5）" });
    expect(system).toContain("【此刻的由头】想去看看窗外");
    expect(system).not.toContain("undefined");
  });
});

describe("runSelfTalk 的由头注入", () => {
  it("把由头写进 system，材料仍照旧进 user；不改变调用形状（2 条消息）", async () => {
    const dir = tmpDir();
    const { store } = fakeStore([rec()]);
    const journal = SelftalkJournal.open(join(dir, "j.json"));
    const seen: { role: string; content: string }[][] = [];
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 1_000_000,
      mood: { valence: 0.6, arousal: 0.4 },
      personaName: "AI助手",
      intentNote: NOTE,
      generate: (messages) => {
        seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return Promise.resolve("茶凉了才想起来喝，倒是更清一点。");
      },
    });
    expect(seen).toHaveLength(1);
    const messages = seen[0] ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("【此刻的由头】我想找人说句话");
    expect(messages[0]?.content).toContain("你叫AI助手。");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content.length).toBeGreaterThan(0);
    expect(out.written).toBe(true);
  });

  it("不给由头时 system 里没有由头段（旧行为逐字保留）", async () => {
    const dir = tmpDir();
    const { store } = fakeStore([rec()]);
    const journal = SelftalkJournal.open(join(dir, "j2.json"));
    const seen: string[] = [];
    await runSelfTalk({
      store,
      journal,
      cfg,
      now: 2_000_000,
      mood: { valence: 0.6, arousal: 0.4 },
      generate: (messages) => {
        seen.push(String(messages[0]?.content));
        return Promise.resolve("茶凉了也好喝。");
      },
    });
    expect(seen[0]).not.toContain("此刻的由头");
  });

  it("没有模型（降级模板）时由头不会凭空改变产出：仍是模板句子且标 degraded", async () => {
    const dir = tmpDir();
    const { store } = fakeStore([rec()]);
    const journal = SelftalkJournal.open(join(dir, "j3.json"));
    const out = await runSelfTalk({
      store,
      journal,
      cfg,
      now: 3_000_000,
      mood: { valence: 0.6, arousal: 0.4 },
      intentNote: NOTE,
    });
    expect(out.written).toBe(true);
    expect(out.entry?.degraded).toBe(true);
  });
});
