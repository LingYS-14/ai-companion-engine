/**
 * §5.4 再巩固的**触发候选**（纯函数）。
 *
 * 规格要的是「想起来的时候，带着今天的眼光重新解释一次旧事，写成一个新版本，旧版本进版本链」。
 * 这里只做**候选发现**，不做改写：
 *
 * - 改写必须有一句「为什么现在这么理解」——那句话只能由模型或人给。意图引擎的纪律是
 *   零模型调用，所以这一步到候选为止，交给人/评审决定谁去写补丁（见 docs/DESIGN.md）。
 * - 落盘形状在 `version-file.ts`（F201）：候选被采纳后由那一层写 `data/reconsolidation-<id>.json`。
 *
 * 判据刻意保守（宁可漏，不可冤）：
 * 1. 两条记忆都写下了**话题域**（来自 F189 的写入侧情境指纹），且相同；
 * 2. 在场者不冲突（两边都有在场者时要有交集）；
 * 3. 情绪底色**翻了面**（一条偏正、一条偏负），且数值差 ≥ `VALENCE_GAP_MIN`。
 *    这是「同一件事被重新看待」的最低成本代理——没有语义模型也能判，误报也只是多一条待审候选。
 */

import {
  AFFECT_NEGATIVE_MAX,
  AFFECT_POSITIVE_MIN,
  affectOf,
  type AffectBucket,
} from "./episode-write.js";

/** 情绪底色翻面所需的数值差；低于它多半是日常抖动，不配当"重新解释"。 */
export const VALENCE_GAP_MIN = 0.5;
/** 一次最多提几条：候选进人审，不是自动改写，但也不能一次刷爆。 */
export const MAX_RECONSOLIDATION_CANDIDATES = 5;

/** 判定只需要的只读字段（结构类型，便于测试）。 */
export interface ReconsolidationMemory {
  readonly id: string;
  readonly created_at: number;
  readonly participants?: readonly string[];
  readonly encode_ctx?: Readonly<Record<string, unknown>>;
  readonly encode_state?: Readonly<Record<string, number>>;
}

export type ReconsolidationReason = "valence_flip";

export interface ReconsolidationCandidate {
  /** 旧的那条（被重新解释的对象）。 */
  readonly olderMemoryId: string;
  /** 新的那条（带着新眼光的这一次回忆）。 */
  readonly newerMemoryId: string;
  readonly topicDomain: string;
  readonly reason: ReconsolidationReason;
  readonly olderValence: number;
  readonly newerValence: number;
  readonly valenceGap: number;
  readonly olderBucket: AffectBucket;
  readonly newerBucket: AffectBucket;
  /** 恒定 true：提醒调用方"这不是自动改写，得有人给解释"。 */
  readonly requiresExplanation: true;
}

export interface ReconsolidationSkipped {
  readonly noFingerprint: number;
  readonly noValence: number;
  readonly sameBucket: number;
  readonly smallGap: number;
  readonly participantsDiffer: number;
  readonly truncated: number;
}

export interface ReconsolidationPlan {
  readonly candidates: readonly ReconsolidationCandidate[];
  readonly scanned: number;
  readonly skipped: ReconsolidationSkipped;
  readonly note: string;
}

interface Cue {
  readonly topicDomain: string;
  readonly participants: readonly string[];
}

function stringsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/** 从写入侧指纹里取出可比对的线索；取不到就返回 null（不猜）。 */
function cueOf(memory: ReconsolidationMemory): Cue | null {
  const ctx = memory.encode_ctx;
  if (ctx === undefined || ctx === null) return null;
  const fingerprint = ctx["cue_fingerprint"];
  if (typeof fingerprint !== "object" || fingerprint === null) return null;
  const record = fingerprint as Record<string, unknown>;
  const topicDomain = record["topicDomain"];
  if (typeof topicDomain !== "string") return null;
  const domain = topicDomain.trim();
  if (domain === "" || domain.startsWith("unknown:")) return null;
  const fromCue = stringsOf(record["participants"]);
  const fromMemory = stringsOf(memory.participants);
  const participants = fromCue ?? fromMemory ?? [];
  return { topicDomain: domain, participants };
}

