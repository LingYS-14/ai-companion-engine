/**
 * 意图存活率与半衰期（纯函数；不读时钟、不读文件、不调模型）
 *
 * 规格验收（docs/DESIGN.md）：**意图存活率半衰期可测**。
 * 这里的"存活"指一条意图从被创建到被终结（done/dropped）之间，跨过了多少个 tick；
 * `IntentionRecord.survival` 就是这个计数（types.ts:151）。半衰期 = 多少拍之后
 * 仍有一半意图没被终结。
 *
 * 用 Kaplan-Meier 而不是简单平均，是因为**右删失**：此刻还开着的意图没有"死亡时间"，
 * 直接算平均会被活着的长尾拉低，看起来像"意图死得快"。删失样本只贡献存活段、不进死亡计数。
 *
 * 硬性约定：
 *   - 样本不足 **5** 条时返回 `null`，不硬算（不能用 2 条样本宣布一个半衰期）；
 *   - 全部删失（没有一条终结）时返回 `Infinity`（"在观测窗口内没有可测的死亡"），不返回 0；
 *   - 时间单位是 tick 数（survival），不是毫秒——与 `survival` 字段一致。
 */

import type { IntentionRecord, IntentionStatus } from "./types.js";

/** 少于这么多样本不给数字（避免小样本噪声被当成结论）。 */
export const MIN_HALF_LIFE_SAMPLES = 5;

/** 终结状态：到这里才算"死亡"，进入事件计数。 */
const TERMINAL: readonly IntentionStatus[] = ["done", "dropped"];

export function isTerminal(status: IntentionStatus): boolean {
  return TERMINAL.includes(status);
}

export interface SurvivalPoint {
  /** 观测到的存活拍数 */
  readonly survival: number;
  /** 到这一刻仍在的意图数（风险集） */
  readonly atRisk: number;
  /** 正好在这一拍终结的条数 */
  readonly died: number;
  /** 累积存活概率（KM 估计） */
  readonly survivalProb: number;
}

export interface SurvivalSummary {
  readonly samples: number;
  /** 终结（非删失）样本数 */
  readonly deaths: number;
  /** 半衰期（tick 数）；样本不足或全删失时为 null / Infinity */
  readonly medianTicks: number | null;
  /** KM 曲线（按 survival 升序） */
  readonly curve: readonly SurvivalPoint[];
  /** 观测窗口：最大观察拍数（含删失） */
  readonly horizon: number;
  readonly note: string;
}

/**
 * Kaplan-Meier 估计。
 * 删失样本在它被观察到的拍数处离开风险集，不计死亡。
 */
export function survivalSummary(records: readonly IntentionRecord[]): SurvivalSummary {
  const samples = records.length;
  const times = records.map((r) => r.survival);

  if (samples < MIN_HALF_LIFE_SAMPLES) {
    return {
      samples,
      deaths: records.filter((r) => isTerminal(r.status)).length,
      medianTicks: null,
      curve: [],
      horizon: times.length === 0 ? 0 : Math.max(...times),
      note: `样本 ${String(samples)} 条 < ${String(MIN_HALF_LIFE_SAMPLES)}，不计算半衰期`,
    };
  }

  // 每个时刻的死亡数（只看终结样本）与删失数（非终结样本离开风险集）
  const deathAt = new Map<number, number>();
  for (const record of records) {
    if (!isTerminal(record.status)) continue;
    const t = record.survival;
    deathAt.set(t, (deathAt.get(t) ?? 0) + 1);
  }
  const allTimes = [...new Set(times)].sort((a, b) => a - b);

  const curve: SurvivalPoint[] = [];
  let alive = samples;
  let cumulative = 1;
  let median: number | null = null;

  for (const t of allTimes) {
    const died = deathAt.get(t) ?? 0;
    const atRisk = alive;
    if (died > 0) {
      const factor = 1 - died / atRisk;
      cumulative *= factor;
      curve.push({ survival: t, atRisk, died, survivalProb: cumulative });
      if (median === null && cumulative <= 0.5) median = t;
    }
    // 该时刻所有样本离开风险集（死亡或删失），下个时刻的风险集相应缩小
    const censored = records.filter((r) => r.survival === t && !isTerminal(r.status)).length;
    alive -= died + censored;
  }

  const deaths = records.filter((r) => isTerminal(r.status)).length;
  const note =
    deaths === 0
      ? "全部样本仍开着（全删失），观测窗口内没有可测死亡"
      : median === null
        ? "存活概率在观测窗口内始终 > 0.5，中位寿命超过当前观察范围"
        : `中位寿命 ${String(median)} 拍`;

  return {
    samples,
    deaths,
    medianTicks: deaths === 0 ? Number.POSITIVE_INFINITY : median,
    curve,
    horizon: Math.max(...times),
    note,
  };
}

/** 存活率达到 threshold（默认 0.5）所需的拍数；达不到返回 null。 */
export function ticksToSurvival(records: readonly IntentionRecord[], threshold = 0.5): number | null {
  const summary = survivalSummary(records);
  if (summary.medianTicks === null) return null;
  if (threshold <= 0.5) return Number.isFinite(summary.medianTicks) ? summary.medianTicks : null;
  const hit = summary.curve.find((point) => point.survivalProb <= threshold);
  return hit === undefined ? null : hit.survival;
}
