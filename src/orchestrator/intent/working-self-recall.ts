/**
 * §5.2 working self 闸门接进真实召回路径的胶水（调用侧，不改检索内核）。
 *
 * 规格（docs/DESIGN.md-390）要求闸门只在**调用侧**做前置过滤：
 * 检索内核（`src/memory/retrieve.ts`）的权重、ACT-R 激活、top-k 语义一行都不动。
 * 所以这里只做三件事：
 *   1. 把 `RecallRow[]` 收窄成闸门要的只读视图（`asWorkingSelfMemory`）；
 *   2. 调 `workingSelfFilter` 得到 kept / filtered / filterRate；
 *   3. 算一次具体性比例并交给 `diagnoseWorkingSelf` 出诊断（过滤率 >90%、具体性 <0.5 等）。
 *
 * 三条诚实的边界（写在这里而不是只写在台账里）：
 *   - 现在**没有「当前目标」**这一信号进召回路径（意图引擎在常驻进程里，插件/桥的召回
 *     调用点拿不到那一拍的结果）。所以 `intent` 缺省为 null，只做价值过滤——那基本是
 *     fail-open：没有 `value:` 标注的记忆不会被拦。
 *   - 价值排序来自人格卡 B 层；人格卡没给就退回到"全 1 = 不过滤"，而不是替她编一套排序。
 *   - 跨次累计（连续 20 次具体性低才放宽）需要持久化，这里只带当次诊断与上一次的 streak
 *     （调用方可传，不传为 0）；"没接持久化"这件事在台账里明写，不假装已经做到了。
 */

import type { Personality } from "../../engine/personality.js";
import type { ValueKey } from "../../engine/personality.js";
import {
  asWorkingSelfMemory,
  diagnoseWorkingSelf,
  isEpisodeHit,
  workingSelfFilter,
  type ValueOrder,
  type WorkingSelfIntent,
  type WorkingSelfMemory,
  type WorkingSelfAlarm,
} from "./working-self.js";

/** 人格卡没给 B 层权重时的排序：全 1 = 每项都过 `VALUE_FLOOR`，等于不过滤（fail-open）。 */
export const NO_RANKING_VALUES: ValueOrder = Object.freeze({
  care: 1,
  truth: 1,
  freedom: 1,
  beauty: 1,
  belonging: 1,
  mastery: 1,
});

/** 默认多取一些行再过滤：过滤率 >90% 的报警线要求本次检索 ≥20 条（见 diagnoseWorkingSelf）。 */
export const WORKING_SELF_RETRIEVE = 20;

export interface WorkingSelfRecallOptions {
  /** 此刻的意图；缺省 null = 只做价值过滤（fail-open）。 */
  readonly intent?: WorkingSelfIntent | null;
  /** 价值排序；缺省用 NO_RANKING_VALUES。 */
  readonly values?: ValueOrder;
  /** 之前连续多少次具体性低于阈值（跨次累计目前由调用方自行持有）。 */
  readonly lowConcretenessStreak?: number;
  /**
   * 放宽系数（>1 才生效）：给过"具体性长期太低"之后，这一轮把价值门槛降一档。
   * 由调用方从落盘的 streak 状态里带过来（F205/F206），没带 = 不放宽。
   */
  readonly relaxFactor?: number;
  /** 为诊断多取的行数，默认 WORKING_SELF_RETRIEVE。 */
  readonly retrieve?: number;
}

/** 一次闸门的可观测结果：调用方必须把它落日志，否则 §5.2 的可观测要求没兑现。 */
export interface WorkingSelfRecallReport {
  readonly retrieved: number;
  readonly kept: number;
  readonly filterRate: number | null;
  readonly concreteness: number | null;
  readonly alarms: readonly WorkingSelfAlarm[];
  readonly selfNote: string | null;
  readonly suggestedThreshold: number | null;
  readonly note: string;
}

