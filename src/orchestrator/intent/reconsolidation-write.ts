/**
 * §5.4 再巩固的**写入口**：把「这一条旧事，我现在这么理解」变成一条版本补丁。
 *
 * 用户 2026-10-31 的裁决：「A、巩固（改写旧记忆）允许调用，可以稍微放开。」
 * 所以这一步允许调一次模型——但只做「让模型给出解释」，**不改任何记忆内容**：
 * 产物是一条 `ReconsolidationPatch`，由 `version-file.ts` 追加进版本链；旧版本永远留着。
 *
 * 三条纪律：
 * 1. 解释必须是模型自己写的「我现在这么理解：…」+「为什么：…」，不接受空话/元叙述；
 * 2. 只改 `interpretation`，不动 valence/salience——那是状态层（S 层）的职责；
 * 3. 落盘/上限/链指针全部交给 `version-file.ts` 的 `addReconsolidationPatch`，这一层不写历史。
 */

import {
  type ReconsolidationCandidate,
  type ReconsolidationMemory,
} from "./reconsolidation.js";
import {
  MAX_VALENCE_DELTA,
  validatePatch,
  type ReconsolidationPatch,
} from "./version-chain.js";

/** 解释至少几个字：低于它多半是「嗯，想通了」这种废话。 */
export const MIN_INTERPRETATION_CHARS = 8;
/** 理由至少几个字（与 `validatePatch` 的 MIN_REASON_CHARS 对齐，但这里是给模型的提示）。 */
export const MIN_REASON_CHARS = 6;
export const MAX_INTERPRETATION_CHARS = 300;
export const MAX_REASON_CHARS = 200;

/** 提示里要给她看的两条记忆（只要读出来的部分）。 */
export interface RecallPair {
  readonly older: { readonly id: string; readonly content: string; readonly createdAtMs: number };
  readonly newer: { readonly id: string; readonly content: string; readonly createdAtMs: number };
}

