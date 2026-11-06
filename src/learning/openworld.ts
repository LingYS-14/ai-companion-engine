/**
 * §10.1 开放世界五段漏斗——第 2 段（廉价预筛）与第 5 段（睡眠缓冲）。
 *
 * 规格的五段是：抓 7 天快照 → **廉价预筛（淘汰 >90%）** → LLM 摘要 → 来源门控 →
 * **睡眠巩固缓冲，不当场写库**。这里实现其中两段纯逻辑（预筛打分、缓冲队列），
 * 抓取仍在工具层（`bili/public.ts` 的 `fetchPopular`），写库仍在执行层
 * （`bili/ingest.ts` 的 `ingestVideos`，睡眠巩固时由宿主调用）。
 *
 * 三条设计约束（踩过才知道）：
 *   1. **不许在预筛里调模型**：这一段的意义就是"便宜"，用播放/点赞/新近/标题长度做线性打分；
 *      真要用 embedding 也是本地算，不是 LLM。
 *   2. **打分必须可复现**：同样的输入 + 同样的 now 必须给同样的分数与顺序，否则线上没法回放
 *      （`tr-*` trace 里也记不进分数）。所以 tie-break 用 bvid 字典序，不用随机。
 *   3. **缓冲落盘要原子**：`.tmp-<pid>` + rename。半写坏的 JSON 会让下一轮整批候选丢掉——
 *      读的时候坏行跳过、整文件坏就给空缓冲，不抛（凌晨 3 点抛异常会让她连巩固都不做）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 漏斗看到的视频（结构上就是序列化后的 `BiliVideo`，故意不 import 工具层类型） */
export interface FunnelVideo {
  readonly bvid: string;
  readonly title: string;
  readonly play?: number;
  readonly like?: number;
  /** 发布时间（epoch ms）；热门榜与搜索结果都可能缺 */
  readonly pubdateMs?: number;
  readonly durationSec?: number;
  readonly owner?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
}

export interface ScoredVideo {
  readonly video: FunnelVideo;
  readonly score: number;
  /** 分数由哪几项构成（日志/测试用，便于解释"为什么留了这条"） */
  readonly parts: {
    readonly recency: number;
    readonly popularity: number;
    readonly engagement: number;
    readonly title: number;
  };
}

/** 新鲜度半衰：7 天没更新的热点掉到 0.5。与学习计划"看 7 天快照"同一时间尺度 */
export const FUNNEL_RECENCY_HALF_LIFE_MS = 7 * 86_400_000;
/** 播放量归一化的参考点：100 万播放算"很热"（log1p 压缩，防止头部一条通吃） */
const FUNNEL_POPULARITY_REF = 1_000_000;
/** 标题的"合适长度"：24 字左右信息量最大；太长多是标题党 */
const FUNNEL_TITLE_IDEAL = 24;
/** 各分项权重（和为 1，纯常量不进注册表：这是算法常数，不是可调旋钮） */
const W_RECENCY = 0.4;
const W_POPULARITY = 0.35;
const W_ENGAGEMENT = 0.15;
const W_TITLE = 0.1;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const finiteOr = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : value;

/** 单条打分。缺 pubdate 时按"不新不旧"处理（0.5），不假装它刚发 */
export function scoreVideo(video: FunnelVideo, nowMs: number): ScoredVideo {
  const pub = video.pubdateMs;
  const recency = pub === undefined || !Number.isFinite(pub) ? 0.5 : clamp01(0.5 ** ((nowMs - pub) / FUNNEL_RECENCY_HALF_LIFE_MS));
  const play = Math.max(0, finiteOr(video.play, 0));
  const popularity = clamp01(Math.log1p(play) / Math.log1p(FUNNEL_POPULARITY_REF));
  const like = Math.max(0, finiteOr(video.like, 0));
  const engagement = play <= 0 ? 0 : clamp01(like / play);
  const titleLength = [...video.title].length;
  const title = clamp01(1 - Math.abs(titleLength - FUNNEL_TITLE_IDEAL) / 60);
  const parts = { recency, popularity, engagement, title };
  const score = W_RECENCY * recency + W_POPULARITY * popularity + W_ENGAGEMENT * engagement + W_TITLE * title;
  return { video, score, parts };
}

