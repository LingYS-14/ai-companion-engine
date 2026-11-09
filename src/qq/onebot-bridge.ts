/**
 * OneBot 事件 → 既有 QQ 流水线。
 *
 * 分工：`onebot.ts` 只管「事件长什么样、怎么发、怎么重连」，不判断该不该回；
 * 这里才是决策层。它必须和窗口通道（`bridge.ts`）说同一套话，所以
 * appraisal / prompt / cleanReply / 引擎的 turn() **全部复用**，一行都不重写。
 *
 * 和 `bridge.ts` 的差别只有一处，但很关键：窗口通道是「拉」——定时去 inbox
 * 目录捞一批 JSON，靠 `cursorEpochNs` 判断新旧；OneBot 是「推」——一条事件一条
 * `handle()`，没有批，也就没有「从最新往前挑一条」的逻辑，来一条判一条。
 * 判据本身（静默时段、最小间隔、每小时上限、去重）仍按 `filter.ts` 的语义照抄，
 * 因为那是产品行为，不是通道细节。
 */

import type {
  BrainPort,
  DialoguePort,
  DialogueRecall,
  LanguagePort,
  ProactiveIntentContext,
  ProactiveOptions,
  TurnOptions,
  TurnRequest,
  TurnText,
  QqAppraiseFn,
} from "../ports/index.js";
import type { ChatHistoryStore } from "../ports/chat-history.js";
import type { QQImageBytes, QQProactiveResult } from "./bridge.js";
import { imageNote, unreadImageNote, type InboundImage } from "./inbound.js";
import { toInbound, type InboundVoice, type OneBotEvent, type OneBotInbound } from "./onebot.js";
import { DEFAULT_QQ_OPTIONS, emptyQQState, type QQStateRecord } from "./types.js";
import { decideQqReply, type QqReplyStateView } from "./reply-policy.js";

/** 主动开口的"先不说"协议（A5）：模型只回这一个词 = 她判断此刻不宜打扰，本轮不发送。 */
export const PROACTIVE_HOLD_TOKEN = "HOLD";

/** task-169 C：回声自检命中后重生成时追加的一句（只换素材，不换人格/门限）。 */
const ECHO_RETRY_NOTE = "换一个具体的话题或细节，不要重复你最近说过的话。";

/** 一次判定为什么没回（工具与日志都用这些词，不要另造） */
export const DEFAULT_PEER_NAME = "用户";

export type OneBotReason =
  | "not-message"
  | "not-private"
  | "self"
  | "empty"
  | "not-peer"
  | "duplicate"
  | "stale"
  | "quiet"
  | "gap"
  | "rate"
  | "engine-failed"
  | "llm-failed"
  | "empty-reply"
  | "dry-run"
  | "selfcheck-held"
  | "test-held"
  | "send-failed"
  | "spine-down"
  | "replied";

export interface OneBotBridgeOptions {
  /** 机器人自己的 QQ 号：用来排掉自发事件与「不属于本账号」的事件 */
  readonly selfId?: number;
  /** 只回这个 QQ 号 */
  readonly peer: number;
  /** 提示词里怎么称呼对方；缺省/纯数字时用「用户」（不能把 QQ 号当称呼） */
  readonly peerName?: string;
  readonly quietFrom: number;
  readonly quietTo: number;
  readonly minGapMs: number;
  readonly maxPerHour: number;
  readonly ignoreOlderThanMs: number;
  readonly dryRun: boolean;
}

/** 从默认 QQ 选项继承静默/限速口径，只覆盖调用方明确给了的字段 */
export function makeOneBotOptions(
  input: { readonly peer: number } & Partial<Omit<OneBotBridgeOptions, "peer">>,
): OneBotBridgeOptions {
  return {
    peer: input.peer,
    quietFrom: input.quietFrom ?? DEFAULT_QQ_OPTIONS.quietFrom,
    quietTo: input.quietTo ?? DEFAULT_QQ_OPTIONS.quietTo,
    minGapMs: input.minGapMs ?? DEFAULT_QQ_OPTIONS.minGapMs,
    maxPerHour: input.maxPerHour ?? DEFAULT_QQ_OPTIONS.maxPerHour,
    ignoreOlderThanMs: input.ignoreOlderThanMs ?? DEFAULT_QQ_OPTIONS.ignoreOlderThanMs,
    dryRun: input.dryRun ?? DEFAULT_QQ_OPTIONS.dryRun,
    ...(input.selfId === undefined ? {} : { selfId: input.selfId }),
    ...(input.peerName === undefined ? {} : { peerName: input.peerName }),
  };
}

