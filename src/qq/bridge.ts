/**
 * QQ 桥：一条消息从「inbox 里的 JSON」到「发出去的一句台词」的完整回合。
 *
 * 与外部世界的所有接触都收在 `QQDeps` 里（读 inbox / 存状态 / 生成台词 / 发送），
 * 所以这个类是纯逻辑，测试用假 deps 就能覆盖全部规则，不需要开 QQ。
 *
 * 刻意不做的事：
 * - **不重写通道**：鼠标键盘、剪贴板、去重、游标都还是 `qq-ops` 那套；
 *   这里只消费它已经落盘的 `bus/inbox/*.json`。
 * - **不把生成放在 turn 之前**：先 `rt.turn()` 推状态拿到"怎么说"，
 *   再用同一份状态写台词——否则台词会和刚推完的状态对不上。
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
import { imageNote, parseInbound, unreadImageNote, type InboundImage } from "./inbound.js";
import { decideReply } from "./filter.js";
import { emptyQQState, type InboxMessage, type QQOptions, type QQStateRecord } from "./types.js";

export interface QQSendResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface QQDeps {
  /** 墙钟毫秒 */
  now(): number;
  /** 本地小时 0..23（本模块不碰 Date，与 clock.ts 的约定一致） */
  localHour(): number;
  /**
   * 可选：读之前先"敲一下"通道（qqbus wait 会去抓一次新消息并落盘）。
   * 不实现时桥只消费别人已经落盘的消息——测试就属于这种情况。
   */
  wake?(): Promise<void>;
  /**
   * 一句话 → appraisal / 语言特征 / 事件类型（F297：判断在大脑层，装配点注入）。
   * 桥只负责传输与会话，不自己决定"这句话算不算冒犯"。
   */
  appraise: QqAppraiseFn;
  readInbox(): readonly InboxMessage[];
  saveState(state: QQStateRecord): void;
  /**
   * 可选：把本地图片读成字节。宿主实现会顺手做媒体类型判断。
   * 不实现时，图片只以「对方发来一张图片」的文字形式进提示词。
   */
  readImage?(path: string): Promise<QQImageBytes | null>;
  generate(input: {
    readonly system: string;
    readonly prompt: string;
    readonly images?: readonly QQImageBytes[];
    /** F353 B1：主动开口与回信共用 generate，必须显式区分，模型档位才落得到 flash/pro */
    readonly task?: "chat" | "proactive";
  }): Promise<string>;
  /** 可选：按对方这句话召回「她记得的事 / 最近看到的东西」，接在系统提示后面 */
  recall?(text: string): DialogueRecall;
  /**
   * 可选：把「一个回合」交给装配点执行（F272）。
   *
   * 插件进程不该自己写状态（单写者）：宿主侧会把它投给自主进程的写通道，
   * 由唯一写者执行后再把结果拿回来。**不实现时退回本进程 `rt.turn(...)`**——
   * 常驻进程与测试就是这种情形。
   */
  turn?(req: TurnRequest, opts?: TurnOptions): TurnText | Promise<TurnText>;
  /**
   * 「嘴」：组提示词 / 清输出 / 判该不该主动开口。
   *
   * 这几件事的实现都在大脑层（`dialogue/*`），工具层不许 import 实现（R3），
   * 所以由装配点把 `createDialoguePort()` 的结果塞进来；测试给个假的也能跑。
   */
  dialogue: DialoguePort;
  /**
   * 语言特征提取（语言特征供 appraisal 用）。同样是大脑实现，由装配点注入。
   */
  language: LanguagePort;
  send(text: string): Promise<QQSendResult>;
  /**
   * 可选：发图片 / 文件。不实现时 `soul_qq_send` 只能发文字。
   * 与 `send` 分开，是因为它们走不同的剪贴板通道（文本文件 / 位图 / 文件列表）。
   */
  sendContent?(target: { readonly kind: "text" | "image" | "file"; readonly payload: string }): Promise<QQSendResult>;
  /**
   * 可选（P0-F）：回信**真的发出去之后**的回调，用来把这句话写进记忆。
   *
   * 插件 host 注入 `runtime.remember`。旁路：同步抛错或异步拒绝都只记日志，不影响已发出的回复。
   * 主动开口路径不挂这个回调（主动开口的记忆由 daemon 写 `spokenMemorySeed`，避免双写）。
   */
  rememberReply?(reply: string): unknown;
  log?(line: string): void;
}

