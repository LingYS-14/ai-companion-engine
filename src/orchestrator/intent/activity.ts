/**
 * 「她这 24 小时到底在干什么」——把散在各处的意图数据合成一页纸。
 *
 * 为什么需要它：P1/P2/P4 的数据现在分别落在 intent-live-shadow / intent-<id> / capability-gaps /
 * ask-history / guardian-* / working-self / reconsolidation 七八个文件里。没有这份汇总的时候，
 * 判断「她今天是不是变吵了 / 为什么没开口」要靠人肉 greps 和 tail 日志——那既慢又会看漏。
 *
 * 三条纪律：
 *   1. 纯函数：不读文件、不读时钟、不调模型；所有数据由调用方读好传进来（可测试、可复算）。
 *   2. 只报事实，不填 0、不评价：没有样本就说没有样本；不写「她很主动」这类自评句（§9.3）。
 *   3. 有异常才给提示（warnings）：例如「想说话但全被拦」「有够格缺口却没有求助记录」。
 */

import type { IntentionRecord } from "./types.js";
import type { GapProbe } from "./capability-signal.js";
import { formatUtc } from "./episode.js";

const DAY_MS = 86_400_000;
const RECENT_WINDOW_MS = 3_600_000;

/** 从 `data/intent-live-shadow-<id>.ndjson` 一行里读出来的最小事实。 */
export interface ActivityTick {
  readonly at: number;
  readonly gate: string;
  readonly outlet: string;
  readonly wouldSpeak: boolean;
  readonly emitted: readonly string[];
  /** "reach_out:0.418" / null */
  readonly top: string | null;
  readonly replay: number;
  /** F247：装配层把表里被拦下的旧意图重新提出来（tick 自己 wouldSpeak=false，但她确实开口了） */
  readonly reRaised?: boolean;
}

export interface ActivityInput {
  readonly generatedAtMs: number;
  readonly ticks: readonly ActivityTick[];
  readonly intentions: readonly IntentionRecord[];
  readonly gapProbes: readonly GapProbe[];
  /** 求助历史条数与最近一次时间 */
  readonly asks: { readonly asked: number; readonly lastAtMs: number | null };
  /** 监护人收件箱条数与应答条数 */
  readonly guardian: { readonly requests: number; readonly replies: number };
  readonly workingSelf: { readonly lowConcretenessStreak: number; readonly relaxFactor: number } | null;
  readonly reconsolidationPatches: number;
  /** 趋势要看几天（默认 3，含今天） */
  readonly trendDays?: number;
  /**
   * 最近 24 小时**真发出**的消息按来源分桶（来自日志，CLI 解析后传入）。
   *
   * 为什么和 tick 分开：tick 记的是"这一拍她判定想开口"，日志记的是"真的发出去了"。
   * 验收标准 §7.2 要的是后者能回溯到意图 kind——两套口径混在一起会把旧路径算成引擎的功劳。
   */
  readonly sends?: ActivitySends;
}

/** 真发出的消息来源分桶（只报事实，不做评价）。 */
export interface ActivitySends {
  readonly total: number;
  /** 由意图出口决定（日志里 intent=outlet:speak） */
  readonly byIntent: number;
  /** 意图出口非 speak 类（日志里 intent=outlet:journal|idle） */
  readonly byNonSpeakOutlet: number;
  /** 闸放行即发（A4 之前：日志里 intent=gate:true） */
  readonly byGateOnly: number;
  /** 与意图引擎无关的旧主动路径（日志里没有 intent=） */
  readonly byLegacy: number;
  /**
   * 由 speak 出口决定的那几条，各自的意图 kind（F252）。
   *
   * 为什么单独记：验收标准 §7.2 要的是"每条消息可回溯到 kind"，光有"由意图决定 N 条"
   * 只证明出口对，不能证明是哪一类心事让她开口的。缺省/空表示日志里没有 kind 字段
   * （F252 上线之前发出的行，或接线退化了）。
   */
  readonly byKind?: Readonly<Record<string, number>>;
}

