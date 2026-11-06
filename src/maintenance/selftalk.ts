/**
 * 内部言语（inner speech）与记忆的三条路径。
 *
 * 依据《自言自语与记忆》：
 *   - 清醒时近一半认知是「不在当下」的自发思维（DMN）；内部言语是其最可测的一层。
 *   - 三条（有争议但可测）：①回指式复现（rehearsal）→ 鲜活度↑；②情绪再巩固（reconsolidation window）
 *     → 同一件事的「现在重述版本」情绪底色可被改写，内容与可信度不动；③方向跑偏 → 干扰代价。
 *   - 约束：她只能复现/重写**自己记得的**（热/温），没有的不能凭空补全。
 *
 * 纯函数：不读盘、不写状态、不碰时钟、不用随机。
 */

import { knobNumber } from "../engine/config.js";
import type { EngineConfig } from "../engine/config.js";
import { diceBigrams } from "./echo-guard.js";

/** §4.2 的冷热分层结果；内部言语只允许触碰 hot / warm */
export type SelfTalkTier = "hot" | "warm" | "cold";

/** 被她「想到」的一条记忆的最小投影（不是 MemoryRecord 全量） */
export interface SelfTalkSeed {
  id: string;
  tags: readonly string[];
  vividness: number;
  unresolved: number;
  tier: SelfTalkTier;
  /** 编码时的情绪底色（来自 encode_state.valence），用于再巩固改写 */
  valence: number;
  /**
   * 这条记忆的实际内容（截断）。没有它，提示词里只剩 tag，模型只能编「刚才那件小事」——
   * 2026-10-30 实测：13 条内部言语有 6 条以「用户，刚才那件小事…」开头，就是因为材料只有分类标签。
   */
  gist?: string;
}

/** 此刻的心境（只读，不改） */
export interface SelfTalkMood {
  valence: number;
  arousal: number;
}

export type SelfTalkKind = "replay" | "wander" | "reflect";

const WANDER_FRAME = "没有具体想起什么，只是让念头自己飘一会儿；不要编造细节，也不要报告检索结果。";

export interface SelfTalkPlan {
  kind: SelfTalkKind;
  /** 被回指的条目 id（按相关度降序，最多 SELFTALK_MAX_SEEDS 条） */
  seeds: readonly string[];
  /** 给渲染器的一句话方向（第一人称，不是最终台词） */
  frame: string;
  /** 被想起的话题词（tags 前两个；wander 时为空） */
  topics: readonly string[];
  maxSeeds: number;
  /** 选材路径：fresh=24h 内没用过；rotate=全想过→按最久未用轮换；none=没有材料 */
  pick?: SeedPickReason;
  /** 本轮开口角度（一句方向指令，不是写死的台词模板） */
  angle?: string;
  /** 给日志的一句话：为什么选到这些材料 */
  note?: string;
}

/** 生成出的内部言语相对种子的关系（用于决定走哪条路径） */
export type SelfTalkRelation = "related" | "divergent" | "unrelated";

export interface SelfTalkRewrite {
  id: string;
  /** 情绪底色的位移（带符号，已按 SELFTALK_REWRITE_FACTOR 缩到 ≤0.2） */
  valenceShift: number;
}

export interface SelfTalkEffects {
  relation: SelfTalkRelation;
  /** 回指式复现的鲜活度加成：[id, +delta] */
  vividness: readonly (readonly [string, number])[];
  /** 「没想通」的松动量（正数=下降） */
  unresolvedRelief: number;
  /** 是否够格进下一轮睡眠巩固（只提信号，真正的 consolidate 由调用方决定） */
  consolidate: boolean;
  /** 方向跑偏的干扰代价 */
  interference: boolean;
  /** 再巩固改写（至多一条） */
  rewrite: SelfTalkRewrite | undefined;
}

