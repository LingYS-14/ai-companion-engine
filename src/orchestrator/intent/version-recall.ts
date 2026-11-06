/**
 * §5.4 再巩固的「读」这一半：把写进版本链的新解释，带回她下次想起这条记忆的地方。
 *
 * 为什么需要它：F204 已经把「同一件事、现在的看法翻了面」写成版本补丁落盘（`data/reconsolidation-<id>.json`），
 * 但那份文件此前只有写入、没有任何读取方——等于她"想明白了"却没机会在下次说话时用上。
 * 规格 §5.4 要求「每次 recall 可改写，但旧版进版本链」：旧版在链里留着，新版要能进到 recall 的文本里。
 *
 * 三条边界（写在这里而不是只写在台账里）：
 *   1. 只改**呈现的文本**：在原文后面追加"后来我想明白了：…"，不改分数、不改检索内核、不改记忆本体；
 *   2. 每个 memoryId 只带**最新版本**的那条解释（链更长也不叠加，否则一句话挂三四个"后来"）；
 *   3. 文件坏了就整体退回"没有解释"（`errors` 非空、map 为空）——宁可不加后记，也不拿半份链乱拼。
 */

import { join } from "node:path";

import type { ReconsolidationPatch } from "./version-chain.js";
import { parseReconsolidationFile } from "./version-file.js";

/** 每个记忆 id → 最新一版解释（只放有 `changed.interpretation` 的补丁）。 */
export type InterpretationMap = ReadonlyMap<string, string>;

export interface ReadInterpretationsResult {
  readonly interpretations: InterpretationMap;
  readonly errors: readonly string[];
}

/** `<dataDir>/reconsolidation-<characterId>.json`（调用方手里通常已经是数据目录）。 */
export function interpretationsFilePathInDataDir(dataDir: string, characterId: string): string {
  return join(dataDir, `reconsolidation-${characterId}.json`);
}

/** 从原始文件内容建「最新解释」表；坏文件返回空表 + errors（不抛）。 */
export function interpretationsFromRaw(raw: string): ReadInterpretationsResult {
  const parsed = parseReconsolidationFile(raw);
  if (parsed.file === null) return { interpretations: new Map(), errors: parsed.errors };
  const byMemory = new Map<string, { version: number; text: string }>();
  for (const patch of parsed.file.patches) {
    const interpretation = patch.changed.interpretation;
    if (interpretation === undefined || interpretation.trim() === "") continue;
    const prev = byMemory.get(patch.memoryId);
    if (prev === undefined || patch.newVersion > prev.version) {
      byMemory.set(patch.memoryId, { version: patch.newVersion, text: interpretation.trim() });
    }
  }
  const interpretations = new Map<string, string>();
  for (const [memoryId, entry] of byMemory) interpretations.set(memoryId, entry.text);
  return { interpretations, errors: [] };
}

/** 一个记忆在链里的当前版本号与解释；没有补丁返回 null。 */
export function latestPatchOf(
  patches: readonly ReconsolidationPatch[],
  memoryId: string,
): { readonly version: number; readonly interpretation: string } | null {
  const chain = patches.filter((patch) => patch.memoryId === memoryId);
  if (chain.length === 0) return null;
  const texts = chain
    .map((patch) => ({ version: patch.newVersion, text: patch.changed.interpretation }))
    .filter((entry): entry is { version: number; text: string } => typeof entry.text === "string" && entry.text.trim() !== "");
  if (texts.length === 0) return null;
  const latest = texts.reduce((a, b) => (b.version > a.version ? b : a));
  return { version: latest.version, interpretation: latest.text.trim() };
}

/**
 * 给一条召回文本加后记。`interpretation` 为空/只有空白时原样返回；
 * 后记单独一行（`\n`），因为对话提示词是按行读的，混在同一行会让"原文"和"后记"分不清。
 */
export function withInterpretation(content: string, interpretation: string | undefined): string {
  const text = interpretation?.trim() ?? "";
  if (text === "") return content;
  return `${content}\n（后来我想明白了：${text}）`;
}

export interface RecallTextRow {
  readonly id: string;
  readonly content: string;
}

/**
 * 批量加后记：保持顺序、不改入参；没有解释的行原样返回（同一个对象也行，这里只产出新文本）。
 */
export function withInterpretationRows<T extends RecallTextRow>(
  rows: readonly T[],
  interpretations: InterpretationMap,
): readonly T[] {
  return rows.map((row) => {
    const interpretation = interpretations.get(row.id);
    if (interpretation === undefined) return row;
    return { ...row, content: withInterpretation(row.content, interpretation) };
  });
}
