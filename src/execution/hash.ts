/**
 * 请求指纹：同一句话再发一次，不该因为内容相同就被永久吞掉。
 *
 * 设计要点（审计 E4）：
 * - 指纹 = 工具 + 目标 + 载荷 的稳定散列，**不含**任意"当前时间"；
 * - 去重窗口由适配器的 dedupeTtlMs 决定，落盘时记录 at；
 * - 需要"同一天内同一内容只做一次"的场景（如入库），由适配器把时间桶放进载荷里，
 *   而不是由指纹层偷偷加时间——否则调试时无法复现。
 */

import { createHash } from "node:crypto";

/** 稳定序列化：键排序、跳过 undefined、数组保序，保证同一语义得到同一指纹。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export interface FingerprintInput {
  readonly toolId: string;
  readonly target?: string;
  readonly payload: unknown;
}

/** 64 位十六进制指纹。纯函数，无时钟、无随机。 */
export function requestFingerprint(input: FingerprintInput): string {
  const body = stableStringify({
    tool: input.toolId,
    ...(input.target === undefined ? {} : { target: input.target }),
    payload: input.payload,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}
