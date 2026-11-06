/**
 * L2 知识条目的落盘存储（§6.3 的 11 字段，schema 见 `spec/schema/knowledge.schema.json`）。
 *
 * 和 L1 的 `Wal` 分开是刻意的：知识条目是"蒸馏"出来的，条数少、只增不改、按 id 幂等覆盖；
 * 而 L1 需要 tombstone 与压实。两套生命周期混在一个文件里，任何一次清理都会互相牵连。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { cosine, embedCached } from "./semantic.js";
// 只为了 id 推导规则（`idFor`）：consolidate 对 knowledge 只有 `import type`，不会成环
import { knowledgeIdFor } from "./consolidate.js";

export type KnowledgeType = "meme" | "news" | "trend" | "fact" | "lore";

export interface KnowledgeRecord {
  id: string;
  content: string;
  knowledge_type: KnowledgeType;
  source: string;
  source_credibility?: number;
  objective_freshness?: number;
  social_freshness?: number;
  freshness: number;
  access_count?: number;
  ingested_at?: number;
  worldview_translated?: boolean;
}

type Line = { op: "put"; rec: KnowledgeRecord };

/**
 * 中文停用字：这类字几乎每条知识里都出现，拿出来算词面重合只会把无关条目拉起来。
 * 只用于检索打分，不影响落库内容。
 */
const STOP_CHARS = new Set("的了吗呢啊吧么我你他她它是在有和就都也很不个这那什么怎么多少要会能说想看听觉得");

/** 取中文二元组（跳过含停用字的组合） */
function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    if ([...gram].some((ch) => STOP_CHARS.has(ch))) continue;
    out.push(gram);
  }
  return out;
}

/** 词面重合率：查询里的实词二元组有多少原样出现在条目里（0..1） */
function lexicalOverlap(query: string, content: string): number {
  const grams = [...new Set(bigrams(query))];
  if (grams.length === 0) return 0;
  let hit = 0;
  for (const gram of grams) if (content.includes(gram)) hit += 1;
  return hit / grams.length;
}

export class KnowledgeStore {
  private readonly records = new Map<string, KnowledgeRecord>();
  private corrupt = 0;
  private appended = 0;
  /** 最近一次同步时的文件指纹（size+mtimeMs）。外部改写文件后靠它发现"我读到的是旧的" */
  private seen: { size: number; mtimeMs: number } | null = null;

  constructor(readonly path: string) {}

