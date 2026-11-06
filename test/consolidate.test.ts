import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/engine/config.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { KnowledgeStore } from "../src/memory/knowledge.js";
import {
  clusterEpisodic,
  consolidate,
  distillContent,
  hashTag,
  isValidBeliefUpdate,
  knowledgeIdFor,
  makeKnowledge,
  type EpisodicCluster,
} from "../src/memory/consolidate.js";

const cfg = loadConfig();
const TMP = fileURLToPath(new URL("../.tmp/knowledge", import.meta.url));
mkdirSync(TMP, { recursive: true });
const tmpFile = () => join(TMP, `${randomUUID()}.ndjson`);

const NOW = 1_700_000_000_000;

function rec(id: string, extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord {
  return makeMemory({
    id,
    content: `事件-${id}`,
    source: "player",
    created_at: NOW,
    tags: ["conversation"],
    ...extra,
  });
}

const batch = (n: number, extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord[] =>
  Array.from({ length: n }, (_, i) => rec(`m${i}`, extra));

describe("§7.3 L1 聚类", () => {
  it("同一 tag 够 5 条 → 一个簇，证据数就是成员数", () => {
    const clusters = clusterEpisodic(batch(5), { cfg });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.tag).toBe("conversation");
    expect(clusters[0]?.evidenceCount).toBe(5);
  });

  it("只有 4 条 → 不构成簇（门槛默认 CONSOLIDATION_THRESHOLD=5）", () => {
    expect(clusterEpisodic(batch(4), { cfg })).toHaveLength(0);
    // 显式降低门槛就能聚出来——门槛是参数，不是硬编码
    expect(clusterEpisodic(batch(4), { cfg, minSize: 4 })).toHaveLength(1);
  });

  it("不可信来源在聚类前就被滤掉（否则一条 web 会把整簇拖成污点）", () => {
    expect(clusterEpisodic(batch(5, { source: "web" }), { cfg })).toHaveLength(0);
    const mixed = [...batch(4), rec("web1", { source: "web" })];
    expect(clusterEpisodic(mixed, { cfg })).toHaveLength(0);
  });

  it("被遗忘/被压制的记忆不参与巩固", () => {
    // makeMemory 的 seed 不含这两个字段（它们由 store 在运行期改），所以在记录上覆盖
    const forgotten = batch(5).map((m) => ({ ...m, forgotten: true }));
    expect(clusterEpisodic(forgotten, { cfg })).toHaveLength(0);
    const suppressed = batch(5).map((m) => ({ ...m, suppressed_by_stronger: true }));
    expect(clusterEpisodic(suppressed, { cfg })).toHaveLength(0);
  });

  it("簇内有一条污点记忆 → 整簇标记 tainted，并给出原因", () => {
    const clusters = clusterEpisodic([...batch(4), rec("t1", { retrieved_under_taint: true })], { cfg });
    expect(clusters[0]?.stateProvenance).toBe("tainted");
    expect(clusters[0]?.taintReason).toContain("retrieved_under_taint");
  });

  it("多个 tag 分别成簇，按 tag 字典序输出（可复现）", () => {
    const mixed = [
      ...batch(5, { tags: ["b"] }),
      ...Array.from({ length: 5 }, (_, i) => rec(`x${i}`, { tags: ["a"] })),
    ];
    expect(clusterEpisodic(mixed, { cfg }).map((c) => c.tag)).toEqual(["a", "b"]);
  });
});

describe("§8.1 四道闸（顺序即规格顺序）", () => {
  const cluster: EpisodicCluster = {
    tag: "conversation",
    members: batch(5),
    evidenceCount: 5,
    source: "player",
    stateProvenance: "trusted",
    taintReason: null,
  };
  const base = { cluster, memoryLayer: "L1_episodic", evidenceCount: 5, source: "player", stateProvenance: "trusted" as const };

  it("ACCEPTED：来源可信、L1、无污点、证据够", () => {
    expect(isValidBeliefUpdate(base, cfg).verdict).toBe("ACCEPTED");
  });

  it("REJECTED_SOURCE：来源不在 RELATION_SOURCES", () => {
    const v = isValidBeliefUpdate({ ...base, source: "web" }, cfg);
    expect(v.verdict).toBe("REJECTED_SOURCE");
  });

  it("REJECTED_LAYER：只有 L1_episodic 能进信念更新", () => {
    const v = isValidBeliefUpdate({ ...base, memoryLayer: "L2_knowledge" }, cfg);
    expect(v.verdict).toBe("REJECTED_LAYER");
  });

  it("REJECTED_TAINTED_STATE：簇内记忆在污染下被检索过", () => {
    const v = isValidBeliefUpdate(
      { ...base, stateProvenance: "tainted", cluster: { ...cluster, stateProvenance: "tainted" } },
      cfg,
    );
    expect(v.verdict).toBe("REJECTED_TAINTED_STATE");
  });

  it("REJECTED_EVIDENCE：证据 4 < 门槛 5", () => {
    const v = isValidBeliefUpdate({ ...base, evidenceCount: 4 }, cfg);
    expect(v.verdict).toBe("REJECTED_EVIDENCE");
  });

  it("顺序：来源与层同时不满足时，报先命中的那条", () => {
    const v = isValidBeliefUpdate({ ...base, source: "web", memoryLayer: "L2_knowledge" }, cfg);
    expect(v.verdict).toBe("REJECTED_SOURCE");
  });
});

describe("§7.3 蒸馏与知识条目", () => {
  it("knowledgeIdFor 由 tag 决定，重复巩固不产生第二条", () => {
    const id = knowledgeIdFor("conversation");
    expect(id).toMatch(/^kn_[0-9a-f]{8}$/);
    expect(knowledgeIdFor("conversation")).toBe(id);
    expect(knowledgeIdFor("other")).not.toBe(id);
    expect(hashTag("conversation")).toHaveLength(8);
  });

  it("兜底蒸馏文本带 tag 与证据数，并把重复内容去掉", () => {
    const [c] = clusterEpisodic(batch(5), { cfg });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const text = distillContent(c);
    expect(text).toContain("关于「conversation」的 5 次经历");
    // 同一条内容只出现一次
    expect(text.split("事件-m0").length).toBe(2);
  });

  it("makeKnowledge：11 字段、默认 fact、freshness 起于 1", () => {
    const [c] = clusterEpisodic(batch(5), { cfg });
    expect(c).toBeDefined();
    if (c === undefined) return;
    const k = makeKnowledge(c, NOW);
    expect(Object.keys(k).sort()).toEqual(
      [
        "access_count",
        "content",
        "freshness",
        "id",
        "ingested_at",
        "knowledge_type",
        "objective_freshness",
        "social_freshness",
        "source",
        "source_credibility",
        "worldview_translated",
      ].sort(),
    );
    expect(k.knowledge_type).toBe("fact");
    expect(k.freshness).toBe(1);
    expect(k.ingested_at).toBe(NOW);
  });

  it("模型给的洞见优先于兜底文本（这是 extract_insight 的唯一 LLM 入口）", () => {
    const [c] = clusterEpisodic(batch(5), { cfg });
    if (c === undefined) throw new Error("fixture 没聚出簇");
    const k = makeKnowledge(c, NOW, { content: " 他每次沉默都是在等我先开口  ", knowledgeType: "lore" });
    expect(k.content).toBe("他每次沉默都是在等我先开口");
    expect(k.knowledge_type).toBe("lore");
  });
});

describe("§7.3 一轮巩固", () => {
  it("5 条可信 L1 → 1 条知识，没有被拒的", () => {
    const r = consolidate(batch(5), cfg, NOW);
    expect(r.clusters).toHaveLength(1);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
    expect(r.accepted[0]?.knowledge.id).toBe(knowledgeIdFor("conversation"));
  });

  it("有污点的簇被拒且带拒绝码（不是静默丢弃）", () => {
    const r = consolidate([...batch(4), rec("t", { retrieved_under_taint: true })], cfg, NOW);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.check.verdict).toBe("REJECTED_TAINTED_STATE");
  });

  it("不写磁盘：纯函数返回，落库是插件的事", () => {
    const before = JSON.stringify(consolidate(batch(5), cfg, NOW));
    const after = JSON.stringify(consolidate(batch(5), cfg, NOW));
    expect(before).toBe(after);
  });
});

