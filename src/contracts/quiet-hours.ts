/**
 * 静默时段（F268，审计 L2 的收尾）：一份事实，三处引用。
 *
 * 审计 L2 指出"静默窗三处、两个口径"：
 *   - `src/orchestrator/intent/situation.ts` 23–7（意图引擎的情境）
 *   - `src/autonomy/standalone.ts` 23–7（旧机械门/降级路径）
 *   - `src/plugin/index.ts` + `src/qq/types.ts` 0–7（宿主主动开口与 QQ 自动回复）
 * 0–7 与 23–7 的差别不是风格问题：她 23–24 点也会主动说话，而插件那条路径认为"不算深夜"。
 *
 * 本文件是**唯一**的时段事实。可 import 它的：大脑层（engine/orchestrator/dialogue…）
 * 与装配点。工具层（`src/qq/*`、`src/plugin/tools.ts`）按 R3 不能 import 大脑内部，
 * 因此那里的字面量由 `test/quiet-hours.test.ts` 锁一致，而不是靠人记得同步。
 *
 * 为什么复用 `engine/timewindow.ts:inQuietHours`：跨零点判定的边界（23:00 含、07:00 不含）
 * 只该有一份实现，重复实现最容易在 `from === to` 与跨零点两种边界上分叉。
 */

import { inQuietHours } from "../engine/timewindow.js";

export interface QuietHours {
  /** 起始小时（含），本地时间 */
  readonly start: number;
  /** 结束小时（不含），本地时间 */
  readonly end: number;
}

/** 工程先验，不是运行期旋钮：夜里 23 点到早 7 点不主动打扰。 */
export const QUIET_HOURS: Readonly<QuietHours> = Object.freeze({ start: 23, end: 7 });

/** 给不接受对象参数的调用点（旧签名 `inQuietHours(hour, from, to)`）用。 */
export const QUIET_HOURS_FROM = QUIET_HOURS.start;
export const QUIET_HOURS_TO = QUIET_HOURS.end;

/** 是否处于静默时段（默认 23 → 7，支持跨零点）。小时由调用方从 Clock 取。 */
export function isQuietHour(localHour: number, window: QuietHours = QUIET_HOURS): boolean {
  requireHour("localHour", localHour);
  requireHour("window.start", window.start);
  requireHour("window.end", window.end);
  return inQuietHours(localHour, window.start, window.end);
}

/**
 * 小时必须是 0..23 的整数：静默窗判定错一小时就是"半夜吵醒人"或"该静的时候说话了"，
 * 静默地归一化（24 → 0）会把调用方的 bug 变成行为差异，所以这里故意抛。
 */
function requireHour(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`静默窗：${name} 必须是 0..23 的整数，收到 ${value}`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new RangeError(`静默窗：${name} 必须是 0..23 的整数，收到 ${value}`);
  }
}