/** 近几天的按天汇总（只报事实，不做趋势判断）。 */
export interface ActivityTrendDay {
  /** UTC 日字符串，例如 "10-30" */
  readonly day: string;
  readonly ticks: number;
  readonly wouldSpeak: number;
  readonly quota: number;
}

export interface ActivityReport {
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
  /** 24h 窗口内的样本数（调用方/测试用来判断「有没有数据」） */
  readonly windowTicks: number;
  /** 最近 1 小时窗口内的样本数（F236：用来看额度优先级 A 生效后的变化） */
  readonly recentTicks: number;
  /** 按天汇总（默认最近 3 天；只含至少有一条样本的天） */
  readonly trend: readonly ActivityTrendDay[];
}

function counts<K extends string>(items: readonly K[]): Array<[K, number]> {
  const map = new Map<K, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function fmtCounts(entries: ReadonlyArray<readonly [string, number]>): string {
  if (entries.length === 0) return "无";
  return entries.map(([key, value]) => `${key}×${String(value)}`).join(" / ");
}

function isOpen(status: IntentionRecord["status"]): boolean {
  return status === "pending" || status === "active" || status === "blocked";
}

/** 24 小时活动一页纸。 */
export function buildActivityReport(input: ActivityInput): ActivityReport {
  if (!Number.isFinite(input.generatedAtMs) || input.generatedAtMs < 0) {
    throw new RangeError(`buildActivityReport: generatedAtMs 非法：${String(input.generatedAtMs)}`);
  }
  const since = input.generatedAtMs - DAY_MS;
  const window = input.ticks.filter(
    (tick) => Number.isFinite(tick.at) && tick.at >= since && tick.at <= input.generatedAtMs,
  );
  const lines: string[] = [];
  const warnings: string[] = [];

  const trendDays = input.trendDays ?? 3;
  if (!Number.isInteger(trendDays) || trendDays < 1 || trendDays > 14) {
    throw new RangeError(`buildActivityReport: trendDays 非法：${String(input.trendDays)}`);
  }
  const todayStart = Math.floor(input.generatedAtMs / DAY_MS) * DAY_MS;
  const trendByDay = new Map<number, { ticks: number; wouldSpeak: number; quota: number }>();
  for (const tick of input.ticks) {
    if (!Number.isFinite(tick.at) || tick.at > input.generatedAtMs) continue;
    const dayStart = Math.floor(tick.at / DAY_MS) * DAY_MS;
    if (dayStart < todayStart - (trendDays - 1) * DAY_MS) continue;
    const bucket = trendByDay.get(dayStart) ?? { ticks: 0, wouldSpeak: 0, quota: 0 };
    bucket.ticks += 1;
    if (tick.wouldSpeak) bucket.wouldSpeak += 1;
    if (tick.gate === "quota") bucket.quota += 1;
    trendByDay.set(dayStart, bucket);
  }
  const trend: ActivityTrendDay[] = [...trendByDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayStart, bucket]) => ({
      day: formatUtc(dayStart).slice(5, 10),
      ticks: bucket.ticks,
      wouldSpeak: bucket.wouldSpeak,
      quota: bucket.quota,
    }));

  lines.push(`她一昼夜的活动（截至 ${formatUtc(input.generatedAtMs)}）`);

  if (window.length === 0) {
    lines.push("· [tick] 最近 24 小时没有真实拍样本——意图节拍可能没开，或刚重启还没有满一天。");
  } else {
    const gates = counts(window.map((tick) => tick.gate));
    const outlets = counts(window.map((tick) => tick.outlet));
    const emittedKinds = window.flatMap((tick) => [...tick.emitted]);
    const wouldSpeak = window.filter((tick) => tick.wouldSpeak).length;
    // F247：重提不经过 tick 的 wouldSpeak，单列出来，否则"她开口了几次"会对不上账。
    const reRaised = window.filter((tick) => tick.reRaised === true).length;
    const replaySum = window.reduce((sum, tick) => sum + (Number.isFinite(tick.replay) ? tick.replay : 0), 0);
    lines.push(
      `· [tick] ${String(window.length)} 拍；想开口 ${String(wouldSpeak)} 次（${((wouldSpeak / window.length) * 100).toFixed(0)}%）${reRaised === 0 ? "" : `；其中重提旧话 ${String(reRaised)} 次`}，出口：${fmtCounts(outlets)}`,
    );
    lines.push(`· [闸] ${fmtCounts(gates)}`);
    // F236：A 方案（给开口留额度）只看 24h 会被历史拖住——单独给最近 1 小时，
    // 这样发布后的变化能立刻看见，也不用等一整天。
    const recentSince = input.generatedAtMs - RECENT_WINDOW_MS;
    const recent = window.filter((tick) => tick.at >= recentSince);
    if (recent.length > 0) {
      const recentGates = counts(recent.map((tick) => tick.gate));
      const recentSpeak = recent.filter((tick) => tick.wouldSpeak).length;
      lines.push(
        `· [最近 1 小时] ${String(recent.length)} 拍；想开口 ${String(recentSpeak)} 次；闸：${fmtCounts(recentGates)}`,
      );
    }
    lines.push(
      `· [浮现] ${emittedKinds.length === 0 ? "没有新意图浮现" : fmtCounts(counts(emittedKinds))}；回放线程共 ${String(replaySum)} 条`,
    );
    const quotaShare = (gates.find(([key]) => key === "quota")?.[1] ?? 0) / window.length;
    if (quotaShare >= 0.5) {
      warnings.push(`额度闸占了 ${(quotaShare * 100).toFixed(0)}% 的拍：她不是不想开口，是额度先用完了（回消息不受影响）`);
    }
    if (wouldSpeak === 0 && reRaised === 0 && window.length >= 12) {
      warnings.push("最近 24 小时一次也没到「该开口」的判定——要么阈值偏高，要么驱动缺口一直不够");
    }
  }

  if (trend.length >= 2) {
    const parts = trend.map(
      (day) => `${day.day}: ${String(day.ticks)} 拍 / 想开口 ${String(day.wouldSpeak)} / quota ${String(day.quota)}`,
    );
    lines.push(`· [趋势] ${parts.join(" ｜ ")}（只报数，不下结论）`);
  } else if (trend.length === 1) {
    lines.push("· [趋势] 只有一天样本，还看不出趋势。");
  }

  const open = input.intentions.filter((record) => isOpen(record.status));
  if (input.intentions.length === 0) {
    lines.push("· [意图表] 还没有记录。");
  } else {
    const byStatus = counts(input.intentions.map((record) => record.status));
    const oldest = open.reduce<number | null>((acc, record) => {
      const at = Date.parse(record.created_at ?? "");
      if (!Number.isFinite(at)) return acc;
      return acc === null || at < acc ? at : acc;
    }, null);
    const oldestHours = oldest === null ? null : (input.generatedAtMs - oldest) / 3_600_000;
    const blocked = open.filter((record) => record.blocked_by !== null && record.blocked_by !== undefined);
    lines.push(
      `· [意图表] ${String(open.length)} 条开着（${fmtCounts(byStatus)}）` +
        (oldestHours === null ? "" : `；最旧一条 ${oldestHours.toFixed(1)} 小时`) +
        (blocked.length === 0
          ? ""
          : `；被拦 ${String(blocked.length)} 条（${fmtCounts(counts(blocked.map((record) => String(record.blocked_by ?? "?"))))}）`),
    );
  }

  if (input.sends !== undefined) {
    const sends = input.sends;
    const zero = sends.total === 0;
    lines.push(
      zero
        ? "· [发送] 最近 24 小时没有真发出任何消息（这不等于她哑了，先看闸与额度）。"
        : `· [发送] 最近 24 小时真发出 ${String(sends.total)} 条：由意图决定 ${String(sends.byIntent)} / 意图非 speak 类 ${String(sends.byNonSpeakOutlet)} / 闸放行即发 ${String(sends.byGateOnly)} / 旧路径 ${String(sends.byLegacy)}`,
    );
    const kindEntries = Object.entries(sends.byKind ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (!zero && kindEntries.length > 0) {
      lines.push(
        `· [发送·kind] 由意图决定的那 ${String(sends.byIntent)} 条：${kindEntries
          .map(([kind, count]) => `${kind} ${String(count)}`)
          .join(" / ")}`,
      );
    }
    if (!zero && sends.byIntent > 0 && kindEntries.length === 0) {
      warnings.push(
        "由 speak 出口决定的消息没有 kind 字段——这些若是 F252 之前发的可以忽略；F252 之后仍没有，才是发送日志的 kind 接线退化了",
      );
    }
    if (!zero && sends.byIntent === 0) {
      warnings.push(
        `最近 24 小时发出的 ${String(sends.total)} 条里，一条也不是由 speak 出口决定的——A4 出口接线可能退化了（看 F240/F219）`,
      );
    }
    if (sends.byLegacy > 0 && sends.total >= 5) {
      warnings.push(
        `有 ${String(sends.byLegacy)} 条消息与意图引擎无关（旧主动路径）——A4 守卫上线后不应再出现，值得查日志`,
      );
    }
  }

  const qualified = input.gapProbes.filter((probe) => probe.attempts >= 2);
  if (input.gapProbes.length === 0) {
    lines.push("· [能力缺口] 没有缺口记录（手边工具够用，或驱动还没到阈值）。");
  } else {
    const top = input.gapProbes
      .slice(0, 3)
      .map((probe) => `${probe.kind}/${probe.missingFamily}×${String(probe.attempts)}天`);
    lines.push(`· [能力缺口] ${String(input.gapProbes.length)} 个缺口；最久的：${top.join("、")}`);
    if (qualified.length > 0 && input.asks.asked === 0) {
      warnings.push("有够格求助的缺口，但一次求助都没发出去——发射端可能没接上");
    }
  }

  if (input.asks.asked === 0 && input.guardian.requests === 0) {
    lines.push("· [求助] 还没有求助记录。");
  } else {
    const last = input.asks.lastAtMs === null ? "无" : formatUtc(input.asks.lastAtMs);
    lines.push(
      `· [求助] 问过 ${String(input.asks.asked)} 次（最近 ${last}）；收件箱 ${String(input.guardian.requests)} 条，已回 ${String(input.guardian.replies)} 条`,
    );
    if (input.guardian.requests > 0 && input.guardian.replies === 0) {
      warnings.push("收件箱里有求助但还没有任何应答——她可能在等，去看 `npm run intent:guardian list`");
    }
  }

  if (input.workingSelf === null) {
    lines.push("· [working self] 还没有状态文件（要等一次真实召回）。");
  } else {
    lines.push(
      `· [working self] 具体性低连续 ${String(input.workingSelf.lowConcretenessStreak)} 次，门槛放宽 ×${String(input.workingSelf.relaxFactor)}`,
    );
  }

  lines.push(`· [再巩固] 已写 ${String(input.reconsolidationPatches)} 条解释补丁。`);

  return {
    lines,
    warnings,
    windowTicks: window.length,
    recentTicks: window.filter((tick) => tick.at >= input.generatedAtMs - RECENT_WINDOW_MS).length,
    trend,
  };
}

/** 一行摘要（给早报/日志用）。 */
export function describeActivity(report: ActivityReport): string {
  const first = report.lines.find((line) => line.startsWith("· [tick]")) ?? "";
  return first.replace(/^· /, "");
}