describe("§6.3 L2 知识库落盘", () => {
  it("写入后重开能回放，同 id 覆盖而不是追加第二条", () => {
    const path = tmpFile();
    const store = new KnowledgeStore(path).open();
    const [c] = clusterEpisodic(batch(5), { cfg });
    if (c === undefined) throw new Error("fixture 没聚出簇");
    const k1 = makeKnowledge(c, NOW, { content: "第一版" });
    store.put(k1);
    expect(store.size()).toBe(1);

    const reopened = new KnowledgeStore(path).open();
    expect(reopened.size()).toBe(1);
    expect(reopened.get(k1.id)?.content).toBe("第一版");

    reopened.put(makeKnowledge(c, NOW, { content: "第二版" }));
    const again = new KnowledgeStore(path).open();
    expect(again.size()).toBe(1);
    expect(again.get(k1.id)?.content).toBe("第二版");
  });

  it("坏行只计数，不让一条 JSON 毁掉整个知识库", () => {
    const path = tmpFile();
    const store = new KnowledgeStore(path).open();
    const [c] = clusterEpisodic(batch(5), { cfg });
    if (c === undefined) throw new Error("fixture 没聚出簇");
    store.put(makeKnowledge(c, NOW));
    // 追加一条坏行
    appendFileSync(path, "{not json}\n", "utf8");
    const reopened = new KnowledgeStore(path).open();
    expect(reopened.size()).toBe(1);
    expect(reopened.stats().corrupt).toBe(1);
  });
});

