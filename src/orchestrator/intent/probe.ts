/**
 * P4 能力地图夜更：效力探测的排期与应用（纯逻辑；不读时钟、不发请求）
 *
 * 规格 §11.2：能力地图不是手填的，是**每晚 probe 一遍**得来的——只问"它还通不通"（risk 0、只读），
 * 不通了就把效力降到 0 并记原因，通了就维持/恢复。谁真正去问（ToolPort、B 站、QQ）不在本文件，
 * 本文件只回答三件事：
 *   1. 今晚哪些能力该探（到期 + 数量上限；按"最久没探"优先，避免总探同几个）；
 *   2. 探回来的观测怎么应用（未知能力不写、自相矛盾不写、坏时间不写——逐条列错，不吞）；
 *   3. 探完之后的净变化（变好/变差/没变），给台账一句人话。
 *
 * 与 `forge.ts` 的分工：本文件只产出/更新 `EffectivityEntry`（能力地图的一行），
 * 缺口（`CapabilityGap`）与四级阶梯在 `forge.ts`，别在探测里夹带"该造什么"。
 */

import { validateEffectivity, type EffectivityEntry } from "./forge.js";

/** 每 24 小时探一轮 */
export const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 一晚最多探 10 个（避免把一次 tick 拖成长任务；剩下的明晚继续） */
export const MAX_PROBES_PER_NIGHT = 10;
/** 探测只允许 risk 0 的只读动作（规格红线） */
export const PROBE_MAX_RISK = 0;

export interface ProbeTarget {
  readonly tool: string;
  /** 是否在声明过的能力清单里（没声明过的不探：先要知道"世界上有这功能"） */
  readonly declared: boolean;
  /** 上次探测的 ISO 时间；从没探过传 null（排最前） */
  readonly lastProbeAt: string | null;
  /** 0..3；>0 的能力不能自动探测（要先确认只读探测也算安全） */
  readonly riskCeiling: number;
}

export function parseProbeAt(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function validateTarget(target: ProbeTarget): string[] {
  const errors: string[] = [];
  if (target.tool.trim() === "") errors.push("tool 不能为空");
  if (!Number.isFinite(target.riskCeiling) || target.riskCeiling < 0 || target.riskCeiling > 3) {
    errors.push(`riskCeiling 必须在 0..3：${String(target.riskCeiling)}`);
  }
  if (target.lastProbeAt !== null && parseProbeAt(target.lastProbeAt) === null) {
    errors.push(`lastProbeAt 不是可解析的 ISO 时间：${target.lastProbeAt}`);
  }
  return errors;
}

export interface ProbeNightPlan {
  readonly due: readonly ProbeTarget[];
  /** 到期但超出今晚名额的（明晚继续） */
  readonly deferred: readonly ProbeTarget[];
  /** 不在声明清单里、不探的 */
  readonly undeclared: readonly ProbeTarget[];
  /** 风险上限 > 0、不自动探的 */
  readonly needsManual: readonly ProbeTarget[];
  readonly note: string;
}

/**
 * 今晚该探谁。排序：从没探过的优先 → 最久没探的优先 → 工具名字典序（保证同输入同输出）。
 * 名额用完的进 `deferred`，不是丢掉。
 */
export function planProbeNight(targets: readonly ProbeTarget[], nowMs: number, maxPerNight = MAX_PROBES_PER_NIGHT): ProbeNightPlan {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError(`planProbeNight: nowMs 非法：${String(nowMs)}`);
  if (!Number.isInteger(maxPerNight) || maxPerNight < 1) {
    throw new RangeError(`planProbeNight: maxPerNight 必须是正整数：${String(maxPerNight)}`);
  }
  const undeclared: ProbeTarget[] = [];
  const needsManual: ProbeTarget[] = [];
  const eligible: ProbeTarget[] = [];
  for (const target of targets) {
    const errors = validateTarget(target);
    if (errors.length > 0) throw new RangeError(`planProbeNight: 目标不合法（${target.tool}）：${errors.join("；")}`);
    if (!target.declared) {
      undeclared.push(target);
      continue;
    }
    if (target.riskCeiling > PROBE_MAX_RISK) {
      needsManual.push(target);
      continue;
    }
    const lastMs = parseProbeAt(target.lastProbeAt);
    if (lastMs === null || nowMs - lastMs >= PROBE_INTERVAL_MS) eligible.push(target);
  }
  const byName = (a: ProbeTarget, b: ProbeTarget): number => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);
  const byStaleness = (a: ProbeTarget, b: ProbeTarget): number => {
    const aMs = parseProbeAt(a.lastProbeAt);
    const bMs = parseProbeAt(b.lastProbeAt);
    if (aMs === null && bMs === null) return byName(a, b);
    if (aMs === null) return -1;
    if (bMs === null) return 1;
    return aMs - bMs || byName(a, b);
  };
  const sorted = [...eligible].sort(byStaleness);
  const due = sorted.slice(0, maxPerNight);
  const deferred = sorted.slice(maxPerNight);
  const note =
    due.length > 0
      ? `今晚探 ${due.length} 个（到期 ${sorted.length} 个${deferred.length > 0 ? `，${deferred.length} 个留明晚` : ""}）`
      : deferred.length > 0
        ? "今晚名额已用完"
        : "今晚没有到期的能力";
  return {
    due,
    deferred,
    undeclared: undeclared.sort(byName),
    needsManual: needsManual.sort(byName),
    note,
  };
}