function valenceOf(memory: ReconsolidationMemory): number | null {
  const state = memory.encode_state;
  if (state === undefined || state === null) return null;
  const raw = state["valence"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // 没有在场者信息 = 不因此拦截
  const set = new Set(b);
  return a.some((item) => set.has(item));
}

function isFlip(older: AffectBucket, newer: AffectBucket): boolean {
  return (
    (older === "positive" && newer === "negative") || (older === "negative" && newer === "positive")
  );
}

interface Prepared {
  readonly memory: ReconsolidationMemory;
  readonly cue: Cue;
  readonly valence: number;
  readonly bucket: AffectBucket;
}

/**
 * 扫描一组记忆，挑出「同一话题、在场者不冲突、情绪翻面且差得够多」的候选。
 * 不修改入参；同输入同输出（按 created_at、id 稳定排序）。
 */
export function planReconsolidation(
  memories: readonly ReconsolidationMemory[],
  options: { readonly maxCandidates?: number; readonly valenceGapMin?: number } = {},
): ReconsolidationPlan {
  const maxCandidates = options.maxCandidates ?? MAX_RECONSOLIDATION_CANDIDATES;
  const valenceGapMin = options.valenceGapMin ?? VALENCE_GAP_MIN;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new RangeError(`maxCandidates 必须是正整数，收到 ${String(maxCandidates)}`);
  }
  if (!Number.isFinite(valenceGapMin) || valenceGapMin < 0 || valenceGapMin > 1) {
    throw new RangeError(`valenceGapMin 必须在 [0,1]，收到 ${String(valenceGapMin)}`);
  }

  const skipped: {
    noFingerprint: number;
    noValence: number;
    sameBucket: number;
    smallGap: number;
    participantsDiffer: number;
    truncated: number;
  } = {
    noFingerprint: 0,
    noValence: 0,
    sameBucket: 0,
    smallGap: 0,
    participantsDiffer: 0,
    truncated: 0,
  };

  const byTopic = new Map<string, Prepared[]>();
  for (const memory of memories) {
    const cue = cueOf(memory);
    if (cue === null) {
      skipped.noFingerprint += 1;
      continue;
    }
    const valence = valenceOf(memory);
    if (valence === null) {
      skipped.noValence += 1;
      continue;
    }
    const prepared: Prepared = { memory, cue, valence, bucket: affectOf(valence, 0) };
    const bucket = byTopic.get(cue.topicDomain);
    if (bucket === undefined) byTopic.set(cue.topicDomain, [prepared]);
    else bucket.push(prepared);
  }

  const candidates: ReconsolidationCandidate[] = [];
  for (const [topicDomain, group] of [...byTopic.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ordered = [...group].sort((a, b) => {
      if (a.memory.created_at !== b.memory.created_at) return a.memory.created_at - b.memory.created_at;
      return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
    });
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const older = ordered[index]!;
      const newer = ordered[index + 1]!;
      if (!overlaps(older.cue.participants, newer.cue.participants)) {
        skipped.participantsDiffer += 1;
        continue;
      }
      if (!isFlip(older.bucket, newer.bucket)) {
        skipped.sameBucket += 1;
        continue;
      }
      const valenceGap = Math.abs(newer.valence - older.valence);
      if (valenceGap < valenceGapMin) {
        skipped.smallGap += 1;
        continue;
      }
      candidates.push({
        olderMemoryId: older.memory.id,
        newerMemoryId: newer.memory.id,
        topicDomain,
        reason: "valence_flip",
        olderValence: older.valence,
        newerValence: newer.valence,
        valenceGap,
        olderBucket: older.bucket,
        newerBucket: newer.bucket,
        requiresExplanation: true,
      });
    }
  }

  candidates.sort((a, b) => {
    const olderA = memories.find((m) => m.id === a.olderMemoryId)?.created_at ?? 0;
    const olderB = memories.find((m) => m.id === b.olderMemoryId)?.created_at ?? 0;
    if (olderA !== olderB) return olderA - olderB;
    return a.olderMemoryId < b.olderMemoryId ? -1 : a.olderMemoryId > b.olderMemoryId ? 1 : 0;
  });

  const kept = candidates.slice(0, maxCandidates);
  skipped.truncated = candidates.length - kept.length;

  const note =
    kept.length === 0
      ? "没有需要重新解释的记忆（只提候选，不改写；改写要有人给一句解释）。"
      : `提出 ${String(kept.length)} 条再巩固候选（只提候选，不改写：每条都需要一句「为什么现在这么理解」）。`;

  return { candidates: kept, scanned: memories.length, skipped, note };
}

/** 一行摘要（日志/看板用），不含评价词。 */
export function describeReconsolidationPlan(plan: ReconsolidationPlan): string {
  const s = plan.skipped;
  return (
    `再巩固候选：${String(plan.candidates.length)} 条 / 扫描 ${String(plan.scanned)} 条` +
    `（无指纹 ${String(s.noFingerprint)}、无情绪 ${String(s.noValence)}、同底色 ${String(s.sameBucket)}、` +
    `差不够 ${String(s.smallGap)}、在场者不同 ${String(s.participantsDiffer)}、超上限 ${String(s.truncated)}）`
  );
}
