/**
 * §9 六指标的纯计算（P3 看板的数据层；不读文件、不调模型、不自评）
 *
 * 规格：docs/DESIGN.md §9（六指标）与 §9.3（**不许自评**：指标必须从
 * 行为日志/记忆数据算出来，不能让她自己说"我最近很主动"）。
 *
 * 本文件只做计算，输入是**已经落盘的观测记录**（shadow ndjson、意图 WAL、探针结果）。
 * 六个指标：
 *   1. 存活率 / 半衰期（survival）——意图是不是活了一会儿还是秒死；
 *   2. 自发发起率 × 行为熵（initiative）——没人跟她说话时她会不会自己动，且不是每次同一个动作；
 *   3. 跨会话一致性（consistency）——重启前后行为是否还能对得上；
 *   4. 记忆—行为因果性（causality）——**需要消融工具（P3 后续）**，这里不做假数，返回 null；
 *   5. 先验压制比（suppression）——有多少"想做的事"被硬闸拦住了（想 ≠ 说）；
 *   6. 能力解锁率（capability）——P4 能力账本落地前，输入为空就是 null。
 *
 * 设计取向：算不出来就 null + 原因，绝不填 0 或"大约"。指标页宁可显示"未测"，
 * 也不能显示一个看起来像测过的数字。
 */

import { survivalSummary, type SurvivalSummary } from "./half-life.js";
import type { IntentionRecord, IntentKind } from "./types.js";

/** 一条 shadow tick 记录（tools/intent/shadow.mjs 与 live shadow 写出的形状子集）。 */
export interface MetricTickRecord {
  readonly at: string;
  /** 本拍浮现出的意图类别（emitted） */
  readonly emitted: readonly IntentKind[];
  /** 本拍算出的候选数（没有候选 = 0） */
  readonly candidates?: number;
  /** 硬闸是否允许开口 */
  readonly gateAllowed: boolean;
  /** 最终会不会说 */
  readonly wouldSpeak: boolean;
}

export interface InitiativeMetrics {
  readonly ticks: number;
  /** 有意图浮现的拍 / 总拍 */
  readonly initiativeRate: number | null;
  /** 浮现事件按类别的香农熵（bit）；全 0 时 null */
  readonly behaviorEntropy: number | null;
  /** 熵归一化到 [0,1]（除以 log2(7)）；便于跨期比较 */
  readonly normalizedEntropy: number | null;
  readonly note: string;
}

/** 自发发起率 × 行为熵。 */
export function initiativeMetrics(records: readonly MetricTickRecord[]): InitiativeMetrics {
  if (records.length === 0) {
    return { ticks: 0, initiativeRate: null, behaviorEntropy: null, normalizedEntropy: null, note: "没有 tick 记录" };
  }
  const withEmitted = records.filter((record) => record.emitted.length > 0).length;
  const counts = new Map<IntentKind, number>();
  let total = 0;
  for (const record of records) {
    for (const kind of record.emitted) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      total += 1;
    }
  }
  let entropy: number | null = null;
  let normalized: number | null = null;
  if (total > 0) {
    let h = 0;
    for (const count of counts.values()) {
      const p = count / total;
      h -= p * Math.log2(p);
    }
    entropy = h;
    normalized = Math.log2(INTENT_KIND_COUNT) > 0 ? h / Math.log2(INTENT_KIND_COUNT) : null;
  }
  return {
    ticks: records.length,
    initiativeRate: withEmitted / records.length,
    behaviorEntropy: entropy,
    normalizedEntropy: normalized,
    note: `${String(records.length)} 拍里 ${String(withEmitted)} 拍有意图浮现`,
  };
}

/** 与 `INTENT_KINDS` 的长度保持一致（写死常量，避免本文件 import 整张表只为取 length）。 */
const INTENT_KIND_COUNT = 7;

export interface SuppressionMetrics {
  /** 有意图浮现的拍数 */
  readonly emittableTicks: number;
  /** 其中被硬闸拦住的拍数 */
  readonly suppressedTicks: number;
  /** 先验压制比 = 被拦 / 想动（想动 = 被拦 + 真的说了） */
  readonly ratio: number | null;
  readonly note: string;
}