export interface PrefilterOptions {
  readonly nowMs: number;
  /** 保留几条。默认 3——一晚睡 8 小时、每轮都收，缓冲会膨胀，所以单轮宁少勿多 */
  readonly keep?: number;
  /** 低于这个分数直接丢（默认 0 = 不设阈值，只靠 keep 截断） */
  readonly minScore?: number;
  /** 已经见过的 bvid（知识库已有的、或上一轮保留过的） */
  readonly seen?: readonly string[];
}

export interface PrefilterResult {
  readonly kept: readonly ScoredVideo[];
  readonly examined: number;
  readonly dropped: number;
  /** 淘汰率 = dropped / examined（规格要求 >0.9；候选少时达不到，如实返回） */
  readonly dropRate: number;
}

/**
 * 廉价预筛：去掉看过的/重复的，打分排序，截到 keep 条。
 *
 * 为什么要两趟：先过滤再排序，`examined` 才是"真正评估过的条数"，淘汰率才有意义；
 * 混在一起算会把幂等跳过的重复条目也算成"淘汰"，让人误以为筛得很狠。
 */
export function prefilterVideos(videos: readonly FunnelVideo[], options: PrefilterOptions): PrefilterResult {
  const keep = Math.max(1, Math.trunc(options.keep ?? 3));
  const minScore = options.minScore ?? 0;
  const seen = new Set(options.seen ?? []);
  const seenInBatch = new Set<string>();
  const candidates: FunnelVideo[] = [];
  for (const video of videos) {
    if (video.bvid.trim() === "" || seen.has(video.bvid) || seenInBatch.has(video.bvid)) continue;
    seenInBatch.add(video.bvid);
    candidates.push(video);
  }
  const scored = candidates
    .map((video) => scoreVideo(video, options.nowMs))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : a.video.bvid.localeCompare(b.video.bvid)));
  const examined = videos.length;
  const kept = scored.slice(0, keep);
  // dropped 相对"评估过的去重候选"算：重复条目不是"被筛掉的观点"，是同一件事
  const dropped = Math.max(0, candidates.length - kept.length);
  const dropRate = candidates.length === 0 ? 0 : dropped / candidates.length;
  return { kept, examined, dropped, dropRate };
}

export interface FunnelItem {
  readonly video: FunnelVideo;
  readonly score: number;
  /** 进缓冲的时刻：TTL 与"放了几轮"都按它算 */
  readonly at: number;
}

export interface BufferOptions {
  readonly path: string;
  /** 缓冲上限：满了丢最老的（睡眠巩固前的候选不值得留到明天） */
  readonly capacity?: number;
  /** 存活时间：超过就丢（热点过期了，写进知识库只会误导"最近在流行什么"） */
  readonly ttlMs?: number;
}

export interface BufferStats {
  readonly size: number;
  readonly droppedExpired: number;
  readonly droppedOverflow: number;
}

/** 缓冲文件形状。`version` 让以后换结构时能直接判废而不是猜 */
interface BufferFile {
  readonly version: 1;
  readonly items: readonly FunnelItem[];
}

const DEFAULT_CAPACITY = 40;
const DEFAULT_TTL_MS = 3 * 86_400_000;

function isFunnelItem(value: unknown): value is FunnelItem {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  const video = rec["video"];
  if (typeof video !== "object" || video === null) return false;
  const v = video as Record<string, unknown>;
  return typeof v["bvid"] === "string" && typeof v["title"] === "string" && typeof rec["at"] === "number" && typeof rec["score"] === "number";
}

/**
 * 睡眠巩固缓冲（第 5 段）。**不当场写库**：学习时只把候选放进来，凌晨巩固时才写。
 *
 * 为什么必须落盘：她的进程一晚上会被重启（发布/崩溃/守夜人），放内存里就丢了一整晚的候选。
 * 为什么容量这么小（40）：这不是"待办箱"，是"今晚值得消化的几条"。越大越像在囤垃圾。
 */