function tierWeight(tier: SelfTalkTier): number {
  if (tier === "hot") return 0.3;
  if (tier === "warm") return 0.2;
  return 0;
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** 同一材料在 recent 里每出现一次扣多少分（降权，不是排除） */
const REPEAT_PENALTY_STEP = 0.15;
const REPEAT_PENALTY_MAX = 0.45;

export type SeedPickReason = "fresh" | "rotate" | "none";

/**
 * 一轮可以换的开口角度：是「从哪儿起头」的方向，不是写死的台词模板。
 *
 * F311：旧提示词只要求「围绕材料说」，模型就每次用材料的原句起头（「你回来啦」×17/20）。
 * 这里给的是**入口方位**（动作/细节/半句念头），说法仍旧由她自己的口吻决定。
 */
const OPENING_ANGLES = [
  "从一个具体的动作或手里的东西起头：先说你现在正在做的这件小事，再让它带你想到材料。",
  "从一个细节起头：光、声音、温度、味道，或某样东西的位置；不要用「你回来了」「今天」「用户」开头。",
  "不用交代前因后果，直接从一句没头没尾的念头起头，像自言自语被人听见。",
  "先挑材料里最不起眼的一处（一个词、一个动作），再说你现在想到哪儿了。",
] as const;

/** 按种子 id + 轮次选一个开口角度：同一个材料也会因为轮次不同换起头（确定性，便于测试） */
export function pickOpeningAngle(seedIds: readonly string[], variant: number): string {
  let hash = Math.abs(Math.floor(variant)) % 997;
  for (const id of seedIds) {
    for (const ch of id) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return OPENING_ANGLES[hash % OPENING_ANGLES.length]!;
}

export interface SeedPick {
  readonly seeds: readonly SelfTalkSeed[];
  readonly reason: SeedPickReason;
  /** 给日志的一句话（选材口径） */
  readonly note: string;
}

/**
 * 选材（纯函数，便于穷举测试）。
 *
 * 1) 24h 内想过（avoid）的材料先让路；
 * 2) 同一材料在 recent 里出现次数越多分数越低（降权）；
 * 3) 全都被想过时**不再回落到全集按鲜活度重打分**——那会让 3 条高 vividness 的用户记忆
 *    每天独占 Top-3（F311 的根因）；改为按「最久没被想到」轮换，并把理由交给日志。
 */
export function pickSelfTalkSeeds(input: {
  readonly seeds: readonly SelfTalkSeed[];
  readonly avoid?: readonly string[];
  readonly recent?: readonly string[];
  readonly maxSeeds: number;
}): SeedPick {
  const usage = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  (input.recent ?? []).forEach((id, index) => {
    usage.set(id, (usage.get(id) ?? 0) + 1);
    lastSeen.set(id, index);
  });
  const score = (s: SelfTalkSeed): number =>
    clamp(s.vividness, 0, 1) * 0.5 +
    clamp(s.unresolved, 0, 1) * 0.4 +
    tierWeight(s.tier) -
    Math.min(REPEAT_PENALTY_MAX, REPEAT_PENALTY_STEP * (usage.get(s.id) ?? 0));

  const visible = input.seeds.filter((s) => s.tier !== "cold");
  const avoid = new Set(input.avoid ?? []);
  const fresh = visible.filter((s) => !avoid.has(s.id));
  if (fresh.length > 0) {
    const ranked = [...fresh].sort((a, b) => (score(b) === score(a) ? a.id.localeCompare(b.id) : score(b) - score(a)));
    return {
      seeds: ranked.slice(0, Math.max(1, input.maxSeeds)),
      reason: "fresh",
      note: `24h 内没想过 ${fresh.length}/${visible.length} 条可选`,
    };
  }
  if (visible.length > 0) {
    const rotated = [...visible].sort((a, b) => {
      const la = lastSeen.get(a.id) ?? -1;
      const lb = lastSeen.get(b.id) ?? -1;
      if (la !== lb) return la - lb;
      if (score(a) !== score(b)) return score(b) - score(a);
      return a.id.localeCompare(b.id);
    });
    return {
      seeds: rotated.slice(0, Math.max(1, input.maxSeeds)),
      reason: "rotate",
      note: "24h 内全想过 → 按最久未用轮换（不按鲜活度回落）",
    };
  }
  return { seeds: [], reason: "none", note: "没有可想的材料（全是 cold）" };
}

/**
 * 选种子 + 定调子。
 *
 * 排序：鲜活度 0.5 + 未解决 0.4 + 热度权重 0.3（同分按 id 稳定）。
 * cold 一律不进（INV-7 的可见性同样约束自发思维：想不起来就是想不起来）。
 */
export function planSelfTalk(input: {
  seeds: readonly SelfTalkSeed[];
  mood: SelfTalkMood;
  cfg: EngineConfig;
  /** 最近 24h 已经想过的种子：优先换别的，避免反复重播同一个念头 */
  avoid?: readonly string[];
  /** 最近想过的种子 id，按时间从旧到新（可重复）：用于降权与「最久未用」轮换 */
  recent?: readonly string[];
  /** 轮次/变体号（一般传日记条数）：让同一个材料也换起头角度 */
  variant?: number;
  /**
   * task-169 B：最近 24h 日记正文，用于多样性判断。
   *
   * 只做「换一个材料」，不改选材算法本身：top 材料的 gist 与最近日记重叠（Dice ≥ 0.5）
   * 时把下一个不重叠的材料提到前面——否则同一件小事会被反复讲成同一句话。
   */
  recentTexts?: readonly string[];
}): SelfTalkPlan {
  const maxSeeds = Math.max(1, Math.floor(knobNumber(input.cfg, "SELFTALK_MAX_SEEDS")));
  const picked = pickSelfTalkSeeds({
    seeds: input.seeds,
    maxSeeds,
    ...(input.avoid === undefined ? {} : { avoid: input.avoid }),
    ...(input.recent === undefined ? {} : { recent: input.recent }),
  });
  let visible = picked.seeds;
  // task-169 B：多样性。top 材料与最近日记里的说法重叠时，换下一个不重叠的材料；
  // 全都不重叠/全都重叠时保持原样（宁可按原排序，也不硬凑一个更差的）。
  const recentTexts = input.recentTexts ?? [];
  let diversityNote: string | undefined;
  if (recentTexts.length > 0 && visible.length > 1) {
    const distinct = visible.filter((v) => !recentTexts.some((t) => diceBigrams(v.gist ?? "", t) >= 0.5));
    if (distinct.length > 0 && distinct[0]?.id !== visible[0]?.id) {
      visible = [...distinct, ...visible.filter((v) => !distinct.includes(v))];
      diversityNote = "多样性：top 与最近日记重叠，已换下一个材料";
    }
  }

  const top = visible[0];
  if (top === undefined) {
    return { kind: "wander", seeds: [], frame: WANDER_FRAME, maxSeeds, topics: [], pick: "none", note: picked.note };
  }

  const unresolvedTop = Math.max(...visible.map((v) => clamp(v.unresolved, 0, 1)));
  const kind: SelfTalkKind = unresolvedTop >= 0.5 ? "reflect" : "replay";
  const moodNote =
    input.mood.valence < 0.4
      ? "此刻情绪偏低，重述会偏沉，别硬转成开心。"
      : input.mood.valence > 0.65
        ? "此刻情绪偏高，重述会偏亮，别假装低落。"
        : "此刻情绪平，按事情本来的重量重述。";
  // 只用中文标签当「话题」：记忆 tag 里混着 conversation/meme 这类英文分类，直接念出来不像人话。
  // 没有中文标签时退到记忆正文（gist），**不要**再用「刚才那件小事」这种空话——那会变成模型的口头禅。
  const cjk = top.tags.filter((t) => /[一-鿿]/.test(t)).slice(0, 2);
  const gist = (top.gist ?? "").trim();
  // 有正文就用正文当话题：标签是她自己的分类名（「聊天」「冷淡」），念出来像在报目录；
  // 没正文才退到中文标签，最后才是「一件小事」这种保底（不再固定成「刚才那件小事」）。
  const topics = gist !== "" ? [gist.slice(0, 12)] : cjk.length > 0 ? cjk : ["一件小事"];
  const materials = visible
    .map((v) => (v.gist ?? "").trim())
    .filter((g) => g !== "")
    .slice(0, maxSeeds);
  const angle = pickOpeningAngle(visible.map((v) => v.id), input.variant ?? 0);
  const NL = "\n";
  const materialNote =
    materials.length === 0
      ? ""
      : `材料（你记得的事；它不是给你照抄的句子，可以只取其中一处来想）：${NL}${materials.map((m) => `- ${m}`).join(NL)}${NL}`;
  const opening =
    gist !== ""
      ? `想起的是「${gist.slice(0, 24)}」这件事。`
      : cjk.length > 0
        ? `想起的是和「${cjk.join("、")}」有关的这件事。`
        : "想起了一件小事。";
  const frame = `${opening}${NL}${materialNote}这一轮这样开口：${angle}${NL}${moodNote}`;

  const note = diversityNote === undefined ? picked.note : `${picked.note}；${diversityNote}`;
  return { kind, seeds: visible.map((v) => v.id), frame, maxSeeds, topics, pick: picked.reason, angle, note };
}

const SPLIT = /[^\p{L}\p{N}]+/u;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(SPLIT)
    .filter((t) => t.length > 0);
}

/**
 * 判断这句内部言语和材料的关系。
 * 命中任一 seed 的 tag → related；有材料但一个 tag 都没碰 → divergent（跑偏）；
 * 没有材料 → unrelated（纯漂浮，不产生记忆效应）。
 */
export function relateSelfTalk(text: string, seeds: readonly SelfTalkSeed[]): SelfTalkRelation {
  if (seeds.length === 0) return "unrelated";
  const words = tokens(text);
  if (words.length === 0) return "divergent";
  let hit = 0;
  let contentHit = 0;
  for (const seed of seeds) {
    for (const tag of seed.tags) {
      const t = tag.toLowerCase();
      if (t.length > 0 && words.some((w) => w.includes(t) || t.includes(w))) hit += 1;
    }
    if (relatedByContent(text, seed.gist ?? "")) contentHit += 1;
  }
  // 只按 tag 判定会把「有材料但换了说法」的言语误判成跑偏（实测 10-30 每轮都 divergent、
  // 每轮都吃干扰代价）。正文二元组命中同样算相关。
  return hit > 0 || contentHit > 0 ? "related" : "divergent";
}

/** 只按 tag 判定会让「用材料但换了说法」的言语被当成跑偏：中文按二元组比正文 */
function relatedByContent(text: string, gist: string): boolean {
  const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "");
  const t = norm(text);
  const g = norm(gist);
  if (t === "" || g.length < 4) return false;
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= g.length; i += 1) grams.add(g.slice(i, i + 2));
  if (grams.size === 0) return false;
  let matched = 0;
  for (const gram of grams) if (t.includes(gram)) matched += 1;
  return matched >= 2 && matched / grams.size >= 0.25;
}

