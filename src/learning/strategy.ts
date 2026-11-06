/**
 * strategy.ts —— bandit 的「没有历史时该干什么」（G5-②）。
 *
 * 规格 §7.4 的回退写的是 `archetype.default_strategy[context_tag]`，
 * 但**规格里没有 archetype 表**：全文只有这一处引用（[1036]），
 * A.19 的 per-archetype 只约束"可调项数量"，没有任何一条给出 archetype 的字段。
 * 这是登记在案的规格缺口（F19），不是本文件的疏忽。
 *
 * 因此这里做的是**最小可执行替身**，并把边界写死：
 *   · 回退值必须是 ACTION_TYPES 里的合法动作（规格 §A.2 定义了六个动作）；
 *   · context_tag 由 event_type 归一化而来（规格的 context_tag 没有枚举，归一化表是本文件唯一发明）；
 *   · 选择依据不是口味，而是 §A.5 的 OUTCOME_REWARD：挑在该情境下期望收益为正、
 *     且语义上最能化解该情境的动作。
 *
 * 一旦规格补上 archetype 表，只需把 DEFAULT_BY_CONTEXT 换成读表，调用点不用改。
 */

import { knobStrings, type EngineConfig } from "../engine/config.js";

/** 规格 §A.2：{"care","ignore","tease","praise","hurt","promise"} */
export const CONTEXT_TAGS = ["conflict", "praise", "distance", "intimacy", "neutral"] as const;
export type ContextTag = (typeof CONTEXT_TAGS)[number];

/**
 * 情境 → 默认动作。每一条都写清"为什么是这个"：
 *   conflict  争吵/指责时，唯一正收益反应是「安抚」(OUTCOME_REWARD 0.8) → care
 *   praise    被夸时顺势「升温」(1.0) 最高 → praise
 *   distance  对方冷淡/要离开，全部反应里只有升温为正；用 promise 承接"我会在" → promise
 *   intimacy  亲密场景优先照顾而不是加码试探 → care
 *   neutral   无信号时最安全的是照顾 → care
 */
export const DEFAULT_BY_CONTEXT: Readonly<Record<ContextTag, string>> = {
  conflict: "care",
  praise: "praise",
  distance: "promise",
  intimacy: "care",
  neutral: "care",
};

/** 关键词表：中文事件标签归一到五个情境。命中多个时按数组顺序取第一个（确定性）。 */
const KEYWORDS: readonly (readonly [ContextTag, readonly string[]])[] = [
  ["conflict", ["冲突", "争吵", "指责", "批评", "冷战", "生气", "吵架", "conflict", "quarrel", "blame"]],
  ["praise", ["夸", "赞", "表扬", "感谢", "praise", "compliment", "thanks"]],
  ["distance", ["冷淡", "离开", "沉默", "疏远", "回避", "distance", "leave", "silence", "avoid"]],
  ["intimacy", ["亲密", "告白", "撒娇", "拥抱", "吻", "intimacy", "confess", "hug", "kiss"]],
];

/** event_type（自由字符串）→ 情境标签；认不出就是 neutral，不做模糊猜测 */
export function normalizeContext(eventType: string): ContextTag {
  const raw = (eventType ?? "").trim();
  if (raw === "") return "neutral";
  const lower = raw.toLowerCase();
  for (const [tag, words] of KEYWORDS) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) return tag;
    }
  }
  return "neutral";
}

/**
 * 回退动作。会校验结果确实在 ACTION_TYPES 里——
 * 这挡住了一个真实 bug：G4 的回退写的是"自然"，根本不是一个合法动作。
 */
export function defaultStrategyFor(eventType: string, cfg: EngineConfig): string {
  const actions = knobStrings(cfg, "ACTION_TYPES");
  const tag = normalizeContext(eventType);
  const action = DEFAULT_BY_CONTEXT[tag];
  if (!actions.includes(action)) {
    throw new Error(`默认动作「${action}」不在 ACTION_TYPES 里（注册表给了 ${actions.join("/")}）`);
  }
  return action;
}