export interface ReconsolidationPromptOptions {
  readonly personaName: string;
  readonly pair: RecallPair;
  /** 话题域（候选带过来的），让模型知道这是"同一件事"。 */
  readonly topicDomain: string;
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/**
 * 构造「请重新解释一次旧事」的提示。
 * 要求模型输出两行固定格式，便于解析；不要求 JSON（模型写 JSON 时更容易带出多余字段）。
 */
export function buildReconsolidationPrompt(options: ReconsolidationPromptOptions): readonly ChatMessage[] {
  const { personaName, pair, topicDomain } = options;
  return [
    {
      role: "system",
      content:
        `你是${personaName}。你正在想起一件旧事，并且这一次你对它的感受和当时不一样了。` +
        `不要解释你是 AI，不要提"记忆""系统""设定"。用第一人称写。` +
        `输出必须正好两行：\n` +
        `第一行：我现在这么理解：<一句话，8-300 字>\n` +
        `第二行：为什么：<一句话，6-200 字>`,
    },
    {
      role: "user",
      content:
        `话题：${topicDomain}\n` +
        `当时（${formatWhen(pair.older.createdAtMs)}）我说：${pair.older.content}\n` +
        `后来（${formatWhen(pair.newer.createdAtMs)}）我说：${pair.newer.content}\n` +
        `现在你在重新想起这两句。按上面的两行格式，写下你现在的理解。`,
    },
  ];
}

/** 秒级 UTC 时间（不调 Date 的本地化，避免时区/格式漂移）。 */
function formatWhen(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86_400);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(days)} 天前 ${pad(hours)}:${pad(minutes)}:${pad(seconds)} UTC`;
}

export interface ReconsolidationExplanation {
  readonly interpretation: string;
  readonly reason: string;
}

/** 模型输出里不该出现的元叙述（出现就整条丢弃，不做"抽掉一句"的修补）。 */
const META_PATTERNS: readonly RegExp[] = [
  /作为\s*(一个)?\s*(ai|人工智能|语言模型)/i,
  /(系统|设定|提示词|prompt)/i,
  /(记忆|数据库|引擎|版本链)/,
];

function cleanLine(raw: string, label: string): string | null {
  // 标签可以出现在任意一行；取标签之后、本行结束之前的那段。
  const pattern = new RegExp(`(?:^|\\n)[^\\n]*?${label}\\s*[：:]\\s*([^\\n]*)`);
  const match = pattern.exec(raw);
  if (match === null) return null;
  const rest = (match[1] ?? "").trim();
  return rest === "" ? null : rest;
}

/**
 * 解析模型输出。宽容但**不替模型补话**：
 * - 认两种写法：「我现在这么理解：/为什么：」两行，或 JSON `{interpretation, reason}`；
 * - 任何一段太短、太长、含元叙述 → 返回 null（整条丢弃，让调用方当"废稿"记账）。
 */
export function parseReconsolidationExplanation(text: string): ReconsolidationExplanation | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const interpretation = typeof record["interpretation"] === "string" ? record["interpretation"].trim() : "";
        const reason = typeof record["reason"] === "string" ? record["reason"].trim() : "";
        return accept(interpretation, reason);
      }
    } catch {
      // 落到两行格式
    }
  }

  const interpretation = cleanLine(trimmed, "我现在这么理解");
  const reason = cleanLine(trimmed, "为什么");
  if (interpretation === null || reason === null) return null;
  return accept(interpretation, reason);
}

function accept(interpretation: string, reason: string): ReconsolidationExplanation | null {
  if (interpretation.length < MIN_INTERPRETATION_CHARS || interpretation.length > MAX_INTERPRETATION_CHARS) return null;
  if (reason.length < MIN_REASON_CHARS || reason.length > MAX_REASON_CHARS) return null;
  if (META_PATTERNS.some((pattern) => pattern.test(interpretation) || pattern.test(reason))) return null;
  if (interpretation.includes("\n") || reason.includes("\n")) return null;
  return { interpretation, reason };
}

export interface ToPatchOptions {
  readonly candidate: ReconsolidationCandidate;
  /** 版本链当前末端（null 表示还没有任何版本；从 0 起算）。 */
  readonly current: { readonly newVersion: number } | null;
  readonly explanation: ReconsolidationExplanation;
}

/**
 * 把候选 + 解释变成一条补丁。只改 interpretation；`supersededBy` 留给 `addReconsolidationPatch`。
 * 返回值保证通过 `validatePatch`（否则抛错——这是我们自己的 bug，不该写进历史）。
 */
export function toReconsolidationPatch(options: ToPatchOptions): ReconsolidationPatch {
  const { candidate, current, explanation } = options;
  const prevVersion = current === null ? 0 : current.newVersion;
  const patch: ReconsolidationPatch = {
    memoryId: candidate.olderMemoryId,
    newVersion: prevVersion + 1,
    changed: { interpretation: explanation.interpretation },
    reason: explanation.reason,
    source_ids: [candidate.olderMemoryId, candidate.newerMemoryId],
    prevVersion,
    supersededBy: null,
  };
  const errors = validatePatch(patch);
  if (errors.length > 0) throw new Error(`再巩固补丁自我校验失败：${errors.join("；")}`);
  return patch;
}

/** 一行日志：谁被重新理解、从第几版到第几版、为什么。 */
export function describeReconsolidationPatch(patch: ReconsolidationPatch): string {
  return `再巩固记忆 ${patch.memoryId}：v${String(patch.prevVersion)} → v${String(patch.newVersion)}（${patch.reason}）`;
}

/** 对外暴露常量：与 version-chain 的数值上限保持一致，测试里直接断言。 */
export const RECONSOLIDATION_LIMITS = {
  minInterpretationChars: MIN_INTERPRETATION_CHARS,
  minReasonChars: MIN_REASON_CHARS,
  maxInterpretationChars: MAX_INTERPRETATION_CHARS,
  maxReasonChars: MAX_REASON_CHARS,
  maxValenceDelta: MAX_VALENCE_DELTA,
} as const;

/** 只读工具：把记忆记录投影成提示需要的形状（不读 encode_ctx，避免把指纹当内容）。 */
export function recallPairOf(
  older: ReconsolidationMemory & { readonly content: string },
  newer: ReconsolidationMemory & { readonly content: string },
): RecallPair {
  return {
    older: { id: older.id, content: older.content, createdAtMs: older.created_at },
    newer: { id: newer.id, content: newer.content, createdAtMs: newer.created_at },
  };
}