/** 与 `forge.ts` 的 `EffectivityEntry.reason` 同一套枚举（自由文本会污染可机读的能力地图） */
export type ProbeReason = "no-login" | "rate-limited" | "port-down" | "unknown";

export interface ProbeObservation {
  readonly tool: string;
  readonly available: boolean;
  /** 只许 0 / 0.5 / 1（0.5 = 可用但不稳定/要登录），与能力地图同一档 */
  readonly effectivity: 0 | 0.5 | 1;
  readonly reason: ProbeReason | null;
  /** 探测发生的 ISO 时间（写进 lastProbeAt，别用"现在"顶替，便于审计） */
  readonly at: string;
}

export function validateObservation(observation: ProbeObservation): string[] {
  const errors: string[] = [];
  if (observation.tool.trim() === "") errors.push("tool 不能为空");
  if (observation.effectivity !== 0 && observation.effectivity !== 0.5 && observation.effectivity !== 1) {
    errors.push(`effectivity 只能是 0 / 0.5 / 1：${String(observation.effectivity)}`);
  }
  if (observation.available && observation.effectivity === 0) errors.push("available=true 但 effectivity=0（自相矛盾）");
  if (!observation.available && observation.effectivity > 0) errors.push("available=false 但 effectivity>0（自相矛盾）");
  if (parseProbeAt(observation.at) === null) errors.push(`at 不是可解析的 ISO 时间：${observation.at}`);
  return errors;
}

export interface ApplyProbeResult {
  /** 更新后的能力地图（按 tool 升序；未知能力的观测不进来） */
  readonly entries: readonly EffectivityEntry[];
  /** 真正应用了的工具名 */
  readonly applied: readonly string[];
  /** 逐条拒收理由（不吞） */
  readonly errors: readonly string[];
}

/** 把一晚的观测应用到能力地图：未知能力拒、矛盾观测拒、坏时间拒；其余更新 available/effectivity/reason/lastProbeAt。 */
export function applyProbeObservations(
  entries: readonly EffectivityEntry[],
  observations: readonly ProbeObservation[],
): ApplyProbeResult {
  const errors: string[] = [];
  const applied: string[] = [];
  const map = new Map(entries.map((entry) => [entry.tool, { ...entry }]));
  for (const observation of observations) {
    const errorsForObservation = validateObservation(observation);
    if (errorsForObservation.length > 0) {
      errors.push(`${observation.tool}：${errorsForObservation.join("；")}`);
      continue;
    }
    const existing = map.get(observation.tool);
    if (existing === undefined) {
      errors.push(`${observation.tool}：能力地图里没有这个工具（未声明的能力不写）`);
      continue;
    }
    const reason = observation.reason === null ? existing.reason : observation.reason;
    const updated: EffectivityEntry = {
      tool: existing.tool,
      declared: existing.declared,
      available: observation.available,
      effectivity: observation.effectivity,
      lastProbeAt: observation.at,
      ...(reason === undefined ? {} : { reason }),
    };
    const shapeErrors = validateEffectivity(updated);
    if (shapeErrors.length > 0) {
      errors.push(`${observation.tool}：${shapeErrors.join("；")}`);
      continue;
    }
    map.set(observation.tool, updated);
    applied.push(observation.tool);
  }
  const result = [...map.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  return { entries: result, applied: applied.sort(), errors };
}

export interface ProbeSummary {
  readonly improved: readonly string[];
  readonly regressed: readonly string[];
  readonly unchanged: readonly string[];
  /** 只出现在 after 里的（新探测到的能力） */
  readonly added: readonly string[];
}

export function probeSummary(
  before: readonly EffectivityEntry[],
  after: readonly EffectivityEntry[],
): ProbeSummary {
  const oldMap = new Map(before.map((entry) => [entry.tool, entry]));
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];
  for (const entry of after) {
    const old = oldMap.get(entry.tool);
    if (old === undefined) {
      added.push(entry.tool);
      continue;
    }
    if (entry.effectivity > old.effectivity) improved.push(entry.tool);
    else if (entry.effectivity < old.effectivity) regressed.push(entry.tool);
    else unchanged.push(entry.tool);
  }
  const sorted = (list: string[]): string[] => list.sort();
  return { improved: sorted(improved), regressed: sorted(regressed), unchanged: sorted(unchanged), added: sorted(added) };
}

/** 一行夜更摘要（没有变化就明说，不写"一切正常"这种空话）。 */
export function describeProbeSummary(summary: ProbeSummary): string {
  const parts: string[] = [];
  if (summary.improved.length > 0) parts.push(`变好 ${summary.improved.length}`);
  if (summary.regressed.length > 0) parts.push(`变差 ${summary.regressed.length}`);
  if (summary.added.length > 0) parts.push(`新探测 ${summary.added.length}`);
  if (parts.length === 0) return `能力地图夜更：${summary.unchanged.length} 个能力无变化`;
  return `能力地图夜更：${parts.join(" / ")}（无变化 ${summary.unchanged.length}）`;
}
