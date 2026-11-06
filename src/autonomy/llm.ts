/**
 * 自主进程用的最小 LLM 客户端（OpenAI 兼容协议）。
 *
 * 为什么自己写：插件运行在 DSH 宿主里，拿不到宿主的模型通道；而她「脱离本会话存在」
 * 之后必须能自己开口、自己学习，所以自主进程需要一个自己的凭据与调用面。
 *
 * 安全：
 * - key 只从环境变量读（`AI_COMPANION_LLM_API_KEY`），不进日志、不落盘；
 * - 网络可注入（`fetchImpl`），测试不联网；
 * - 超时用 AbortController，失败抛 HTTP 状态 + 截断后的正文，便于审计。
 */

import { resolveApiKey, readKeyEnv } from "./secret.js";

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 高质量档（F353）：对话/做梦/再巩固/自我模型用；缺省时退回 model */
  readonly proModel?: string | undefined;
  readonly timeoutMs: number;
}

/**
 * 任务档位（F353，用户 2026-11-06「一切为了效果服务」）。
 *
 * 2026-11 起 DeepSeek 的模型默认开启 thinking（思考链按输出计费且默认 high），
 * 短输出/短 max_tokens 会被思考链吃掉 → 必须显式声明档位，而不是靠默认值。
 */
export type LlmTask = "chat" | "proactive" | "selftalk" | "learn" | "social" | "insight" | "reconsolidation" | "dream" | "self_model";

export interface TaskModelPolicy {
  readonly model: string;
  readonly thinking: "enabled" | "disabled";
  readonly reasoningEffort: "low" | "high" | "max" | undefined;
  readonly maxTokens: number;
}

/** 默认高质量档的模型名；可用 `AI_COMPANION_LLM_MODEL_PRO` 覆盖 */
export const DEFAULT_PRO_MODEL = "deepseek-v4-pro";
/** 默认快档模型名（旧名 deepseek-chat 仍被服务端接受并路由到 flash） */
export const DEFAULT_FLASH_MODEL = "deepseek-flash";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatReply {
  readonly text: string;
  readonly model: string;
  /** 服务端返回的 token 用量（没有就 undefined）；cacheHit/Miss 是官方前缀缓存口径 */
  readonly usage:
    | {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly cacheHitTokens: number | undefined;
        readonly cacheMissTokens: number | undefined;
      }
    | undefined;
}

