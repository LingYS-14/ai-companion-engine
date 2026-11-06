/**
 * v5.4-P1 §4.2 冷热分层（D1/D2/D3）：ACT-R 的「激活强度」标量版。
 *
 * 与规格字面的三处差异，全部按审计裁决：
 *   1. **时间基**：规格代码拿 `now()`（秒）× `ACT_R_DECAY`（per-hour），少除 3600（N1）。
 *      这里统一用毫秒时间戳 + `HOUR_MS` 换算成小时，`thermalTier`/`onRetrieve`/迁移三处同一口径。
 *   2. **纯函数边界**：`activationNow`/`thermalTier` 只读；写回只在 `MemoryStore.touch()`（A27）。
 *   3. **特赦阈值**按本仓库 specificity 的定义重校准（0.55/0.70，审计 F4）。
 */

import { knobNumber, type EngineConfig } from "../engine/config.js";
import type { MemoryRecord } from "./types.js";

export const HOUR_MS = 3_600_000;

export type ThermalTier = "hot" | "warm" | "cold";

/** 两个毫秒时间戳之间的小时数（负数裁成 0：时钟回拨不该制造"未来记忆"） */
export function hoursBetween(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, (toMs - fromMs) / HOUR_MS);
}

/**
 * 一次检索带来的激活抬升：B ← ln(exp(B − decay·Δt) + 1)（§4.2 on_retrieve）。
 *
 * INV7-EXEMPT：这里的指数是 ACT-R 的遗忘曲线本体（规格 §4.2 明写），
 * 不是检索排序里的第二份 recency 折扣——INV-7 禁的是「recency_curve 与 B_i 重复计入」。
 */
export function baseActivationAfterRetrieval(previousBase: number, dtHours: number, cfg: EngineConfig): number {
  const decay = knobNumber(cfg, "ACT_R_DECAY");
  return Math.log(Math.exp(previousBase - decay * dtHours) + 1);
}

/** 当前激活值：惰性衰减，不写字段 */
export function activationNow(m: Pick<MemoryRecord, "base_activation" | "last_accessed">, nowMs: number, cfg: EngineConfig): number {
  const decay = knobNumber(cfg, "ACT_R_DECAY");
  const base = Number.isFinite(m.base_activation) ? m.base_activation : 0;
  return base - decay * hoursBetween(m.last_accessed, nowMs);
}

/** b > HOT 为 hot，b >= COLD 为 warm，否则 cold（§4.2 原文） */
export function thermalTier(m: Pick<MemoryRecord, "base_activation" | "last_accessed">, nowMs: number, cfg: EngineConfig): ThermalTier {
  const b = activationNow(m, nowMs, cfg);
  if (b > knobNumber(cfg, "ACT_R_THRESHOLD_HOT")) return "hot";
  if (b >= knobNumber(cfg, "ACT_R_THRESHOLD_COLD")) return "warm";
  return "cold";
}

export interface RescueSignals {
  /** F25 自实现的 encoding_specificity（0..1） */
  readonly specificity: number;
  /** 与当前情绪的一致性（0..1） */
  readonly emotionMatch: number;
}

/** INV-7 特赦：specificity 或 emotion_match 过线，cold 条目才允许进候选 */
export function rescuedFromCold(signals: RescueSignals, cfg: EngineConfig): boolean {
  return (
    signals.specificity > knobNumber(cfg, "SPECIFICITY_RESCUE_THRESHOLD") ||
    signals.emotionMatch > knobNumber(cfg, "EMOTION_RESCUE_THRESHOLD")
  );
}

/** 旧记录迁移：没有 base_activation 的记录按「访问次数 + 年龄」反推一个初始值（D2） */
export function migratedBaseActivation(m: Pick<MemoryRecord, "access_count" | "last_accessed">, nowMs: number, cfg: EngineConfig): number {
  const decay = knobNumber(cfg, "ACT_R_DECAY");
  const raw = Math.log(1 + Math.max(0, m.access_count)) - decay * hoursBetween(m.last_accessed, nowMs);
  return Math.max(-1, Math.min(0, raw));
}
