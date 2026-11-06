/**
 * 意向引擎 P0 —— B1 上游：情境帧（VISION §4.2 `SituationFrame`）。
 *
 * 职责：把"此刻的世界"压成一张只读快照——时间、渠道、在场者、**真正可用**的工具能力、距离上次接触多久、
 * 未闭合的意图、额度与静默。**不做能力探测**（§11.4 的效力探测是 P4，要 IO 与缓存）；这里只组装调用方
 * 已经探测好的事实，纯函数、零 IO。
 *
 * 时钟纪律：本文件**不调用系统时间函数**（`tools/lint/writers.mjs` 规则 2：读系统时间只允许出现在
 * `src/engine/clock.ts`）。`localHour` 由调用方用 `Clock.localHour()` 取好再传进来——P0 因此可重放，
 * 也不会在测试里依赖"跑测试时几点"。
 *
 * `hardBlocks` 是"只读告警，不参与打分"（§4.2 注释）：打分不知道静默时段，闸在 B2 之后、B3 之前
 * （§4.5 #3）。P0 只把告警算出来并给出 `canSendEffects`，**不执行任何拦截**。
 */

import type { Affordance, RiskLevel, SituationFrame } from "./types.js";
import { QUIET_HOURS, isQuietHour, type QuietHours } from "../../contracts/quiet-hours.js";

/** 静默时段的事实与判定都收在 `contracts/quiet-hours.ts`（F268）。这里保留同名导出，旧调用点不用改。 */
export { QUIET_HOURS, isQuietHour };
export type { QuietHours };

/** `SituationFrame.hardBlocks` 的取值集合（码值，便于审计与断言）。 */
export type HardBlock = "quiet_hours" | "single_writer_conflict" | "rate_limited" | "no_affordance";

/** 会拦住"有副作用动作"的告警；`no_affordance` 不拦（只是说明此刻只能想、不能做）。 */
export const WRITE_BLOCKING: readonly HardBlock[] = Object.freeze([
  "quiet_hours",
  "single_writer_conflict",
  "rate_limited",
]);

export interface SituationInput {
  /** ISO 时间（只记录，不由本函数解析——时钟从 `Clock` 来） */
  at: string;
  /** 本机小时 0..23，由 `Clock.localHour()` 提供 */
  localHour: number;
  channel: SituationFrame["channel"];
  participants?: readonly string[];
  /** 已按登录/额度过滤过的工具能力；空数组是合法事实（"此刻什么都做不了"） */
  affordances?: readonly Affordance[];
  /** 距上次**真实**互动的分钟数（不含 selftalk / 系统消息；口径由调用方保证） */
  sinceLastContactMin: number;
  activeIntents?: readonly string[];
  /** `rph` = 本小时剩余模型调用名额；`peak` = 是否峰时 */
  budget: { rph: number; peak: boolean };
  /** 单写者冲突（另一个进程正持有写锁） */
  singleWriterConflict?: boolean;
}

function requireFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`buildSituation: ${name} 必须是有限数字，收到 ${String(value)}`);
  }
  return value;
}

function requireHour(name: string, value: number): number {
  requireFinite(name, value);
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new RangeError(`buildSituation: ${name} 必须是 0..23 的整数，收到 ${value}`);
  }
  return value;
}

/**
 * 组装情境帧。所有数组**复制**进结果（调用方之后改自己的数组不会污染快照）。
 * `hardBlocks` 的顺序固定（quiet → single_writer → rate_limit → no_affordance），便于 golden replay 对拍。
 */
export function buildSituation(input: SituationInput): SituationFrame {
  const localHour = requireHour("localHour", input.localHour);
  const sinceLastContactMin = requireFinite("sinceLastContactMin", input.sinceLastContactMin);
  if (sinceLastContactMin < 0) {
    throw new RangeError(`buildSituation: sinceLastContactMin 不能为负：${sinceLastContactMin}`);
  }
  const rph = requireFinite("budget.rph", input.budget.rph);
  if (rph < 0) throw new RangeError(`buildSituation: budget.rph 不能为负：${rph}`);

  const affordances = [...(input.affordances ?? [])];
  const quietHours = isQuietHour(localHour);

  const hardBlocks: HardBlock[] = [];
  if (quietHours) hardBlocks.push("quiet_hours");
  if (input.singleWriterConflict === true) hardBlocks.push("single_writer_conflict");
  if (rph <= 0) hardBlocks.push("rate_limited");
  if (affordances.length === 0) hardBlocks.push("no_affordance");

  return {
    at: input.at,
    channel: input.channel,
    participants: [...(input.participants ?? [])],
    affordances,
    sinceLastContactMin,
    activeIntents: [...(input.activeIntents ?? [])],
    budget: { rph, peak: input.budget.peak === true, quietHours },
    hardBlocks,
  };
}

export function hasHardBlock(frame: SituationFrame, block: HardBlock): boolean {
  return frame.hardBlocks.includes(block);
}

/**
 * 此刻能不能做"有副作用的动作"（发消息、写数据、点桌面）。
 * 注意：这是**咨询函数**，不是闸——真正的闸在 `shouldInitiate` 与 execution 层（§4.5 #3，P1 才接）。
 */
export function canSendEffects(frame: SituationFrame): boolean {
  return !WRITE_BLOCKING.some((block) => hasHardBlock(frame, block));
}

/** 风险最高的可用能力级别（0 = 只能读或什么都没有）。审计/自述用，不参与打分。 */
export function maxAffordanceRisk(frame: SituationFrame): RiskLevel {
  let max: RiskLevel = 0;
  for (const affordance of frame.affordances) {
    if (affordance.risk > max) max = affordance.risk;
  }
  return max;
}