/** 一张已读进内存的图片（宿主侧负责判类型与大小） */
export interface QQImageBytes {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

export interface QQProactiveResult {
  readonly acted: boolean;
  readonly verdict: string;
  readonly detail: string;
  readonly topic?: string;
  readonly reply?: string;
  readonly dryRun?: boolean;
}

export type QQReason =
  | "idle"
  | "skipped"
  | "empty-reply"
  | "send-failed"
  | "replied"
  | "dry-run"
  | (string & {});

export interface QQPollResult {
  readonly acted: boolean;
  readonly reason: QQReason;
  readonly detail: string;
  readonly message?: InboxMessage;
  readonly reply?: string;
  readonly dryRun?: boolean;
  readonly mode?: string;
  readonly stage?: string | null;
}

interface Exchange {
  readonly who: "peer" | "her";
  readonly text: string;
}

const MAX_IDS = 200;
const MAX_HISTORY = 12;

export class QQBridge {
  private state: QQStateRecord;
  private history: Exchange[] = [];

  constructor(
    private readonly rt: BrainPort,
    private readonly opts: QQOptions,
    private readonly deps: QQDeps,
    state: QQStateRecord = emptyQQState(),
  ) {
    this.state = state;
  }

  /** 只读快照：工具与日志都走这里，避免外部改到内部状态 */
  status(): {
    readonly ready: boolean;
    readonly dryRun: boolean;
    readonly peer: string;
    readonly replied: number;
    readonly lastReplyAt: number | null;
    readonly cursorEpochNs: number;
    readonly repliesLastHour: number;
  } {
    const now = this.deps.now();
    return {
      ready: true,
      dryRun: this.opts.dryRun,
      peer: this.opts.peer,
      replied: this.state.repliedIds.length,
      lastReplyAt: this.state.lastReplyAt,
      cursorEpochNs: this.state.cursorEpochNs,
      repliesLastHour: this.state.replyTimes.filter((t) => now - t < 3_600_000).length,
    };
  }

  /** 一个回合。返回 acted=false 时 `reason` 说明为什么没回。 */
  async poll(): Promise<QQPollResult> {
    // 先让通道抓一次（宿主实现里是 `qqbus.sh wait 1 6`）：否则 inbox 只在
    // 别的会话主动 wait 时才会更新，桥自己会一直"没消息"。
    try {
      await this.deps.wake?.();
    } catch {
      // 抓取失败不算这一轮失败：下面仍然读现有 inbox
    }
    const msgs = [...this.deps.readInbox()].sort((a, b) => a.epochNs - b.epochNs);
    const pending = msgs.filter((m) => m.epochNs > this.state.cursorEpochNs);
    if (pending.length === 0) {
      return { acted: false, reason: "idle", detail: "没有新消息" };
    }

    const now = this.deps.now();
    const localHour = this.deps.localHour();

    // 从最新往前找第一条可回的：连着发来几条时，只回最后一条，避免刷屏
    let chosen: InboxMessage | null = null;
    let firstSkip = "";
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const msg = pending[i];
      if (msg === undefined) continue;
      const d = decideReply({ msg, opts: this.opts, state: this.state, now, localHour });
      if (d.ok) {
        chosen = msg;
        break;
      }
      if (firstSkip === "") firstSkip = `${d.reason}: ${d.detail}`;
    }

    const cursor = pending[pending.length - 1]?.epochNs ?? this.state.cursorEpochNs;

    if (chosen === null) {
      // 全部不可回：把游标推过去，否则同一批消息会被反复判定
      this.state = { ...this.state, cursorEpochNs: cursor };
      this.deps.saveState(this.state);
      return { acted: false, reason: "skipped", detail: firstSkip === "" ? "没有可回消息" : firstSkip };
    }

