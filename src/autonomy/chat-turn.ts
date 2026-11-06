/**
 * P2：网页聊天的 daemon 侧一轮（`op:"chat"` 的业务实现）。
 *
 * 与 QQ 回信共用同一套大脑/提示词，但走一条独立的、**不记模型预算**的入口：
 * 网页里的一次对话不该被 QQ 的「每小时上限」卡住（设计 §3 语义 2）。
 *
 * 关键约束（逐条对应设计 §4/§10）：
 * - 睡着不聊：`runtime.sleepInfo().phase === "asleep"` 直接抛 `asleep`，不唤醒、不写 peerMessagedAt；
 *   drowsy 可以聊（只是困，不是睡死）。
 * - 双向入记忆：用户的话走 `runtime.turn({source:"player"})`（与 QQ 同一路径）；
 *   她的话在发送成功后用 `chatReplyMemorySeed()` 单独写一条（source `chat_reply`、direction outbound）。
 *   不复用 `spokenMemorySeed`：那条是"主动开口"的语义，标签/来源都不同。
 * - 历史共享：组提示词读同一个 `ChatHistoryStore.recent(12)`；追加自己这一对。
 * - 不记账：这里不碰 `recordUsageOnce` / autonomy-usage.json，token 只写日志。
 *
 * 时间一律走注入的 `now()`（writers lint 禁止 spine 里出现 Date.now）。
 */

import type {
  DialoguePort,
  DialogueRecall,
  LanguagePort,
  Persona,
  QqAppraiseFn,
  TurnOptions,
  TurnRequest,
  TurnText,
} from "../ports/index.js";
import type { ChatHistoryEntry, ChatHistoryStore } from "../ports/chat-history.js";

import { chatComplete, type ChatMessage, type ChatReply, type LlmConfig, formatUsageLog } from "./llm.js";
import type { ChatRequest, ChatResult } from "./write-protocol.js";

/** 网页里一条消息的上限（插件侧也有一份同值校验，两处都是"拒收"而不是截断）。 */
export const CHAT_MAX_CHARS = 2_000;
/** 组提示词时带多少条共享历史（与 QQ 的 MAX_HISTORY 同口径）。 */
export const CHAT_HISTORY_PROMPT_LIMIT = 12;
/** 回复长度上限（与 QQ 的 cleanReply 口径一致）。 */
export const CHAT_REPLY_MAX_CHARS = 160;

export type ChatTurnErrorCode =
  | "bad-request"
  | "asleep"
  | "chat-model-unavailable"
  | "chat-empty-reply"
  | "chat-engine-failed";

/** 带错误码的业务错误：写通道的 catch 会把 `code` 原样透传给插件。 */
export class ChatTurnError extends Error {
  readonly code: ChatTurnErrorCode;

  constructor(code: ChatTurnErrorCode, message: string) {
    super(message);
    this.name = "ChatTurnError";
    this.code = code;
  }
}

/** 只依赖用到的那几个运行时方法，测试可以给一个极小的假对象。 */
export interface ChatRuntimeLike {
  readonly sleepInfo: () => { readonly phase: string };
  readonly turn: (req: TurnRequest, opts: TurnOptions) => TurnText;
  readonly remember: (input: {
    readonly content: string;
    readonly source?: string;
    readonly tags?: string[];
    readonly vividness?: number;
    readonly selfRelevance?: number;
    readonly direction?: "inbound" | "outbound";
  }) => { readonly stored: boolean; readonly reason: string; readonly id: string };
  readonly persona: () => Persona | null;
}

/** 她的回复落记忆的形状（结构同 `chatReplyMemorySeed()` 的返回，由装配层注入）。 */
export interface ChatReplySeed {
  readonly content: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly vividness: number;
  readonly selfRelevance: number;
  readonly direction: "outbound";
}