/**
 * 三条路径的效应。所有数值都来自注册表（overlay 的 SELFTALK_* 键）。
 */
export function selfTalkEffects(
  relation: SelfTalkRelation,
  seeds: readonly SelfTalkSeed[],
  mood: SelfTalkMood,
  cfg: EngineConfig,
): SelfTalkEffects {
  const vividGain = Math.max(0, knobNumber(cfg, "SELFTALK_VIVIDNESS_GAIN"));
  const relief = Math.max(0, knobNumber(cfg, "SELFTALK_UNRESOLVED_RELIEF"));
  const loss = Math.max(0, knobNumber(cfg, "SELFTALK_INTERFERENCE_LOSS"));
  const rewriteFactor = clamp(knobNumber(cfg, "SELFTALK_REWRITE_FACTOR"), 0, 1);

  if (relation === "related") {
    const vividness = seeds.map((s) => [s.id, vividGain] as const);
    const rewrite = pickRewrite(seeds, mood, rewriteFactor);
    return {
      relation,
      vividness,
      unresolvedRelief: relief,
      consolidate: seeds.some((s) => clamp(s.unresolved, 0, 1) >= 0.4),
      interference: false,
      rewrite,
    };
  }
  if (relation === "divergent") {
    return {
      relation,
      vividness: seeds.map((s) => [s.id, -loss] as const),
      unresolvedRelief: 0,
      consolidate: false,
      interference: true,
      rewrite: undefined,
    };
  }
  return { relation, vividness: [], unresolvedRelief: 0, consolidate: false, interference: false, rewrite: undefined };
}

