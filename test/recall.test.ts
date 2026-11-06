import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore, type KnowledgeRecord } from "../src/memory/knowledge.js";
import {
  formatRecallHitLog,
  knowledgeCard,
  recallBlock,
  recallForDialogue,
  recentKnowledge,
  withRecall,
} from "../src/dialogue/recall.js";

const HERE = dirname(fileURLToPath(import.meta.url));


const TMP_ROOT = process.env["TMP_ROOT"] ?? join(process.cwd(), ".tmp-probe");
mkdirSync(TMP_ROOT, { recursive: true });

function rec(id: string, content: string, extra: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id,
    content,
    knowledge_type: "trend",
    source: "bili",
    freshness: 0.9,
    ingested_at: 1000,
    ...extra,
  };
}

describe("知识条目 → 一句话", () => {
  it("从《标题》（up，播放…）：简介 里只留标题与简介", () => {
    const card = knowledgeCard("在 B 站看到《你的名字 取景地巡礼》（某某UP，播放 12.3 万，点赞 1.1 万）：飞騨古川的台阶还是老样子");
    expect(card).toBe("《你的名字 取景地巡礼》：飞騨古川的台阶还是老样子");
  });

  it("标题内部自带书名号时也不会被切错", () => {
    // B 站有些视频标题自己就带《》，落库格式是 《整条标题》（up…）——
    // 按字符位置切（第一个《 到最后一个》（），而不是正则贪婪匹配。
    const card = knowledgeCard("在 B 站看到《【你的名字】取景地巡礼》（up，播放 1 万，点赞 100）：（无简介）");
    expect(card).toBe("《【你的名字】取景地巡礼》");
  });

  it("简介是「（无简介）」时只留标题", () => {
    const card = knowledgeCard("在 B 站看到《【究极佐菲格斗】第五集》（Dennis飞昊，播放 56.5 万，点赞 5.8 万）：（无简介）");
    expect(card).toBe("《【究极佐菲格斗】第五集》");
  });

  it("没有书名号时退回到整行裁短；空串返回空", () => {
    expect(knowledgeCard("随便一条没有标题的知识")).toBe("随便一条没有标题的知识");
    expect(knowledgeCard("   ")).toBe("");
  });
});

describe("召回块", () => {
  it("两条路都空时整段为空，不塞空标题", () => {
    expect(recallBlock({ memories: [], knowledge: [] })).toBe("");
    expect(withRecall("SYS", { memories: [], knowledge: [] })).toBe("SYS");
  });

  it("有记忆与知识时两段都在，并带上「别念稿」的约束", () => {
    const block = recallBlock({
      memories: ["你看我今天拍的花 像不像你？"],
      knowledge: ["《你的名字》取景地巡礼：飞騨古川的台阶还是老样子"],
    });
    expect(block).toContain("【你记得的事】");
    expect(block).toContain("你看我今天拍的花");
    expect(block).toContain("【你最近看到的东西】");
    expect(block).toContain("《你的名字》");
    expect(block).toContain("最多提一条");
    expect(block).toContain("别编");
  });

  it("只有知识时不出记忆段", () => {
    const block = recallBlock({ memories: [], knowledge: ["《A》"] });
    expect(block).not.toContain("【你记得的事】");
    expect(block).toContain("【你最近看到的东西】");
  });

  it("withRecall 用空行接在系统提示后面", () => {
    const out = withRecall("SYS", { memories: ["m1"], knowledge: [] });
    expect(out.startsWith("SYS\n\n")).toBe(true);
    expect(out).toContain("【你记得的事】");
  });
});

describe("库存问题：召回块必须能当答案用（2026-10-29 13:13 实测缺口）", () => {
  it("mandatory 块的措辞明确要求讲具体内容，并禁止气氛填空", () => {
    const block = recallBlock({
      memories: [],
      knowledge: ["《一口气看完：大明开国功臣李善长案》：手握免死铁券的开国功臣，77 岁被满门抄斩"],
      mandatory: true,
    });
    expect(block).toContain("必须");
    expect(block).toContain("夜里很安静");
    expect(block).not.toContain("最多提一条");
  });

  it("非 mandatory 仍是原来的「自然相关才提」口径（不把背景变成稿子）", () => {
    const block = recallBlock({ memories: ["我回来了。"], knowledge: ["《某视频》：一句摘要"] });
    expect(block).toContain("最多提一条");
    expect(block).not.toContain("必须从上面挑一条");
  });
});

