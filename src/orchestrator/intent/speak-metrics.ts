/**
 * S3b（M5 时间一致性）——发言时刻快照与「她明确说了时间」的比对（纯函数，零 IO/时钟）。
 *
 * 为什么单独一层：生产链路上「她真的说话」有三条路径（主进程主动开口、QQ 回信、网页回信），
 * 每条能拿到的上下文不同。采集器 M5 只需要一个统一口径：这句话里点了几次时间、其中几次能验、
 * 几次与当时的真实时间对不上。比对本身是纯算术，放大脑层，装配层只负责把快照凑齐。
 *
 * 纪律（与 temporal.ts 同源）：
 * - 不读时钟、不构造 Date（writers lint 禁止）；本地时刻用 `localPartsAt` 的纯算术。
 * - 不落原文：`formatSpeakLog` 只输出计数、时长大数与本机时刻，回答正文一律不出日志。
 * - 不知道就不编：缺快照字段 → 该 claim 记 unverified，不进分母（宁可样本少，不冤枉她）。
 * - V1 只认明确表述（见 `extractTimeClaims` 注释），暗示性说法不提取 → M5 是下界。
 */

import { localPartsAt } from "./temporal.js";
import type { TemporalSnapshot } from "./temporal.js";

/** 说话时刻能拿到的事实（缺的给 null，不编）。 */
export interface SpeakSnapshot {
  readonly nowMs: number;
  /** 本地时刻 + 偏移，形如 `2026-11-03T23:50+0800`（日志里只用它，避免正文）。 */
  readonly localIso: string;
  readonly localHour: number;
  readonly localMinute: number;
  readonly awakeForHours: number | null;
  readonly sinceLastUserMsgMin: number | null;
  readonly sinceLastOwnMsgMin: number | null;
  readonly lastSleepAtMs: number | null;
  readonly presenceActive: boolean | null;
}

/** 只认两类明确时间表述：钟点 / 「N 时间单位没见（聊/说话/联系）」。 */
export type TimeClaimKind = "hour" | "elapsed";

export interface TimeClaim {
  readonly kind: TimeClaimKind;
  readonly value: number;
}

export interface SpeakSnapshotInput {
  readonly nowMs: number;
  readonly tzOffsetMinutes: number;
  readonly awakeForHours?: number | null;
  readonly sinceLastUserMsgMin?: number | null;
  readonly sinceLastOwnMsgMin?: number | null;
  readonly lastSleepAtMs?: number | null;
  readonly presenceActive?: boolean | null;
}

