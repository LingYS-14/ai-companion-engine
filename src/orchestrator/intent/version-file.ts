/**
 * §5.4 再巩固版本链的**落盘形状**（P2 的 R2：先把结构定死，再接写入口）。
 *
 * 纯逻辑（本文件不碰文件系统、不读时钟）：序列化 / 解析 / 追加 / 合并 / 摘要。
 * 真正的读写由装配点决定（同 `ledger-file.ts` 与 `persist.ts` 的分工）。
 *
 * 为什么优先级是"先定形状"：
 *   - 版本链一旦写进任何存储，就必须能向后兼容地读回来；形状（顶层字段、键序、
 *     每记忆最多几版、断链怎么办）比"什么时候写"更难改。
 *   - 规格要求"被覆盖版本不删除、检索按 1/(1+链距) 降权"，但**降权属于检索**——
 *     在这一步之前不能动；所以这一层只负责"把链存对、能验证、能回溯"。
 *
 * 三条硬纪律（写在解析里，不靠调用方自觉）：
 *   1. **fail-closed**：版本不符 / 未知顶层字段 / 任一条 patch 非法 / 同一记忆重复版本 /
 *      超过单记忆上限 / 链断掉或分叉 —— 整份文件拒绝，不返回半份；
 *   2. **链必须从 0 起、连续可到末端**：断链的存储没法解释"现在这一版是哪个"；
 *   3. **追加时自动补齐 supersededBy**：调用方只给新补丁，旧的链末由这一层指过去，
 *      免得手写指针时出现两条互相矛盾的边。
 *
 * 诚实边界：线上还没有任何"再巩固触发"（改写要模型给解释，当前纪律是零模型调用），
 * 所以这份文件现阶段只有测试与审计会读它；写入口接线在台账里单列，不假装已经开通。
 */

import {
  MAX_PATCHES_PER_MEMORY_LIMIT,
  resolveChain,
  validatePatch,
  type ReconsolidationPatch,
} from "./version-chain.js";

/** 文件格式版本（未来若改形状必须换号，旧格式直接拒绝读，不做静默兼容）。 */
export const VERSION_FILE_VERSION = 1 as const;

/** 单条记忆最多保留多少版（超过后拒绝追加，而不是悄悄丢最旧的——丢版本等于篡改历史）。 */
export const MAX_PATCHES_PER_MEMORY = MAX_PATCHES_PER_MEMORY_LIMIT;

/** 一次落盘最多多少条 patch（防止文件无限长；超了拒绝，不裁剪）。 */
export const MAX_PATCHES_TOTAL = 500;

export interface ReconsolidationFile {
  readonly version: typeof VERSION_FILE_VERSION;
  readonly savedAtMs: number;
  readonly patches: readonly ReconsolidationPatch[];
}

export interface ParseReconsolidationResult {
  readonly file: ReconsolidationFile | null;
  readonly errors: readonly string[];
}

/** `data/reconsolidation-<characterId>.json` —— 与其它旁路文件同一命名规则。 */
export function reconsolidationFilePath(root: string, characterId: string): string {
  const sep = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
  return `${root}${sep}data/reconsolidation-${characterId}.json`;
}

function checkSavedAt(savedAtMs: number): string | null {
  return Number.isFinite(savedAtMs) && savedAtMs > 0 ? null : "savedAtMs 必须是正数（毫秒时间戳）";
}