describe("知识库检索", () => {
  const path = join(TMP_ROOT, `knowledge-search-${process.pid}.ndjson`);
  rmSync(path, { force: true });

  it("按语义相近挑出相关条目，不相关的不冒头", () => {
    const store = new KnowledgeStore(path).open();
    store.put(rec("kn_a", "在 B 站看到《你的名字》取景地巡礼（up，播放 12 万）：飞騨古川的台阶还是老样子", { freshness: 0.5 }));
    store.put(rec("kn_b", "在 B 站看到《黑神话：悟空》剧情解说（up，播放 40 万）：天命人一路打过去的理由", { freshness: 0.5 }));
    const hit = store.search("你还记得你的名字那部电影的取景地吗", 2);
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]?.id).toBe("kn_a");
  });

  it("查询为空或 limit<=0 时返回空", () => {
    const store = new KnowledgeStore(join(TMP_ROOT, `knowledge-empty-${process.pid}.ndjson`)).open();
    expect(store.search("", 2)).toEqual([]);
    expect(store.search("花", 0)).toEqual([]);
  });

  it("没有相关知识时返回空（不让提示词里出现噪音）", () => {
    const store = new KnowledgeStore(join(TMP_ROOT, `knowledge-none-${process.pid}.ndjson`)).open();
    store.put(rec("kn_x", "在 B 站看到《量子力学入门》（up，播放 1 万）：薛定谔方程", { freshness: 0.9 }));
    expect(store.search("今天想吃火锅", 2)).toEqual([]);
  });
});

describe("检索门槛：别把话题硬拽到 B 站", () => {
  function storeWith(): KnowledgeStore {
    const store = new KnowledgeStore(join(TMP_ROOT, `knowledge-gate-${process.pid}.ndjson`)).open();
    store.put(rec("kn_lsc", "在 B 站看到《一口气看完：大明开国功臣李善长案》（up，播放 88 万）：手握免死铁券还被满门抄斩"));
    store.put(rec("kn_bh3", "在 B 站看到《【崩坏3】花火回归！全流程细节语音讲解》（up，播放 12 万）：官服红莲扰动"));
    return store;
  }

  it("寒暄（你在干嘛呢）不召回任何知识", () => {
    expect(storeWith().search("你在干嘛呢", 2)).toEqual([]);
  });

  it("问题里有实词（李善长案）时能精确捞到那一条", () => {
    const hit = storeWith().search("李善长案你怎么看", 2);
    expect(hit.length).toBe(1);
    expect(hit[0]?.id).toBe("kn_lsc");
  });

  it("recentKnowledge 按吸收时间倒序", () => {
    const store = new KnowledgeStore(join(TMP_ROOT, `knowledge-recent-${process.pid}.ndjson`)).open();
    store.put(rec("kn_old", "在 B 站看到《旧视频》（up）：旧的", { ingested_at: 100 }));
    store.put(rec("kn_new", "在 B 站看到《新视频》（up）：新的", { ingested_at: 900 }));
    const rows = [...store.all()].sort((a, b) => (b.ingested_at ?? 0) - (a.ingested_at ?? 0));
    const cards = recentKnowledge(rows, 2);
    expect(cards[0]).toContain("新视频");
    expect(cards[1]).toContain("旧视频");
  });

  it("「你学到什么」这类问库存的问题退回最近吸收的条目", () => {
    const store = storeWith();
    const fake = {
      recall: () => [],
      searchKnowledge: (q: string, n = 3) => store.search(q, n).map((r) => ({ id: r.id, content: r.content })),
      recentKnowledge: (n = 3) =>
        [...store.all()]
          .sort((a, b) => (b.ingested_at ?? 0) - (a.ingested_at ?? 0))
          .slice(0, n)
          .map((r) => ({ id: r.id, content: r.content, knowledge_type: r.knowledge_type })),
    };
    const recall = recallForDialogue(fake, "昨天晚上你学到了什么？");
    expect(recall.knowledge.length).toBe(2);
  });

  it("普通寒暄即使检索为空也不退库存（不主动把话题拽走）", () => {
    const store = storeWith();
    const fake = {
      recall: () => [],
      searchKnowledge: (q: string, n = 3) => store.search(q, n).map((r) => ({ id: r.id, content: r.content })),
      recentKnowledge: (n = 3) =>
        [...store.all()]
          .sort((a, b) => (b.ingested_at ?? 0) - (a.ingested_at ?? 0))
          .slice(0, n)
          .map((r) => ({ id: r.id, content: r.content, knowledge_type: r.knowledge_type })),
    };
    const recall = recallForDialogue(fake, "在干嘛呢");
    expect(recall.knowledge).toEqual([]);
  });
});