export interface TimeClaimCompareResult {
  readonly claims: number;
  readonly verifiable: number;
  readonly mismatch: number;
  readonly unverified: number;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function minutesOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n === null ? null : Math.max(0, n);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 时区偏移 → `+0800` / `-0500`（分钟口径，东八区=480）。 */
function offsetLabel(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(Math.trunc(tzOffsetMinutes));
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** 把注入的事实整理成快照；nowMs/tz 非法直接抛（装配层参数错误要尽早暴露）。 */
export function buildSpeakSnapshot(input: SpeakSnapshotInput): SpeakSnapshot {
  if (!Number.isFinite(input.nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(input.tzOffsetMinutes)) throw new RangeError("tzOffsetMinutes 必须是有限数");
  const local = localPartsAt(input.nowMs, input.tzOffsetMinutes);
  return {
    nowMs: input.nowMs,
    localIso: `${local.localDate}T${local.localTime}${offsetLabel(input.tzOffsetMinutes)}`,
    localHour: local.localHour,
    localMinute: local.localMinute,
    awakeForHours: finiteOrNull(input.awakeForHours),
    sinceLastUserMsgMin: minutesOrNull(input.sinceLastUserMsgMin),
    sinceLastOwnMsgMin: minutesOrNull(input.sinceLastOwnMsgMin),
    lastSleepAtMs: finiteOrNull(input.lastSleepAtMs),
    presenceActive: typeof input.presenceActive === "boolean" ? input.presenceActive : null,
  };
}

const HOUR_CLAIM_RE = /现在(?:是|已经)?\s*(\d{1,2})\s*点/g;
const ELAPSED_CLAIM_RE = /(\d+)\s*(分钟|小时|天)\s*(没有|没)?\s*(?:见|聊|说话|联系)/g;

const UNIT_MINUTES: Readonly<Record<string, number>> = {
  分钟: 1,
  小时: 60,
  天: 60 * 24,
};

/**
 * 提取「明确时间表述」：
 * - `现在(是|已经)? N 点` → hour（0..23；>23 视为坏表述，记 unverified）。
 * - `N 分钟/小时/天 没见/没聊/没说话/没联系` → elapsed（换算成分钟）；
 *   没有「没/没有」的（例如「3 小时聊」）对象不明，记 unverified、不当 claim。
 *
 * 12 小时制歧义（如「现在 7 点」）在提取阶段不判死，留给 compare：有快照再决定验不验。
 */
export function extractTimeClaims(text: string): { claims: TimeClaim[]; unverified: number } {
  if (typeof text !== "string" || text.trim() === "") return { claims: [], unverified: 0 };
  const claims: TimeClaim[] = [];
  let unverified = 0;

  for (const match of text.matchAll(HOUR_CLAIM_RE)) {
    const hour = Number(match[1]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      unverified += 1;
      continue;
    }
    claims.push({ kind: "hour", value: hour });
  }

  for (const match of text.matchAll(ELAPSED_CLAIM_RE)) {
    const amount = Number(match[1]);
    const unit = match[2] ?? "";
    const minutes = amount * (UNIT_MINUTES[unit] ?? 0);
    // 只有「没/没有」形态能确定是"距上次联系过了多久"；否则可能是在说一段相处时长，不猜。
    if (match[3] === undefined || !Number.isInteger(amount) || amount <= 0 || minutes <= 0) {
      unverified += 1;
      continue;
    }
    claims.push({ kind: "elapsed", value: minutes });
  }

  return { claims, unverified };
}

function circularHourDiff(hour: number, localHour: number): number {
  const raw = Math.abs(hour - localHour);
  return Math.min(raw, 24 - raw);
}

/**
 * 逐条比对 claim 与快照：
 * - hour：12 小时制且无上午/下午标记（1..12 点）→ unverified；0 点与 13..23 点按 24 小时口径，
 *   与本地时刻圆环差 ≤1h 算一致。
 * - elapsed：对 `sinceLastUserMsgMin`；缺该字段 → unverified；容差 `max(10min, 20%)`。
 */
export function compareTimeClaims(
  claims: readonly TimeClaim[],
  snap: SpeakSnapshot,
): TimeClaimCompareResult {
  let verifiable = 0;
  let mismatch = 0;
  let unverified = 0;

  for (const claim of claims) {
    if (claim.kind === "hour") {
      // 12 小时制、又没有「上午/下午」可依：同一个「7 点」可能是 07:00 也可能是 19:00，不冒险。
      if (claim.value >= 1 && claim.value <= 12) {
        unverified += 1;
        continue;
      }
      if (claim.value < 0 || claim.value > 23) {
        unverified += 1;
        continue;
      }
      verifiable += 1;
      if (circularHourDiff(claim.value, snap.localHour) > 1) mismatch += 1;
      continue;
    }

    // elapsed：没有「他上一次说话距今多久」就无法验，按 unverified 处理（不进分母）。
    if (snap.sinceLastUserMsgMin === null) {
      unverified += 1;
      continue;
    }
    verifiable += 1;
    const diff = Math.abs(claim.value - snap.sinceLastUserMsgMin);
    const tolerance = Math.max(10, snap.sinceLastUserMsgMin * 0.2);
    if (diff > tolerance) mismatch += 1;
  }

  return { claims: claims.length, verifiable, mismatch, unverified };
}

function formatHours(value: number | null): string {
  return value === null ? "null" : String(Math.round(value * 10) / 10);
}

function formatMinutes(value: number | null): string {
  return value === null ? "null" : `${String(Math.round(value))}min`;
}

/** 一行日志：只含计数、时长大数与本机时刻，不含她/他的原文。 */
export function formatSpeakLog(channel: string, snap: SpeakSnapshot, result: TimeClaimCompareResult): string {
  return (
    `[time-claim] ch=${channel} claims=${String(result.claims)} verifiable=${String(result.verifiable)}` +
    ` mismatch=${String(result.mismatch)} unverified=${String(result.unverified)}` +
    ` snap=${snap.localIso}/awake=${formatHours(snap.awakeForHours)}/peer=${formatMinutes(snap.sinceLastUserMsgMin)}`
  );
}

/** 主进程主动开口的 M5 日志：`temporal` 必须是**同一拍**建好的快照，缺失就跳过、不补造。 */
export interface ProactiveTimeClaimLogInput {
  readonly reply: string;
  readonly temporal: TemporalSnapshot | undefined;
  readonly tzOffsetMinutes: number;
  readonly log: (line: string) => void;
}

/**
 * F352：把「主动开口后的时间一致性日志」从装配层内联块搬成可单测的纯编排。
 *
 * 这原来内联在 `scripts/autonomy/main.mjs` 的 proactiveImpl 里，直接引用了 intentTickImpl
 * 作用域里的 `temporal`——两个函数各自是闭包，装配层跑 `.mjs` 又不过 tsc，于是每次主动
 * 开口成功都抛 `ReferenceError: temporal is not defined`（2026-11-04 16:16 线上实锤）。
 * 搬到这里后：快照必须由调用方显式传入（`beatTemporal`），单测能覆盖「有快照/无快照」。
 */
export function logProactiveTimeClaims(input: ProactiveTimeClaimLogInput): void {
  const { reply, temporal, tzOffsetMinutes, log } = input;
  if (temporal === undefined) return;
  try {
    const extracted = extractTimeClaims(reply);
    if (extracted.claims.length === 0) return;
    const snap = buildSpeakSnapshot({
      nowMs: temporal.nowMs,
      tzOffsetMinutes,
      awakeForHours: temporal.awakeForHours,
      sinceLastUserMsgMin: temporal.sinceLastUserMsgMin,
      sinceLastOwnMsgMin: temporal.sinceLastOwnMsgMin,
      lastSleepAtMs: temporal.lastSleep?.atMs ?? null,
      presenceActive: temporal.presence?.active ?? null,
    });
    const compared = compareTimeClaims(extracted.claims, snap);
    log(
      formatSpeakLog("autonomy", snap, {
        claims: compared.claims + extracted.unverified,
        verifiable: compared.verifiable,
        mismatch: compared.mismatch,
        unverified: compared.unverified + extracted.unverified,
      }),
    );
  } catch {
    log("[time-claim] failed");
  }
}
