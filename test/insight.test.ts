/**
 * 洞见生成（v5.2 §7.3 `extract_insight`）的纯逻辑：选簇、组提示词、校验输出、账本。
 *
 * 为什么值得测：这条链路是**唯一**能把 L1 经历升级成 L2 信念的通道，而它同时是
 * 全系统唯一调模型的地方。选错簇 = 她学到一句噪声并拿它在每轮对话里判断你；
 * 不校验输出 = 知识库变成模型废话的垃圾桶（229 条知识里 0 条洞见就是这么来的）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INSIGHT_COOLDOWN_MS,
  INSIGHT_MAX_CHARS,
  INSIGHT_MIN_CHARS,
  buildInsightPrompt,
  emptyLedger,
  markInsight,
  parseInsight,
  pickInsightCluster,
  readLedger,
  samplesOf,
  writeLedger,
} from "../src/learning/insight.js";
import type { EpisodicCluster } from "../src/memory/consolidate.js";

const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);

function cluster(tag: string, evidenceCount: number, opts: { provenance?: "trusted" | "tainted"; samples?: string[] } = {}): EpisodicCluster {
  const samples = opts.samples ?? ["今天她说想多聊一会儿", "她说今天有点累"];
  return {
    tag,
    members: samples.map((content, i) => ({
      id: `m-${tag}-${String(i)}`,
      character_id: "test",
      content,
      tags: [tag],
      created_at: NOW - i * 3_600_000,
      last_access_at: NOW - i * 3_600_000,
      access_count: 0,
      vividness: 0.5,
      emotion_valence: 0.5,
      emotion_arousal: 0.3,
      source: "player",
      specificity_score: 0.6,
      unresolved_score: 0,
      is_obsession: false,
      suppressed_by: [],
      forgotten: false,
      encode_state: {},
    })) as unknown as EpisodicCluster["members"],
    evidenceCount,
    source: "player",
    stateProvenance: opts.provenance ?? "trusted",
    taintReason: null,
  };
}

describe("pickInsightCluster：该把哪段经历收成信念", () => {
  it("证据不够的簇不选（两条记忆就提炼人生道理=学噪声）", () => {
    const ledger = emptyLedger();
    expect(pickInsightCluster([cluster("花", 2)], ledger, NOW)).toBeNull();
    expect(pickInsightCluster([cluster("花", 3)], ledger, NOW)?.tag).toBe("花");
  });

  it("被污点污染的簇不选（A11：脏的阅历不许升级成信念）", () => {
    const ledger = emptyLedger();
    expect(pickInsightCluster([cluster("网上的话", 9, { provenance: "tainted" })], ledger, NOW)).toBeNull();
  });

  it("冷却期内不重写，过了冷却才再选（洞见不是日报）", () => {
    const c = cluster("花", 5);
    const ledger = markInsight(emptyLedger(), "花", NOW - 1_000);
    expect(pickInsightCluster([c], ledger, NOW)).toBeNull();
    expect(pickInsightCluster([c], ledger, NOW + INSIGHT_COOLDOWN_MS)?.tag).toBe("花");
  });

  it("平手时按证据数降序、tag 升序（同一份数据每次选到同一个）", () => {
    const ledger = emptyLedger();
    const picked = pickInsightCluster([cluster("b", 4), cluster("a", 4), cluster("c", 9)], ledger, NOW);
    expect(picked?.tag).toBe("c");
    const tie = pickInsightCluster([cluster("b", 4), cluster("a", 4)], ledger, NOW);
    expect(tie?.tag).toBe("a");
  });

  it("空 tag 不选（没有标签的簇没法在库里定位）", () => {
    expect(pickInsightCluster([cluster("  ", 9)], emptyLedger(), NOW)).toBeNull();
  });
});

describe("buildInsightPrompt：口径是「一句具体的话」，不是「讲个道理」", () => {
  it("system 里钉死第一人称、字数范围、禁止元叙述", () => {
    const messages = buildInsightPrompt({ persona: "AI助手", tag: "花", samples: ["她说喜欢花"] });
    const sys = messages[0]!.content;
    expect(sys).toContain("第一人称");
    expect(sys).toContain(String(INSIGHT_MIN_CHARS));
    expect(sys).toContain(String(INSIGHT_MAX_CHARS));
    expect(sys).toContain("不要写「我意识到」");
  });

  it("user 里带上样本原话与标签（没有素材的提炼=让模型编）", () => {
    const messages = buildInsightPrompt({ persona: "AI助手", tag: "花", samples: ["她说喜欢花", "她今天买了花"] });
    const user = messages[1]!.content;
    expect(user).toContain("标签：花");
    expect(user).toContain("1. 她说喜欢花");
    expect(user).toContain("2. 她今天买了花");
  });
});

describe("parseInsight：把模型废话挡在知识库外面", () => {
  it("接受一句具体的第一人称话", () => {
    expect(parseInsight("「用户说累的时候，其实是想让我别问为什么，陪着就行。」")).toBe(
      "用户说累的时候，其实是想让我别问为什么，陪着就行。",
    );
  });

  it("剥掉代码块与「洞见：」前缀", () => {
    expect(parseInsight("```\n洞见：他每次说随便，其实心里已经选好了。\n```")).toBe("他每次说随便，其实心里已经选好了。");
  });

  it("太短、太长、元叙述、无人称一律丢弃", () => {
    expect(parseInsight("挺好的")).toBeNull();
    expect(parseInsight("啊".repeat(INSIGHT_MAX_CHARS + 1))).toBeNull();
    expect(parseInsight("作为一个AI语言模型，我观察到用户喜欢花，这说明陪伴很重要")).toBeNull();
    expect(parseInsight("以下是本次提炼的洞见：陪伴很重要，需要长期观察才能确认这一点")).toBeNull();
    expect(parseInsight("耐心和信任是长期关系里最重要的东西，需要时间慢慢积累")).toBeNull();
    expect(parseInsight("")).toBeNull();
  });
});

describe("账本：坏了不许把她弄崩", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-insight-"));
    path = join(dir, "insight-test.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("写进去再读回来，count 递增", () => {
    writeLedger(path, markInsight(markInsight(emptyLedger(), "花", NOW), "雨", NOW + 1));
    const back = readLedger(path);
    expect(back.count).toBe(2);
    expect(back.last["花"]).toBe(NOW);
    expect(back.last["雨"]).toBe(NOW + 1);
  });

  it("文件不存在/是坏 JSON/字段类型不对，都退回空账本", () => {
    expect(readLedger(path)).toEqual(emptyLedger());
    writeFileSync(path, "{半行", "utf8");
    expect(readLedger(path)).toEqual(emptyLedger());
    writeFileSync(path, JSON.stringify({ last: { 花: "昨天" }, count: -3 }), "utf8");
    expect(readLedger(path)).toEqual(emptyLedger());
  });
});

describe("samplesOf：喂给模型的素材要干净", () => {
  it("去重、压空白、截断、限条数", () => {
    const c = cluster("花", 5, {
      samples: ["  她说喜欢花  ", "她说喜欢花", "一条很长很长的句子".repeat(20)],
    });
    const out = samplesOf(c, 5, 20);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("她说喜欢花");
    expect(out[1]!.length).toBe(20);
  });
});
