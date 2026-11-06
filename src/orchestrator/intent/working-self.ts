/**
 * §5.2 working self 闸门（P2 记忆改造的"过滤层"，纯函数，不改检索内核）
 *
 * 规格（docs/DESIGN.md-390）：
 *   workingSelfFilter(memories, intent, values) 只在调用侧做前置过滤，
 *   不改 ACT-R 内核、不改检索权重；过滤率 >90% 要报警（Conway 的 OGM 过度概括化
 *   正是闸门过严的结果——只剩"那段时间挺糟的"，具体细节全被挡在外面）。
 *   只看过滤率不够，还要看具体性比例 concreteness_ratio：
 *   < 0.5 连续 N≈20 次 → 闸门放宽一档（阈值 ×1.2）并记一条 self_note。
 *
 * 这个文件的诚实边界：
 *   - 现有记忆没有"当前目标"字段，也没有 value 标注；**没有信号就不拦**（fail-open），
 *     否则闸门会凭名字的相似度乱杀，那比没有闸门更糟；
 *   - 过滤率与具体性都写进诊断对象，调用方必须落日志，否则 §5.2 的可观测要求没兑现。
 */

import type { ValueKey } from "../../engine/personality.js";
import type { MemoryRecord } from "../../memory/types.js";
import { concretenessRatio, looksLikeEpisode, type EpisodeDetail } from "./episode.js";

/** 闸门判定只需要的只读字段；用结构类型而不是 MemoryRecord，便利测试与复用。 */
export interface WorkingSelfMemory {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly participants?: readonly string[];
  readonly encode_ctx?: Readonly<Record<string, unknown>>;
  readonly vividness?: number;
  readonly self_relevance?: number;
}

/** 闸门需要的意图形状（只读；不 import 整个 IntentionRecord，避免循环与过宽依赖）。 */
export interface WorkingSelfIntent {
  readonly id: string;
  /** 她此刻想做的那件事（第一人称短句）。 */
  readonly goal: string;
  /** 与目标相关的标签；缺省时 goalOk 恒真（没有信号不乱拦）。 */
  readonly tags?: readonly string[];
}

/** 当前目标与身份的价值排序（B 层）；只读，不改。 */
export type ValueOrder = Readonly<Record<ValueKey, number>>;

/** 价值权重低于这个数，就认为"这件事和她的取舍无关"。 */
export const VALUE_FLOOR = 0.2;

/** 过滤率报警线（§5.2：长期 >90% 说明闸门过严）。 */
export const FILTER_RATE_ALARM = 0.9;
/** 具体性报警线（<0.5 连续 20 次 → 放宽一档）。 */
export const CONCRETENESS_FLOOR = 0.5;
/** 连续多少次才真的放宽（规格 N≈20）。 */
export const LOW_CONCRETENESS_STREAK = 20;
/** 放宽系数。 */
export const RELAX_FACTOR = 1.2;

/** 被拦下来的原因：目标不一致 / 价值冲突。 */
export interface FilteredMemory {
  readonly memoryId: string;
  readonly reason: "goal_mismatch" | "value_incompatible";
}

export interface WorkingSelfResult<T extends WorkingSelfMemory> {
  readonly kept: readonly T[];
  readonly filtered: readonly FilteredMemory[];
  /** 过滤率 = filtered / total；total 为 0 时返回 null（"没检索"不是"全被拦"）。 */
  readonly filterRate: number | null;
  /** 一个便于直接打日志的一行摘要。 */
  readonly note: string;
}

/** 从 encode_ctx / tags 里读价值标注（`value:care` 或 `encode_ctx.value="care"`）。 */
function valueKeysOf(memory: WorkingSelfMemory): ValueKey[] {
  const keys: ValueKey[] = [];
  const fromCtx = memory.encode_ctx?.["value"];
  if (typeof fromCtx === "string") keys.push(fromCtx as ValueKey);
  for (const tag of memory.tags ?? []) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.startsWith("value:")) keys.push(trimmed.slice("value:".length) as ValueKey);
  }
  return keys;
}

/** 目标一致性：标签有交集才算相关；意图没有标签时不拦（fail-open）。 */
function relatedToGoal(memory: WorkingSelfMemory, intent: WorkingSelfIntent): boolean {
  const goalTags = intent.tags ?? [];
  if (goalTags.length === 0) return true;
  const memoryTags = new Set((memory.tags ?? []).map((t) => t.trim().toLowerCase()));
  return goalTags.some((t) => memoryTags.has(t.trim().toLowerCase()));
}

/** 价值兼容：有明确价值标注才判；没有标注就放行。 */
function valueCompatible(memory: WorkingSelfMemory, values: ValueOrder, floor: number): boolean {
  const keys = valueKeysOf(memory);
  if (keys.length === 0) return true;
  return keys.some((key) => (values[key] ?? 0) >= floor);
}

/** 放宽后的价值门槛：低于门槛才拦，所以「放宽」= 门槛变小，而不是变大。 */
export function relaxedValueFloor(relaxFactor: number): number {
  if (!Number.isFinite(relaxFactor) || relaxFactor < 1) return VALUE_FLOOR;
  return VALUE_FLOOR / relaxFactor;
}

