/**
 * 记忆回放 → 候选生成（P2 的"记忆回放候选源"接线，纯函数）
 *
 * 规格（docs/DESIGN.md/:337）：空转 tick 的默认行为是消化——
 * 记忆回放之后，回放出来的"线头"要能变成 `continue_thread` 候选；否则回放就只是
 * 一段日志，不会影响她下一句想说什么。
 *
 * 本文件是 `replay.ts`（选哪几条）与 `candidates.ts`（生成候选）之间的适配层：
 *   - 回放项 → `OpenThread`（候选生成本来就会按线头生成 continue_thread 候选）；
 *   - 与已有的未完成线程**按 id 去重**（同一条记忆既是心事又是线头时只留一条），
 *     已有线程优先、保留原有顺序，回放线程补在后面，总数有上限；
 *   - 没有可回放的记忆时**原样返回上下文**，并在 note 里说明"这次没有想起什么"，
 *     不伪造线头。
 *
 * 不做的事：不读存储、不写存储、不调模型、不在本文件里打分（分数在 replay.ts 里）。
 */

import type { CandidateContext, OpenThread } from "./candidates.js";
import {
  replayContextLine,
  replayThreads,
  selectReplay,
  type ReplayItem,
  type ReplayMemory,
  type SelectReplayResult,
} from "./replay.js";
import type { SituationFrame } from "./types.js";

/** 回放线头最多补几条（候选每类最多 2 条，补 3 条已经足够覆盖）。 */
export const MAX_REPLAY_THREADS = 3;

/** 合并后线程总数上限（已有线程 + 回放线程），防止候选生成被旧事淹没。 */
export const MAX_MERGED_THREADS = 4;

export interface ReplaySource {
  /** 回放选中的记忆（已按 kind 限额、稳定排序） */
  readonly items: readonly ReplayItem[];
  readonly byKind: SelectReplayResult["byKind"];
  readonly note: string;
  /** 每条回放项的一行情境说明（五元组是否完整），可直接进日志 */
  readonly contextLines: readonly string[];
  /** 回放转成的线程（可能为空） */
  readonly threads: readonly OpenThread[];
}

/**
 * 从记忆里选回放项并转成候选线头。
 * `allowNewCandidates=false` 时（§4.5 #4：已有活跃意图、只消化），仍然回放、仍然产线程，
 * 但 note 写明"只消化"——是否真的生成候选由调用方决定（本函数不替调用方做闸）。
 */
export function replaySource(memories: readonly ReplayMemory[], nowMs: number, allowNewCandidates = true): ReplaySource {
  const selected = selectReplay({ memories, nowMs, allowNewCandidates });
  const threads = replayThreads(selected.items, memories, nowMs).slice(0, MAX_REPLAY_THREADS);
  return {
    items: selected.items,
    byKind: selected.byKind,
    note: selected.note,
    contextLines: selected.items
      .map((item) => replayContextLine(item, memories))
      .filter((line): line is string => line !== null),
    threads,
  };
}

/**
 * 把回放线程合进候选上下文：已有线程优先，按 id 去重，总数 ≤ MAX_MERGED_THREADS。
 * 不修改入参（返回新对象）；没有回放线程时返回上下文原对象（便于调用方做恒等判断）。
 */
export function withReplayThreads(
  context: CandidateContext,
  source: ReplaySource,
): { readonly context: CandidateContext; readonly added: number; readonly note: string } {
  if (source.threads.length === 0) return { context, added: 0, note: "回放没有产出线头（没有可接的话头）" };

  const existing = context.threads ?? [];
  const seen = new Set(existing.map((thread) => thread.id));
  const merged: OpenThread[] = [...existing];
  let added = 0;
  for (const thread of source.threads) {
    if (merged.length >= MAX_MERGED_THREADS) break;
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    merged.push(thread);
    added += 1;
  }
  if (added === 0) return { context, added: 0, note: "回放线头都已在线程表里（无新增）" };
  return {
    context: { ...context, threads: merged },
    added,
    note: `回放补了 ${String(added)} 条线程（共 ${String(merged.length)} 条，上限 ${String(MAX_MERGED_THREADS)}）`,
  };
}

/** 一行摘要：给 idle tick 日志用（不参与决策）。 */
export function describeReplaySource(source: ReplaySource, frame: SituationFrame): string {
  if (source.items.length === 0) return `[replay] 没有想起什么（frame=${frame.channel}@${frame.at}）`;
  const kinds = source.items.map((item) => item.kind).join("/");
  return `[replay] ${source.note}；线头 ${String(source.threads.length)} 条；类型=${kinds}`;
}