    // 正文里可能夹着 `[图片 name] <file:///…>`：把路径抽出来，正文只留人话。
    const inbound = parseInbound(chosen.text);
    const text = inbound.text === "" ? imageNote(inbound.images.length) : inbound.text;
    const images = await this.readImages(inbound.images);
    // 有图片标记却读不到字节时，必须告诉模型"别猜"——否则它会照着文件名编内容。
    const unread = unreadImageNote(inbound.images.length, images.length);
    if (unread !== "") {
      this.deps.log?.(`[qq] images ${images.length}/${inbound.images.length} loaded, prompt 已加"别猜图"提示`);
    }

    const { appraisal, eventType, features } = this.deps.appraise(text === "" ? "（图片）" : text, this.deps.language);
    const turnRequest: TurnRequest = {
      text: text === "" ? "（对方发来图片）" : text,
      appraisal,
      language: features,
    };
    const turnOptions: TurnOptions = { source: "qq_contact_verified", eventType, audiencePresent: 0 };
    let turn: TurnText;
    try {
      // F272：装配点给了 turn 就投给唯一写者，否则退回本进程（测试/常驻进程）。
      turn =
        this.deps.turn === undefined
          ? this.rt.turn(turnRequest, turnOptions)
          : await this.deps.turn(turnRequest, turnOptions);
    } catch (err) {
      return {
        acted: false,
        reason: "engine-failed",
        detail: err instanceof Error ? err.message : String(err),
        message: chosen,
      };
    }

