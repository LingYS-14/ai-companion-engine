/**
 * 时间观 P2a——他的作息骨架：把「他什么时候出现」的观察整理成节律事实（纯函数，零 IO）。
 *
 * 设计稿（DESIGN-TEMPORALITY-SLEEP-PERSONA v0.2 §2.3）的分层：
 * - 本文件只做**统计与事实**：哪些时间点算「他出现」、跨了几个本地日期、最常在哪个小时；
 * - **不知道就不编**：样本门槛没同时满足 → 返回 null，上层（temporal / situation-note）如实写
 *   「我还不了解他的作息」，绝不用几天的稀疏样本假装摸清了作息；
 * - 不读时钟、不构造 Date：时间由调用方注入，本地日期/小时一律走 `localPartsAt` 的纯算术
 *   （`tools/lint/writers.mjs` 规则 2：src 里除 `src/engine/clock.ts` 外禁止构造 Date）。
 *
 * 门槛与置信度全部由参数注入（`RhythmThresholds`），配置读取只在 `rhythmThresholdsFromConfig`
 * 一个函数里发生——测试可以完全不碰配置，直接给常量。
 */

import type { EngineConfig } from "../../engine/config.js";
import { knobNumber } from "../../engine/config.js";
import { localPartsAt, type HisRhythm } from "./temporal.js";

/** 一条「他出现过」的观察。direction 由记忆/消息的进出方向决定。 */
export interface RhythmSample {
  readonly occurredAtMs: number;
  readonly direction: "inbound" | "outbound" | "unknown";
  /** 记忆/消息来源：只有 player / qq_contact_verified 算「他本人出现」。 */
  readonly source: string;
}

/** 产出节律所需的全部门槛与置信度参数（对应 overlay 的 RHYTHM_* 键）。 */
export interface RhythmThresholds {
  readonly minInboundSamples: number;
  readonly minLocalDates: number;
  /** 工作日**不同日期数**门槛（DESIGN §2.3：工作日与休息日各自 ≥3 天）。 */
  readonly minWorkdayDates: number;
  /** 休息日**不同日期数**门槛。 */
  readonly minRestdayDates: number;
  readonly confidenceLowCap: number;
  readonly confidenceHighFloor: number;
  readonly confidenceHighSlope: number;
  readonly confidenceHighCap: number;
}

/**
 * 可选的日历覆盖：dateKey 形如 `2026-11-01`。
 * 命中 `restDays` → 休息日；命中 `workDays` → 工作日；都没命中才按周六/周日算休息日。
 */
export interface RhythmCalendar {
  readonly restDays?: ReadonlySet<string>;
  readonly workDays?: ReadonlySet<string>;
}

/** 只有这两类来源是「他本人」；selftalk/web/parasocial/unknown/proactive 一律不计。 */
const HIS_SOURCES: ReadonlySet<string> = new Set(["player", "qq_contact_verified"]);

const HOURS_PER_DAY = 24;

function isHisSample(sample: RhythmSample, nowMs: number): boolean {
  if (sample.direction !== "inbound") return false;
  if (!HIS_SOURCES.has(sample.source)) return false;
  const at = sample.occurredAtMs;
  return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= nowMs;
}

