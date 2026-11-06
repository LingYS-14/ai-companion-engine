/**
 * §5.4 再巩固 → 版本链（P2 的"一致性"那一半，纯函数）
 *
 * 规格（docs/DESIGN.md-423）：
 *   现状是再巩固只改 encode_state.valence 且单次 ≤0.2——这只实现了"情绪权重可变"，
 *   没实现"我自己怎么看这件事变了"。改成"新版本 + source_ids 指向旧版"：
 *
 *     interface ReconsolidationPatch {
 *       memoryId; newVersion; changed{valence?, salience?, interpretation?};
 *       reason; source_ids[]; prevVersion;
 *     }
 *
 *   resolveCurrent 沿 superseded_by 走到链末端；DAG 且显式防自指；
 *   被覆盖版本不删除，检索按 1/(1+链距) 降权；显式回溯时按链顺序全部返回。
 *
 * 为什么"必须成对上线"（规格原文）：只有衰减没有版本链 → 人格漂移；只有版本链
 * 没有衰减 → 人格僵化。本文件只负责链本身，不碰衰减，也不碰检索内核。
 *
 * 诚实边界：这里定义的是**旁路结构**，WAL 仍是唯一写入口。等 P2 评审确认
 * 版本链是否要写进 WAL 后再接线；在那之前它只是可测试的纯逻辑。
 */

/** 一次再巩固造成的改写。字段与规格同名，`interpretation` 是"我现在怎么看这件事"。 */
export interface ReconsolidationPatch {
  readonly memoryId: string;
  readonly newVersion: number;
  readonly changed: {
    readonly valence?: number;
    readonly salience?: number;
    readonly interpretation?: string;
  };
  /** 为什么改写（"今天和她聊完，觉得当时没那么糟"）。 */
  readonly reason: string;
  /** 触发这次改写的新记忆（源头可追溯）。 */
  readonly source_ids: readonly string[];
  /** 不可变指针：从哪个版本改写而来。0 = 尚未有版本链（原始记录本身）。 */
  readonly prevVersion: number;
  /** 指向下一个版本；null = 链末端（当前可见版本）。自身版本号 = 非法自指。 */
  readonly supersededBy?: number | null;
}

/** 版本节点的稳定标识：`<memoryId>@<version>`。 */
export function versionId(memoryId: string, version: number): string {
  return `${memoryId}@${String(version)}`;
}

/** 单次再巩固的幅度上限（沿用现有"单次 valence ≤0.2"的纪律）。 */
export const MAX_VALENCE_DELTA = 0.2;
/** 一条记忆最多保留多少版（落盘层的硬上限；超过就拒绝，不静默丢旧版）。 */
export const MAX_PATCHES_PER_MEMORY_LIMIT = 20;

/** 理由至少写几个字（空的 reason 等于没有可追溯性）。 */
export const MIN_REASON_CHARS = 6;

/** 校验一条 patch；不抛错，返回错误清单。 */
export function validatePatch(patch: ReconsolidationPatch): string[] {
  const errors: string[] = [];
  if (typeof patch.memoryId !== "string" || patch.memoryId.trim() === "") errors.push("patch.memoryId 不能为空");
  if (!Number.isInteger(patch.newVersion) || patch.newVersion <= 0) errors.push("patch.newVersion 必须是正整数");
  if (patch.prevVersion < 0 || !Number.isInteger(patch.prevVersion)) errors.push("patch.prevVersion 必须是非负整数");
  if (patch.newVersion <= patch.prevVersion) errors.push("patch.newVersion 必须大于 prevVersion（版本号只能往前）");
  if (typeof patch.reason !== "string" || patch.reason.trim().length < MIN_REASON_CHARS) {
    errors.push(`patch.reason 至少 ${String(MIN_REASON_CHARS)} 个字`);
  }
  if (!Array.isArray(patch.source_ids) || patch.source_ids.length === 0) {
    errors.push("patch.source_ids 至少要有一条（没有源头就无法回滚解释）");
  } else if (patch.source_ids.some((id) => typeof id !== "string" || id.trim() === "")) {
    errors.push("patch.source_ids 里不能有空字符串");
  }
  const valence = patch.changed.valence;
  if (valence !== undefined) {
    if (!Number.isFinite(valence)) errors.push("changed.valence 必须是有限数");
    else if (Math.abs(valence) > MAX_VALENCE_DELTA) {
      errors.push(`changed.valence 单次变化不能超过 ±${String(MAX_VALENCE_DELTA)}（防止情绪被一次回忆抹平）`);
    }
  }
  const salience = patch.changed.salience;
  if (salience !== undefined && (!Number.isFinite(salience) || salience < 0 || salience > 1)) {
    errors.push("changed.salience 必须在 [0,1]");
  }
  if (patch.changed.interpretation !== undefined) {
    if (typeof patch.changed.interpretation !== "string" || patch.changed.interpretation.trim() === "") {
      errors.push("changed.interpretation 必须是非空字符串");
    }
  }
  if (patch.supersededBy !== undefined && patch.supersededBy !== null) {
    if (!Number.isInteger(patch.supersededBy)) errors.push("supersededBy 必须是整数或 null");
    else if (patch.supersededBy === patch.newVersion) errors.push("supersededBy 不能指向自己（自指非法）");
    else if (patch.supersededBy <= patch.newVersion) errors.push("supersededBy 必须指向更晚的版本");
  }
  return errors;
}

