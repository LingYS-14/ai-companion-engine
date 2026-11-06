/**
 * 网页能力的日额度与本地说（纯函数，无 IO；spec v2.3 §7.3）。
 *
 * 为什么额度不并入 `nightBudget`：夜账本按「睡眠夜」算，白天清醒时没有夜；而网页额度
 * 是按「本机本地日」算的，跨日就要重置，两者生命周期不同，混在一起会互相重置。
 *
 * 落盘由装配层负责（`data/web-usage-<characterId>.json`，原子写）；本文件只把
 * 「读回来的 object 是否可信 → 规范化成 WebUsage」「这一拍能不能搜/抓」算清楚。
 * 时间口径：所有函数都收 `nowMs`/`tzOffsetMinutes`，不读系统时钟。
 */

export interface WebUsage {
  readonly v: 1;
  /** 本地日 YYYY-MM-DD */
  readonly date: string;
  readonly tzOffsetMinutes: number;
  readonly searchCount: number;
  readonly fetchCount: number;
  /** 最近一次**发起**搜索尝试的时刻（成功/失败都更新） */
  readonly lastSearchAtMs: number | null;
  /** 最近一次**发起**抓取尝试的时刻（成功/失败都更新） */
  readonly lastFetchAtMs: number | null;
}

export interface WebBudgetConfig {
  readonly searchDailyCap: number;
  readonly fetchDailyCap: number;
  readonly minIntervalMs: number;
}

export const WEB_USAGE_VERSION = 1;
/** 本地说固定 UTC+8（与 daemon 的 tzOffsetMinutes 同口径） */
export const WEB_DEFAULT_TZ_OFFSET_MINUTES = 480;

export interface WebBudgetGate {
  readonly allowed: boolean;
  /** 不允许时的原因（日志用；allowed=true 时为空串） */
  readonly reason: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInt(value: unknown): number | null {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/** 本地日（YYYY-MM-DD）——纯算术，不依赖 Date */
export function localDateOf(nowMs: number, tzOffsetMinutes: number): string {
  const shifted = nowMs + tzOffsetMinutes * 60_000;
  const days = Math.floor(shifted / 86_400_000);
  // 1970-01-01 起的天数 → 公历日期（Howard Hinnant 的 civil_from_days 简化版）
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function emptyWebUsage(nowMs: number, tzOffsetMinutes: number): WebUsage {
  return {
    v: WEB_USAGE_VERSION,
    date: localDateOf(nowMs, tzOffsetMinutes),
    tzOffsetMinutes,
    searchCount: 0,
    fetchCount: 0,
    lastSearchAtMs: null,
    lastFetchAtMs: null,
  };
}

/**
 * 把磁盘上的 object 规范化：损坏/旧版/跨日本地日 → 重来。
 *
 * 跨日只清计数与 last*AtMs，不丢文件本身（下一次写盘会覆盖）。
 */
export function normalizeWebUsage(raw: unknown, nowMs: number, tzOffsetMinutes: number): WebUsage {
  const fresh = emptyWebUsage(nowMs, tzOffsetMinutes);
  if (typeof raw !== "object" || raw === null) return fresh;
  const rec = raw as Record<string, unknown>;
  const date = typeof rec.date === "string" && DATE_RE.test(rec.date) ? rec.date : null;
  if (date === null) return fresh;
  const searchCount = nonNegativeInt(rec.searchCount);
  const fetchCount = nonNegativeInt(rec.fetchCount);
  if (searchCount === null || fetchCount === null) return fresh;
  const lastSearchAtMs = isFiniteNumber(rec.lastSearchAtMs) ? rec.lastSearchAtMs : null;
  const lastFetchAtMs = isFiniteNumber(rec.lastFetchAtMs) ? rec.lastFetchAtMs : null;
  if (date !== fresh.date) return fresh;
  return {
    v: WEB_USAGE_VERSION,
    date,
    tzOffsetMinutes,
    searchCount,
    fetchCount,
    lastSearchAtMs,
    lastFetchAtMs,
  };
}

/** 这一拍能不能发起搜索（开关不在这里判，由装配层先看 WEB_SEARCH_ENABLED） */
export function canSearch(nowMs: number, usage: WebUsage, cfg: WebBudgetConfig): WebBudgetGate {
  if (usage.searchCount >= cfg.searchDailyCap) return { allowed: false, reason: "daily-cap" };
  if (usage.lastSearchAtMs !== null && nowMs - usage.lastSearchAtMs < cfg.minIntervalMs) {
    return { allowed: false, reason: "min-interval" };
  }
  return { allowed: true, reason: "" };
}

export function canFetch(nowMs: number, usage: WebUsage, cfg: WebBudgetConfig): WebBudgetGate {
  if (usage.fetchCount >= cfg.fetchDailyCap) return { allowed: false, reason: "daily-cap" };
  if (usage.lastFetchAtMs !== null && nowMs - usage.lastFetchAtMs < cfg.minIntervalMs) {
    return { allowed: false, reason: "min-interval" };
  }
  return { allowed: true, reason: "" };
}

/** 发起搜索尝试：只更新 lastSearchAtMs（成功失败都算一次尝试），不涨计数 */
export function touchSearchAttempt(usage: WebUsage, nowMs: number): WebUsage {
  return { ...usage, lastSearchAtMs: nowMs };
}

/** 搜索成功（HTTP 2xx 且结果非空）：计数 +1，同时记下尝试时刻 */
export function consumeSearch(usage: WebUsage, nowMs: number): WebUsage {
  return { ...usage, searchCount: usage.searchCount + 1, lastSearchAtMs: nowMs };
}

export function touchFetchAttempt(usage: WebUsage, nowMs: number): WebUsage {
  return { ...usage, lastFetchAtMs: nowMs };
}

export function consumeFetch(usage: WebUsage, nowMs: number): WebUsage {
  return { ...usage, fetchCount: usage.fetchCount + 1, lastFetchAtMs: nowMs };
}
