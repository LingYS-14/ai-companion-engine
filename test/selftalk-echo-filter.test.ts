/**
 * task-169 B/C：自言自语不再拿「她自己说过的话」当材料，且生成后过 Dice 回声闸门。
 *
 * B：seedsFor 排除自述来源；选材在 top 与最近日记重叠时换下一个（多样性）。
 * C：生成结果与最近自身输出太像 → 重生成一次；仍像 → 这一轮跳过（不写日记）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { planSelfTalk, type SelfTalkSeed } from "../src/maintenance/selftalk.js";
import { SelftalkJournal } from "../src/maintenance/selftalk-journal.js";
import { runSelfTalk, seedsFor } from "../src/maintenance/selftalk-runner.js";
import { SELF_AUTHORED_SOURCES } from "../src/memory/echo-sources.js";

const cfg = loadConfig();
const NOW = 1_700_000_000_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-selftalk-echo-"));
  dirs.push(dir);
  return dir;
}

interface Row {
  readonly id: string;
  readonly content: string;
  readonly source?: string;
  readonly tags: readonly string[];
  readonly vividness: number;
  readonly unresolved_score: number;
  readonly encode_state: Record<string, number>;
  readonly last_accessed: number;
  readonly base_activation: number;
  readonly created_at: number;
}

function row(over: Partial<Row> & Pick<Row, "id">): Row {
  return {
    content: "楼下的猫在晒太阳，翻了个身。",
    tags: ["猫"],
    vividness: 0.6,
    unresolved_score: 0.1,
    encode_state: { valence: 0.6 },
    last_accessed: NOW,
    base_activation: 0,
    created_at: NOW,
    ...over,
  };
}

function store(rows: readonly Row[]): { active: () => Row[]; get: () => undefined; mutate: () => void; touch: () => void } {
  return {
    active: () => [...rows],
    get: () => undefined,
    mutate: () => {},
    touch: () => {},
  };
}

const seed = (over: Partial<SelfTalkSeed> = {}): SelfTalkSeed => ({
  id: over.id ?? "m1",
  tags: over.tags ?? ["花"],
  vividness: over.vividness ?? 0.6,
  unresolved: over.unresolved ?? 0.1,
  tier: over.tier ?? "hot",
  valence: over.valence ?? 0.6,
  ...(over.gist === undefined ? {} : { gist: over.gist }),
});

describe("B：seedsFor 排除自述来源", () => {
  it("proactive / selftalk / chat_reply 不当材料，普通记忆照留", () => {
    const rows = [
      row({ id: "p", source: "proactive", content: "我主动说过：窗台的花开了" }),
      row({ id: "s", source: "selftalk", content: "我自言自语：夜里很安静" }),
      row({ id: "c", source: "chat_reply", content: "我在网页里说：今天好累" }),
      row({ id: "real", source: "player", content: "他说想看海" }),
    ];
    const seeds = seedsFor(store(rows) as never, NOW, cfg, SELF_AUTHORED_SOURCES);
    expect(seeds.map((s) => s.id)).toEqual(["real"]);
  });

  it("不传 excludeSources 时旧行为不变（全留）", () => {
    const rows = [
      row({ id: "p", source: "proactive", content: "主动一句" }),
      row({ id: "real", source: "player", content: "真实一句" }),
    ];
    expect(seedsFor(store(rows) as never, NOW, cfg).map((s) => s.id)).toEqual(["p", "real"]);
  });
});

describe("B：多样性——top 与最近日记重叠时换下一个材料", () => {
  it("gist 与最近日记 Dice≥0.5 时，第二个材料提到前面并写进 note", () => {
    const seeds = [
      seed({ id: "flower", gist: "窗台上的花昨天开了", vividness: 0.9 }),
      seed({ id: "cat", gist: "楼下的猫在晒太阳", vividness: 0.5 }),
    ];
    const plan = planSelfTalk({
      seeds,
      mood: { valence: 0.6, arousal: 0.4 },
      cfg,
      recentTexts: ["窗台上的花昨天又开了"],
    });
    expect(plan.seeds[0]).toBe("cat");
    expect(plan.note ?? "").toContain("多样性");
  });

  it("没有 recentTexts 时排序不变", () => {
    const seeds = [
      seed({ id: "flower", gist: "窗台上的花昨天开了", vividness: 0.9 }),
      seed({ id: "cat", gist: "楼下的猫在晒太阳", vividness: 0.5 }),
    ];
    const plan = planSelfTalk({ seeds, mood: { valence: 0.6, arousal: 0.4 }, cfg });
    expect(plan.seeds[0]).toBe("flower");
  });
});

describe("C：生成回声闸门（selftalk）", () => {
  it("未来时间戳的日记条目不计入回声参照（task-172 上界）", async () => {
    const dir = tmp();
    const journal = SelftalkJournal.open(join(dir, "selftalk.json"));
    const echoText = "今天下午我在窗边看雨，风把窗帘吹起来。";
    journal.append(
      {
        id: "future",
        at: NOW + 3_600_000,
        kind: "reflect",
        seeds: ["real"],
        text: echoText,
        relation: "related",
        vividness: [],
        unresolvedRelief: 0,
        rewrite: undefined,
        source: "autonomy",
      },
      cfg,
    );
    const rows = [row({ id: "real", source: "player", content: "他说下周三要加班，可能很晚。" })];
    const outcome = await runSelfTalk({
      store: store(rows) as never,
      journal,
      cfg,
      now: NOW,
      mood: { valence: 0.6, arousal: 0.4 },
      generate: async () => echoText,
    });
    expect(outcome.written).toBe(true);
    expect(outcome.skipReason).toBeUndefined();
    expect(journal.size()).toBe(2);
  });
  it("两次都命中 → 跳过这一轮，不写日记，日志说明是回声", async () => {
    const dir = tmp();
    const journal = SelftalkJournal.open(join(dir, "selftalk.json"));
    const echoText = "今天下午我在窗边看雨，风把窗帘吹起来。";
    const rows = [
      row({ id: "real", source: "player", content: "他说下周三要加班，可能很晚。" }),
      row({ id: "p", source: "proactive", content: echoText }),
    ];
    const logs: string[] = [];
    const outcome = await runSelfTalk({
      store: store(rows) as never,
      journal,
      cfg,
      now: NOW,
      mood: { valence: 0.6, arousal: 0.4 },
      generate: async () => echoText,
      log: (line) => logs.push(line),
    });
    expect(outcome.written).toBe(false);
    expect(outcome.skipReason).toBe("repeat");
    expect(journal.size()).toBe(0);
    expect(logs.join("\n")).toContain("回声自检");
  });
});
