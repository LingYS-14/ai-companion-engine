/**
 * 空转节拍决策（§4.5 #4 空转防抖 → 接进常驻 tick 的那一层）
 *
 * 为什么：`idle.ts` 已经能算出"这一拍该不该空转、该重还是该轻"，但常驻 tick 一直没用它——
 * 每 5 分钟都允许"想点新事"，于是意图表可能被每拍堆一条；而 §4.5 #4 要的正是
 * "开着的意图够多时只消化、不要每拍都生成新的"。
 *
 * 本文件只做一件事：把 `planIdleTick` 的结论翻译成 tick 可直接用的两个动作
 *   - `recordNewIntentions`：这一拍浮现的意图要不要写进意图表；
 *   - `mode`/`nextAtMs`：给日志与持久化看的节拍信息。
 * 不读时钟、不读写文件、不调模型。
 */

import { idleIntervalMs, planIdleTick, type IdleMode } from "./idle.js";

export interface TickModeInput {
  /** 上一次空转窗口的时间；null = 进程还没落过盘（首次启动） */
  readonly lastIdleAtMs: number | null;
  readonly nowMs: number;
  /** 此刻开着的意图数（pending + active + blocked） */
  readonly openIntentions: number;
  /** 确定性种子（建议 `<角色id>-<日期>`） */
  readonly seed: string;
  /** 覆盖 K_S（默认 3） */
  readonly kS?: number;
}

export interface TickModeResult {
  /** 这一拍是否空转窗口（首次启动视为窗口已到） */
  readonly due: boolean;
  readonly mode: IdleMode;
  /** 这一拍浮现的新意图要不要写表 */
  readonly recordNewIntentions: boolean;
  /** 下一次窗口的毫秒时间（due=false 时给排期，due=true 时给"下一次"） */
  readonly nextAtMs: number | null;
  readonly reason: string;
}

/**
 * 把空转计划翻译成 tick 动作。
 *
 * 首次启动（`lastIdleAtMs === null`）`planIdleTick` 会返回"还没开始计时"，
 * 若照它办，重启后要等一整个窗口才允许记新意图；这里显式把首次启动当作窗口已到，
 * 并把下一次窗口排在 now+间隔——这样重启不会让"想点新的"停滞一轮。
 */
export function planTickMode(input: TickModeInput): TickModeResult {
  const kS = input.kS ?? 3;
  const intervalMs = idleIntervalMs(input.seed);
  const plan = planIdleTick({
    lastTickAtMs: input.lastIdleAtMs,
    nowMs: input.nowMs,
    openIntentions: input.openIntentions,
    seed: input.seed,
    ...(input.kS === undefined ? {} : { kS: input.kS }),
  });

  if (input.lastIdleAtMs === null) {
    const deliberate = input.openIntentions < kS;
    return {
      due: true,
      mode: deliberate ? "deliberate" : "digest",
      recordNewIntentions: deliberate,
      nextAtMs: input.nowMs + intervalMs,
      reason: deliberate
        ? "首次启动：当作空转窗口已到，允许记一笔新意图"
        : `首次启动：已有 ${String(input.openIntentions)} 条开着的意图（≥ K_S=${String(kS)}），只消化`,
    };
  }

  const deliberate = plan.due && plan.mode === "deliberate";
  return {
    due: plan.due,
    mode: plan.due ? plan.mode : "digest",
    recordNewIntentions: deliberate,
    nextAtMs: plan.due ? input.nowMs + intervalMs : plan.nextAtMs,
    reason: plan.reason,
  };
}
