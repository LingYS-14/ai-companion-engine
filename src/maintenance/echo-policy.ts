/**
 * 回声自检的三个阈值（task-169 C，overlay cluster A.15）。
 *
 * 为什么单独成文件：`check_registry` 要求每个 overlay 键在 src/ 里有真实消费点，
 * 且 owner 必须出现在 readers 里。三个键集中在这里读取一次，policy 作为纯数据
 * 传给 echo-guard / selftalk-runner / 装配层，避免每个调用点各读一遍、各写一套缺省。
 *
 * 注意：这里读的是 `KnobReader.read`（本仓库的实际端口），不是设计稿里写的
 * `knobs.number(...)`——端口签名以 src/ports/index.ts:241 为准。
 */

import type { KnobReader } from "../ports/index.js";

export interface EchoPolicy {
  /** Dice 相似度阈值（0..1）；≥ 即判为回声。 */
  readonly threshold: number;
  /** 参照文本最多取最近多少条。 */
  readonly lookback: number;
  /** 参照窗口（小时）。 */
  readonly windowHours: number;
  /** 参照窗口（毫秒），由 windowHours 换算，调用侧直接用。 */
  readonly windowMs: number;
}

export const ECHO_POLICY_DEFAULTS = {
  threshold: 0.65,
  lookback: 20,
  windowHours: 24,
} as const;

const HOUR_MS = 3_600_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 缺键时 `KnobReader.read` 会抛（端口注释如此），这里自己兜底成默认值。 */
function readNumber(knobs: KnobReader, name: string, fallback: number): number {
  try {
    const value = Number(knobs.read(name));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 从引擎旋钮读回声策略。
 *
 * 任一键缺失/非数字/越界都回落到设计默认值（0.65 / 20 / 24h），不让配置错误
 * 把闸门变成「永远命中」或「永远不命中」。
 */
export function loadEchoPolicy(knobs: KnobReader): EchoPolicy {
  const threshold = clamp(readNumber(knobs, "ECHO_DICE_THRESHOLD", ECHO_POLICY_DEFAULTS.threshold), 0.1, 1);
  const lookback = Math.max(1, Math.trunc(readNumber(knobs, "ECHO_LOOKBACK", ECHO_POLICY_DEFAULTS.lookback)));
  const windowHours = Math.max(
    1,
    Math.trunc(readNumber(knobs, "ECHO_WINDOW_HOURS", ECHO_POLICY_DEFAULTS.windowHours)),
  );
  const thresholdSafe = Number.isFinite(threshold) ? threshold : ECHO_POLICY_DEFAULTS.threshold;
  const lookbackSafe = Number.isFinite(lookback) ? lookback : ECHO_POLICY_DEFAULTS.lookback;
  const windowHoursSafe = Number.isFinite(windowHours) ? windowHours : ECHO_POLICY_DEFAULTS.windowHours;
  return {
    threshold: thresholdSafe,
    lookback: lookbackSafe,
    windowHours: windowHoursSafe,
    windowMs: windowHoursSafe * HOUR_MS,
  };
}
