/**
 * v5.4-P1 §4.3 记忆宫殿（D5）：把「同一次经历」落进同一格，检索时给同格/邻格的候选一点加成。
 *
 * 规格给的是 `assign_loci(channel, primary_tag, position)`：
 *   path_id = stable_hash(`${channel}:${primary_tag}`) % LOCI_PATH_CAPACITY
 *   order   = position // LOCI_PER_SLOT_CAPACITY
 * 两个决定（审计 D5）：
 *   1. **只在写入时分配一次**：`loci_path_id` 一旦有值就不再改（A36 幂等）；重放旧档案不会挪格子。
 *   2. **不参与 RETRIEVAL_WEIGHTS**：加成是 rerank 最后的乘性项（`retrieve.lociMatch`），
 *      七键权重和仍为 1.00——这是与 v5.3 遗留文「新增 0.05 权重」的关键差异。
 *
 * 纯函数：给定已有记录列表就能算出新记录该进哪一格，不读 store、不读时钟。
 */

import { knobNumber, type EngineConfig } from "../engine/config.js";
import type { MemoryRecord } from "./types.js";

/** FNV-1a 32 位：稳定、无依赖、跨平台一致（不能用 Math.random 或进程内 Map 计数） */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface LociPlacement {
  readonly path_id: number;
  readonly order: number;
}

/** 主标签：没有标签的记忆归到 "misc"，避免全部挤进同一格 */
export function primaryTagOf(rec: Pick<MemoryRecord, "tags">): string {
  const tag = rec.tags.find((t) => t.trim() !== "");
  return tag ?? "misc";
}

/** 通道：runtime 写记忆时会塞 encode_ctx.channel，缺省 web */
export function channelOf(rec: Pick<MemoryRecord, "encode_ctx">): string {
  const raw = (rec.encode_ctx as Readonly<Record<string, unknown>>).channel;
  return typeof raw === "string" && raw !== "" ? raw : "web";
}

/**
 * 给一条**尚未分配**的记忆找格子。
 * position = 同一 path 下已有的条数（含被遗忘的：格子不回收，除非 hard_delete）。
 */
export function assignLoci(
  rec: Pick<MemoryRecord, "tags" | "encode_ctx">,
  existing: readonly Pick<MemoryRecord, "loci_path_id" | "forgotten">[],
  cfg: EngineConfig,
): LociPlacement {
  const capacity = knobNumber(cfg, "LOCI_PATH_CAPACITY");
  const perSlot = knobNumber(cfg, "LOCI_PER_SLOT_CAPACITY");
  const pathId = stableHash(`${channelOf(rec)}:${primaryTagOf(rec)}`) % capacity;
  const position = existing.filter((m) => m.loci_path_id === pathId).length;
  return { path_id: pathId, order: Math.floor(position / perSlot) };
}

/** 幂等：已有格子就原样返回；没有才分配 */
export function withLoci(
  rec: MemoryRecord,
  existing: readonly MemoryRecord[],
  cfg: EngineConfig,
): MemoryRecord {
  if (rec.loci_path_id !== undefined && rec.loci_order !== undefined) return rec;
  const placement = assignLoci(rec, existing, cfg);
  return { ...rec, loci_path_id: placement.path_id, loci_order: placement.order };
}