/** 只改情绪底色；位移由「现在的心境 vs 当时的底色」决定，且单次 ≤ 0.2 */
function pickRewrite(
  seeds: readonly SelfTalkSeed[],
  mood: SelfTalkMood,
  rewriteFactor: number,
): SelfTalkRewrite | undefined {
  if (mood.arousal < 0.4) return undefined;
  let best: { seed: SelfTalkSeed; gap: number } | undefined;
  for (const seed of seeds) {
    const gap = Math.abs(clamp(mood.valence, 0, 1) - clamp(seed.valence, 0, 1));
    if (gap < 0.3) continue;
    if (best === undefined || gap > best.gap) best = { seed, gap };
  }
  if (best === undefined) return undefined;
  const shift = clamp((clamp(mood.valence, 0, 1) - clamp(best.seed.valence, 0, 1)) * rewriteFactor, -0.2, 0.2);
  if (shift === 0) return undefined;
  return { id: best.seed.id, valenceShift: shift };
}

/**
 * 没有模型时的降级：仍然按「想起了什么」说一句，而不是把 frame 这种指令原样吐出来。
 * 只在自主进程没有 API key / 模型调用失败时使用；它保证循环不中断，也保证台词不越界。
 */
export function fallbackSelfTalk(plan: SelfTalkPlan): string {
  const topic = plan.topics.join("、");
  if (plan.kind === "wander" || topic === "") return "……（一个人坐着发了会儿呆，什么也没想清楚）";
  if (plan.kind === "reflect") return `又绕回「${topic}」上了。想来想去，还是没个结果。`;
  return `忽然想起「${topic}」了。就那么一下，又过去了。`;
}