export interface OneBotBridgeDeps {
  now(): number;
  localHour(): number;
  /**
   * 一句话 → appraisal / 语言特征 / 事件类型（F297：判断在大脑层，装配点注入）。
   * 桥只负责传输与会话，不自己决定"这句话算不算冒犯"。
   */
  appraise: QqAppraiseFn;
  /** 可选：把图片引用读成字节；没有就退化成纯文字 + 「对方发来一张图片」 */
  readImage?(ref: InboundImage): Promise<QQImageBytes | null>;
  /** 可选：把语音转成文字；没有就退化成「对方发来一条语音」，不猜内容 */
  transcribeVoice?(ref: InboundVoice): Promise<string>;
  /** 可选：用语音回（对方发语音时镜像）；失败或未接线时降级成文字 */
  sendVoice?(input: { readonly peer: number; readonly text: string }): Promise<{ readonly ok: boolean; readonly detail: string }>;
  generate(input: {
    readonly system: string;
    readonly prompt: string;
    readonly images?: readonly QQImageBytes[];
    /** F353 B1：主动开口与回信共用 generate，必须显式区分，模型档位才落得到 flash/pro */
    readonly task?: "chat" | "proactive";
  }): Promise<string>;
  /**
   * 真发送。与窗口通道的 `send(text)` 不同：这里必须带 peer（WS 里没有会话上下文）。
   *
   * `imagePath` 有值时先把那张图发出去，再发文字（`qq.sendOneBotImage` 走执行层，
   * 24 小时内同一张图只发一次）。图发不出去**不影响**文字——她的话不能因为附件丢。
   */
  send(input: {
    readonly peer: number;
    readonly text: string;
    readonly imagePath?: string;
  }): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /**
   * 可选：她手上现在有没有一张可以递出去的画面（B 站取帧目录里 24h 内最新那张）。
   *
   * 只有 `dialogue.wantsImage(reply)` 为真、且这里返回了路径时才会附上。
   * 返回 null 表示「没有图」——那就照常只发文字，不假装有图。
   */
  shareImage?(): string | null;
  saveState(state: QQStateRecord): void;
  /** 可选：按对方这句话召回「她记得的事 / 最近看到的东西」，接在系统提示后面 */
  recall?(text: string): DialogueRecall;
  /**
   * 可选（task-169 A）：主动开口专用召回——排除她自己说过的话（proactive/selftalk/chat_reply），
   * 避免拿自述当素材。不传时退回 `recall`（旧行为）。
   */
  recallForProactive?(text: string): DialogueRecall;
  /**
   * 可选（task-169 C）：生成侧回声自检（装配点注入，工具层不 import 大脑）。
   * 命中 → 换一句重生成一次；仍命中 → 这次不开口（held / echo-repeat）。
   */
  echoCheck?(text: string): { readonly hit: boolean; readonly score: number };
  /**
   * 可选（P2）：与网页聊天共享的对话历史。
   *
   * 不给时退回桥内的 `this.history`（旧行为一字不差：测试/宿主独立起桥都不受影响）。
   * 给了之后，组提示词读 `recent(MAX_HISTORY)`，收发各追加一条到同一个 NDJSON。
   */
  history?: ChatHistoryStore;
  /**
   * 「嘴」：组提示词 / 清输出 / 判该不该主动开口（实现见 `dialogue/port-adapter.ts`）。
   * 工具层不许 import 大脑实现（R3），由装配点注入。
   */
  dialogue: DialoguePort;
  /** 语言特征提取（appraisal 用），同样由装配点注入 */
  language: LanguagePort;
  /**
   * 可选：一个回合的写锁。返回释放函数。
   * 宿主与常驻自主进程都会写状态文件，接待这一回合时由宿主拿锁（见 docs/OPERATIONS.md）。
   */
  beginTurn?(): () => void;
  /**
   * 可选：把「一个回合」交给装配点执行（F272）。
   *
   * 插件进程不该自己写状态（单写者）：宿主侧会把它投给自主进程的写通道。
   * **不实现时退回本进程 `rt.turn(...)`**——常驻进程与测试就是这种情形。
   */
  turn?(req: TurnRequest, opts?: TurnOptions): TurnText | Promise<TurnText>;
  /** 可选：§4.9 阶段 0 的状态门阈值（缺省则不做 energy/trust 门，保持旧行为） */
  gates?(): { readonly energyFloor: number; readonly trustFloor: number; readonly trustSafeMin: number };
  /**
   * 可选：脊髓熔断中（对外通道连着失败）。
   * 通道断的时候不该再生成台词——生成要花一次模型调用，发出去必然失败。
   */
  channelDown?(): boolean;
  /**
   * 可选（P0-F）：回信**真的发出去之后**的回调，用来把这句话写进记忆。
   *
   * 生产由 daemon 的 `qq-runner` 注入 `runtime.remember`，插件 host 由 `plugin/index` 注入。
   * 这是旁路：同步抛错或异步拒绝都只记日志，绝不影响「已经回复成功」这个结果。
   */
  rememberReply?(reply: string): unknown;
  /**
   * 可选（S3b/M5）：回信**真的发出去之后**的回调，用来落时间一致性日志。
   *
   * 只挂回信分支；主动开口由主进程在发送成功后自己记，若挂在这里会重复计数。
   * 旁路语义同 `rememberReply`：同步抛错或异步拒绝都只记日志，绝不影响「已经回复成功」。
   */
  /**
   * 可选（2026-11-09 单话题根因）：把**对方这次说的正文**写进记忆。
   *
   * 回信成功时 `turn()` 自己会写一条入站记忆；但这一轮被闸门挡下（gap/rate）时
   * 那句话就彻底消失了——她的记忆里于是只剩自述。这里补上被挡下的那一半，
   * 旁路语义同 `rememberReply`：抛错只记日志，绝不影响判定结果。
   */
  rememberInbound?(text: string): unknown;
  recordTimeClaims?(reply: string): unknown;
  log?(line: string): void;
}

export interface OneBotHandleResult {
  readonly acted: boolean;
  readonly reason: OneBotReason;
  readonly detail: string;
  readonly id?: string;
  readonly reply?: string;
  readonly dryRun?: boolean;
  readonly mode?: string;
  readonly stage?: string | null;
}

export interface OneBotDecision {
  readonly ok: boolean;
  readonly reason?: Exclude<OneBotReason, "engine-failed" | "llm-failed" | "empty-reply" | "dry-run" | "send-failed" | "replied" | "not-message" | "not-private" | "self">;
  readonly detail: string;
}

const MAX_IDS = 200;
const MAX_HISTORY = 12;
const MAX_IMAGES = 3;
/** 语音转写提示：模型要知道"可能听错"，但不要跟用户解释这是转写 */
const VOICE_NOTE = "（对方发来的是语音，下面是转写的字，可能有错字；别跟他提语音转文字这件事）";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 该不该回。顺序与 `filter.ts` 的 `decideReply` 一致：
 * 空 → 非目标 → 重复 → 太旧 → 太频繁 → 超限速。
 * **静默时段只约束"她主动开口"**（proactive），不约束回信——你半夜找她，她该说话。
 * 先检查便宜的条件，避免为一辆已经拦掉的消息去读图/调引擎。
 */