/** 先验压制比：想做的事里，有多大比例被硬闸（静默/额度/单写者/不信任）拦住。 */
export function priorSuppression(records: readonly MetricTickRecord[]): SuppressionMetrics {
  const emittable = records.filter((record) => record.emitted.length > 0);
  if (emittable.length === 0) {
    return { emittableTicks: 0, suppressedTicks: 0, ratio: null, note: "没有浮现过意图，无从计算压制比" };
  }
  const spoke = emittable.filter((record) => record.gateAllowed && record.wouldSpeak).length;
  const suppressed = emittable.length - spoke;
  return {
    emittableTicks: emittable.length,
    suppressedTicks: suppressed,
    ratio: suppressed / emittable.length,
    note: `想动 ${String(emittable.length)} 拍，真说 ${String(spoke)} 拍，被拦 ${String(suppressed)} 拍`,
  };
}

export interface ConsistencyMetrics {
  readonly pairs: number;
  readonly consistent: number;
  /** 通过率；没有探针记录时 null（不把"没测"当 100%） */
  readonly rate: number | null;
  readonly note: string;
}

/** 跨会话一致性：探针每跑一次记一个布尔（两拍是否逐字段相同）。 */
export function consistencyMetrics(results: readonly boolean[]): ConsistencyMetrics {
  if (results.length === 0) {
    return { pairs: 0, consistent: 0, rate: null, note: "没有跑过一致性探针" };
  }
  const consistent = results.filter(Boolean).length;
  return {
    pairs: results.length,
    consistent,
    rate: consistent / results.length,
    note: `${String(results.length)} 次探针，${String(consistent)} 次通过`,
  };
}

export interface CapabilityMetrics {
  readonly unlocked: number;
  readonly gaps: number;
  readonly rate: number | null;
  readonly note: string;
}

/** 能力解锁率（P4 能力账本输入；P4 之前调用方传空就是 null）。 */
export function capabilityUnlockMetrics(unlocked: number, gaps: number): CapabilityMetrics {
  if (gaps <= 0) return { unlocked: 0, gaps: 0, rate: null, note: "没有记录到能力缺口（P4 之前正常）" };
  return {
    unlocked,
    gaps,
    rate: unlocked / gaps,
    note: `缺口 ${String(gaps)} 个，解锁 ${String(unlocked)} 个`,
  };
}

export interface MetricsReport {
  readonly survival: SurvivalSummary;
  readonly initiative: InitiativeMetrics;
  readonly suppression: SuppressionMetrics;
  readonly consistency: ConsistencyMetrics;
  readonly capability: CapabilityMetrics;
  /** 记忆—行为因果性：P3 消融工具落地前恒为 null */
  readonly causality: { readonly value: number | null; readonly note: string };
  /** 给人看的一页纸（纯文本，不自评、不总结成"她很主动"这类话） */
  readonly lines: readonly string[];
}

export interface MetricsInput {
  readonly intentions: readonly IntentionRecord[];
  readonly ticks: readonly MetricTickRecord[];
  readonly consistencyResults?: readonly boolean[];
  readonly capabilityUnlocked?: number;
  readonly capabilityGaps?: number;
}

/** 汇总六个指标；`causality` 固定 null + 原因（消融工具已可用，但汇总还没有并入它的结果）。 */
export function metricsReport(input: MetricsInput): MetricsReport {
  const survival = survivalSummary(input.intentions);
  const initiative = initiativeMetrics(input.ticks);
  const suppression = priorSuppression(input.ticks);
  const consistency = consistencyMetrics(input.consistencyResults ?? []);
  const capability = capabilityUnlockMetrics(input.capabilityUnlocked ?? 0, input.capabilityGaps ?? 0);
  const causality = {
    value: null,
    note: "未接入：消融工具已可用（npm run intent:ablation），但六指标汇总还没有并入它的结果，所以这里仍是未测，不做估计值",
  };

  const lines = [
    `存活：样本 ${String(survival.samples)} 条，终结 ${String(survival.deaths)} 条；${survival.note}`,
    `自发发起率：${formatRate(initiative.initiativeRate)}；行为熵 ${formatNumber(initiative.behaviorEntropy)} bit（归一 ${formatRate(initiative.normalizedEntropy)}）`,
    `先验压制比：${formatRate(suppression.ratio)}（${suppression.note}）`,
    `跨会话一致性：${formatRate(consistency.rate)}（${consistency.note}）`,
    `能力解锁率：${formatRate(capability.rate)}（${capability.note}）`,
    `记忆—行为因果性：${causality.note}`,
  ];
  return { survival, initiative, suppression, consistency, capability, causality, lines };
}

function formatRate(value: number | null): string {
  return value === null ? "未测" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "未测" : value.toFixed(2);
}