/** 固定键序 + 按 (memoryId, newVersion) 排序；同输入两次序列化逐字节相同。 */
export function serializeReconsolidationFile(
  patches: readonly ReconsolidationPatch[],
  savedAtMs: number,
): string {
  const savedError = checkSavedAt(savedAtMs);
  if (savedError !== null) throw new RangeError(savedError);
  const errors: string[] = [];
  for (const patch of patches) errors.push(...validatePatch(patch));
  if (errors.length > 0) throw new RangeError(`补丁不合法：${errors.join("；")}`);
  if (patches.length > MAX_PATCHES_TOTAL) throw new RangeError(`补丁总数 ${String(patches.length)} 超过上限 ${String(MAX_PATCHES_TOTAL)}`);

  const sorted = [...patches].sort((a, b) => {
    if (a.memoryId !== b.memoryId) return a.memoryId < b.memoryId ? -1 : 1;
    return a.newVersion - b.newVersion;
  });
  const out = sorted.map((p) => ({
    memoryId: p.memoryId,
    newVersion: p.newVersion,
    prevVersion: p.prevVersion,
    changed: {
      ...(p.changed.valence === undefined ? {} : { valence: p.changed.valence }),
      ...(p.changed.salience === undefined ? {} : { salience: p.changed.salience }),
      ...(p.changed.interpretation === undefined ? {} : { interpretation: p.changed.interpretation }),
    },
    reason: p.reason,
    source_ids: [...p.source_ids],
    supersededBy: p.supersededBy ?? null,
  }));
  return `${JSON.stringify({ version: VERSION_FILE_VERSION, savedAtMs, patches: out }, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOnePatch(raw: Record<string, unknown>, where: string): ReconsolidationPatch {
  const changed = raw["changed"];
  if (!isRecord(changed)) throw new Error(`${where}.changed 必须是对象`);
  const sourceIds = raw["source_ids"];
  if (!Array.isArray(sourceIds)) throw new Error(`${where}.source_ids 必须是数组`);
  const patch: ReconsolidationPatch = {
    memoryId: String(raw["memoryId"] ?? ""),
    newVersion: Number(raw["newVersion"] ?? Number.NaN),
    prevVersion: Number(raw["prevVersion"] ?? Number.NaN),
    changed: {
      ...(typeof changed["valence"] === "number" ? { valence: changed["valence"] } : {}),
      ...(typeof changed["salience"] === "number" ? { salience: changed["salience"] } : {}),
      ...(typeof changed["interpretation"] === "string" ? { interpretation: changed["interpretation"] } : {}),
    },
    reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
    source_ids: sourceIds.map((id) => String(id)),
    supersededBy:
      raw["supersededBy"] === null || raw["supersededBy"] === undefined
        ? null
        : Number(raw["supersededBy"]),
  };
  const errors = validatePatch(patch);
  if (errors.length > 0) throw new Error(`${where} 不合法：${errors.join("；")}`);
  return patch;
}

/** 解析一份落盘文件。**整份拒绝**：errors 非空时 file 一定是 null。 */
export function parseReconsolidationFile(raw: string): ParseReconsolidationResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { file: null, errors: ["不是合法 JSON"] };
  }
  if (!isRecord(parsed)) return { file: null, errors: ["顶层必须是对象"] };

  const allowed = new Set(["version", "savedAtMs", "patches"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) errors.push(`未知顶层字段：${key}`);
  }
  if (parsed["version"] !== VERSION_FILE_VERSION) {
    errors.push(`版本不符：期望 ${String(VERSION_FILE_VERSION)}，读到 ${String(parsed["version"])}`);
  }
  const savedAtMs = parsed["savedAtMs"];
  if (typeof savedAtMs !== "number") errors.push("savedAtMs 必须是数字");
  else {
    const savedError = checkSavedAt(savedAtMs);
    if (savedError !== null) errors.push(savedError);
  }

  const rawPatches = parsed["patches"];
  const patches: ReconsolidationPatch[] = [];
  if (!Array.isArray(rawPatches)) errors.push("patches 必须是数组");
  else {
    if (rawPatches.length > MAX_PATCHES_TOTAL) errors.push(`补丁总数超过上限 ${String(MAX_PATCHES_TOTAL)}`);
    rawPatches.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`patches[${String(index)}] 必须是对象`);
        return;
      }
      try {
        patches.push(parseOnePatch(item, `patches[${String(index)}]`));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });
    // 同一条记忆里版本号不能重复；每记忆版本数不能超上限
    const byMemory = new Map<string, number[]>();
    for (const patch of patches) {
      const list = byMemory.get(patch.memoryId) ?? [];
      list.push(patch.newVersion);
      byMemory.set(patch.memoryId, list);
    }
    for (const [memoryId, versions] of byMemory) {
      if (versions.length > MAX_PATCHES_PER_MEMORY) {
        errors.push(`${memoryId} 的版本数 ${String(versions.length)} 超过上限 ${String(MAX_PATCHES_PER_MEMORY)}`);
      }
      if (new Set(versions).size !== versions.length) errors.push(`${memoryId} 出现重复版本号`);
    }
    // 链完整性：每条记忆都必须能从根走到末端
    for (const memoryId of byMemory.keys()) {
      const chain = resolveChain(memoryId, patches);
      if (chain.corrupt) errors.push(...chain.errors.map((e) => `${memoryId}：${e}`));
    }
  }

  if (errors.length > 0) return { file: null, errors };
  return {
    file: { version: VERSION_FILE_VERSION, savedAtMs: savedAtMs as number, patches },
    errors: [],
  };
}

export interface AddPatchResult {
  readonly file: ReconsolidationFile;
  readonly added: boolean;
  readonly errors: readonly string[];
}

/**
 * 追加一条补丁。调用方只需给"新版本 + 从哪一版改的"，被顶掉的旧链末由这一层补
 * `supersededBy`。重复 / 跳版 / 超上限都**拒绝并说明**，不悄悄改历史。
 */
export function addReconsolidationPatch(
  existing: ReconsolidationFile | null,
  patch: ReconsolidationPatch,
  savedAtMs: number,
): AddPatchResult {
  const base: ReconsolidationFile =
    existing ?? { version: VERSION_FILE_VERSION, savedAtMs, patches: [] };
  const errors: string[] = [];
  const savedError = checkSavedAt(savedAtMs);
  if (savedError !== null) errors.push(savedError);
  errors.push(...validatePatch(patch));

  const chain = resolveChain(patch.memoryId, base.patches);
  if (chain.corrupt) errors.push(`现有链已损坏，拒绝追加：${chain.errors.join("；")}`);
  const current = chain.current;
  const expectedPrev = current === null ? 0 : current.newVersion;
  if (patch.prevVersion !== expectedPrev) {
    errors.push(`prevVersion 应为 ${String(expectedPrev)}（当前链末），读到 ${String(patch.prevVersion)}`);
  }
  const versions = base.patches.filter((p) => p.memoryId === patch.memoryId).length;
  if (versions >= MAX_PATCHES_PER_MEMORY) {
    errors.push(`${patch.memoryId} 已有 ${String(versions)} 版，超过上限 ${String(MAX_PATCHES_PER_MEMORY)}`);
  }
  if (base.patches.some((p) => p.memoryId === patch.memoryId && p.newVersion === patch.newVersion)) {
    errors.push(`版本 ${patch.memoryId}@${String(patch.newVersion)} 已存在`);
  }
  if (base.patches.length >= MAX_PATCHES_TOTAL) errors.push(`补丁总数已达上限 ${String(MAX_PATCHES_TOTAL)}`);

  if (errors.length > 0) return { file: base, added: false, errors };

  // 旧的链末指向新版本；新版本自己指向 null
  const linked = base.patches.map((p) =>
    p.memoryId === patch.memoryId && p.newVersion === expectedPrev
      ? { ...p, supersededBy: patch.newVersion }
      : p,
  );
  const nextPatch: ReconsolidationPatch = { ...patch, supersededBy: null };
  return {
    file: { version: VERSION_FILE_VERSION, savedAtMs, patches: [...linked, nextPatch] },
    added: true,
    errors: [],
  };
}

/** 某条记忆的全部版本（按版本号升序）。 */
export function patchesForMemory(file: ReconsolidationFile, memoryId: string): readonly ReconsolidationPatch[] {
  return file.patches.filter((p) => p.memoryId === memoryId).slice().sort((a, b) => a.newVersion - b.newVersion);
}

/** 合并两份来源（例如 WAL 旁路 + 测试夹具）：同 (memoryId,newVersion) 只保留一份，冲突报错。 */
export function mergeReconsolidationFiles(
  left: ReconsolidationFile | null,
  right: ReconsolidationFile | null,
): { file: ReconsolidationFile | null; errors: readonly string[] } {
  const errors: string[] = [];
  const seen = new Map<string, ReconsolidationPatch>();
  for (const file of [left, right]) {
    if (file === null) continue;
    for (const patch of file.patches) {
      const key = `${patch.memoryId}@${String(patch.newVersion)}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        if (JSON.stringify(prev) !== JSON.stringify(patch)) errors.push(`${key} 两份内容不同，拒绝合并`);
        continue;
      }
      seen.set(key, patch);
    }
  }
  const savedAtMs = Math.max(left?.savedAtMs ?? 0, right?.savedAtMs ?? 0, 1);
  if (errors.length > 0) return { file: null, errors };
  return {
    file: { version: VERSION_FILE_VERSION, savedAtMs, patches: [...seen.values()] },
    errors: [],
  };
}

/** 一行摘要：补丁数 / 涉及记忆数 / 最长链。 */
export function describeReconsolidationFile(file: ReconsolidationFile): string {
  if (file.patches.length === 0) return "再巩固版本链：空";
  const byMemory = new Map<string, number>();
  for (const patch of file.patches) byMemory.set(patch.memoryId, (byMemory.get(patch.memoryId) ?? 0) + 1);
  let longest = 0;
  for (const count of byMemory.values()) longest = Math.max(longest, count);
  return `再巩固版本链：${String(file.patches.length)} 条补丁 / ${String(byMemory.size)} 条记忆 / 最长 ${String(longest)} 版`;
}
