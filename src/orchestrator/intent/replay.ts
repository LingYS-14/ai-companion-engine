/**
 * P2 idle tick 的"记忆回放候选源"（纯函数，零模型调用）
 *
 * 规格（docs/DESIGN.md/:337/:551）：空转 tick 默认行为是消化——
 *   记忆回放 → 未闭合意图重整 → 前瞻意图到期检查 → 高缺口时候选生成；
 * 并且"若上一 tick 的意图仍 active 且 survival 未超 K_s，本次 idle tick 只做记忆回放
 * 与前瞻意图到期检查，不生成新候选"（§4.5 约束 4，防意图抖振）。
 *
 * 本文件只回答一个问题：**从一堆记忆里，今晚该想起哪几条**，并把它们变成
 * 候选生成能吃的形状（OpenThread 或 plan seed）。它不读存储、不写存储、不调模型；
 * 调用方（P2 的 idle tick）负责取数、落日志。
 *
 * 三类回放各有各的用，不混在一起打分：
 *   - unfinished：没闭合的事（unresolved_score 高）——对应"心事"；
 *   - echo：鲜明、跟自己有关、最近被想起过的——对应"余响"；
 *   - dormant：很久没被想起的旧事——对应"翻旧账"（也是防止只回忆最近的东西）。
 */

import { deriveQuintuple, type EpisodeSource } from "./episode.js";

/** 回放需要的只读记忆视图（结构类型，不 import memory 实现）。 */
export interface ReplayMemory extends EpisodeSource {
  readonly id: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly vividness?: number;
  readonly self_relevance?: number;
  readonly unresolved_score?: number;
  readonly last_accessed?: number;
  readonly access_count?: number;
}

export type ReplayKind = "unfinished" | "echo" | "dormant";

export interface ReplayItem {
  readonly memoryId: string;
  readonly kind: ReplayKind;
  /** 0..1，越大越该被想起。 */
  readonly salience: number;
  /** 一句话理由，直接进日志/自述。 */
  readonly why: string;
  /** 标题（截断后的内容或 tags），供 OpenThread 用。 */
  readonly title: string;
}

/** 一次回放的预算：三类各最多 2 条，总数最多 5 条（与候选上限 8 留出余量）。 */
export const REPLAY_PER_KIND = 2;
export const REPLAY_MAX = 5;

/** 未闭合的判定线：低于它就不算"心事"。 */
export const UNRESOLVED_FLOOR = 0.4;
/** 多久没被想起算"很旧"（毫秒）。 */
export const DORMANT_DAYS = 14;
export const DAY_MS = 86_400_000;
/** 旧事的记忆保真窗口：30 天外的"最近度"记 0（线性衰减，不用指数，避免与 INV-7 混淆）。 */
export const RECENCY_WINDOW_DAYS = 30;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 线性最近度：0 天=1，超过 30 天=0。 */
export function recencyOf(ageDays: number): number {
  return clamp01(1 - ageDays / RECENCY_WINDOW_DAYS);
}

/** 标题：优先用内容前 20 字，退到 tags，最后退到 id。 */
export function replayTitle(memory: ReplayMemory): string {
  const content = (memory.content ?? "").trim().replace(/\s+/g, " ");
  if (content !== "") return content.length > 20 ? `${content.slice(0, 20)}…` : content;
  const tags = (memory.tags ?? []).filter((t) => t.trim() !== "");
  if (tags.length > 0) return tags.slice(0, 3).join("/");
  return memory.id;
}

/** 心事分：未闭合程度为主，最近度只做小幅加权（旧心事也该被想起）。 */
export function unfinishedScore(memory: ReplayMemory, ageDays: number): number {
  const unresolved = clamp01(memory.unresolved_score ?? 0);
  return clamp01(unresolved * 0.8 + recencyOf(ageDays) * 0.2);
}

/** 余响分：鲜明 + 跟自己有关 + 被想起过（使用强化，不改 ACT-R，只是选择依据）。 */
export function echoScore(memory: ReplayMemory, ageDays: number): number {
  const vivid = clamp01(memory.vividness ?? 0);
  const self = clamp01(memory.self_relevance ?? 0);
  const used = clamp01((memory.access_count ?? 0) / 10);
  return clamp01(vivid * 0.5 + self * 0.3 + used * 0.2 + recencyOf(ageDays) * 0.1);
}

/** 旧事分：越久没想起越该翻一翻，但只翻还鲜明的（忘了的翻不出来）。 */
export function dormantScore(memory: ReplayMemory, ageDays: number): number {
  const vivid = clamp01(memory.vividness ?? 0);
  const staleness = clamp01((ageDays - DORMANT_DAYS) / (RECENCY_WINDOW_DAYS * 2));
  return clamp01(vivid * 0.4 + staleness * 0.6);
}

export interface SelectReplayInput {
  readonly memories: readonly ReplayMemory[];
  /** 当前时间（毫秒）；由调用方从 Clock 传入，本文件不读时钟。 */
  readonly nowMs: number;
  /** 是否允许新候选（§4.5 #4：已有活跃意图且未超 K_s 时只回放，不生成）。 */
  readonly allowNewCandidates?: boolean;
}