export class OpenWorldBuffer {
  private readonly path: string;
  private readonly capacity: number;
  private readonly ttlMs: number;
  private items: FunnelItem[] = [];
  private droppedExpired = 0;
  private droppedOverflow = 0;

  constructor(options: BufferOptions) {
    this.path = options.path;
    this.capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CAPACITY));
    this.ttlMs = Math.max(60_000, Math.trunc(options.ttlMs ?? DEFAULT_TTL_MS));
  }

  get filePath(): string {
    return this.path;
  }

  get size(): number {
    return this.items.length;
  }

  stats(): BufferStats {
    return { size: this.items.length, droppedExpired: this.droppedExpired, droppedOverflow: this.droppedOverflow };
  }

  /** 读盘。坏 JSON / 坏条目都跳过，不抛——凌晨巩固不能因为一个坏文件停下 */
  load(): void {
    this.items = [];
    this.droppedExpired = 0;
    this.droppedOverflow = 0;
    let raw: string;
    try {
      raw = readText(this.path);
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const file = parsed as Partial<BufferFile>;
    if (file.version !== 1 || !Array.isArray(file.items)) return;
    this.items = file.items.filter(isFunnelItem);
  }

  /**
   * 放一批候选。返回实际收下的条数。
   *
   * `seen` 由调用方传：知识库已有的 bvid 不该进来（否则巩固时整批被幂等跳过，白占容量）。
   */
  append(items: readonly FunnelItem[], nowMs: number, seen: readonly string[] = []): number {
    const blocked = new Set(seen);
    const blockedInBatch = new Set<string>();
    let accepted = 0;
    for (const item of items) {
      const bvid = item.video.bvid;
      if (bvid === "" || blocked.has(bvid) || blockedInBatch.has(bvid)) continue;
      if (nowMs - item.at > this.ttlMs) continue;
      blockedInBatch.add(bvid);
      this.items.push(item);
      accepted += 1;
    }
    // 去重：同一个 bvid 只留分最高的一份（多轮重复进缓冲时）
    const best = new Map<string, FunnelItem>();
    for (const item of this.items) {
      const prev = best.get(item.video.bvid);
      if (prev === undefined || item.score > prev.score) best.set(item.video.bvid, item);
    }
    // 老的排前面（FIFO）：drain 时先消化放得久的，容量溢出时被挤掉的也是最老的
    const deduped = [...best.values()].sort((a, b) => (a.at - b.at !== 0 ? a.at - b.at : b.score - a.score));
    const kept = deduped.filter((item) => nowMs - item.at <= this.ttlMs);
    this.droppedExpired += deduped.length - kept.length;
    const overflow = Math.max(0, kept.length - this.capacity);
    this.items = kept.slice(overflow);
    this.droppedOverflow += overflow;
    this.save();
    return accepted;
  }

  /** 取出（不清空文件里的其它条目）。`limit` 控制一晚最多写几条，防止一次灌库 */
  drain(nowMs: number, limit: number): FunnelItem[] {
    const take = Math.max(0, Math.trunc(limit));
    const alive = this.items.filter((item) => nowMs - item.at <= this.ttlMs);
    this.droppedExpired += this.items.length - alive.length;
    const out = alive.slice(0, take);
    const outIds = new Set(out.map((item) => item.video.bvid));
    this.items = alive.filter((item) => !outIds.has(item.video.bvid));
    this.save();
    return out;
  }

  private save(): void {
    const body: BufferFile = { version: 1, items: this.items };
    writeAtomic(this.path, `${JSON.stringify(body)}\n`);
  }
}

// ── 文件 I/O：只在宿主（她自己的进程）里跑，所以直接用 node:fs 同步接口 ──
function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
  } catch {
    // 落盘失败不抛：缓冲丢一批不该让她整晚不学（下一轮还会重新抓）
  }
}