/**
 * 前置过滤。不修改输入数组，返回 kept / filtered / 过滤率 / 一行摘要。
 * `intent` 为 null 表示"此刻没有活跃目标"，只做价值过滤。
 *
 * `relaxFactor > 1` 表示上一轮已经判过"具体性长期太低"，这一轮把价值门槛降一档
 * （见 `relaxedValueFloor`）。注意规格写的是"阈值 ×1.2"，但闸门语义是"低于阈值才拦"，
 * 按字面乘 1.2 会拦得更多、和"放宽"相反；这里按"门槛 ÷1.2"实现，并在台账里写明。
 */
export function workingSelfFilter<T extends WorkingSelfMemory>(
  memories: readonly T[],
  intent: WorkingSelfIntent | null,
  values: ValueOrder,
  relaxFactor = 1,
): WorkingSelfResult<T> {
  const floor = relaxedValueFloor(relaxFactor);
  const kept: T[] = [];
  const filtered: FilteredMemory[] = [];
  for (const memory of memories) {
    if (intent !== null && !relatedToGoal(memory, intent)) {
      filtered.push({ memoryId: memory.id, reason: "goal_mismatch" });
      continue;
    }
    if (!valueCompatible(memory, values, floor)) {
      filtered.push({ memoryId: memory.id, reason: "value_incompatible" });
      continue;
    }
    kept.push(memory);
  }
  const total = memories.length;
  const filterRate = total === 0 ? null : filtered.length / total;
  const pct = filterRate === null ? "n/a" : `${(filterRate * 100).toFixed(0)}%`;
  const relaxNote = relaxFactor > 1 ? `，门槛降为 ${floor.toFixed(3)}` : "";
  return {
    kept,
    filtered,
    filterRate,
    note: `working self：留 ${String(kept.length)} / 拦 ${String(filtered.length)}（${pct}）${relaxNote}`,
  };
}

/** 诊断输入：一次检索的计数 + 跨次累计。 */
export interface WorkingSelfTrace {
  readonly retrieved: number;
  readonly kept: number;
  /** 本次命中的具体性（可以是 episode 列表，也可以直接给比例）。 */
  readonly concreteness: number | null;
  /** 此前连续多少次具体性低于阈值。 */
  readonly lowConcretenessStreak: number;
}

export type WorkingSelfAlarm = "filter-rate-high" | "concreteness-low" | "concreteness-flat-high";

export interface WorkingSelfDiagnostics {
  readonly filterRate: number | null;
  readonly concreteness: number | null;
  readonly alarms: readonly WorkingSelfAlarm[];
  /** 下一条 self_note；没有就 null。 */
  readonly selfNote: string | null;
  /** 建议的下一次过滤阈值（不直接改配置，只给建议）。 */
  readonly suggestedThreshold: number | null;
}

/**
 * §5.2 的两个指标一起看：过滤率与具体性。
 * - 过滤率高（>90% 且本次检索 ≥20 条）→ 闸门过严，OGM 风险；
 * - 具体性 <0.5 连续 20 次 → 放宽一档并记 self_note；
 * - 具体性长期 >0.95 且纹丝不动 → fact 轨没被用起来（巩固可能空转）。
 */
export function diagnoseWorkingSelf(trace: WorkingSelfTrace): WorkingSelfDiagnostics {
  const alarms: WorkingSelfAlarm[] = [];
  const filterRate = trace.retrieved === 0 ? null : (trace.retrieved - trace.kept) / trace.retrieved;

  if (filterRate !== null && trace.retrieved >= 20 && filterRate > FILTER_RATE_ALARM) {
    alarms.push("filter-rate-high");
  }

  let selfNote: string | null = null;
  let suggestedThreshold: number | null = null;

  if (trace.concreteness !== null && trace.concreteness < CONCRETENESS_FLOOR) {
    alarms.push("concreteness-low");
    if (trace.lowConcretenessStreak + 1 >= LOW_CONCRETENESS_STREAK) {
      selfNote = "我最近只记得结论，不记得事情了。";
      suggestedThreshold = RELAX_FACTOR;
    }
  }

  if (trace.concreteness !== null && trace.concreteness > 0.95 && trace.lowConcretenessStreak === 0 && trace.retrieved >= 20) {
    // 不报警（这可能是好事），但留一个可观测标记，避免"fact 轨空转"完全不可见。
    alarms.push("concreteness-flat-high");
  }

  return { filterRate, concreteness: trace.concreteness, alarms, selfNote, suggestedThreshold };
}

/** 把 EpisodeSource 视图交给 episode.ts 的具体性函数（方便调用方少写胶水）。 */
export function concretenessOf(hits: readonly EpisodeDetail[]): number | null {
  return concretenessRatio(hits);
}

/** 一条命中是否情景记忆（供调用方统计/日志；语义见 episode.ts）。 */
export function isEpisodeHit(memory: WorkingSelfMemory): boolean {
  return looksLikeEpisode(memory);
}

/** 便利函数：把 MemoryRecord 收窄成闸门视图（不复制字段，只做类型收窄）。 */
export function asWorkingSelfMemory(record: MemoryRecord): WorkingSelfMemory {
  return record;
}