describe("知识库外部改写（清账脚本重写后，运行中的实例不能还拿着旧的）", () => {
  it("磁盘被删掉条目后，读之前先发现并重放", () => {
    const base = fileURLToPath(new URL("../../.tmp-probe/", import.meta.url)).replace(/^\/([A-Za-z]:\/)/, "$1");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "kb-"));
    const path = join(dir, "knowledge.ndjson");
    const a = { id: "kn_keep", content: "留下的", knowledge_type: "trend" as const, source: "bili", freshness: 1 };
    const b = { id: "kn_drop", content: "该删的", knowledge_type: "trend" as const, source: "bili", freshness: 1 };
    const store = new KnowledgeStore(path).open();
    store.put(a);
    store.put(b);
    expect(store.size()).toBe(2);

    // 模拟清理脚本：只留一条，整文件重写
    writeFileSync(path, JSON.stringify({ op: "put", rec: a }) + "\n", "utf8");

    expect(store.size()).toBe(1);
    expect(store.has("kn_drop")).toBe(false);
    expect(store.get("kn_keep")?.content).toBe("留下的");
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件没变时不重放（put 之后立刻读仍是同一份内存）", () => {
    const base2 = fileURLToPath(new URL("../../.tmp-probe/", import.meta.url)).replace(/^\/([A-Za-z]:\/)/, "$1");
    mkdirSync(base2, { recursive: true });
    const dir = mkdtempSync(join(base2, "kb2-"));
    const path = join(dir, "knowledge.ndjson");
    const store = new KnowledgeStore(path).open();
    store.put({ id: "kn_x", content: "x", knowledge_type: "fact", source: "bili", freshness: 1 });
    expect(store.refreshIfChanged()).toBe(false);
    expect(store.size()).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
