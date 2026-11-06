/**
 * 「网页聊天」的远程执行端（插件进程用，P2.1 / task-157）。
 *
 * 为什么需要它：`src/plugin/web/chat.ts` 只做 HTTP 协议与 CSRF，真正的一轮聊天
 * 必须投给**唯一写者**（daemon）执行——与 `channel-turn.ts` 同一个理由（R3/R4：
 * 插件不能变成第二个写者，也不能直接 import 大脑实现）。
 *
 * 边界：
 * - 写通道不可用 / 拒绝 → 抛 `ChatChannelError`（带 `code`），由路由层映射成
 *   `daemon-unavailable`/`CHANNEL_DOWN` 等前端认识的状态码；**不回退本进程执行**。
 * - 成功 → 返回 daemon 侧的 `ChatResult`（reply/mode/stage/traceId…）。
 * - 超时固定 90s（设计 §7.1），与前端等待上限一致；调用方可覆盖以便测试。
 */
import type { ChatResult } from "../autonomy/write-protocol.js";
import { callWriteChannel, WriteChannelUnavailableError, type CallWriteChannelInput } from "./write-client.js";

/** 设计 §7.3：网页聊天单轮最多等 90s（模型慢时前端也等得住）。 */
export const CHAT_CHANNEL_TIMEOUT_MS = 90_000;

/** 写通道拒绝/不可用时抛这个；`code` 直接来自通道错误码（CHANNEL_DOWN 等）。 */
export class ChatChannelError extends Error {
  readonly code: string;

  constructor(message: string, code = "daemon-unavailable") {
    super(message);
    this.name = "ChatChannelError";
    this.code = code;
  }
}

/** 与 `callWriteChannel` 同形，但只要求本模块用到的字段——测试可以给假的 */
export interface ChannelChatCallInput
  extends Pick<CallWriteChannelInput, "dataDir" | "characterId" | "op" | "payload"> {
  readonly timeoutMs?: number;
}

/** 测试用的窄结果（真实 `callWriteChannel` 的 `WriteChannelResult` 兼容它）。 */
export interface ChannelChatResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly code?: string;
}

export interface ChannelChatDeps {
  /** 数据根（与 daemon 同一个，`data/write-channel-<id>.json` 在它下面） */
  readonly dataDir: string;
  readonly characterId: string;
  /** 投递函数；缺省=真写通道客户端（测试给假的） */
  readonly call?: (input: ChannelChatCallInput) => Promise<ChannelChatResult>;
  /** 单轮超时（默认 90s；测试可缩短） */
  readonly timeoutMs?: number;
}

/**
 * 造一个「投给唯一写者」的聊天函数，给 `registerChatRoutes` 当 `call`。
 *
 * 注：`payload` 形状与 daemon 侧 `runChatTurn` 的入参一致（`{text}`）。
 */
export function makeChannelChat(deps: ChannelChatDeps): (text: string) => Promise<ChatResult> {
  const call = deps.call ?? callWriteChannel;
  const timeoutMs = deps.timeoutMs ?? CHAT_CHANNEL_TIMEOUT_MS;
  return async (text) => {
    let result: ChannelChatResult;
    try {
      result = await call({
        dataDir: deps.dataDir,
        characterId: deps.characterId,
        op: "chat",
        payload: { text },
        timeoutMs,
      });
    } catch (err) {
      // 通道缺失/连不上：明确说「宿主那边没在跑」，不假装是引擎错误。
      if (err instanceof WriteChannelUnavailableError) {
        throw new ChatChannelError(
          `写通道不可用（daemon 没跑或写通道没开）：${err.message}`,
          err.code,
        );
      }
      throw err;
    }
    if (!result.ok) {
      throw new ChatChannelError(`写通道拒绝了这次聊天：${result.error ?? "未知原因"}`, result.code ?? "daemon-unavailable");
    }
    if (result.result === undefined) {
      throw new ChatChannelError("写通道没有返回聊天结果", "daemon-unavailable");
    }
    return result.result as ChatResult;
  };
}
