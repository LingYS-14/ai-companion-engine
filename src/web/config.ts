/**
 * 网页能力的配置读取（W1，spec v2.3 §7.2）。
 *
 * 六个键都注册在 `spec/config/v54.overlay.json` 的 cluster A.14；本文件是它们唯一的
 * 读取点——`tools/audit/check_registry.mjs` 要求每个 overlay 键在 src 下的 .ts 文件里
 * 作为字符串字面量出现，否则算「死旋钮」直接 FAIL。
 *
 * 缺省兜底：`KnobReader.read` 对缺失键会抛（当前实现），这里按默认值继续跑——
 * 老数据目录/裁剪过的配置不该让网页能力整块炸掉；非法值（越界/非数字）才是真错误，
 * 抛 `RangeError` 让装配点显式失败（fail-closed）。
 */

import type { KnobReader } from "../ports/index.js";

export interface WebConfig {
  /** 总开关；0 = 零网络、零行为变化（W1 的默认值） */
  readonly enabled: boolean;
  /** 每日搜索成功次数上限 */
  readonly searchDailyCap: number;
  /** 每日抓取成功次数上限（W1 不执行抓取，只保留额度口径） */
  readonly fetchDailyCap: number;
  /** 两次搜索之间的最小间隔（毫秒） */
  readonly minIntervalMs: number;
  /** 单次 HTTP 超时（毫秒） */
  readonly timeoutMs: number;
  /** 落库时的 source_credibility（web 低于 bili） */
  readonly sourceCredibility: number;
}

/** 默认值必须与 v54.overlay.json 的 value 一致（registry 侧另有校验） */
export const WEB_CONFIG_DEFAULTS: WebConfig = {
  enabled: false,
  searchDailyCap: 20,
  fetchDailyCap: 10,
  minIntervalMs: 1_800_000,
  timeoutMs: 8_000,
  sourceCredibility: 0.55,
};

/** 每个键的合法区间（overlay 的 range 也写了同一份；这里是为了 fail-closed） */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  WEB_SEARCH_ENABLED: [0, 1],
  WEB_SEARCH_DAILY_CAP: [0, 100],
  WEB_FETCH_DAILY_CAP: [0, 50],
  WEB_SEARCH_MIN_INTERVAL_MS: [0, 21_600_000],
  WEB_TIMEOUT_MS: [1_000, 30_000],
  WEB_SOURCE_CREDIBILITY: [0, 1],
};

let missingLogged = false;

function readNumber(reader: KnobReader, name: string, fallback: number, log?: (line: string) => void): number {
  let raw: number;
  try {
    raw = reader.read(name);
  } catch {
    if (!missingLogged) {
      missingLogged = true;
      log?.("[web] 配置缺失，按默认值运行（只提示一次）");
    }
    return fallback;
  }
  const [min, max] = RANGES[name] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new RangeError(`[web] 配置 ${name}=${String(raw)} 非法（允许 ${min}..${max}）`);
  }
  return raw;
}

/** 读六个键；缺失走默认，非法值抛 RangeError */
export function readWebConfig(reader: KnobReader, log?: (line: string) => void): WebConfig {
  return {
    enabled: readNumber(reader, "WEB_SEARCH_ENABLED", WEB_CONFIG_DEFAULTS.enabled ? 1 : 0, log) === 1,
    searchDailyCap: readNumber(reader, "WEB_SEARCH_DAILY_CAP", WEB_CONFIG_DEFAULTS.searchDailyCap, log),
    fetchDailyCap: readNumber(reader, "WEB_FETCH_DAILY_CAP", WEB_CONFIG_DEFAULTS.fetchDailyCap, log),
    minIntervalMs: readNumber(reader, "WEB_SEARCH_MIN_INTERVAL_MS", WEB_CONFIG_DEFAULTS.minIntervalMs, log),
    timeoutMs: readNumber(reader, "WEB_TIMEOUT_MS", WEB_CONFIG_DEFAULTS.timeoutMs, log),
    sourceCredibility: readNumber(reader, "WEB_SOURCE_CREDIBILITY", WEB_CONFIG_DEFAULTS.sourceCredibility, log),
  };
}