export interface ChatTurnDeps {
  readonly runtime: ChatRuntimeLike;
  readonly llm: LlmConfig | null;
  readonly dialogue: DialoguePort;
  /** 情绪/语言特征判定：装配层注入（spine 不 import 大脑实现，见 R4）。 */
  readonly appraise: QqAppraiseFn;
  readonly language: LanguagePort;
  /** 召回：网页是主人视角（设计 §10.2 与 QQ 同口径，只是 channel="web"）。 */
  readonly recall: (text: string) => DialogueRecall;
  /** 她的话落记忆：装配层注入 `chatReplyMemorySeed`（chat_reply 只存不巩固）。 */
  readonly replySeed: (reply: string) => ChatReplySeed;
  readonly history: ChatHistoryStore;
  readonly peerName: string;
  /** S3b（M5）：网页回信的时间一致性日志，由装配层注入（spine 不 import 大脑实现，见 R4）。 */
  readonly recordTimeClaims?: (reply: string) => unknown;
  readonly now: () => number;
  readonly log?: (line: string) => void;
  /** 测试注入点：默认走真实 chatComplete；生产不传。 */
  readonly complete?: (
    cfg: LlmConfig,
    messages: readonly ChatMessage[],
    options: { readonly maxTokens?: number; readonly temperature?: number },
  ) => Promise<ChatReply>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 走完一轮网页聊天，返回可给插件的 `ChatResult`。
 *
 * 抛 `ChatTurnError` 表示"这一轮没成立"（睡着/没模型/空回复/引擎失败），
 * 由写通道把 `code` 透传给插件；不发出去的话**不写历史、不写记忆**。
 */
export async function runChatTurn(deps: ChatTurnDeps, request: ChatRequest): Promise<ChatResult> {
  const rawText = typeof request?.text === "string" ? request.text : "";
  const text = rawText.trim();
  if (text === "") throw new ChatTurnError("bad-request", "消息是空的");
  if (Array.from(text).length > CHAT_MAX_CHARS) {
    throw new ChatTurnError("bad-request", `消息太长（上限 ${String(CHAT_MAX_CHARS)} 字）`);
  }

  const sleep = deps.runtime.sleepInfo();
  if (sleep.phase === "asleep") {
    throw new ChatTurnError("asleep", "她正在睡觉（phase=asleep）。等醒来再聊。");
  }
  if (deps.llm === null) {
    throw new ChatTurnError("chat-model-unavailable", "没有模型凭据，网页聊天不可用");
  }

  try {
    return await chatTurnBusiness(deps, text);
  } catch (err) {
    if (err instanceof ChatTurnError) throw err;
    // B2（task-148）：业务段任何非预期抛错都折成 engine-failed（500），
    // 不能让插件把它误兜成 daemon-unavailable（503）。
    throw new ChatTurnError("chat-engine-failed", `网页聊天这一轮没走完：${messageOf(err)}`);
  }
}

/** 历史读写只是账本：失败记日志、不阻断这一轮已经走通的对话（沿用 P2 既有约定）。 */
function safeRecent(
  deps: ChatTurnDeps,
  limit: number,
): ReadonlyArray<{ readonly who: "peer" | "her"; readonly text: string }> {
  try {
    return deps.history.recent(limit).map((entry) => ({ who: entry.who, text: entry.text }));
  } catch (err) {
    deps.log?.(`[chat] 读历史失败（按空历史继续）：${messageOf(err)}`);
    return [];
  }
}

function safeAppend(deps: ChatTurnDeps, entry: ChatHistoryEntry): void {
  try {
    deps.history.append(entry);
  } catch (err) {
    deps.log?.(`[chat] 写历史失败（不阻断回复）：${messageOf(err)}`);
  }
}

/**
 * 业务段：appraise/turn/recall/compose/模型/clean/veto 都在这里，
 * 非 `ChatTurnError` 的抛错由上层统一折成 `chat-engine-failed`。
 */
async function chatTurnBusiness(deps: ChatTurnDeps, text: string): Promise<ChatResult> {
  // 上层已判过 null；这里再取一次是为了把 non-null 收窄保住（TS 的跨函数收窄不会带进来）。
  const llm = deps.llm;
  if (llm === null) throw new ChatTurnError("chat-model-unavailable", "没有模型凭据，网页聊天不可用");
  // 判定与记忆都走和 QQ 相同的路径：appraise → turn（唯一写者在这之后落盘）。
  const appraisal = deps.appraise(text, deps.language);
  let turn: TurnText;
  try {
    turn = deps.runtime.turn(
      { text, appraisal: appraisal.appraisal, language: appraisal.features },
      {
        source: "player",
        eventType: appraisal.eventType,
        audiencePresent: 0,
        // 纯寒暄/表情不写记忆（与 QQ 同一个判断函数）。
        skipMemory: deps.dialogue.isJunkMemory(text),
      },
    );
  } catch (err) {
    throw new ChatTurnError("chat-engine-failed", `引擎这一轮没走完：${messageOf(err)}`);
  }

  // 先把对方这句写进共享历史：模型失败也不该把他说过的话弄丢（UI 轮询还能看到）。
  safeAppend(deps, { atMs: deps.now(), who: "peer", text, channel: "web" });

  const recalled = deps.recall(text);
  const composed = deps.dialogue.composeReply({
    layers: {
      persona: deps.runtime.persona(),
      mode: turn.mode,
      modeStyle: turn.style.modeStyle,
      stageStyle: turn.style.stageStyle,
      expressionStyle: turn.style.expressionStyle,
      suppressInstruction: turn.style.suppressInstruction,
      eventPermission: turn.eventStyle?.permission ?? null,
      eventAvoid: turn.eventStyle?.avoid ?? null,
    },
    peerName: deps.peerName,
    text,
    unread: "",
    history: safeRecent(deps, CHAT_HISTORY_PROMPT_LIMIT),
    recall: recalled,
  });

  const startedAt = deps.now();
  const complete = deps.complete ?? chatComplete;
  let replyText: string;
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const reply = await complete(
      llm,
      [
        { role: "system", content: composed.system },
        { role: "user", content: composed.user },
      ],
      { task: "chat" },
    );
    replyText = reply.text;
    promptTokens = reply.usage?.promptTokens ?? 0;
    completionTokens = reply.usage?.completionTokens ?? 0;
    const usageLine = formatUsageLog("chat", reply);
    if (usageLine !== undefined) deps.log?.(usageLine);
  } catch (err) {
    throw new ChatTurnError("chat-engine-failed", `模型调用失败：${messageOf(err)}`);
  }