/** F354：把一次调用的用量/缓存命中压成一行日志（没有 usage 就不打） */
export function formatUsageLog(task: string, reply: ChatReply): string | undefined {
  if (reply.usage === undefined) return undefined;
  const u = reply.usage;
  const parts = [`[llm] task=${task} model=${reply.model} in=${String(u.promptTokens)} out=${String(u.completionTokens)}`];
  if (u.cacheHitTokens !== undefined) parts.push(`cached=${String(u.cacheHitTokens)}`);
  if (u.cacheMissTokens !== undefined) parts.push(`miss=${String(u.cacheMissTokens)}`);
  return parts.join(" ");
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_LLM_MODEL = DEFAULT_FLASH_MODEL;
export const DEFAULT_LLM_TIMEOUT_MS = 90_000;

/**
 * 档位表：对话与「理解类」任务用 pro + thinking，短句类用 flash 非思考。
 *
 * 取舍（用户 2026-11-06「先考虑效果再考虑消耗」）：
 * - chat / self_model / reconsolidation / dream / insight → 需要「想一下」才像活的，用 pro；
 * - proactive / selftalk / learn / social → 短、快、口吻自然，thinking 反而会让句子变硬且拖慢，用 flash 非思考。
 */
export function pickTaskPolicy(cfg: LlmConfig, task: LlmTask): TaskModelPolicy {
  const pro = cfg.proModel ?? DEFAULT_PRO_MODEL;
  switch (task) {
    case "chat":
      return { model: pro, thinking: "enabled", reasoningEffort: "low", maxTokens: 800 };
    case "self_model":
      return { model: pro, thinking: "enabled", reasoningEffort: "high", maxTokens: 900 };
    case "reconsolidation":
      return { model: pro, thinking: "enabled", reasoningEffort: "high", maxTokens: 600 };
    case "dream":
      return { model: pro, thinking: "enabled", reasoningEffort: "high", maxTokens: 600 };
    case "insight":
      return { model: pro, thinking: "enabled", reasoningEffort: "high", maxTokens: 400 };
    case "proactive":
    case "selftalk":
    case "learn":
      return { model: cfg.model, thinking: "disabled", reasoningEffort: undefined, maxTokens: 400 };
    // 社交短句（弹幕/评论）比主动开口还短：20/60 字，120 token 足够且不容易被截断。
    case "social":
      return { model: cfg.model, thinking: "disabled", reasoningEffort: undefined, maxTokens: 120 };
  }
}

/**
 * 完整解析（异步）：环境变量优先，其次 DPAPI 文件（%LOCALAPPDATA%）。
 * 返回的 keySource 只用于日志，方便排查"这次用的是哪把 key"而不暴露值。
 */
export async function loadLlmConfig(env: NodeJS.ProcessEnv):
  Promise<{ readonly config: LlmConfig; readonly keySource: "env" | "dpapi" } | null> {
  const resolved = await resolveApiKey(env);
  if (resolved === null) return null;
  const base = resolveLlmConfig({ ...env, AI_COMPANION_LLM_API_KEY: resolved.key });
  return base === null ? null : { config: base, keySource: resolved.source };
}

/** 从环境变量解析；缺 key 返回 null（自主进程会降级为模板，不静默失败） */
export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig | null {
  const apiKey = readKeyEnv(env)?.key;
  if (apiKey === undefined) return null;
  const baseUrl = (env.AI_COMPANION_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
  const model = env.AI_COMPANION_LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const proModel = env.AI_COMPANION_LLM_MODEL_PRO ?? DEFAULT_PRO_MODEL;
  const timeoutRaw = Number(env.AI_COMPANION_LLM_TIMEOUT_MS ?? String(DEFAULT_LLM_TIMEOUT_MS));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_LLM_TIMEOUT_MS;
  return { baseUrl, apiKey, model, proModel, timeoutMs };
}

function trimForLog(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 一次 chat completion；任何非 2xx 都抛错，错误信息不含 key */
export async function chatComplete(
  cfg: LlmConfig,
  messages: readonly ChatMessage[],
  deps: {
    fetchImpl?: FetchLike;
    maxTokens?: number;
    temperature?: number;
    /** F353：任务档位（决定模型/思考开关/默认 token 预算） */
    task?: LlmTask;
    /** 显式覆盖（测试/灰度用） */
    model?: string;
    thinking?: "enabled" | "disabled";
    reasoningEffort?: "low" | "high" | "max";
  } = {},
): Promise<ChatReply> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (fetchImpl === undefined) throw new Error("没有可用的 fetch：请注入 fetchImpl 或使用 Node 18+");
  const policy = deps.task === undefined ? undefined : pickTaskPolicy(cfg, deps.task);
  const model = deps.model ?? policy?.model ?? cfg.model;
  const thinking = deps.thinking ?? policy?.thinking ?? "disabled";
  const reasoningEffort = deps.reasoningEffort ?? policy?.reasoningEffort;
  const maxTokens = deps.maxTokens ?? policy?.maxTokens ?? 220;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
    // 2026-11 起服务端默认开启 thinking；必须显式关，否则短输出会被思考链吃掉
    thinking: { type: thinking },
  };
  if (reasoningEffort !== undefined && thinking === "enabled") body.reasoning_effort = reasoningEffort;
  // thinking 模式不支持 temperature（传了也不生效），只在非思考时带上
  if (thinking === "disabled") body.temperature = deps.temperature ?? 0.9;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`LLM HTTP ${String(response.status)}：${trimForLog(bodyText)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`LLM 返回不是 JSON：${trimForLog(bodyText, 120)}`);
    }
    const obj = parsed as { model?: unknown; choices?: unknown; usage?: unknown };
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    const first = choices[0] as { message?: { content?: unknown; reasoning_content?: unknown } } | undefined;
    const content = first?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      const hadReasoning = typeof first?.message?.reasoning_content === "string" && first.message.reasoning_content.length > 0;
      throw new Error(
        hadReasoning
          ? `LLM 思考链占满了 max_tokens（${String(maxTokens)}），没有最终内容：${trimForLog(bodyText, 120)}`
          : `LLM 返回没有内容：${trimForLog(bodyText, 120)}`,
      );
    }
    const usage = obj.usage as
      | {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          prompt_cache_hit_tokens?: unknown;
          prompt_cache_miss_tokens?: unknown;
        }
      | undefined;
    return {
      text: content.trim(),
      model: typeof obj.model === "string" ? obj.model : cfg.model,
      usage:
        usage === undefined || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number"
          ? undefined
          : {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              cacheHitTokens:
                typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : undefined,
              cacheMissTokens:
                typeof usage.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : undefined,
            },
    };
  } finally {
    clearTimeout(timer);
  }
}
