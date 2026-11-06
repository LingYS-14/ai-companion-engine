/**
 * §4.6 状态机 —— 纯函数，读 S 层快照，不写任何状态。
 *
 * 优先级（v5.3.1 §4.6 冻结顺序）：
 *   BREAK > DEFENSE > OBSESSION > LAZY > OVERDRIVE > NORMAL
 *
 * 阈值唯一真源是 engine.json 的 meta.modeThresholds（由 v5.3.1 §4.6 的 MODE_THRESHOLDS
 * 字面量经 build_engine_v531.py 抽出来）。这里不再有第二份常量副本 ——
 * v5.2/v5.3 各留过一份，结果两边漂移（B1）。
 */

import type { EngineConfig } from "./config.js";
import type { SState } from "./state.js";

export type Mode = "NORMAL" | "DEFENSE" | "BREAK" | "OBSESSION" | "OVERDRIVE" | "LAZY";

export const MODE_ORDER: readonly Mode[] = ["BREAK", "DEFENSE", "OBSESSION", "LAZY", "OVERDRIVE", "NORMAL"];

export interface ModeThresholds {
  readonly breakMaskMax: number;
  readonly breakPressureMin: number;
  readonly defensePressureMin: number;
  readonly obsessionEntropyMin: number;
  readonly obsessionValenceMax: number;
  readonly overdriveValenceMin: number;
  readonly overdriveArousalMin: number;
  readonly lazyEnergyMax: number;
}

/** 只从 meta.modeThresholds 映射一次（camelCase 视图），不做数值加工 */
export function thresholdsFrom(cfg: EngineConfig): ModeThresholds {
  const t = cfg.meta.modeThresholds;
  return {
    breakMaskMax: t.break_mask_max,
    breakPressureMin: t.break_pressure_min,
    defensePressureMin: t.defense_pressure_min,
    obsessionEntropyMin: t.obsession_entropy_min,
    obsessionValenceMax: t.obsession_valence_max,
    overdriveValenceMin: t.overdrive_valence_min,
    overdriveArousalMin: t.overdrive_arousal_min,
    lazyEnergyMax: t.lazy_energy_max,
  };
}

/**
 * 必须在 tick **之后**调用（post-tick 语义）：
 * 单次冲击算不出 DEFENSE，持续压力才算 —— 否则一次尖锐事件就翻转人格。
 */
export function resolveMode(s: SState, t: ModeThresholds): Mode {
  if (s.maskIntegrity < t.breakMaskMax && s.pressure > t.breakPressureMin) return "BREAK";
  if (s.pressure > t.defensePressureMin) return "DEFENSE";
  if (s.entropy > t.obsessionEntropyMin && s.valence < t.obsessionValenceMax) return "OBSESSION";
  if (s.energy < t.lazyEnergyMax) return "LAZY";
  if (s.valence > t.overdriveValenceMin && s.arousal > t.overdriveArousalMin) return "OVERDRIVE";
  return "NORMAL";
}