  const cleaned = deps.dialogue.cleanReply(replyText, CHAT_REPLY_MAX_CHARS, deps.peerName);
  const reply = deps.dialogue.vetoTaboo(cleaned).text.trim();
  if (reply === "") {
    throw new ChatTurnError("chat-empty-reply", "模型没有给出可发送的回复");
  }

  const atMs = deps.now();
  safeAppend(deps, { atMs, who: "her", text: reply, channel: "web" });

  // S3b（M5）：网页回信的时间一致性日志。只记计数/时长大数，不落原文；
  // 具体判定在装配层注入的闭包里（R4：spine 不 import 大脑实现），失败不影响回复。
  try {
    const pending = deps.recordTimeClaims?.(reply);
    if (pending instanceof Promise) {
      void pending.catch(() => deps.log?.("[time-claim] failed"));
    }
  } catch {
    deps.log?.("[time-claim] failed");
  }

  // 她的话也要进记忆（设计 §3 语义 4）：只存不巩固——chat_reply 不在 RELATION_SOURCES。
  try {
    const seed = deps.replySeed(reply);
    const saved = deps.runtime.remember({ ...seed, tags: [...seed.tags] });
    if (!saved.stored) {
      deps.log?.(`[chat] 回复没进记忆：${saved.reason}`);
    }
  } catch (err) {
    // 记忆写不进不该把已经生成的话吞掉（P0-2 的取舍：说出去的话比账本重要）。
    deps.log?.(`[chat] 回复记忆写入失败（不影响回复）：${messageOf(err)}`);
  }

  deps.log?.(
    `[chat] web llm=${llm.model} in≈${String(promptTokens)} out≈${String(completionTokens)} ms=${String(atMs - startedAt)}`,
  );

  return {
    reply,
    mode: turn.mode,
    ...(turn.stage === null ? {} : { stage: turn.stage }),
    historyWritten: true,
    ...(turn.traceId === undefined ? {} : { traceId: turn.traceId }),
  };
}
