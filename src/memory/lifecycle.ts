/**
 * §6 记忆生命周期里的**数值规则**（纯函数，不碰 IO）：
 *   - confidence：0.3×vividness + 0.7×accuracy（0.7 乘 accuracy，不是 confidence 自身）
 *   - L2 知识 freshness：半衰期按 knowledge_type 查表，最终 clamp 到 [0,1]
 *   - 冷归档：forgotten 且非执念且 vividness < 阈值，且 last_accessed 超过冷归档窗口
 *   - 硬删除：显式 hard_deleted 且过保留期
 *   - 高唤醒遗忘：arousal ≥ HIGH_AROUSAL_THRESHOLD 时 vividness 衰减加速
 *
 * 这些规则都是"读数 + 判断"，真正的写入仍由 MemoryStore 负责（INV-1 的写路径不变）。
 */

import { knobNumber, knobObject, type EngineConfig } from "../engine/config.js";
import { clamp01 } from "../engine/state.js";
import type { MemoryRecord } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * 置信度。原稿（v5.0–v5.3）写 `0.3*vividness + 0.7*confidence`，并注释"系数 ≤ 0.5"，
 * 那是自指：不动点 = vividness，于是 confidence 永远追随 vividness（"永远自信"复发）。
 * 这里乘 accuracy —— 校准的是"我有多确定它真实"，而不是"它有多鲜明"。
 */
export function updateConfidence(m: Pick<MemoryRecord, "vividness" | "accuracy">): number {
  return clamp01(0.3 * m.vividness + 0.7 * m.accuracy);
}

/** L2 知识条目（§6.3）：11 字段，这里只用到新鲜度相关部分 */
export interface KnowledgeRecord {
  readonly knowledge_type: string;
  readonly ingested_at: number;
  readonly access_count: number;
  readonly social_freshness: number;
}

/** §6.3 freshness：半衰期表的值本身就是"天"，原稿多套了一层 ["days"] 导致 TypeError */
export function computeFreshness(k: KnowledgeRecord, now: number, cfg: EngineConfig): number {
  const hl = knobObject<Record<string, number>>(cfg, "KNOWLEDGE_HALFLIFE");
  const days = hl[k.knowledge_type];
  if (days === undefined) throw new Error(`KNOWLEDGE_HALFLIFE 没有 ${k.knowledge_type} 这一类`);
  const elapsedDays = Math.max(0, now - k.ingested_at) / DAY_MS;
  const objective = Math.pow(0.5, elapsedDays / days);
  // 社会新鲜度与访问次数加成，最后必须 clamp：原稿没有 clamp，access=100 时算出 1.4615
  return clamp01(objective * k.social_freshness * (1 + Math.log1p(k.access_count) * 0.1));
}

/**
 * 冷归档判定（§6.9，B6 修法）：字段名必须是 last_accessed；
 * now 由 Clock 传入；保留期常量来自注册表而不是裸字面量。
 */
export function shouldColdArchive(
  m: Pick<MemoryRecord, "forgotten" | "is_obsession" | "vividness" | "last_accessed">,
  now: number,
  cfg: EngineConfig,
): boolean {
  if (!m.forgotten) return false;
  if (m.is_obsession) return false;
  if (m.vividness >= knobNumber(cfg, "FORGET_VIVIDNESS_THRESHOLD")) return false;
  return now - m.last_accessed > knobNumber(cfg, "COLD_ARCHIVE_DAYS") * DAY_MS;
}

/** 硬删除资格：显式标记 + 过保留期（普通 forgotten 只是软删除，不销毁证据） */
export function hardDeleteEligible(
  m: { readonly hard_deleted?: boolean; readonly hard_delete_at?: number },
  now: number,
  cfg: EngineConfig,
): boolean {
  if (m.hard_deleted !== true || m.hard_delete_at === undefined) return false;
  return now - m.hard_delete_at > knobNumber(cfg, "HARD_DELETE_RETENTION_DAYS") * DAY_MS;
}