export function decideOneBotReply(input: {
  readonly inbound: OneBotInbound;
  readonly opts: OneBotBridgeOptions;
  readonly state: QQStateRecord;
  readonly now: number;
  readonly localHour: number;
}): OneBotDecision {
  const { inbound, opts, state, now } = input;
  // 判定本身只有一份（F298）：把 OneBot 事件压成候选形状，规则交给 reply-policy。
  // 静默时段**不拦回信**：那是「她主动开口」的规则，见 proactive.ts。
  const judgement = decideQqReply({
    candidate: {
      id: inbound.id,
      text: inbound.text,
      atMs: inbound.atMs,
      hasMedia: inbound.images.length > 0 || inbound.voices.length > 0,
      fromPeer: inbound.userId === opts.peer,
      fromSelf: false,
    },
    policy: {
      ignoreOlderThanMs: opts.ignoreOlderThanMs,
      minGapMs: opts.minGapMs,
      maxPerHour: opts.maxPerHour,
    },
    state: state as QqReplyStateView,
    now,
  });
  if (judgement.ok) return { ok: true, detail: "" };
  if (judgement.reason === "empty") {
    return { ok: false, reason: "empty", detail: "没有正文、图片或语音" };
  }
  if (judgement.reason === "not-peer") {
    return {
      ok: false,
      reason: "not-peer",
      detail: `发信人 ${String(inbound.userId)} 不是目标 ${String(opts.peer)}`,
    };
  }
  // 理论上到不了：OneBot 桥已在上游排掉自己发的事件（fromSelf 恒为 false）。
  if (judgement.reason === "echo") return { ok: false, detail: judgement.detail };
  return judgement.reason === undefined
    ? { ok: false, detail: judgement.detail }
    : { ok: false, reason: judgement.reason, detail: judgement.detail };
}

interface Exchange {
  readonly who: "peer" | "her";
  readonly text: string;
}

export class OneBotBridge {
  private state: QQStateRecord;
  private history: Exchange[] = [];
  /**
   * 串行化闸：两条事件几乎同时到达时，若并发处理会同时读到旧的 repliedIds
   * 与 lastReplyAt，双双通过判定然后各回一条。排队最省事。
   */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 组提示词用的历史：共享 store 优先（网页/QQ 同一段），没有就退回本进程内存。
   *
   * 回退不是死代码：宿主侧独立起桥（以及大量测试）不注入 store，行为必须与 F326 前一致。
   */
  private historyForPrompt(): readonly Exchange[] {
    const store = this.deps.history;
    if (store === undefined) return this.history;
    return store.recent(MAX_HISTORY).map((entry) => ({ who: entry.who, text: entry.text }));
  }

