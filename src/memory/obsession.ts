/**
 * §6.8 执念（线索驱动 + 反刍耦合）
 *
 * 规格原文（fixtures/v531.txt:871-889，段落 [874]-[889]）：
 *
 *     def obsession_trigger(m, ctx, state, state_machine):
 *         if m.hard_deleted: return None                 # A30：硬删除不可召回
 *         cue = encoding_specificity(m.encode_ctx, ctx)
 *         emotion = max(0, state.valence * m.valence)
 *         unresolved = m.unresolved_score
 *         prob = cue * emotion * (OBSESSION_PROB_BASE + unresolved
 *                                 + RUMINATION_PROB_WEIGHT * state.rumination)
 *         if prob > OBSESSION_PROB_THRESHOLD:
 *             state_machine.submit_gain_event(GainEvent(
 *                 source="obsession_intrusion",
 *                 amount=OBSESSION_GAIN_WEIGHT * prob,
 *                 rumination_add=OBSESSION_RUMINATION_ADD,
 *                 apply_at="immediate"))
 *             return "INTRUDE"
 *         if days_since_last_recall(m) > 7: return "MILD_REMIND"
 *
 * 三处规格缺口（docs/DESIGN.md F26），一律"显式替代 + 报出缺失"，不静默补值：
 *   1. `m.hard_deleted` 不在 27 字段里（F22 同源）→ 读不到时视为 false，并记 missing。
 *   2. `m.valence` 不在 27 字段里 → 用编码时的 `m.encode_state["valence"]`；再没有就取
 *      中性 0.5 并记 missing。取 0.5 而不是 0，是因为 emotion 会直接乘进 prob，
 *      取 0 会让整条机制永不触发（那等于把功能关掉却假装实现了）。
 *   3. `days_since_last_recall` 未定义 → 用 `last_accessed`（没有则 `created_at`）到 now 的天数。
 *
 * `encoding_specificity` 与 §6.6 共用 `memory/specificity.ts` 的同一份实现。
 */

import { knobNumber, type EngineConfig } from "../engine/config.js";
import { encodingSpecificity, type SpecificityContext } from "./specificity.js";
import type { MemoryRecord } from "./types.js";

const DAY_MS = 86_400_000;

/** 规格 §4.6 的 immediate 白名单只允许两个来源，这里是其一。 */
export interface ObsessionGain {
  readonly source: "obsession_intrusion";
  readonly amount: number;
  readonly ruminationAdd: number;
  readonly applyAt: "immediate";
}

export type ObsessionKind = "INTRUDE" | "MILD_REMIND";

export interface ObsessionCheck {
  /** null = 既不闯入也不提醒 */
  readonly kind: ObsessionKind | null;
  readonly cue: number;
  readonly emotion: number;
  readonly prob: number;
  readonly threshold: number;
  readonly daysSinceRecall: number;
  readonly gain: ObsessionGain | null;
  /** 规格引用但记忆里读不到的字段。 */
  readonly missing: readonly string[];
}

export interface ObsessionState {
  readonly valence: number;
  readonly rumination: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** `m.valence` 不在 schema 里：优先用编码时的状态快照，再退中性 0.5。 */
function memoryValence(m: MemoryRecord): { value: number; missing: boolean } {
  const raw = (m as MemoryRecord & { valence?: number }).valence;
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: clamp01(raw), missing: false };
  const encoded = m.encode_state["valence"];
  if (typeof encoded === "number" && Number.isFinite(encoded)) return { value: clamp01(encoded), missing: true };
  return { value: 0.5, missing: true };
}

/** `m.hard_deleted` 不在 27 字段里；读不到就是 false（A30 的删除判定见 lifecycle）。 */
function hardDeleted(m: MemoryRecord): { value: boolean; missing: boolean } {
  const raw = (m as MemoryRecord & { hard_deleted?: boolean }).hard_deleted;
  if (typeof raw === "boolean") return { value: raw, missing: false };
  return { value: false, missing: true };
}

/** `days_since_last_recall` 未定义：用最后访问时间（没有则编码时间）。 */
export function daysSinceLastRecall(m: MemoryRecord, now: number): number {
  const last = typeof m.last_accessed === "number" ? m.last_accessed : m.created_at;
  return Math.max(0, (now - last) / DAY_MS);
}

