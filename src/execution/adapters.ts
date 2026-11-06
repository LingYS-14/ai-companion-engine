/**
 * 真实工具适配器（P1）：把"大脑要做的动作"翻译成执行层契约。
 *
 * 这里的元数据是**写死的**（不是配置），因为风险等级和幂等语义属于设计决策，
 * 不该被运行期改配置改掉。要改就改代码、过评审、跑门禁。
 */

import type { Idempotency, RiskTier, ToolAdapterSpec } from "./types.js";

export interface AdapterMeta {
  readonly idempotency: Idempotency;
  readonly riskTier: RiskTier;
  readonly queryable: boolean;
  readonly timeoutMs: number;
  readonly maxPerMinute: number;
  readonly dedupeTtlMs: number;
}

export const ADAPTER_META = {
  "qq.send": {
    idempotency: "at-most-once",
    riskTier: "external",
    queryable: false,
    timeoutMs: 15_000,
    maxPerMinute: 10,
    dedupeTtlMs: 60_000,
  },
  "qq.sendOneBot": {
    idempotency: "at-most-once",
    riskTier: "external",
    queryable: true,
    timeoutMs: 10_000,
    maxPerMinute: 10,
    dedupeTtlMs: 60_000,
  },
  /**
   * 发一张私聊图片。为什么幂等键是"图片路径"、去重 24 小时：同一张画面她不该反复发；
   * 但换一张新的画面是同一次新的表达，所以不做"每天只发一张"这类更狠的限制（那属于行为策略，
   * 不归执行层；表达额度在 proactive 闸门那边管）。
   */
  "qq.sendOneBotImage": {
    idempotency: "at-most-once",
    riskTier: "external",
    queryable: true,
    timeoutMs: 20_000,
    maxPerMinute: 5,
    dedupeTtlMs: 24 * 60 * 60_000,
  },
  /**
   * 发一条语音。幂等键=文本：同一句话不重复合成+发送；但换一句话就是新的一次表达。
   * 超时比文字长（合成要跑 TTS），上限比文字低（声音是重通道，别刷）。
   */
  "qq.sendOneBotVoice": {
    idempotency: "at-most-once",
    riskTier: "external",
    queryable: true,
    timeoutMs: 30_000,
    maxPerMinute: 4,
    dedupeTtlMs: 24 * 60 * 60_000,
  },
  "bili.fetch": {
    idempotency: "idempotent",
    riskTier: "read",
    queryable: true,
    timeoutMs: 20_000,
    maxPerMinute: 30,
    dedupeTtlMs: 10 * 60_000,
  },
  "bili.ingest": {
    idempotency: "at-least-once",
    riskTier: "reversible",
    queryable: true,
    timeoutMs: 30_000,
    maxPerMinute: 30,
    dedupeTtlMs: 24 * 60 * 60_000,
  },
} as const satisfies Record<string, AdapterMeta>;

export type AdapterId = keyof typeof ADAPTER_META;

/**
 * 用给定实现生成适配器。`digest` 只返回结果摘要（长度/状态），不能含聊天正文或凭据。
 */
export function makeAdapter<TInput, TResult>(
  toolId: AdapterId,
  call: (input: TInput) => Promise<TResult>,
  digest?: (result: TResult) => string,
): ToolAdapterSpec<TInput, TResult> {
  const meta = ADAPTER_META[toolId];
  return {
    toolId,
    idempotency: meta.idempotency,
    riskTier: meta.riskTier,
    queryable: meta.queryable,
    timeoutMs: meta.timeoutMs,
    maxPerMinute: meta.maxPerMinute,
    dedupeTtlMs: meta.dedupeTtlMs,
    call,
    ...(digest === undefined ? {} : { digest }),
  };
}