/**
 * 高唤醒遗忘（§6.4）：arousal ≥ 阈值时 vividness 额外按 HIGH_AROUSAL_DECAY_FACTOR 衰减。
 * 语义是"情绪太强的那段，反而记不清细节"——不是把它们一起抹掉。
 */
export function decayVividness(m: Pick<MemoryRecord, "vividness">, arousal: number, dtDays: number, cfg: EngineConfig): number {
  const threshold = knobNumber(cfg, "HIGH_AROUSAL_THRESHOLD");
  if (arousal < threshold) return m.vividness;
  const factor = knobNumber(cfg, "HIGH_AROUSAL_DECAY_FACTOR");
  return clamp01(m.vividness * Math.pow(factor, dtDays));
}

/**
 * 未解决度（§6.8）：上界 1，每 tick 加 UNRESOLVED_GAIN，按 UNRESOLVED_DECAY 线性回落。
 * 它是"这件事还没想明白"的强度，不是情绪强度。
 */
export function updateUnresolved(m: { unresolved_score: number }, resolvedNow: boolean, dtDays: number, cfg: EngineConfig): number {
  const gain = resolvedNow ? 0 : knobNumber(cfg, "UNRESOLVED_GAIN");
  const decay = knobNumber(cfg, "UNRESOLVED_DECAY") * dtDays;
  return clamp01(m.unresolved_score + gain - decay);
}

/**
 * §6.5 `MemoryLifecycle.tick` 的鲜明度衰减（规格原式）：
 *
 * ```python
 * lam = DECAY_RATE * (HIGH_AROUSAL_DECAY_FACTOR if m.arousal_tag > HIGH_AROUSAL_THRESHOLD else 1.0)
 * m.vividness *= (1 + ctx.dt_days) ** (-lam)
 * ```
 *
 * 两处必须说明的偏差（记在 NOTES 的 F22）：
 *   1. `arousal_tag` 不在 §6.2 的 27 字段里 —— 这里退化为传参 `arousal`（调用方给当轮 `state.arousal`）；
 *   2. `HIGH_AROUSAL_DECAY_FACTOR = 0.1` 让高唤醒时 lam 变成 0.07，也就是**衰减更慢**，
 *      而 §6.4 的散文写的是"情绪太强反而记不清细节"。数值与散文相反；此处照公式实现，
 *      因为断言与夹具都以公式为准，散文可以下一版改。
 */
export function tickVividness(vividness: number, arousal: number, dtDays: number, cfg: EngineConfig): number {
  const lam =
    knobNumber(cfg, "DECAY_RATE") *
    (arousal > knobNumber(cfg, "HIGH_AROUSAL_THRESHOLD") ? knobNumber(cfg, "HIGH_AROUSAL_DECAY_FACTOR") : 1.0);
  return clamp01(vividness * Math.pow(1 + Math.max(0, dtDays), -lam));
}

/** §6.5：鲜明度跌破阈值且不是执念 → 标记遗忘（软删除，可回溯） */
export function shouldForgetNow(vividness: number, isObsession: boolean, cfg: EngineConfig): boolean {
  if (isObsession) return false;
  return vividness < knobNumber(cfg, "FORGET_VIVIDNESS_THRESHOLD");
}

/**
 * §6.5：unresolved_score 的时间衰减 `clamp(score * exp(-UNRESOLVED_DECAY*dt_days), 0, 1)`。
 *
 * INV7-EXEMPT：unresolved_score 的下界是 0、没有 baseline，所以这里只有"乘法衰减"一条路径，
 * 不存在"乘法衰减 + 向 baseline 松弛"互相打架的问题（INV-7 针对的是 pressure / suppression_load）。
 */
export function decayUnresolved(score: number, dtDays: number, cfg: EngineConfig): number {
  return clamp01(score * Math.exp(-knobNumber(cfg, "UNRESOLVED_DECAY") * Math.max(0, dtDays)));
}