    const recallText = text === "" ? imageNote(inbound.images.length) : text;
    const recalled = this.deps.recall?.(recallText);
    // 唯一出口（见 src/dialogue/composer.ts）：桥只提供素材，不再自己拼系统提示。
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
      peerName: this.opts.peer,
      text: recallText,
      unread,
      history: this.history,
      ...(recalled === undefined ? {} : { recall: recalled }),
    });
    const system = composed.system;
    const prompt = composed.user;
    this.deps.log?.(`[compose] intent=${composed.intent} m=${composed.recall.memories} k=${composed.recall.knowledge}`);

    let raw: string;
    try {
      raw = await this.deps.generate({
        system,
        prompt,
        task: "chat",
        ...(images.length === 0 ? {} : { images }),
      });
    } catch (err) {
      return {
        acted: false,
        reason: "llm-failed",
        detail: err instanceof Error ? err.message : String(err),
        message: chosen,
      };
    }

    let reply = this.deps.dialogue.cleanReply(raw);
    if (reply === "") {
      this.commit(chosen, cursor, now, null);
      return { acted: false, reason: "empty-reply", detail: "生成结果清理后为空", message: chosen, mode: turn.mode };
    }
    // A 层否决（v5.2 §3）：禁区命中就摘掉那句再外发，而不是原样发出去。
    // F326 方案 A：人格卡已删除，禁区清单默认为空（硬安全边界在协议层/系统规则，不在卡里）；装配点传空清单。
    const veto = this.deps.dialogue.vetoTaboo(reply);
    if (veto.hits.length > 0) {
      this.deps.log?.(`[qq] 禁忌否决 hits=${veto.hits.join("、")}：已摘句`);
      reply = veto.text;
    }

    if (this.opts.dryRun) {
      this.commit(chosen, cursor, now, null);
      return {
        acted: false,
        reason: "dry-run",
        detail: "试运行：没有真的发送",
        message: chosen,
        reply,
        dryRun: true,
        mode: turn.mode,
        stage: turn.stage,
      };
    }

    // 自检注入：生成有效，但不发送、不进历史（2026-10-29：自检曾往他 QQ 里连发好几条「在呀」）
    if (this.deps.dialogue.isSelfCheck(chosen.text)) {
      this.recordOnly(chosen, cursor, now);
      this.deps.log?.("[qq] selfcheck held: " + reply);
      return { acted: false, reason: "selfcheck-held", detail: "自检消息：只验证生成，不发送、不写历史", message: chosen, reply, mode: turn.mode, stage: turn.stage };
    }

    const sent = await this.deps.send(reply);
    if (!sent.ok) {
      // 发送失败**不**推进游标：下一轮还能重试这条
      return { acted: false, reason: "send-failed", detail: sent.detail, message: chosen, reply, mode: turn.mode };
    }

    this.commit(chosen, cursor, now, reply);
    this.notifyReply(reply);
    return {
      acted: true,
      reason: "replied",
      detail: sent.detail,
      message: chosen,
      reply,
      mode: turn.mode,
      stage: turn.stage,
    };
  }

  /**
   * 把消息里的图片真读进来。读不到不是错误：降级成纯文字（模型仍知道"对方发了图"）。
   * 最多 3 张、单张 8MB 上限——QQ 截图动辄几 MB，全塞进去会把一轮对话拖死。
   */
  private async readImages(refs: readonly InboundImage[]): Promise<QQImageBytes[]> {
    if (refs.length === 0 || this.deps.readImage === undefined) return [];
    const out: QQImageBytes[] = [];
    for (const ref of refs.slice(0, 3)) {
      try {
        const bytes = await this.deps.readImage(ref.path);
        if (bytes !== null && bytes.data.byteLength <= 8 * 1024 * 1024) out.push(bytes);
      } catch {
        // 单个图片读失败不影响这条消息
      }
    }
    return out;
  }

  /** 发一条媒体（图片/文件）。通道没提供能力时明确失败，不假装成功。 */
  async sendContent(target: {
    readonly kind: "text" | "image" | "file";
    readonly payload: string;
  }): Promise<QQSendResult> {
    if (this.deps.sendContent === undefined) {
      return { ok: false, detail: "当前通道没有提供发图片/文件的能力" };
    }
    return this.deps.sendContent(target);
  }

  /**
   * 她主动开口：由状态与时间决定，不依赖有人发消息。
   *
   * 和 `poll()` 的区别是**没有来消息**——所以不推 `turn()`，也不能用那一轮的
   * 关系阶段/事件许可；只保留人格卡与当前模式。台词仍交给同一个 LLM。
   */
  async proactive(opts?: ProactiveOptions, intent?: ProactiveIntentContext): Promise<QQProactiveResult> {
    const options = opts ?? this.deps.dialogue.defaultProactive;
    const now = this.deps.now();
    const snap = this.rt.snapshot();
    // snapshot() 是给面板/工具用的宽类型（Record<string, unknown>），这里只取需要的四个数
    const s = snap.state as { pressure: number; rumination: number; energy: number; entropy: number };
    const mode = String(snap.mode ?? "NORMAL");
    const proactiveAt = this.state.proactiveAt ?? [];
    const todayCount = proactiveAt.filter((t) => now - t < 86_400_000).length;
    // 窗口桥这条路上没有 runtime 的状态门（gates），所以 intent.gate 这里不参与判定——
    // 它只用于线上 OneBot 路径；note 仍然生效（自述本来就是措辞素材）。
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
      // 动机层（见 src/psychology/wonder.ts）：分值够高时优先说她在乎的事，
      // 而不是又被自己的压力/疲惫推着开口
      wonder: this.rt.wonder(),
    });
    if (!decision.act || decision.topic === undefined) {
      return { acted: false, verdict: decision.verdict, detail: decision.note };
    }

    // 主动开口也要先「想起点什么」：种子是她这一拍想开口的由头（自述优先，其次话题描述），
    // 不是用户原句——这条路径上根本没有用户原句。召回失败只是「没想起什么」，不影响开口。
    const recallSeed = intent?.note?.line ?? decision.note;
    const recalled = this.deps.recall?.(recallSeed);
    const composed = this.deps.dialogue.composeProactive({
      intent: "proactive",
      persona: this.rt.persona(),
      mode,
      topic: decision.topic,
      peerName: this.opts.peer,
      localHour: this.deps.localHour(),
      // 只留对方说过的话会让她看不见自己刚说过什么：连续几次挑同一个话题
      // （2026-11-09 实测：五条主动消息都在说"睡了四个钟头"）。这里把最近 3 条她自己的话
      // 也带上并标注清楚——prompt 里本来就有"供你避免重复"这一行，模型需要素材才用得上。
      history: [
        ...this.history.filter((e) => e.who === "peer").map((e) => `${this.opts.peer}：${e.text}`),
        ...this.history
          .filter((e) => e.who === "her")
          .slice(-3)
          .map((e) => `你自己最近说过（不要重复这些内容）：${e.text}`),
      ],
      // 召回接在系统提示后面；没有 recall 依赖时不传，旧行为一个字不变。
      ...(recalled === undefined ? {} : { recall: recalled }),
      // P1 真出口：意向引擎的自述（没有就不传，旧行为一个字不变）
      ...(intent?.note === undefined ? {} : { intentNote: intent.note }),
      // A5 情境自觉（与 OneBot 桥同一份处境；窗口通道没有 runtime gates，但 HOLD 仍然适用）
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
    let reply = this.deps.dialogue.cleanReply(raw, 120);
    if (reply === "") {
      return { acted: false, verdict: "empty-reply", detail: "生成结果清理后为空", topic: decision.topic };
    }
    // A5：与 OneBot 桥同一个"先不说"协议（字面量保持一致，测试锁 composer 的同一 token）。
    if (reply.trim().toUpperCase() === "HOLD") {
      this.deps.log?.("[qq] 主动开口：她判断此刻不宜打扰（HOLD）");
      return { acted: false, verdict: "held", detail: "她判断此刻不宜打扰", topic: decision.topic };
    }
    // A 层否决（v5.2 §3）：禁区命中就摘掉那句再外发，而不是原样发出去。
    // F326 方案 A：人格卡已删除，禁区清单默认为空（硬安全边界在协议层/系统规则，不在卡里）；装配点传空清单。
    const veto = this.deps.dialogue.vetoTaboo(reply);
    if (veto.hits.length > 0) {
      this.deps.log?.(`[qq] 禁忌否决 hits=${veto.hits.join("、")}：已摘句`);
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
    const sent = await this.deps.send(reply);
    if (!sent.ok) {
      return { acted: false, verdict: "send-failed", detail: sent.detail, topic: decision.topic, reply };
    }
    this.markProactive(now);
    this.history.push({ who: "her", text: reply });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    return { acted: true, verdict: "spoke", detail: sent.detail, topic: decision.topic, reply };
  }

  private markProactive(now: number): void {
    const proactiveAt = [...(this.state.proactiveAt ?? []), now].slice(-MAX_IDS);
    this.state = { ...this.state, proactiveAt, lastProactiveAt: now };
    this.deps.saveState(this.state);
  }

  private commit(msg: InboxMessage, cursor: number, now: number, reply: string | null): void {
    const repliedIds = [...this.state.repliedIds, msg.id].slice(-MAX_IDS);
    const replyTimes = reply === null ? this.state.replyTimes : [...this.state.replyTimes, now].slice(-MAX_IDS);
    this.state = {
      cursorEpochNs: Math.max(cursor, msg.epochNs),
      repliedIds,
      replyTimes,
      lastReplyAt: reply === null ? this.state.lastReplyAt : now,
    };
    this.deps.saveState(this.state);

    this.history.push({ who: "peer", text: msg.text });
    if (reply !== null) this.history.push({ who: "her", text: reply });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }

  /**
   * P0-F：回信记忆旁路。唯一调用点在回信路径 `commit(...)` 之后，
   * 主动开口路径不调用（daemon 的 spokenMemorySeed 负责，避免双写）。
   *
   * 同步实现优先；回调返回 Promise 时桥负责 `.catch` 兜底，调用点不 await。
   */
  private notifyReply(reply: string): void {
    const cb = this.deps.rememberReply;
    if (cb === undefined) return;
    try {
      const ret = cb(reply);
      if (ret instanceof Promise) {
        void ret.catch((err: unknown) => {
          this.deps.log?.(`[qq] 回信记忆写入失败：${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      this.deps.log?.(`[qq] 回信记忆写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 自检消息：记游标与 id 防重复，但不写历史、不记回复 */
  private recordOnly(msg: InboxMessage, cursor: number, _now: number): void {
    this.state = {
      cursorEpochNs: Math.max(cursor, msg.epochNs),
      repliedIds: [...this.state.repliedIds, msg.id].slice(-MAX_IDS),
      replyTimes: this.state.replyTimes,
      lastReplyAt: this.state.lastReplyAt,
    };
    this.deps.saveState(this.state);
  }
}
