/**
 * §4.7 crisis_event —— immediate 白名单的第二个来源（见 A.2 IMMEDIATE_WHITELIST）。
 *
 * 普通事件排队到下一 tick；突发重大事件（severity ≥ CRISIS_SEVERITY_MIN）必须同 tick 生效，
 * 否则"角色被当场激怒"要等 5 分钟，状态机就永远比对话慢一拍。
 */

import { knobNumber, type EngineConfig } from "./config.js";
import { clamp01 } from "./state.js";

export interface CrisisEvent {
  readonly id: string;
  readonly severity: number; // 0..1
  readonly summary: string;
}

export interface ImmediateGain {
  readonly source: "crisis_event";
  readonly pressureGain: number;
  readonly suppressionAdd: number;
  readonly reason: string;
}

/** 低于门槛不是危机，返回 null 让调用方走普通 GainEvent 队列 */
export function crisisEvent(event: CrisisEvent, cfg: EngineConfig): ImmediateGain | null {
  const threshold = knobNumber(cfg, "CRISIS_SEVERITY_MIN");
  const ratio = knobNumber(cfg, "CRISIS_SUPPRESSION");
  if (!Number.isFinite(event.severity)) throw new RangeError(`severity 非有限值：${String(event.severity)}`);
  if (event.severity < threshold) return null;
  const sev = clamp01(event.severity);
  return {
    source: "crisis_event",
    pressureGain: sev,
    suppressionAdd: ratio * sev,
    reason: event.summary,
  };
}

/** 把一个 ImmediateGain 折成 tick 入参（同一 tick 内生效；si=0，避免与 suppressionAdd 双计） */
export function immediateTickInput(
  gain: ImmediateGain,
  dtHours: number,
): { dtHours: number; pressureGain: number; suppressionAdd: number; suppressionIntensity: number } {
  return { dtHours, pressureGain: gain.pressureGain, suppressionAdd: gain.suppressionAdd, suppressionIntensity: 0 };
}
