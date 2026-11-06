/**
 * 只读探测的落盘（B3）：把"这个工具此刻能不能用"记下来，供下一拍判断。
 *
 * 为什么需要：审计 §3 P0 说 probe/forge/review 三个模块"零生产调用"——写了、测了、没人用。
 * 这一版只接 **probe（只读）+ 落盘**：每晚（本地 3–5 点）对声明的工具做一次只读探测，
 * 把观测写成一行 ndjson；下一拍的 ToolPort 用最近一次观测覆盖"可用性"，
 * 于是"用不了"是**测出来的**，不是每次拍脑袋决定的。
 *
 * 边界：只探测 risk 0 的工具（只读）；不执行任何有副作用的动作；
 * 不修改能力账本（账本记的是"造出来的工具"，探测只影响"现有工具此刻可用吗"）。
 * 纯函数：不读盘、不读时钟（时间由调用方给）。
 */

import { formatUtc } from "./episode.js";
import { PROBE_MAX_RISK, type ProbeObservation, type ProbeReason } from "./probe.js";
import type { RiskLevel } from "./types.js";

/** 观测的有效期：12 小时。超过就当作"不知道"，不让旧结果永久压住新能力。 */
export const TOOL_PROBE_TTL_MS = 12 * 60 * 60 * 1000;

/** 夜间探测窗口（本地小时，含头不含尾）：03:00–05:00。 */
export const TOOL_PROBE_HOURS: readonly number[] = [3, 4];

export interface ToolProbeTarget {
  readonly tool: string;
  readonly risk: RiskLevel;
  /** 声明的可用性（ToolPort 此刻的判断）；探测结果可能与它不同 */
  readonly declared: boolean;
}

export interface ToolProbePlan {
  /** 够格探测的（risk 0 且未超上限） */
  readonly due: readonly ToolProbeTarget[];
  /** risk 太高、不能自动探测的 */
  readonly needsManual: readonly ToolProbeTarget[];
  /** 计划执行的条数 */
  readonly count: number;
}

/** 从工具清单里挑出"只读、可以自己探"的那些。 */
export function planToolProbe(targets: readonly ToolProbeTarget[], maxPerNight = 8): ToolProbePlan {
  if (!Number.isInteger(maxPerNight) || maxPerNight < 1) throw new RangeError("maxPerNight 必须是正整数");
  const usable = targets.filter((t) => t.tool.trim().length > 0);
  const due = usable.filter((t) => t.risk <= PROBE_MAX_RISK).slice(0, maxPerNight);
  const needsManual = usable.filter((t) => t.risk > PROBE_MAX_RISK);
  return { due, needsManual, count: due.length };
}

function isoSecond(atMs: number): string {
  return formatUtc(Math.floor(atMs / 1000) * 1000);
}

/**
 * 造一条观测：只读探测的结果。
 *
 * `declared` 与 `available` 不同时，reason 给出可读原因；相同时 reason 留空（没有异常不编故事）。
 */
export function observeTool(
  target: ToolProbeTarget,
  available: boolean,
  atMs: number,
  reason?: ProbeReason,
): ProbeObservation {
  if (!Number.isFinite(atMs)) throw new RangeError("atMs 必须是有限数");
  return {
    tool: target.tool,
    available,
    effectivity: available ? 1 : 0,
    reason: reason ?? null,
    at: isoSecond(atMs),
  };
}

/** 序列化一行观测（与 probe.ts 的 ProbeObservation 同形）。 */
export function serializeToolProbe(observation: ProbeObservation): string {
  return JSON.stringify({
    tool: observation.tool,
    available: observation.available,
    effectivity: observation.effectivity,
    ...(observation.reason === undefined ? {} : { reason: observation.reason }),
    at: observation.at,
  });
}

/** 解析整份探测日志；坏行计入 errors，不吞好行。 */
export function parseToolProbeLines(text: string): { observations: ProbeObservation[]; errors: string[] } {
  const observations: ProbeObservation[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`第 ${String(index + 1)} 行不是 JSON`);
      return;
    }
    if (typeof raw !== "object" || raw === null) {
      errors.push(`第 ${String(index + 1)} 行不是对象`);
      return;
    }
    const v = raw as Record<string, unknown>;
    if (typeof v.tool !== "string" || v.tool.trim().length === 0) {
      errors.push(`第 ${String(index + 1)} 行缺 tool`);
      return;
    }
    if (typeof v.available !== "boolean" || (v.effectivity !== 0 && v.effectivity !== 0.5 && v.effectivity !== 1)) {
      errors.push(`第 ${String(index + 1)} 行 available/effectivity 不对`);
      return;
    }
    if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) {
      errors.push(`第 ${String(index + 1)} 行 at 不对`);
      return;
    }
    observations.push({
      tool: v.tool,
      available: v.available,
      effectivity: v.effectivity,
      reason: typeof v.reason === "string" ? (v.reason as ProbeReason) : null,
      at: v.at,
    });
  });
  return { observations, errors };
}

/**
 * 每个工具最近一次（且未过期）的观测。
 *
 * 过期的不返回：探测是"此刻的事实"，12 小时前的可用不代表现在可用。
 */
export function latestToolProbes(
  observations: readonly ProbeObservation[],
  nowMs: number,
  ttlMs = TOOL_PROBE_TTL_MS,
): Map<string, ProbeObservation> {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs 必须是正数");
  const latest = new Map<string, ProbeObservation>();
  for (const observation of observations) {
    const at = Date.parse(observation.at);
    if (!Number.isFinite(at) || nowMs - at > ttlMs || at > nowMs) continue;
    const previous = latest.get(observation.tool);
    if (previous === undefined || Date.parse(previous.at) < at) latest.set(observation.tool, observation);
  }
  return latest;
}

/** 夜间探测窗口判断（本地小时，含头不含尾）。 */
export function inToolProbeWindow(localHour: number): boolean {
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) throw new RangeError("localHour 必须是 0..23 整数");
  return TOOL_PROBE_HOURS.includes(localHour);
}

/** 一行日志：`探测 3 条：可用 2 / 不可用 1（qq.send_text 不可用：port-down）` */
export function describeToolProbe(observations: readonly ProbeObservation[]): string {
  if (observations.length === 0) return "探测 0 条（没有只读工具需要探）";
  const usable = observations.filter((o) => o.available).length;
  const problems = observations
    .filter((o) => !o.available)
    .map((o) => `${o.tool}${o.reason === undefined ? "" : `（${o.reason}）`}`)
    .join("、");
  return `探测 ${String(observations.length)} 条：可用 ${String(usable)} / 不可用 ${String(observations.length - usable)}${
    problems === "" ? "" : `（${problems}）`
  }`;
}