/** 链的解析结果。`corrupt` 为真时 `current` 为 null，且错误在 `errors` 里说清楚。 */
export interface ResolvedChain {
  readonly memoryId: string;
  /** 按版本号升序（v1, v2, …），只含实际存在的节点。 */
  readonly versions: readonly ReconsolidationPatch[];
  readonly current: ReconsolidationPatch | null;
  readonly corrupt: boolean;
  readonly errors: readonly string[];
}

/**
 * 解析一条记忆的完整版本链。
 *
 * 与规格伪代码的差别（显式记录）：规格写"从最新 patch 开始沿 superseded_by 走"，
 * 但最新 patch 的 superseded_by 通常就是 null，照字面实现会永远停在最新一版。
 * 这里改成"从 prevVersion=0 的根开始，按 prevVersion→newVersion 连边"，等价于
 * 沿 superseded_by 的正向遍历，但能在断链/分叉/成环时给出可诊断的错误。
 */
export function resolveChain(memoryId: string, patches: readonly ReconsolidationPatch[]): ResolvedChain {
  const mine = patches.filter((p) => p.memoryId === memoryId).slice().sort((a, b) => a.newVersion - b.newVersion);
  const errors: string[] = [];

  if (mine.length === 0) {
    return { memoryId, versions: [], current: null, corrupt: false, errors: [] };
  }

  for (const patch of mine) {
    errors.push(...validatePatch(patch));
  }

  const byVersion = new Map<number, ReconsolidationPatch>();
  for (const patch of mine) {
    if (byVersion.has(patch.newVersion)) errors.push(`版本 ${String(patch.newVersion)} 重复出现`);
    byVersion.set(patch.newVersion, patch);
  }

  // 链必须从 prevVersion=0 起，且每条新版本的 prevVersion 必须恰好是已有的某个版本。
  const sorted = [...byVersion.values()].sort((a, b) => a.newVersion - b.newVersion);
  const chain: ReconsolidationPatch[] = [];
  const visited = new Set<number>();
  let cursor = 0;
  for (;;) {
    const next = sorted.find((p) => p.prevVersion === cursor && !visited.has(p.newVersion));
    if (next === undefined) break;
    chain.push(next);
    visited.add(next.newVersion);
    cursor = next.newVersion;
  }

  for (const patch of sorted) {
    if (!visited.has(patch.newVersion)) {
      errors.push(`版本 ${String(patch.newVersion)} 无法从链根到达（prevVersion=${String(patch.prevVersion)} 断链或分叉）`);
    }
  }

  // supersededBy 必须与"下一条新版"一致，否则两条指针会互相矛盾。
  for (let i = 0; i < chain.length - 1; i += 1) {
    const current = chain[i];
    const next = chain[i + 1];
    if (current === undefined || next === undefined) continue;
    if (current.supersededBy !== undefined && current.supersededBy !== null && current.supersededBy !== next.newVersion) {
      errors.push(
        `版本 ${String(current.newVersion)} 的 supersededBy=${String(current.supersededBy)} 与链上下一版 ${String(next.newVersion)} 不一致`,
      );
    }
  }
  const last = chain[chain.length - 1];
  if (last !== undefined && last.supersededBy !== undefined && last.supersededBy !== null) {
    errors.push(`链末端版本 ${String(last.newVersion)} 的 supersededBy 应指向 null（指向了不存在的 ${String(last.supersededBy)}）`);
  }

  return { memoryId, versions: chain, current: errors.length === 0 ? (last ?? null) : null, corrupt: errors.length > 0, errors };
}

/** 链距：当前版本为 0，越旧越大。 */
export function chainDistance(chain: ResolvedChain, version: number): number {
  const current = chain.current;
  if (current === null) return 0;
  const index = chain.versions.findIndex((p) => p.newVersion === version);
  if (index < 0) return Number.POSITIVE_INFINITY;
  const currentIndex = chain.versions.findIndex((p) => p.newVersion === current.newVersion);
  return currentIndex - index;
}

/** 检索权重：1/(1+链距)，当前版本 1.0，越旧越低但不为 0（被覆盖版本不删）。 */
export function retrievalWeight(chain: ResolvedChain, version: number): number {
  return 1 / (1 + chainDistance(chain, version));
}

/** 显式回溯（"我以前怎么看这件事"）：从当前版本往回列全部版本。 */
export function backtrack(chain: ResolvedChain): readonly ReconsolidationPatch[] {
  return [...chain.versions].reverse();
}

/** 一行摘要，供日志/审计。 */
export function describeChain(chain: ResolvedChain): string {
  if (chain.corrupt) return `版本链损坏（${chain.memoryId}）：${chain.errors.join("；")}`;
  if (chain.current === null) return `版本链为空（${chain.memoryId}）`;
  const versions = chain.versions.map((p) => `v${String(p.newVersion)}`).join("→");
  return `版本链 ${chain.memoryId}：${versions}（当前 v${String(chain.current.newVersion)}，共 ${String(chain.versions.length)} 版）`;
}