  /** 追加一条：本地回退与共享 store 都写；store 的 channel 固定 qq（网页由聊天端点写 web）。 */
  private appendHistory(entry: Exchange, now: number): void {
    this.history.push(entry);
    this.history = this.history.slice(-MAX_HISTORY);
    // 共享流水只是账本：写不进去不能吞掉这一轮已经生成的话（P2 取舍）。
    try {
      this.deps.history?.append({ atMs: now, who: entry.who, text: entry.text, channel: "qq" });
    } catch (err) {
      this.deps.log?.(`[onebot] 共享历史写入失败（不阻断回信）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  constructor(
    private readonly rt: BrainPort,
    private readonly opts: OneBotBridgeOptions,
    private readonly deps: OneBotBridgeDeps,
    state: QQStateRecord = emptyQQState(),
  ) {
    this.state = state;
  }

  status(): {
    readonly mode: "onebot";
    readonly selfId: number | null;
    readonly peer: number;
    readonly peerName: string;
    readonly dryRun: boolean;
    readonly replied: number;
    readonly lastReplyAt: number | null;
    readonly repliesLastHour: number;
    readonly cursorEpochNs: number;
    readonly lastEventAt: number | null;
  } {
    const now = this.deps.now();
    return {
      mode: "onebot",
      selfId: this.opts.selfId ?? null,
      peer: this.opts.peer,
      peerName: this.peerName(),
      dryRun: this.opts.dryRun,
      replied: this.state.repliedIds.length,
      lastReplyAt: this.state.lastReplyAt,
      repliesLastHour: this.state.replyTimes.filter((t) => now - t < HOUR_MS).length,
      cursorEpochNs: this.state.cursorEpochNs,
      lastEventAt: this.state.onebotLastEventAt ?? null,
    };
  }

  /**
   * 她主动开口：没有来消息，只由状态与时间决定（判据与窗口桥共用 proactive.ts）。
   *
   * 和窗口桥 `bridge.ts` 的差别只在**出站**：这里必须显式带 peer（WS 没有会话上下文），
   * 所以 `deps.send` 要用 `{peer, text}`。宿主把它接在窗口通道上——因此线上
   * `qq.enabled=false` 时她照样能说话。
   */
  async proactive(opts?: ProactiveOptions, intent?: ProactiveIntentContext): Promise<QQProactiveResult> {
    const options = opts ?? this.deps.dialogue.defaultProactive;
    const now = this.deps.now();
    const snap = this.rt.snapshot();
    // snapshot() 是给面板/工具用的宽类型（Record<string, unknown>），这里只取需要的四个数
    const s = snap.state as { pressure: number; rumination: number; energy: number; entropy: number; trust: number };
    const mode = String(snap.mode ?? "NORMAL");
    const proactiveAt = this.state.proactiveAt ?? [];
    const todayCount = proactiveAt.filter((t) => now - t < DAY_MS).length;
    // P1 真出口：意向引擎的四否决结论并进状态门（给了 intentGate = 只认四条否决）。
    // 没有 gates 的通道（窗口桥测试）拿不到阈值，就不硬凑——旧行为原样保留。
    const baseGates = this.deps.gates === undefined ? undefined : this.deps.gates();
    const gatesWithIntent =
      baseGates === undefined || intent?.gate === undefined ? baseGates : { ...baseGates, intentGate: intent.gate };
    const decision = this.deps.dialogue.decideProactive({
      now,
      localHour: this.deps.localHour(),
      pressure: s.pressure,
      rumination: s.rumination,
      energy: s.energy,
      entropy: s.entropy,
      lastAt: this.state.lastProactiveAt ?? null,
      todayCount,
      opts: options,
      // 动机层（见 src/psychology/wonder.ts）：分值够高时优先说她在乎的事
      wonder: this.rt.wonder(),
      // v5.4-P1 §4.9 状态门（energy/trust）+ 安全线（trust < SAFE_MIN 只发安全话术）
      trust: s.trust,
      ...(gatesWithIntent === undefined ? {} : { gates: gatesWithIntent }),
    });
    if (!decision.act || decision.topic === undefined) {
      return { acted: false, verdict: decision.verdict, detail: decision.note };
    }

    // 脊髓先于大脑：通道断着，就别再花一次模型调用「想一句必然发不出去的话」。
    if (this.deps.channelDown?.() === true) {
      return {
        acted: false,
        verdict: "send-failed",
        detail: "脊髓熔断中：对外通道未恢复，本次不生成台词",
        topic: decision.topic,
      };
    }

    const peerName = this.peerName();
    // 主动开口也要先「想起点什么」：种子是她这一拍想开口的由头（自述优先，其次话题描述），
    // 不是用户原句——这条路径上根本没有用户原句。召回失败只是「没想起什么」，不影响开口。
    const recallSeed = intent?.note?.line ?? decision.note;
    // task-169 A：主动开口优先用「排除自述来源」的召回；没接这个依赖就退回旧 recall。
    const recalled = (this.deps.recallForProactive ?? this.deps.recall)?.(recallSeed);
    const composed = this.deps.dialogue.composeProactive({
      intent: "proactive",
      persona: this.rt.persona(),
      mode,
      topic: decision.topic,
      peerName,
      localHour: this.deps.localHour(),
      // 只留对方说过的话：把自己的上一句也拼进去，她会顺着自己的话往下续写（首句逐字重复）。
      // 回信路径的 history 语义不动——那是「对话记录」，主动开口这里只需要「他最近说过什么」。
      // P2：有共享 store 时读 store（网页里说过的话也看得到），没有就用本进程内存（旧行为）。
      history: this.historyForPrompt().filter((e) => e.who === "peer").map((e) => `${peerName}：${e.text}`),
      // 2026-11-09（单话题根因）：最近 3 条她自己的话单独当"别再重复"清单，不混进对话 history。
      avoid: this.historyForPrompt().filter((e) => e.who === "her").slice(-3).map((e) => e.text),
      // 召回接在系统提示后面；没有 recall 依赖时不传，旧行为一个字不变。
      ...(recalled === undefined ? {} : { recall: recalled }),
      // P1 真出口：把"这一拍她想说什么"交给 composeDialogue；没有就不传（旧行为一个字不变）
      ...(intent?.note === undefined ? {} : { intentNote: intent.note }),
      // A5 情境自觉：她能看到的事实（几点、他多久没出现、说了几次没回、在不在电脑前）
      ...(intent?.situation === undefined ? {} : { situation: intent.situation }),
    });
    const system = composed.system;
    const prompt = composed.user;

    let raw: string;
    try {
      raw = await this.deps.generate({ system, prompt, task: "proactive" });
    } catch (err) {
      return {
        acted: false,
        verdict: "llm-failed",
        detail: err instanceof Error ? err.message : String(err),
        topic: decision.topic,
      };
    }
    let reply = this.deps.dialogue.cleanReply(raw, 120, this.opts.peer);
    if (reply === "") {
      return { acted: false, verdict: "empty-reply", detail: "生成结果清理后为空", topic: decision.topic };
    }
    // A5：她判断此刻不宜打扰——只回 HOLD。不发送、不记主动次数、不写历史；
    // 意图表那边由装配点记成 held，下一拍她可以重新决定（没有定时器）。
    if (reply.trim().toUpperCase() === PROACTIVE_HOLD_TOKEN) {
      this.deps.log?.("[onebot] 主动开口：她判断此刻不宜打扰（HOLD）");
      return { acted: false, verdict: "held", detail: "她判断此刻不宜打扰", topic: decision.topic };
    }
    // task-169 C：生成侧回声闸门。与最近自身输出太像 → 换一个具体话题重生成一次；
    // 仍像则这次沉默（held/echo-repeat）：不发送、不记主动次数、不写记忆。
    if (this.deps.echoCheck !== undefined) {
      const first = this.deps.echoCheck(reply);
      if (first.hit) {
        this.deps.log?.(
          `[onebot] 回声自检：与近期输出相似（Dice=${first.score.toFixed(2)}），换一句重生成`,
        );
        try {
          raw = await this.deps.generate({ system: `${system}\n${ECHO_RETRY_NOTE}`, prompt, task: "proactive" });
        } catch (err) {
          return {
            acted: false,
            verdict: "llm-failed",
            detail: err instanceof Error ? err.message : String(err),
            topic: decision.topic,
          };
        }
        reply = this.deps.dialogue.cleanReply(raw, 120, this.opts.peer);
        if (reply === "") {
          return { acted: false, verdict: "empty-reply", detail: "生成结果清理后为空", topic: decision.topic };
        }
        if (reply.trim().toUpperCase() === PROACTIVE_HOLD_TOKEN) {
          this.deps.log?.("[onebot] 主动开口：重生成后判断此刻不宜打扰（HOLD）");
          return { acted: false, verdict: "held", detail: "她判断此刻不宜打扰", topic: decision.topic };
        }
        const second = this.deps.echoCheck(reply);
        if (second.hit) {
          this.deps.log?.(
            `[onebot] 回声自检仍命中（Dice=${second.score.toFixed(2)}），本次不开口（echo-repeat）`,
          );
          return { acted: false, verdict: "held", detail: "echo-repeat", topic: decision.topic };
        }
        this.deps.log?.(`[onebot] 回声自检：重生成后通过（Dice=${second.score.toFixed(2)}）`);
      }
    }
    // A 层否决（v5.2 §3）：禁区命中就摘掉那句再外发，而不是原样发出去。
    // F326 方案 A：人格卡已删除，禁区清单默认为空（硬安全边界在协议层/系统规则，不在卡里）；装配点传空清单。
    const veto = this.deps.dialogue.vetoTaboo(reply);
    if (veto.hits.length > 0) {
      this.deps.log?.(`[onebot] 禁忌否决 hits=${veto.hits.join("、")}：已摘句`);
      reply = veto.text;
    }
    if (this.opts.dryRun) {
      this.markProactive(now);
      return {
        acted: false,
        verdict: "dry-run",
        detail: "试运行：没有真的发送",
        topic: decision.topic,
        reply,
        dryRun: true,
      };
    }
    const attach = this.attachImage(reply);
    if (attach.imagePath !== null) this.deps.log?.(`[onebot] 附一张画面：${attach.imagePath}`);
    if (attach.text !== reply) {
      reply = attach.text;
      this.deps.log?.(`[onebot] 没图就不空口承诺：摘掉 ${attach.removed} 句`);
    }
    const sent = await this.deps.send({
      peer: this.opts.peer,
      text: reply,
      ...(attach.imagePath === null ? {} : { imagePath: attach.imagePath }),
    });
    if (!sent.ok) {
      return { acted: false, verdict: "send-failed", detail: sent.detail, topic: decision.topic, reply };
    }
    this.markProactive(now);
    this.appendHistory({ who: "her", text: reply }, now);
    return { acted: true, verdict: "spoke", detail: sent.detail, topic: decision.topic, reply };
  }

  /** 记一次主动开口（滚动 24 小时计数）——与窗口桥同一份状态字段，可互相接续 */
  /**
   * 这一句要不要附一张图。
   *
   * 两个条件都成立才附：①她这句话在说"给你看张图"（判据在大脑，走端口）；
   * ②装配点给了素材来源、且真的能找到一张 24h 内的画面。缺一个就只发文字。
   */
  private imageFor(text: string): string | null {
    if (this.deps.shareImage === undefined) return null;
    if (!this.deps.dialogue.wantsImage(text)) return null;
    try {
      return this.deps.shareImage();
    } catch {
      return null;
    }
  }

  /**
   * 这一句要附哪张图、以及"没图时这句话该长什么样"。
   *
   * 两个出口（主动开口 / 回信）都从这里走，避免两条路径各写一遍：
   *   ①她没在说"给你看图" → 原样发，不附；
   *   ②在说、且找得到 24h 内画面 → 附上，文字不动；
   *   ③在说、但手上没有图 → **摘掉提图的句子**再发（F102：承诺落空比少说一句更糟）。
   * 摘句只摘该摘的，剩下的照发；全摘光会换成一句诚实兜底，不会发空串。
   */
  private attachImage(text: string): { imagePath: string | null; text: string; removed: number } {
    if (!this.deps.dialogue.wantsImage(text)) return { imagePath: null, text, removed: 0 };
    const imagePath = this.imageFor(text);
    if (imagePath !== null) return { imagePath, text, removed: 0 };
    const stripped = this.deps.dialogue.stripImagePromise(text);
    if (stripped.removed.length === 0 || stripped.text === "") {
      return { imagePath: null, text, removed: 0 };
    }
    return { imagePath: null, text: stripped.text, removed: stripped.removed.length };
  }

  private markProactive(now: number): void {
    const proactiveAt = [...(this.state.proactiveAt ?? []), now].slice(-MAX_IDS);
    this.state = { ...this.state, proactiveAt, lastProactiveAt: now };
    this.deps.saveState(this.state);
  }

  /** 一条事件一个回合。永远不 reject：通道那层只负责把事件递进来。 */
  handle(event: OneBotEvent): Promise<OneBotHandleResult> {
    const run = this.tail.then(
      () => this.process(event),
      () => this.process(event),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private peerName(): string {
    const name = (this.opts.peerName ?? "").trim();
    // 纯数字（= QQ 号）不能当称呼：2026-10-30 实测她把 10000001 写进了句首
    if (name === "" || /^\d{5,}$/u.test(name)) return DEFAULT_PEER_NAME;
    return name;
  }

  /** 旁路写一条「对方的话」：同步抛错与异步拒绝都只记日志（同 rememberReply 的语义）。 */
  private rememberInbound(text: string): void {
    const remember = this.deps.rememberInbound;
    if (remember === undefined) return;
    try {
      const result = remember(text);
      if (result instanceof Promise) {
        void result.catch((err: unknown) => {
          this.deps.log?.(
            `[qq] 对方的话写记忆失败（不影响判定）：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      this.deps.log?.(
        `[qq] 对方的话写记忆失败（不影响判定）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async process(event: OneBotEvent): Promise<OneBotHandleResult> {
    // 一个回合一把写锁：只覆盖真正会写状态的路径，转写/判定这类只读步骤不占锁。
    const release = this.deps.beginTurn?.();
    try {
      return await this.processUnlocked(event);
    } finally {
      release?.();
    }
  }

  private async processUnlocked(event: OneBotEvent): Promise<OneBotHandleResult> {
    // 事件来自网络，类型只是约定：运行时仍按字段实有的样子判
    const raw = event as { readonly post_type?: string; readonly message_type?: string };
    if (raw.post_type !== "message") {
      return { acted: false, reason: "not-message", detail: `不是消息事件（${raw.post_type ?? "?"}）` };
    }
    if (raw.message_type !== "private") {
      return { acted: false, reason: "not-private", detail: `不是私聊（${raw.message_type ?? "?"}）` };
    }
    // 测试注入的标记（我自己做端到端验证时用）：只记录，绝不发给真人
    if ((event as { readonly ase_test?: boolean }).ase_test === true) {
      return { acted: false, reason: "test-held", detail: "测试事件：只记录，不发送" };
    }
    if (this.opts.selfId !== undefined && event.self_id !== this.opts.selfId) {
      return { acted: false, reason: "self", detail: "事件不属于本机器人账号" };
    }
    let inbound = toInbound(event);
    if (inbound === null) {
      return { acted: false, reason: "self", detail: "自己发出去的消息" };
    }

    // 语音：先转写再判定。转写失败不算「没内容」——仍按「对方发来一条语音」继续，
    // 让模型诚实说没听清，而不是静默掉线。
    const voiced = inbound.voices.length > 0;
    if (voiced && inbound.text === "") {
      const heard = await this.transcribeFirst(inbound.voices);
      if (heard !== "") inbound = { ...inbound, text: heard };
    }

    const now = this.deps.now();
    const localHour = this.deps.localHour();
    const decision = decideOneBotReply({ inbound, opts: this.opts, state: this.state, now, localHour });
    // 2026-11-09（单话题根因）：被闸门挡下的对方消息也要落库。
    // 回信成功的那一条由 turn() 自己写，不在这里重复写。
    if (!decision.ok && inbound.userId === this.opts.peer && inbound.text.trim() !== "") {
      this.rememberInbound(inbound.text);
    }
    if (!decision.ok) {
      return {
        acted: false,
        reason: decision.reason ?? "empty",
        detail: decision.detail,
        id: inbound.id,
      };
    }

    // 正文为空但有图/有语音：给引擎一句占位，否则 appraisal 会拿到空串
    const spoken =
      inbound.text === "" ? (voiced ? "（对方发来一条语音，没转写出来）" : imageNote(inbound.images.length)) : inbound.text;
    const images = await this.loadImages(inbound.images);
    const unread = [unreadImageNote(inbound.images.length, images.length), voiced ? VOICE_NOTE : ""]
      .filter((t) => t !== "")
      .join(" ");
    if (unread !== "") {
      this.deps.log?.(`[onebot] images ${String(images.length)}/${String(inbound.images.length)} loaded, prompt 已加"别猜图"提示`);
    }

    const { appraisal, eventType, features } = this.deps.appraise(spoken === "" ? "（图片）" : spoken, this.deps.language);
    let turn: TurnText;
    try {
      // 测试/工程消息照常回（那才是要验的链路），但不写进她的记忆——
      // 否则她会真的"记住"我们拿她做自检、或者记住我们在聊方括号和日志。
      const skipMemory =
        this.deps.dialogue.isJunkMemory(spoken === "" ? "（对方发来图片）" : spoken) ||
        this.deps.dialogue.isJunkMemory(inbound.text);
      // §7.4：这一句也是「上一轮话术」的反应证据。能读出来就顺手给 bandit 记分，
      // 读不出来（null）就不传——不要拿猜出来的负分去惩罚一个其实不差的策略。
      const reaction = this.deps.dialogue.inferReaction({
        now,
        lastReplyAt: this.state.lastReplyAt,
        text: spoken,
      });
      const turnRequest: TurnRequest = {
        text: spoken === "" ? "（对方发来图片）" : spoken,
        appraisal,
        language: features,
      };
      const turnOptions: TurnOptions = {
        source: "qq_contact_verified",
        eventType,
        audiencePresent: 0,
        skipMemory,
        ...(reaction === null ? {} : { reaction }),
      };
      // F272：装配点给了 turn 就投给唯一写者，否则退回本进程（测试/常驻进程）。
      turn =
        this.deps.turn === undefined
          ? this.rt.turn(turnRequest, turnOptions)
          : await this.deps.turn(turnRequest, turnOptions);
    } catch (err) {
      return { acted: false, reason: "engine-failed", detail: messageOf(err), id: inbound.id };
    }

    // §2 A26 降级：存储出错的那一轮她也照常开口了，但要让日志能回答"为什么这段记忆没进去"。
    if (turn.degraded !== undefined) {
      this.deps.log?.(`[onebot] 本轮降级（照样回信）：${turn.degraded}`);
    }

    // §7.2 落差：她预期「你这次会怎么对我」，与真实强度差多少。
    // 只在明显偏离（|误差| ≥ 0.15）时记一行——平常的对话不刷日志。
    const exp = turn.expectation;
    if (exp !== undefined && Math.abs(exp.error) >= 0.15) {
      this.deps.log?.(
        `[expect] type=${exp.type} pred=${exp.predicted.toFixed(2)} actual=${exp.actual.toFixed(2)} pe=${exp.error.toFixed(2)} learned=${exp.learned.toFixed(3)}`,
      );
    }

    // 唯一出口：意图 + 素材 → 两段提示词（见 src/dialogue/composer.ts）。
    // 记忆与知识必须进提示词，否则她会用气氛填空（2026-10-29 实测：被问「昨晚学到什么」，
    // 答的是窗台上的花）。召回失败只是「没想起什么」，不影响回信。
    const recalled = this.deps.recall?.(spoken);
    const composed = this.deps.dialogue.composeReply({
      layers: {
        persona: this.rt.persona(),
        mode: turn.mode,
        modeStyle: turn.style.modeStyle,
        stageStyle: turn.style.stageStyle,
        expressionStyle: turn.style.expressionStyle,
        suppressInstruction: turn.style.suppressInstruction,
        eventPermission: turn.eventStyle?.permission ?? null,
        eventAvoid: turn.eventStyle?.avoid ?? null,
      },
      peerName: this.peerName(),
      text: spoken,
      unread,
      history: this.historyForPrompt(),
      ...(recalled === undefined ? {} : { recall: recalled }),
    });
    const system = composed.system;
    const prompt = composed.user;
    // trace id 跟着这行走：日志里看到一句不顺的话，拿它去 tools/trace/query.mjs 就能反查
    this.deps.log?.(
      `[compose] intent=${composed.intent} m=${composed.recall.memories} k=${composed.recall.knowledge} trace=${turn.traceId ?? "-"}`,
    );

    // 脊髓先于大脑（B.2）：通道断着就别再花一次模型调用「想一句必然发不出去的话」。
    // 主动开口早就这样做了；反应式这条路径以前是「先生成、出站才拦」，白烧一次调用。
    if (this.deps.channelDown?.() === true) {
      return {
        acted: false,
        reason: "spine-down",
        detail: "脊髓熔断中：对外通道未恢复，本次不生成回复",
        id: inbound.id,
        mode: turn.mode,
      };
    }

    let rawReply: string;
    try {
      rawReply = await this.deps.generate({
        system,
        prompt,
        task: "chat",
        ...(images.length === 0 ? {} : { images }),
      });
    } catch (err) {
      return { acted: false, reason: "llm-failed", detail: messageOf(err), id: inbound.id };
    }

    let reply = this.deps.dialogue.cleanReply(rawReply, 160, this.opts.peer);
    if (reply === "") {
      this.commit(inbound, now, null);
      return { acted: false, reason: "empty-reply", detail: "生成结果清理后为空", id: inbound.id, mode: turn.mode };
    }
    // A 层否决（v5.2 §3）：禁区命中就摘掉那句再外发，而不是原样发出去。
    // F326 方案 A：人格卡已删除，禁区清单默认为空（硬安全边界在协议层/系统规则，不在卡里）；装配点传空清单。
    const veto = this.deps.dialogue.vetoTaboo(reply);
    if (veto.hits.length > 0) {
      this.deps.log?.(`[onebot] 禁忌否决 hits=${veto.hits.join("、")}：已摘句`);
      reply = veto.text;
    }

    if (this.opts.dryRun) {
      this.commit(inbound, now, null);
      return {
        acted: false,
        reason: "dry-run",
        detail: "试运行：没有真的发送",
        id: inbound.id,
        reply,
        dryRun: true,
        mode: turn.mode,
        stage: turn.stage,
      };
    }

    // 自检注入的消息：生成是有效的（证明判定→生成这段没坏），但回复**不发**、也不进对话历史。
    // 2026-10-29 实测：自检每跑一次就往他 QQ 里发一句「在呀…」，同一句话被回答两遍，
    // 看起来像她在回应很久以前的话。要给真发留后门时用自检脚本的 --deliver。
    if (this.deps.dialogue.isSelfCheck(inbound.text) || this.deps.dialogue.isSelfCheck(spoken)) {
      this.recordOnly(inbound, now);
      this.deps.log?.(`[onebot] selfcheck held: ${reply}`);
      return {
        acted: false,
        reason: "selfcheck-held",
        detail: "自检消息：只验证生成，不发送、不写历史",
        id: inbound.id,
        reply,
        mode: turn.mode,
        stage: turn.stage,
      };
    }

    let sent: { readonly ok: boolean; readonly detail: string };
    const attach = this.attachImage(reply);
    if (attach.imagePath !== null) this.deps.log?.(`[onebot] 附一张画面：${attach.imagePath}`);
    if (attach.text !== reply) {
      reply = attach.text;
      this.deps.log?.(`[onebot] 没图就不空口承诺：摘掉 ${attach.removed} 句`);
    }
    // 对方发语音就回语音（镜像），这样"嘴巴"和"耳朵"用同一条链路；
    // 合成失败绝不能让这条消息丢——降级成文字，并把原因写进日志。
    const voiceMode = voiced && this.deps.sendVoice !== undefined;
    try {
      if (voiceMode) {
        // 合成/发送抛错都要降级：这里不能让它冒到外层，否则整条回复按 send-failed 丢掉
        let spokenOut: { readonly ok: boolean; readonly detail: string } | null = null;
        try {
          spokenOut = await this.deps.sendVoice!({ peer: this.opts.peer, text: reply });
        } catch (err) {
          this.deps.log?.(`[onebot] voice send failed: ${messageOf(err)}；降级文字`);
        }
        if (spokenOut?.ok === true) sent = spokenOut;
        else {
          if (spokenOut !== null) this.deps.log?.(`[onebot] voice send failed: ${spokenOut.detail}；降级文字`);
          sent = await this.deps.send({
            peer: this.opts.peer,
            text: reply,
            ...(attach.imagePath === null ? {} : { imagePath: attach.imagePath }),
          });
        }
      } else {
        sent = await this.deps.send({
          peer: this.opts.peer,
          text: reply,
          ...(attach.imagePath === null ? {} : { imagePath: attach.imagePath }),
        });
      }
    } catch (err) {
      // 发送抛错和返回 ok=false 同义：都**不**记账，下一轮还能重试这条
      return { acted: false, reason: "send-failed", detail: messageOf(err), id: inbound.id, reply, mode: turn.mode };
    }
    if (!sent.ok) {
      return { acted: false, reason: "send-failed", detail: sent.detail, id: inbound.id, reply, mode: turn.mode };
    }

    this.commit(inbound, now, reply);
    this.notifyReply(reply);
    this.notifyTimeClaims(reply);
    // §10.4：真发出去了才记「她讲了哪条知识」——没发出去的那句没进对话，不该有任何反馈。
    // 结算在下一轮：她/对方下一句的反应决定这条知识还算不算新鲜。
    if (recalled !== undefined) {
      const used = this.deps.dialogue.usedKnowledge(reply, recalled);
      for (const id of used) this.rt.noteKnowledgeUsed?.(id);
      if (used.length > 0) this.deps.log?.(`[onebot] 用到了知识 ${used.join(",")}（等下一句反应定新鲜度）`);
    }
    return {
      acted: true,
      reason: "replied",
      detail: sent.detail,
      id: inbound.id,
      reply,
      mode: turn.mode,
      stage: turn.stage,
    };
  }

  /** 语音转写：只取第一条；失败/未接线就返回空串（调用方会继续走「没听清」路径） */
  private async transcribeFirst(refs: readonly InboundVoice[]): Promise<string> {
    const first = refs[0];
    const transcribe = this.deps.transcribeVoice;
    if (first === undefined || transcribe === undefined) return "";
    try {
      const text = await transcribe(first);
      this.deps.log?.(`[onebot] voice ok: ${String(refs.length)} 条语音，转写 ${String(text.length)} 字`);
      return text;
    } catch (err) {
      this.deps.log?.(`[onebot] voice failed: ${messageOf(err)}`);
      return "";
    }
  }

  /** 读图不是错误路径：单张失败/超大就降级成「对方发了图但没读到」 */
  private async loadImages(refs: readonly InboundImage[]): Promise<QQImageBytes[]> {
    const readImage = this.deps.readImage;
    if (refs.length === 0 || readImage === undefined) return [];
    const out: QQImageBytes[] = [];
    for (const ref of refs.slice(0, MAX_IMAGES)) {
      try {
        const bytes = await readImage(ref);
        if (bytes !== null && bytes.data.byteLength > 0 && bytes.data.byteLength <= MAX_IMAGE_BYTES) {
          out.push(bytes);
        }
      } catch (err) {
        this.deps.log?.(`[onebot] 读图失败：${messageOf(err)}`);
      }
    }
    return out;
  }

  /**
   * 记账并落盘。`reply === null` 表示「没真发」（试运行/空回复）：
   * 仍然记 id（防重复处理），但不写 lastReplyAt/replyTimes（那不是一次真回帖）。
   */
  private commit(inbound: OneBotInbound, now: number, reply: string | null): void {
    this.state = {
      ...this.state,
      repliedIds: [...this.state.repliedIds, inbound.id].slice(-MAX_IDS),
      replyTimes: reply === null ? this.state.replyTimes : [...this.state.replyTimes, now].slice(-MAX_IDS),
      cursorEpochNs: Math.max(this.state.cursorEpochNs, inbound.atMs * 1_000_000),
      lastReplyAt: reply === null ? this.state.lastReplyAt : now,
      onebotLastEventAt: inbound.atMs > 0 ? inbound.atMs : now,
    };
    this.appendHistory(
      { who: "peer", text: inbound.text === "" ? imageNote(inbound.images.length) : inbound.text },
      now,
    );
    if (reply !== null) this.appendHistory({ who: "her", text: reply }, now);
    this.deps.saveState(this.state);
  }

  /**
   * P0-F：回信记忆旁路。唯一调用点在 `commit(...)` 之后，因此
   * send-failed / dryRun / selfcheck-held / 空回复 / 重复都不会走到这里。
   *
   * 同步实现优先；若回调返回 Promise，桥负责 `.catch` 兜底（不产生 unhandled），
   * 调用点不 await、不阻塞回复。
   */
  private notifyReply(reply: string): void {
    const cb = this.deps.rememberReply;
    if (cb === undefined) return;
    try {
      const ret = cb(reply);
      if (ret instanceof Promise) {
        void ret.catch((err: unknown) => this.deps.log?.(`[onebot] 回信记忆写入失败：${messageOf(err)}`));
      }
    } catch (err) {
      this.deps.log?.(`[onebot] 回信记忆写入失败：${messageOf(err)}`);
    }
  }

  /**
   * S3b（M5）：回信成功后的时间一致性旁路。唯一调用点在回信分支的 `commit(...)` 之后；
   * 主动开口不走这里（由主进程在发送成功后自己记，避免重复计数）。
   * 失败只记日志：同步 catch；返回 Promise 则桥负责 `.catch`（不 await）。
   */
  private notifyTimeClaims(reply: string): void {
    const cb = this.deps.recordTimeClaims;
    if (cb === undefined) return;
    try {
      const ret = cb(reply);
      if (ret instanceof Promise) {
        void ret.catch((err: unknown) => this.deps.log?.(`[onebot] 时间一致性日志写入失败：${messageOf(err)}`));
      }
    } catch (err) {
      this.deps.log?.(`[onebot] 时间一致性日志写入失败：${messageOf(err)}`);
    }
  }

  /** 自检消息只「记 id 防重复」，不写历史（否则她会把测试当成真的聊过） */
  private recordOnly(inbound: OneBotInbound, now: number): void {
    this.state = {
      ...this.state,
      repliedIds: [...this.state.repliedIds, inbound.id].slice(-MAX_IDS),
      cursorEpochNs: Math.max(this.state.cursorEpochNs, inbound.atMs * 1_000_000),
      onebotLastEventAt: inbound.atMs > 0 ? inbound.atMs : now,
    };
    this.deps.saveState(this.state);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