/**
 * 一条消息进来时，**哪条**记忆会闯进来。
 *
 * 之所以抽成纯函数：`obsessionTrigger` 只回答"这一条会不会"，而"从一屋子记忆里挑出
 * 最该闯入的那条"是策略，需要能被穷举测试（谁赢、平手怎么办、全都不够阈值）。
 * 写入（pressure/rumination）仍由 runtime 做——这里只读。
 */
export interface IntrusionPick {
  readonly memory: MemoryRecord;
  readonly check: ObsessionCheck;
}

export function pickIntrusion(
  memories: readonly MemoryRecord[],
  ctx: SpecificityContext & { readonly now: number },
  state: ObsessionState,
  cfg: EngineConfig,
): IntrusionPick | null {
  let best: IntrusionPick | null = null;
  for (const m of memories) {
    if (m.forgotten) continue;
    const check = obsessionTrigger(m, ctx, state, cfg);
    if (check.kind !== "INTRUDE" || check.gain === null) continue;
    if (best === null || check.prob > best.check.prob) best = { memory: m, check };
  }
  return best;
}

/**
 * 这条记忆此刻会不会闯进来。
 *
 * 判定顺序照规格：先排除硬删除，再算 prob，超过阈值 → INTRUDE；否则"超过 7 天没被想起"
 * → MILD_REMIND；都不是 → null。
 */
export function obsessionTrigger(
  m: MemoryRecord,
  ctx: SpecificityContext & { readonly now: number },
  state: ObsessionState,
  cfg: EngineConfig,
): ObsessionCheck {
  const missing: string[] = [];
  const hard = hardDeleted(m);
  if (hard.missing) missing.push("hard_deleted");
  const valence = memoryValence(m);
  if (valence.missing) missing.push("valence");
  const daysSinceRecall = daysSinceLastRecall(m, ctx.now);
  const threshold = knobNumber(cfg, "OBSESSION_PROB_THRESHOLD");

  if (hard.value) {
    return { kind: null, cue: 0, emotion: 0, prob: 0, threshold, daysSinceRecall, gain: null, missing };
  }

  const cue = encodingSpecificity(m, ctx);
  // 规格：max(0, state.valence * m.valence) —— 负价情绪不算"情绪唤起"
  const emotion = Math.max(0, clamp01(state.valence) * valence.value);
  const unresolved = clamp01(m.unresolved_score);
  const base = knobNumber(cfg, "OBSESSION_PROB_BASE");
  const ruminationWeight = knobNumber(cfg, "RUMINATION_PROB_WEIGHT");
  const prob = cue * emotion * (base + unresolved + ruminationWeight * clamp01(state.rumination));

  if (prob > threshold) {
    return {
      kind: "INTRUDE",
      cue,
      emotion,
      prob,
      threshold,
      daysSinceRecall,
      gain: {
        source: "obsession_intrusion",
        amount: knobNumber(cfg, "OBSESSION_GAIN_WEIGHT") * prob,
        ruminationAdd: knobNumber(cfg, "OBSESSION_RUMINATION_ADD"),
        applyAt: "immediate",
      },
      missing,
    };
  }
  if (daysSinceRecall > 7) {
    return { kind: "MILD_REMIND", cue, emotion, prob, threshold, daysSinceRecall, gain: null, missing };
  }
  return { kind: null, cue, emotion, prob, threshold, daysSinceRecall, gain: null, missing };
}

/** 一行可读输出。 */
export function obsessionLine(res: ObsessionCheck, id: string): string {
  const miss = res.missing.length > 0 ? ` missing=${res.missing.join(",")}` : "";
  const head =
    `[obsession] ${id} kind=${res.kind ?? "none"} prob=${res.prob.toFixed(4)} ` +
    `threshold=${res.threshold} cue=${res.cue.toFixed(4)} emotion=${res.emotion.toFixed(4)} ` +
    `days_since_recall=${res.daysSinceRecall.toFixed(2)}${miss}`;
  if (!res.gain) return head;
  return `${head} gain=amount:${res.gain.amount.toFixed(4)},rumination_add:${res.gain.ruminationAdd}`;
}