export interface SelectReplayResult {
  readonly items: readonly ReplayItem[];
  /** 按 kind 计数，直接进日志。 */
  readonly byKind: Readonly<Record<ReplayKind, number>>;
  /** 一行摘要。 */
  readonly note: string;
}

/** 选出今晚该想起的记忆。稳定排序：分高者先，同分按 id 字典序（可重放）。 */
export function selectReplay(input: SelectReplayInput): SelectReplayResult {
  const perKind: Record<ReplayKind, ReplayItem[]> = { unfinished: [], echo: [], dormant: [] };

  for (const memory of input.memories) {
    const ageDays = Math.max(0, (input.nowMs - memory.created_at) / DAY_MS);
    const sinceAccessDays = Math.max(0, (input.nowMs - (memory.last_accessed ?? memory.created_at)) / DAY_MS);

    const unresolved = clamp01(memory.unresolved_score ?? 0);
    if (unresolved >= UNRESOLVED_FLOOR) {
      perKind.unfinished.push({
        memoryId: memory.id,
        kind: "unfinished",
        salience: unfinishedScore(memory, ageDays),
        why: `还没闭合的事（unresolved ${unresolved.toFixed(2)}）`,
        title: replayTitle(memory),
      });
    }

    const echo = echoScore(memory, ageDays);
    if (echo >= 0.5) {
      perKind.echo.push({
        memoryId: memory.id,
        kind: "echo",
        salience: echo,
        why: `鲜明 ${clamp01(memory.vividness ?? 0).toFixed(2)}、和自己有关 ${clamp01(memory.self_relevance ?? 0).toFixed(2)}`,
        title: replayTitle(memory),
      });
    }

    if (ageDays >= DORMANT_DAYS && clamp01(memory.vividness ?? 0) >= 0.3) {
      perKind.dormant.push({
        memoryId: memory.id,
        kind: "dormant",
        salience: dormantScore(memory, sinceAccessDays),
        why: `${String(Math.round(sinceAccessDays))} 天没被想起`,
        title: replayTitle(memory),
      });
    }
  }

  const items: ReplayItem[] = [];
  const byKind: Record<ReplayKind, number> = { unfinished: 0, echo: 0, dormant: 0 };
  for (const kind of ["unfinished", "echo", "dormant"] as const) {
    const sorted = perKind[kind]
      .slice()
      .sort((a, b) => b.salience - a.salience || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
    const take = sorted.slice(0, REPLAY_PER_KIND);
    byKind[kind] = take.length;
    items.push(...take);
  }

  const trimmed = items.slice(0, REPLAY_MAX);
  const allowNew = input.allowNewCandidates ?? true;
  return {
    items: trimmed,
    byKind,
    note: allowNew
      ? `回放：未闭合 ${String(byKind.unfinished)} / 余响 ${String(byKind.echo)} / 旧事 ${String(byKind.dormant)}`
      : `回放（只消化，不生成新候选）：未闭合 ${String(byKind.unfinished)} / 余响 ${String(byKind.echo)} / 旧事 ${String(byKind.dormant)}`,
  };
}

/** 回放项 → 候选生成能吃的线头（continue_thread 用）。 */
export interface ReplayThread {
  readonly id: string;
  readonly title: string;
  readonly staleMin: number;
}

export function replayThreads(items: readonly ReplayItem[], memories: readonly ReplayMemory[], nowMs: number): ReplayThread[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  // 同一条记忆可能同时是"未闭合"和"余响"；接话的线头只该有一条，保留分高的那条理由。
  const best = new Map<string, ReplayItem>();
  for (const item of items) {
    if (item.kind === "dormant") continue; // 旧事是"想起来"，不是"要接话"
    const existing = best.get(item.memoryId);
    if (existing === undefined || item.salience > existing.salience) best.set(item.memoryId, item);
  }
  const threads: ReplayThread[] = [];
  for (const item of best.values()) {
    const memory = byId.get(item.memoryId);
    const staleMin =
      memory === undefined ? 0 : Math.max(0, Math.round((nowMs - (memory.last_accessed ?? memory.created_at)) / 60_000));
    threads.push({ id: `replay:${item.memoryId}`, title: item.title, staleMin });
  }
  return threads;
}

/** 回放项 → 一句 plan seed（给候选的 planSeeds 来源之一）。 */
export function replaySeed(item: ReplayItem): string {
  return `回放记忆「${item.title}」——${item.why}`;
}

/** 五元组摘要（便于在 idle tick 日志里看出"这次想起的是不是一件具体的事"）。 */
export function replayContextLine(item: ReplayItem, memories: readonly ReplayMemory[]): string | null {
  const memory = memories.find((m) => m.id === item.memoryId);
  if (memory === undefined) return null;
  const derived = deriveQuintuple(memory);
  const missing = derived.missing.length === 0 ? "五元组完整" : `推断字段=${derived.missing.join(",")}`;
  return `${item.title}（${missing}）`;
}