  /** 打开并回放；坏行只计数，不让一行 JSON 毁掉整个知识库 */
  open(): this {
    if (!existsSync(this.path)) return this;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Line;
        if (parsed?.op === "put" && parsed.rec?.id) this.records.set(parsed.rec.id, parsed.rec);
        else this.corrupt++;
      } catch {
        this.corrupt++;
      }
    }
    return this;
  }

  private fingerprint(): { size: number; mtimeMs: number } | null {
    try {
      const st = statSync(this.path);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * 文件被**外部**改过就重新回放。
   *
   * 为什么需要：清理脚本（`tools/report/audit-knowledge.mjs --fix`）会重写这个文件，
   * 而运行中的插件只会读它自己内存里的 `records`。实测过一次：磁盘上已删掉 2 条离题条目，
   * 进程内仍然能召回到它们（stats 51 vs 磁盘 49），必须重启插件才干净——那是"清账不彻底"，
   * 比没清更危险。这里改为读之前先比 size+mtime，变了就重放，代价是一次 stat。
   */
  refreshIfChanged(): boolean {
    const next = this.fingerprint();
    const same =
      this.seen !== null && next !== null && next.size === this.seen.size && next.mtimeMs === this.seen.mtimeMs;
    if (same) return false;
    this.records.clear();
    this.corrupt = 0;
    this.open();
    this.seen = next;
    return true;
  }

  /** 按 id 幂等：同一个簇重复蒸馏只保留最后一次的内容 */
  put(rec: KnowledgeRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify({ op: "put", rec }) + "\n", "utf8");
    this.appended++;
    this.records.set(rec.id, rec);
    this.seen = this.fingerprint();
  }

  /**
   * 按半衰期重算全库 `freshness`（§6.3）。
   *
   * 为什么需要：`freshness` 是检索打分与好奇心缺口的输入，但它写入时被拍成常量 1
   * （bili 入库的默认值），此后**从不衰减** —— 旧知识永远"新鲜"，好奇心缺口永远是 0。
   * 睡眠那一拍重算一次，变化按 WAL 追加（append-only，不改内存里的旧值）。
   *
   * `score` 由 runtime 注入：store 不知道 EngineConfig，也不能 import engine（分层）。
   * 返回真正改动的条数；只改变化超过 epsilon 的记录，避免每天把全库重写一遍。
   */
  recomputeFreshness(score: (rec: KnowledgeRecord) => number | null, epsilon = 0.02): number {
    let changed = 0;
    for (const rec of [...this.records.values()]) {
      const next = score(rec);
      if (next === null || !Number.isFinite(next)) continue;
      const clamped = Math.min(1, Math.max(0, next));
      if (Math.abs(clamped - rec.freshness) <= epsilon) continue;
      this.put({ ...rec, freshness: clamped });
      changed += 1;
    }
    return changed;
  }

  get(id: string): KnowledgeRecord | undefined {
    this.refreshIfChanged();
    return this.records.get(id);
  }

  has(id: string): boolean {
    this.refreshIfChanged();
    return this.records.has(id);
  }

  /**
   * 幂等 id 的推导（`kn_<hash>`）。
   *
   * 为什么长在 store 上、而不是让调用方自己算：`bili/ingest.ts` 与 `bili/notes.ts`
   * 是工具层，按分层门禁不能 import `memory/consolidate.ts`（R3）。而 id 规则
   * 必须只有一份——重复写入的幂等就靠它。于是规则留在 consolidate，工具层
   * 通过 `KnowledgeWritePort.idFor(tag)` 拿到结果。
   */
  idFor(tag: string): string {
    return knowledgeIdFor(tag);
  }

  /** 按 id 升序，稳定输出（便于 diff 与断言） */
  /**
   * 按「这段话在说什么」找相关条目（给对话用的轻量召回）。
   *
   * 为什么不用 tag：知识条目没有 tag，只有一句 `content`；所以直接用 §6.6 同一套
   * hashing 向量算余弦，再乘一个 freshness 权重——刚学到的更容易被想起，旧知识
   * 只在语义上真的很近时才冒头。阈值 0.08 是实测出来的：低于它的条目基本都是
   * 只是碰巧共享一两个汉字，塞进提示词会让台词跑题。
   */
  search(query: string, limit = 2): KnowledgeRecord[] {
    this.refreshIfChanged();
    const q = query.trim();
    if (q === "" || limit <= 0) return [];
    const qv = embedCached(q);
    const scored: { rec: KnowledgeRecord; score: number }[] = [];
    for (const rec of this.records.values()) {
      const sim = cosine(qv, embedCached(rec.content));
      // 纯向量相似度对中文长句太松（"你在干嘛呢"也能撞上崩坏3），所以掺一半词面重合：
      // 问「李善长案」时能精确捞到那条，寒暄则整体掉到阈值以下——宁可不提，也别硬把话题拽走。
      const hybrid = 0.5 * sim + 0.5 * lexicalOverlap(q, rec.content);
      const score = hybrid * (0.8 + 0.2 * Math.min(1, Math.max(0, rec.freshness)));
      if (score >= 0.25) scored.push({ rec, score });
    }
    scored.sort((a, b) => (b.score === a.score ? (b.rec.ingested_at ?? 0) - (a.rec.ingested_at ?? 0) : b.score - a.score));
    return scored.slice(0, limit).map((x) => x.rec);
  }

  all(): KnowledgeRecord[] {
    this.refreshIfChanged();
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  size(): number {
    this.refreshIfChanged();
    return this.records.size;
  }

  stats(): { size: number; corrupt: number; appended: number } {
    this.refreshIfChanged();
    return { size: this.records.size, corrupt: this.corrupt, appended: this.appended };
  }
}