function isValidThresholds(thresholds: RhythmThresholds): boolean {
  const values = [
    thresholds.minInboundSamples,
    thresholds.minLocalDates,
    thresholds.minWorkdayDates,
    thresholds.minRestdayDates,
    thresholds.confidenceLowCap,
    thresholds.confidenceHighFloor,
    thresholds.confidenceHighSlope,
    thresholds.confidenceHighCap,
  ];
  return values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

/**
 * 算置信度（DESIGN §2.3 字面）：
 * - n < 100：min(lowCap, floor + n*slope)——30–99 档实际被 lowCap 封顶；
 * - n >= 100：min(highCap, floor + n*slope)——100 处允许跳变（DESIGN 的设定，测试锁住）。
 */
export function rhythmConfidence(n: number, thresholds: RhythmThresholds): number {
  const raw = thresholds.confidenceHighFloor + n * thresholds.confidenceHighSlope;
  return n < 100 ? Math.min(thresholds.confidenceLowCap, raw) : Math.min(thresholds.confidenceHighCap, raw);
}

/**
 * 从观察样本构建「他的节律」。
 *
 * 样本门槛（全部满足才产出，否则 null）：
 * sampleCount >= minInboundSamples；distinctLocalDates >= minLocalDates；
 * 工作日覆盖的不同日期数 >= minWorkdayDates；休息日覆盖的不同日期数 >= minRestdayDates。
 *
 * 「各自 ≥3 天」按**不同本地日期**算（DESIGN:128），不是按样本条数——同一晚连着说
 * 10 句也只算 1 天，不能因为话多就假装摸清了他的作息。
 *
 * 时间口径：`occurredAtMs + tzOffsetMinutes` 之后取本地日期/小时；时区必须与入口同一口径。
 */
export function buildHisRhythm(
  samples: readonly RhythmSample[],
  options: {
    nowMs: number;
    tzOffsetMinutes: number;
    thresholds: RhythmThresholds;
    calendar?: RhythmCalendar;
  },
): HisRhythm | null {
  if (!Number.isFinite(options.nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(options.tzOffsetMinutes)) throw new RangeError("tzOffsetMinutes 必须是有限数");
  if (!isValidThresholds(options.thresholds)) throw new RangeError("RhythmThresholds 必须是非负有限数");

  const calendar = options.calendar;
  const restDays = calendar?.restDays;
  const workDays = calendar?.workDays;

  const byLocalHour: number[] = new Array<number>(HOURS_PER_DAY).fill(0);
  const dates = new Set<string>();
  const workdayDates = new Set<string>();
  const restdayDates = new Set<string>();
  let sampleCount = 0;

  for (const sample of samples) {
    if (!isHisSample(sample, options.nowMs)) continue;
    const parts = localPartsAt(sample.occurredAtMs, options.tzOffsetMinutes);
    sampleCount += 1;
    byLocalHour[parts.localHour] = (byLocalHour[parts.localHour] ?? 0) + 1;
    dates.add(parts.localDate);

    // 日历覆盖优先于「周六周日」，这样调休/倒班也能算对；按日期去重计数（DESIGN:128）。
    if (restDays?.has(parts.localDate) === true) restdayDates.add(parts.localDate);
    else if (workDays?.has(parts.localDate) === true) workdayDates.add(parts.localDate);
    else if (parts.weekday >= 6) restdayDates.add(parts.localDate);
    else workdayDates.add(parts.localDate);
  }

  const distinctLocalDates = dates.size;
  const t = options.thresholds;
  if (
    sampleCount < t.minInboundSamples ||
    distinctLocalDates < t.minLocalDates ||
    workdayDates.size < t.minWorkdayDates ||
    restdayDates.size < t.minRestdayDates
  ) {
    // 门槛没同时满足 → 不知道就是不知道（Q11：不编作息）。
    return null;
  }

  // 平局取最早的小时：`>` 而非 `>=`，保证同一个 peak 在所有机器上确定。
  let peakLocalHour = 0;
  for (let hour = 1; hour < HOURS_PER_DAY; hour += 1) {
    if ((byLocalHour[hour] ?? 0) > (byLocalHour[peakLocalHour] ?? 0)) peakLocalHour = hour;
  }

  const sortedDates = [...dates].sort();
  return {
    sampleCount,
    distinctLocalDates,
    workdayDays: workdayDates.size,
    restdayDays: restdayDates.size,
    byLocalHour,
    peakLocalHour,
    confidence: rhythmConfidence(sampleCount, t),
    firstLocalDate: sortedDates[0] ?? "",
    lastLocalDate: sortedDates[sortedDates.length - 1] ?? "",
  };
}

/**
 * 从配置读取 8 个 RHYTHM_* 旋钮。
 *
 * 键由 overlay 提供（`spec/config/v54.overlay.json`）；本函数只按名字读运行期值，
 * 不依赖类型系统里是否存在这些键——测试可绕过配置直接给 `RhythmThresholds`。
 */
export function rhythmThresholdsFromConfig(cfg: EngineConfig): RhythmThresholds {
  return {
    minInboundSamples: knobNumber(cfg, "RHYTHM_MIN_INBOUND_SAMPLES"),
    minLocalDates: knobNumber(cfg, "RHYTHM_MIN_LOCAL_DATES"),
    minWorkdayDates: knobNumber(cfg, "RHYTHM_MIN_WORKDAY_DATES"),
    minRestdayDates: knobNumber(cfg, "RHYTHM_MIN_RESTDAY_DATES"),
    confidenceLowCap: knobNumber(cfg, "RHYTHM_CONFIDENCE_LOW_CAP"),
    confidenceHighFloor: knobNumber(cfg, "RHYTHM_CONFIDENCE_HIGH_FLOOR"),
    confidenceHighSlope: knobNumber(cfg, "RHYTHM_CONFIDENCE_HIGH_SLOPE"),
    confidenceHighCap: knobNumber(cfg, "RHYTHM_CONFIDENCE_HIGH_CAP"),
  };
}

/** 一行摘要（日志/观测用），不用于提示词正文。 */
export function describeRhythm(rhythm: HisRhythm): string {
  return (
    `节律：最常在 ${String(rhythm.peakLocalHour)}:00 前后` +
    `（${String(rhythm.sampleCount)} 条记录 / ${String(rhythm.distinctLocalDates)} 天，` +
    `${rhythm.firstLocalDate}~${rhythm.lastLocalDate}，置信 ${rhythm.confidence.toFixed(2)}）`
  );
}
