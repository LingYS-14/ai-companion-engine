/**
 * cycles.ts —— 昼夜节律里的"睡眠点"（G5-①）。
 *
 * 规格依据：§10.3 睡眠巩固（错峰）
 *
 *   offset = int(md5(player_id), 16) % SLEEP_OFFSET_HOURS
 *   schedule_daily(f"sleep_{player_id}", hour=SLEEP_BASE_HOUR + offset)
 *
 * 为什么实现成"每日一个时刻"而不是"一段睡眠窗口"：
 * 规格只给了触发时刻与错峰，没给睡眠时长。编一个窗口会凭空发明一个常量，
 * 而睡眠时长一旦进入数值层就会被拿去算 energy 恢复，变成"实现自由"。
 * 因此这里只回答两个问题：她下一次什么时候睡、过去这段时间跨过了几次睡点。
 */

import { knobNumber, type EngineConfig } from "./config.js";

export interface SleepCrossing {
  /** 跨过几个睡点（0 表示这段时间里没睡过） */
  readonly count: number;
  /** 距离最近一次睡点过了几小时；count=0 时为 Infinity */
  readonly hoursSinceLast: number;
  /** 该角色的睡点（0-23 整点） */
  readonly sleepHour: number;
}

/** FNV-1a 32 位 —— 与 consolidate.ts 的 knowledgeIdFor 同一套哈希，避免引入依赖 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 该角色每天几点睡：SLEEP_BASE_HOUR + (hash(characterId) % SLEEP_OFFSET_HOURS)。
 * 错峰的意义是别让所有角色在同一分钟写盘；对单个角色它是稳定的。
 */
export function sleepHourFor(characterId: string, cfg: EngineConfig): number {
  const base = Math.trunc(knobNumber(cfg, "SLEEP_BASE_HOUR"));
  const span = Math.max(1, Math.trunc(knobNumber(cfg, "SLEEP_OFFSET_HOURS")));
  const hour = base + (fnv1a(characterId) % span);
  return ((hour % 24) + 24) % 24;
}

/**
 * 从 startHour 起、经过 elapsedHours 小时，跨过几次睡点。
 *
 * 纯算术、不碰日期：测试可以直接给 21.5 与 9 这样的数，不必造时间戳。
 * 恰好从睡点出发时算"明天那一次"，否则 0 小时推进也会被当成睡了一觉。
 */
export function crossedSleeps(startHour: number, elapsedHours: number, sleepHour: number): SleepCrossing {
  if (!Number.isFinite(startHour)) throw new RangeError(`startHour 必须是有限数：${startHour}`);
  if (!Number.isFinite(elapsedHours) || elapsedHours < 0) {
    throw new RangeError(`elapsedHours 必须是非负有限数：${elapsedHours}`);
  }
  const sleep = ((sleepHour % 24) + 24) % 24;
  const start = ((startHour % 24) + 24) % 24;
  let first = (sleep - start + 24) % 24;
  if (first === 0) first = 24;
  if (first > elapsedHours) return { count: 0, hoursSinceLast: Number.POSITIVE_INFINITY, sleepHour: sleep };
  const count = Math.floor((elapsedHours - first) / 24) + 1;
  const last = first + 24 * (count - 1);
  return { count, hoursSinceLast: elapsedHours - last, sleepHour: sleep };
}

/** 距离下一次睡点还有几小时（0 < x ≤ 24） */
export function nextSleepInHours(startHour: number, sleepHour: number): number {
  const start = ((startHour % 24) + 24) % 24;
  const diff = ((sleepHour - start) % 24 + 24) % 24;
  return diff === 0 ? 24 : diff;
}
