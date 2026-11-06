/**
 * 空转（idle）调度：什么时候允许拿一拍来做"没有人在说话"时的内心活动（纯函数；不读时钟）
 *
 * 规格出处：VISION §4.5 #4（空转要防抖，不能每拍都生成新意图）与 §8.2 P2
 * （空转 tick：记忆回放候选源）。本文件只回答两个问题：
 *   1. 现在这一拍该不该做一次"空转活动"？（`idleDue`）
 *   2. 如果该做，这次是做重一点（generating 新候选，`deliberate`）还是轻一点
 *      （只回放记忆 + 检查到期意图，`digest`）？
 *
 * 为什么分两档：她一个人待着的时候，如果每一拍都"想点新事"，意图表会越堆越长、
 * 后台空转会把 WAL 写满，而且会让真正该做的事被噪声挤掉。所以：
 *   - 开着的意图已经够多（≥ K_S）→ 只做 digest，消化已有的；
 *   - 开着的意图不多 → 才允许 deliberate（回放 + 生成候选）。
 *
 * 调度间隔不是固定 5 分钟：`IDLE_MIN_MS`–`IDLE_MAX_MS` 之间按 `seed` 确定性取值，
 * 这样同一天重启不会换节奏，也不同进程之间也不至于完全同拍（避免同时写 WAL）。
 */

import { clamp01 } from "../../engine/state.js";

/** 空转最短间隔：20 分钟 */
export const IDLE_MIN_MS = 20 * 60_000;
/** 空转最长间隔：40 分钟 */
export const IDLE_MAX_MS = 40 * 60_000;
/** 开着这么多条意图时就不再加新的（按类型覆盖的性质，不算"堵死"） */
export const K_S_DEFAULT = 3;

/** 空转活动两档：轻（只消化）/重（可以生成候选） */
export type IdleMode = "digest" | "deliberate";

export interface IdlePlan {
  /** 此刻是否到空转窗口 */
  readonly due: boolean;
  /** 到了窗口时的活动档位；不到窗口时固定 digest（无意义值，别读） */
  readonly mode: IdleMode;
  /** 下一次窗口的毫秒时间；未排期或已到时为 null */
  readonly nextAtMs: number | null;
  /** 本次间隔（毫秒） */
  readonly intervalMs: number;
  /** 给人看的一句话 */
  readonly reason: string;
}

export interface IdleInput {
  /** 上一次空转/主动 tick 的毫秒时间；null = 进程刚起来，还没落过盘 */
  readonly lastTickAtMs: number | null;
  readonly nowMs: number;
  /** 此刻开着的意图数（pending + active + blocked） */
  readonly openIntentions: number;
  /** 确定性种子（建议用角色 id + 日期，保证同一天节奏稳定） */
  readonly seed: string;
  /** 覆盖 K_S（默认 3） */
  readonly kS?: number;
}

/** 32 位 FNV-1a：只用于把种子摊成 [0,1)，不用于任何安全用途。 */
export function seedFraction(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** 由种子决定的间隔（20–40 分钟，含两端附近）。 */
export function idleIntervalMs(seed: string): number {
  const span = IDLE_MAX_MS - IDLE_MIN_MS;
  return Math.round(IDLE_MIN_MS + seedFraction(seed) * span);
}

/** 现在是否到了空转窗口。`lastTickAtMs=null` 视为"未排期"，返回 false（第一拍由启动逻辑负责）。 */
export function idleDue(lastTickAtMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (lastTickAtMs === null) return false;
  return nowMs - lastTickAtMs >= intervalMs;
}

/**
 * 决定这一拍怎么走。
 * 不到窗口 → due=false / nextAtMs=上次+间隔；到窗口 → due=true / nextAtMs=null。
 */
export function planIdleTick(input: IdleInput): IdlePlan {
  const kS = input.kS ?? K_S_DEFAULT;
  const intervalMs = idleIntervalMs(input.seed);
  const due = idleDue(input.lastTickAtMs, input.nowMs, intervalMs);

  if (!due) {
    const nextAtMs = input.lastTickAtMs === null ? null : input.lastTickAtMs + intervalMs;
    return {
      due: false,
      mode: "digest",
      nextAtMs,
      intervalMs,
      reason: input.lastTickAtMs === null ? "还没开始计时（首次启动）" : "未到空转窗口",
    };
  }

  const open = Math.max(0, Math.floor(input.openIntentions));
  // 开着的意图越多，越只该消化；用比例再做一次软过渡，避免 K_S 边界抖动时来回切档
  const load = kS <= 0 ? 1 : clamp01(open / kS);
  const mode: IdleMode = open >= kS ? "digest" : "deliberate";
  return {
    due: true,
    mode,
    nextAtMs: null,
    intervalMs,
    reason:
      mode === "deliberate"
        ? `空转窗口到了，开着 ${String(open)} 条意图（负载 ${load.toFixed(2)}），允许回放并生成候选`
        : `空转窗口到了，开着 ${String(open)} 条意图（≥ K_S=${String(kS)}），只消化不新生成`,
  };
}
