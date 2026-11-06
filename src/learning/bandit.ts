/**
 * §7.4 Bandit 策略强化（倒排索引 + UCB1）。全部是**纯数据**：只算数、不落盘、不写角色状态。
 *
 * 规格边界（§7.4 末句）：社交 reward 只调 C 层话术，不碰 A/B 层人格与关系值。
 * 所以这里维护的是「在某个语境下，哪种说法更容易让对话升温」，与 StateMachine 无关。
 *
 * 为什么是倒排：语境 → 候选动作的索引，避免每次都扫全表；也顺带让「空集回退」显式化（A22）。
 */

import { knobObject, type EngineConfig } from "../engine/config.js";

/** 一次动作的统计量 */
export interface BanditStats {
  readonly n: number;
  readonly reward: number;
}

/** 持久化形状：table 是累加器，index 是语境 → 候选键的倒排索引 */
export interface BanditState {
  readonly table: Readonly<Record<string, BanditStats>>;
  readonly index: Readonly<Record<string, readonly string[]>>;
}

/** 规格里 OUTCOME_REWARD 的五个键 */
export const OUTCOMES = ["安抚", "离开", "冷战", "升温", "无视"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function emptyBandit(): BanditState {
  return { table: {}, index: {} };
}

/**
 * 玩家反应 → 结局分类。
 *
 * 规格只给了 `classify_reaction` 的调用点而没给实现，这里按「先看动作词、再兜底无视」。
 * 关键词故意保持极少：多一个词就多一处要维护的语义，宁可让调用方直接传标准结局名。
 */
const REACTION_RULES: readonly (readonly [readonly string[], Outcome])[] = [
  [["安抚", "安慰", "亲亲", "抱", "哄"], "安抚"],
  [["升温", "开心", "喜欢", "高兴", "甜"], "升温"],
  [["冷战", "不理", "沉默", "生气"], "冷战"],
  [["离开", "走", "再见", "退出"], "离开"],
];

export function classifyReaction(reaction: string): Outcome {
  const text = reaction.trim();
  if ((OUTCOMES as readonly string[]).includes(text)) return text as Outcome;
  for (const [words, outcome] of REACTION_RULES) {
    if (words.some((w) => text.includes(w))) return outcome;
  }
  return "无视";
}

/** 键的形状固定为 `语境␟动作`：ASCII 之外的 `␟` 保证不会被语境名误撞 */
export function banditKey(contextTag: string, actionTag: string): string {
  if (!contextTag || !actionTag) throw new Error("contextTag 与 actionTag 都不能为空");
  return `${contextTag}␟${actionTag}`;
}

export function splitKey(key: string): { contextTag: string; actionTag: string } {
  const [contextTag, actionTag] = key.split("␟");
  if (!contextTag || !actionTag) throw new Error(`非法的 bandit 键：${key}`);
  return { contextTag, actionTag };
}

export function totalN(state: BanditState): number {
  let sum = 0;
  for (const s of Object.values(state.table)) sum += s.n;
  return sum;
}

export interface RecordOutcomeResult {
  readonly outcome: Outcome;
  readonly key: string;
  readonly n: number;
  readonly reward: number;
  readonly delta: number;
}

/**
 * 记一次结果：n+1、reward 累加 OUTCOME_REWARD[outcome]。
 *
 * 返回新状态而不是就地改——调用方（插件）负责持久化，学习层永远不碰磁盘。
 */
export function recordOutcome(
  state: BanditState,
  input: { contextTag: string; actionTag: string; reaction: string },
  cfg: EngineConfig,
): { state: BanditState; result: RecordOutcomeResult } {
  const outcome = classifyReaction(input.reaction);
  const table = rewardTable(cfg);
  const delta = table[outcome];
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    throw new Error(`OUTCOME_REWARD 缺少结局「${outcome}」，无法计分`);
  }
  const key = banditKey(input.contextTag, input.actionTag);
  const prev = state.table[key] ?? { n: 0, reward: 0 };
  const next: BanditStats = { n: prev.n + 1, reward: prev.reward + delta };
  const candidates = state.index[input.contextTag] ?? [];
  const index = candidates.includes(key)
    ? state.index
    : { ...state.index, [input.contextTag]: [...candidates, key] };
  return {
    state: { table: { ...state.table, [key]: next }, index },
    result: { outcome, key, n: next.n, reward: next.reward, delta },
  };
}

function rewardTable(cfg: EngineConfig): Record<string, number> {
  return knobObject<Record<string, number>>(cfg, "OUTCOME_REWARD");
}

export interface StrategyChoice {
  /** 选中的动作标签；候选为空时是 fallback 原样返回 */
  readonly actionTag: string;
  /** UCB1 分数；fallback 时为 null */
  readonly ucb: number | null;
  readonly source: "bandit" | "fallback";
  readonly candidates: readonly { actionTag: string; key: string; n: number; mean: number; ucb: number }[];
}

/**
 * 选策略：UCB1 = 均值 + sqrt(2·ln(N)/n)。
 *
 * 三条边界，都是规格明确要求或实测踩出来的：
 *   1. 候选为空 → 回退 archetype 的默认策略（A22 bandit 空集回退）；
 *   2. 全局 total_n 为 0 → 同样回退（ln(0) 不是数）；
 *   3. 分数相同 → 取字典序最小的键，保证同一输入永远选同一个（可复现、可测）。
 */
export function selectStrategy(
  state: BanditState,
  contextTag: string,
  fallback: string,
): StrategyChoice {
  if (!fallback) throw new Error("fallback 不能为空（空集时必须能退回默认策略）");
  const keys = state.index[contextTag] ?? [];
  if (keys.length === 0) return { actionTag: fallback, ucb: null, source: "fallback", candidates: [] };

  const n = totalN(state);
  if (n === 0) return { actionTag: fallback, ucb: null, source: "fallback", candidates: [] };

  const scored = keys
    .map((key) => {
      const { actionTag } = splitKey(key);
      const s = state.table[key] ?? { n: 0, reward: 0 };
      const mean = s.n === 0 ? 0 : s.reward / s.n;
      const ucb = s.n === 0 ? Number.POSITIVE_INFINITY : mean + Math.sqrt((2 * Math.log(n)) / s.n);
      return { actionTag, key, n: s.n, mean, ucb };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let best = scored[0];
  if (best === undefined) return { actionTag: fallback, ucb: null, source: "fallback", candidates: [] };
  for (const row of scored) if (row.ucb > best.ucb) best = row;
  return { actionTag: best.actionTag, ucb: best.ucb, source: "bandit", candidates: scored };
}