describe("S3c：召回命中的 id/source（M3 接口）", () => {
  function fakeWithRows(
    rows: Array<{ id: string; content: string; source?: string }>,
  ) {
    return {
      recall: () =>
        rows.map((row) => ({ id: row.id, content: row.content, score: 0.9, tags: [], ...(row.source === undefined ? {} : { source: row.source }) })),
      searchKnowledge: () => [],
      recentKnowledge: () => [],
    };
  }

  it("memoryHits 与 memories 逐位对齐，包含 id/source", () => {
    const fake = fakeWithRows([
      { id: "m1", content: "你看我今天拍的花 像不像你？", source: "player" },
      { id: "m2", content: "昨晚梦到海边", source: "dream" },
    ]);
    const recall = recallForDialogue(fake, "在干嘛呢");
    expect(recall.memories).toHaveLength(2);
    expect(recall.memoryHits).toEqual([
      { id: "m1", source: "player" },
      { id: "m2", source: "dream" },
    ]);
    expect(recall.memoryHits).toHaveLength(recall.memories.length);
  });

  it("source 缺失回退 unknown（不猜来源）", () => {
    const recall = recallForDialogue(fakeWithRows([{ id: "m1", content: "一句话" }]), "在干嘛呢");
    expect(recall.memoryHits).toEqual([{ id: "m1", source: "unknown" }]);
  });

  it("没有命中时省略 memoryHits（旧调用行为不变）", () => {
    const recall = recallForDialogue(fakeWithRows([]), "在干嘛呢");
    expect(recall.memoryHits).toBeUndefined();
  });

  it("formatRecallHitLog：source 按计数降序/字典序聚合，且不含内容与 query", () => {
    const line = formatRecallHitLog("qq", [
      { id: "a", source: "player" },
      { id: "b", source: "qq_contact_verified" },
      { id: "c", source: "player" },
    ]);
    expect(line).toBe("[recall-hit] ch=qq n=3 ids=a,b,c src=player:2,qq_contact_verified:1");
    expect(line).not.toContain("你看");
    expect(line).not.toContain("在干嘛");
  });

  it("formatRecallHitLog：空命中输出 n=0", () => {
    expect(formatRecallHitLog("qq", [])).toBe("[recall-hit] ch=qq n=0 ids= src=");
  });

  it("源码锁：daemon 一处落 [recall-hit]，插件 host 不落（S3c2 后置）", () => {
    const qqRunner = readFileSync(join(HERE, "..", "src", "autonomy", "qq-runner.ts"), "utf8");
    const plugin = readFileSync(join(HERE, "..", "src", "plugin", "index.ts"), "utf8");
    const recallSrc = readFileSync(join(HERE, "..", "src", "dialogue", "recall.ts"), "utf8");
    expect(qqRunner).toContain('input.log(formatRecallHitLog("qq", r.memoryHits))');
    expect(qqRunner).toContain("if (r.memoryHits !== undefined && r.memoryHits.length > 0)");
    expect(plugin).not.toContain("formatRecallHitLog");
    expect(recallSrc).toContain("memoryHits");
  });
});