/** 闸门在调用侧只需要「id + 标签」；`RecallRow`/`RecalledMemory` 都满足这个形状。 */
export interface RecallRowLike {
  readonly id: string;
  readonly tags?: readonly string[];
}

export interface WorkingSelfRecallOutcome<T extends RecallRowLike = RecallRowLike> {
  readonly rows: readonly T[];
  readonly dropped: readonly string[];
  readonly report: WorkingSelfRecallReport;
}

/** 从人格卡拿 B 层价值权重；没有就返回"不过滤"的默认值（不替她编排序）。 */
export function workingSelfValuesFrom(personality: Personality | null | undefined): ValueOrder {
  if (personality === undefined || personality === null) return NO_RANKING_VALUES;
  const keys: readonly ValueKey[] = ["care", "truth", "freedom", "beauty", "belonging", "mastery"];
  const out: Record<ValueKey, number> = { ...NO_RANKING_VALUES };
  for (const key of keys) {
    const value = personality.b[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** 具体性比例：命中里"像一回事"的条目占比；一条都没命中时返回 null（不是 0）。 */
export function concretenessOfRows(rows: readonly WorkingSelfMemory[]): number | null {
  if (rows.length === 0) return null;
  let episodes = 0;
  for (const row of rows) if (isEpisodeHit(row)) episodes += 1;
  return episodes / rows.length;
}

/**
 * 过滤一批召回的原始行。**不修改入参**，也不改分数；返回的 rows 保持原顺序。
 * 分数、排序、ACT-R 激活都没变——被拦的行只是没进下一段。
 */
export function filterRecallRows<T extends RecallRowLike>(
  rows: readonly T[],
  options: WorkingSelfRecallOptions = {},
): WorkingSelfRecallOutcome<T> {
  const intent = options.intent ?? null;
  const values = options.values ?? NO_RANKING_VALUES;
  const relaxFactor = options.relaxFactor ?? 1;
  const total = rows.length;
  const filtered = workingSelfFilter(rows, intent, values, relaxFactor);
  const concreteness = concretenessOfRows(rows);
  const diagnostics = diagnoseWorkingSelf({
    retrieved: total,
    kept: filtered.kept.length,
    concreteness,
    lowConcretenessStreak: options.lowConcretenessStreak ?? 0,
  });
  return {
    rows: filtered.kept,
    dropped: filtered.filtered.map((f) => f.memoryId),
    report: {
      retrieved: total,
      kept: filtered.kept.length,
      filterRate: filtered.filterRate,
      concreteness: diagnostics.concreteness,
      alarms: diagnostics.alarms,
      selfNote: diagnostics.selfNote,
      suggestedThreshold: diagnostics.suggestedThreshold,
      // 一行摘要：闸门自己的 note + 具体性，方便直接打日志
      note: `${filtered.note}；具体性 ${concreteness === null ? "n/a" : (concreteness * 100).toFixed(0) + "%"}`,
    },
  };
}

/**
 * 给调用方打日志的一行；**只对"需要人管"的报警说话**，返回 null 就不打。
 *
 * 为什么不是"有报警就返回"：`concreteness-low` 在只有两三条非情景记忆时每轮都会出现，
 * 如果它也打一行，日志会被刷满，真正要看的 `filter-rate-high` 反而看不见。
 * 具体性仍然可见——它一直在 `[recall] … ws=…具体性 N%` 那行摘要里。
 */
export function describeWorkingSelfAlarm(report: WorkingSelfRecallReport): string | null {
  const actionable = report.alarms.filter((a) => a === "filter-rate-high" || a === "concreteness-flat-high");
  if (actionable.length === 0 && report.selfNote === null) return null;
  const parts = (actionable.length === 0 ? report.alarms : actionable).join("、");
  const note = report.selfNote === null ? "" : `；自我注记：${report.selfNote}`;
  return `[recall] working self 报警：${parts}（${report.note}）${note}`;
}
