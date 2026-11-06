/**
 * 常驻自主进程侧的 QQ 接待（"桥全权移交"）。
 *
 * 为什么要有这个文件：`docs/OPERATIONS.md` 的目标是「她是独立个体，DSH 插件只作观察/桥接端口」。
 * 在那之前，OneBot 桥一直挂在宿主插件里——宿主一关，她就不接消息；宿主开着，写权还在宿主手上。
 * 这里把「收消息 → 判该不该回 → 调大脑 → 出站 → 落状态」整套搬进她的进程：
 *
 * - 收：`startWsRelay` 起 ws-relay 子进程（与宿主同一份脚本，单实例守卫会保证只有一个在跑）；
 * - 出：走 OneBot HTTP `send_private_msg`（可查询，at-most-once 有据可查），不走宿主窗口；
 * - 模型：`chatComplete`（DPAPI/env 凭据），与自主进程的学习/自言自语同一套；
 * - 状态：`saveQQState` 写 data/qq-<character>.json，她是唯一写者；
 * - 写锁：启动就持有（`holdWriterLock`），宿主因此只读——权限关系由"谁持锁"表达，而不是靠约定。
 *
 * 明确不做：图片理解（宿主侧的附件读取是 DSH 能力）、窗口通道发送（那需要桌面输入桥）。
 * 对方只发图片时退回「对方发来一张图片」，不猜内容——这比装作看懂了更诚实。
 */

import { join } from "node:path";

import { ExecutionGateway } from "../execution/gateway.js";
import { makeAdapter } from "../execution/adapters.js";
import { chatComplete, type LlmConfig, formatUsageLog } from "./llm.js";
import { loadQQState, saveQQState } from "../qq/host.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../qq/onebot-bridge.js";
import { appraiseFromText } from "../psychology/appraisal-qq.js";
import { sendPrivateText, type OneBotSendDeps } from "../qq/onebot.js";
import { formatRecallHitLog, recallForDialogue, type DialogueRecall, type RecallFilterOptions } from "../dialogue/recall.js";
import { SELF_AUTHORED_SOURCES } from "../memory/echo-sources.js";
import { chatReplyMemorySeed } from "../orchestrator/intent/close-loop.js";
import {
  buildSpeakSnapshot,
  compareTimeClaims,
  extractTimeClaims,
  formatSpeakLog,
} from "../orchestrator/intent/speak-metrics.js";
import { describeWorkingSelfAlarm, workingSelfValuesFrom } from "../orchestrator/intent/working-self-recall.js";
import {
  advanceWorkingSelfState,
  readWorkingSelfState,
  workingSelfStatePathInDataDir,
  writeWorkingSelfState,
} from "../orchestrator/intent/working-self-streak.js";
import { OWNER_VISITOR } from "../ports/visitor.js";
import { createDialoguePort, createLanguagePort } from "../dialogue/port-adapter.js";
import { startWsRelay, type RelayHandle } from "../qq/wsrelay.js";
import { acquireWriterLock, readWriterLock, releaseWriterLock, type WriterLock } from "./lock.js";
import { recordUsageOnce } from "./usage.js";
import { createSpineGate, speakVoiceThroughSpine } from "./spine.js";
import { writeSpineSnapshotFile } from "./spine-file.js";
import type { BrainPort, KnowledgeReader } from "../ports/index.js";
import type { ChatHistoryStore } from "../ports/chat-history.js";

export interface AutonomyQqInput {
  readonly runtime: BrainPort & KnowledgeReader;
  readonly llm: LlmConfig | null;
  /**
   * 可选（P2）：与网页聊天共享的对话历史。
   *
   * 给了就注入桥（回信/主动开口都读同一段，收发追加到同一个文件）；
   * 不给 = 旧行为（桥内内存记录）。装配入口 `main.mjs` 会在两个通道都建好后传同一个实例。
   */
  readonly historyStore?: ChatHistoryStore;
  readonly dataDir: string;
  readonly characterId: string;
  readonly repoRoot: string;
  readonly onebot: {
    readonly baseUrl: string;
    readonly wsUrl: string;
    readonly token: string;
    readonly wsToken: string;
    readonly peer: number;
    readonly peerName?: string;
    readonly dryRun: boolean;
  };
  readonly quietFrom: number;
  readonly quietTo: number;
  readonly minGapMs: number;
  readonly maxPerHour: number;
  /** 出站发送（测试注入用；缺省走 OneBot HTTP） */
  readonly sendImpl?: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>;
  /** 出站发图（装配点注入；不接就只是发不了图，文字照发） */
  readonly sendImageImpl?: (peer: number, imagePath: string) => Promise<{ ok: boolean; detail: string }>;
  /**
   * 出站发语音（装配点注入：合成 + 发 record 都在那里，qq-runner 只经执行层要一次）。
   * 不接就退化成纯文字——她仍然能听（转写），只是不用声音回。
   */
  readonly sendVoiceImpl?: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>;
  /** 语音转写（装配点注入；不接就把语音当成"没听清"） */
  readonly transcribeVoiceImpl?: (ref: { readonly name: string; readonly path: string }) => Promise<string>;
  /**
   * 她手上有没有一张能递出去的画面（装配点给：从 data/frames 里挑 24h 内最新那张）。
   * 只有她这句话在说「给你看图」时才会被调用。
   */
  readonly shareImage?: () => string | null;
  /** 脊髓快照落盘路径（装配点给 `data/spine-<id>.json`；不给就只在内存里，不落盘） */
  readonly spinePath?: string;
  /**
   * task-169 C：生成侧回声自检（装配点注入，见 main.mjs）。
   *
   * 桥在「换个话题重生成」之前问它一次：{hit:true} 表示这句话与最近自身输出太像。
   * 不传 = 旧行为（不闸门）。注入的是装配层闭包，工具层不 import 大脑。
   */
  readonly echoCheck?: (text: string) => { readonly hit: boolean; readonly score: number };
  /**
   * S3b（M5）：本地时区偏移（分钟，东八区 480）。
   *
   * 只用于回信后的时间一致性日志（「现在 15 点」这类说法的本地时刻基准）；
   * 不参与任何判断，缺省由装配层给。
   */
  readonly tzOffsetMinutes: number;
  readonly now: () => number;
  readonly localHour: () => number;
  readonly log: (line: string) => void;
}

export interface AutonomyQqHandle {
  readonly bridge: OneBotBridge;
  readonly relay: RelayHandle;
  /** 停接待：断开 relay、释放写锁。可重复调用。 */
  readonly stop: () => void;
  readonly lockPath: string;
}

/** 心跳间隔：写锁的 staleMs 由调用方给（默认 10 分钟），这里只保证比它短。 */
const HEARTBEAT_MS = 30_000;

/**
 * 常驻进程持锁：它活着期间一直是唯一写者。
 * 与 loop 的"每拍拿锁"不冲突——`acquireWriterLock` 遇到同 pid 会续心跳并视为成功。
 */
export function holdWriterLock(input: {
  readonly path: string;
  readonly pid: number;
  readonly owner: string;
  readonly now: () => number;
  readonly note: string;
  readonly staleMs?: number;
  readonly heartbeatMs?: number;
  readonly log?: (line: string) => void;
}): { readonly lock: WriterLock | null; readonly stop: () => void } {
  const staleMs = input.staleMs ?? 10 * 60_000;
  const heartbeatMs = input.heartbeatMs ?? HEARTBEAT_MS;
  const acquire = (): WriterLock | null =>
    acquireWriterLock({
      path: input.path,
      pid: input.pid,
      owner: input.owner,
      now: input.now(),
      staleMs,
      note: input.note,
    });
  let lock = acquire();
  if (lock === null) input.log?.("[qq] 写锁没拿到（别的进程在写），接待仍会启动但状态写入可能冲突");
  const timer = setInterval(() => {
    // 同 pid 时 acquire 会续写心跳；拿不到说明锁被别人接管了，只能等下一次。
    const again = acquire();
    if (again !== null) {
      lock = again;
      return;
    }
    // F284：失败时把"文件里的持有者"和"本进程 pid"打出来——只写"被接管"无法定位是谁，
    // 2026-11-01 凌晨排障时就是因为没有这两个数字，多花了一轮。
    const existing = readWriterLock(input.path);
    const heldBy =
      existing === null
        ? "文件读不到"
        : `文件里 pid=${String(existing.pid)}，心跳 ${String(Math.round((input.now() - existing.heartbeatAt) / 1000))} 秒前`;
    input.log?.(
      `[qq] 写锁被别的进程接管（本进程 pid=${String(input.pid)}，${heldBy}），这一拍先让路，下一拍再抢`,
    );
  }, heartbeatMs);
  timer.unref();
  return {
    lock,
    stop: () => {
      clearInterval(timer);
      // 只删自己持有的锁：被别的进程接管时锁文件已经不是我们的了
      if (lock !== null && lock.pid === process.pid) releaseWriterLock(lock);
    },
  };
}


/**
 * 出站发送器（走执行层，at-most-once）：同一句话 60 秒内只发一次。
 *
 * 抽成工厂是为了可测——直接 `sendPrivateText` 没法在单测里拦，而"重复发同一句"正是
 * 这里唯一必须保证的语义。事件/幂等文件用 autonomy- 前缀，与宿主 `data/execution/*` 分开写。
 */
export interface GatedSender {
  /** 发文字（行为与以前完全一致：60 秒内同一句只发一次） */
  (peer: number, text: string): Promise<{ ok: boolean; detail: string }>;
  /** 发一张图（幂等键=图片路径，24 小时内同一张不重发） */
  image(peer: number, imagePath: string): Promise<{ ok: boolean; detail: string }>;
  /** 发一条语音（幂等键=文本，同一句话 24 小时内不重复合成/发送） */
  voice(peer: number, text: string): Promise<{ ok: boolean; detail: string }>;
}

export function makeGatedSender(input: {
  readonly now: () => number;
  readonly dataDir: string;
  readonly send: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>;
  readonly sendImage?: (peer: number, imagePath: string) => Promise<{ ok: boolean; detail: string }>;
  readonly sendVoice?: (peer: number, text: string) => Promise<{ ok: boolean; detail: string }>;
  readonly log?: (line: string) => void;
}): GatedSender {
  const gateway = new ExecutionGateway({
    now: input.now,
    eventsFile: join(input.dataDir, "execution", "autonomy-events.ndjson"),
    idemFile: join(input.dataDir, "execution", "autonomy-idem.json"),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
  gateway.register(
    makeAdapter("qq.sendOneBot", async (payload: { peer: number; text: string }) => {
      const r = await input.send(payload.peer, payload.text);
      if (!r.ok) throw new Error(`onebot 发送失败：${r.detail}`);
      return { detail: r.detail, chars: payload.text.length };
    }, (r) => `chars=${String(r.chars)}`),
  );
  const sendText = async (peer: number, text: string): Promise<{ ok: boolean; detail: string }> => {
    const outcome = await gateway.execute<{ peer: number; text: string }, { detail: string; chars: number }>(
      "qq.sendOneBot",
      { peer, text },
      { subject: `qq:${String(peer)}`, target: String(peer) },
    );
    if (outcome.status === "succeeded") return { ok: true, detail: `onebot-http: ${outcome.result?.detail ?? "sent"}` };
    if (outcome.status === "deduplicated") {
      // B.3：去重记录有两种——上一次**成功**（这句确实发出去了）与上一次**失败**
      // （at-most-once 保留了失败记录，不会再执行同一句）。后者必须如实报失败，
      // 否则"对面没收到 + 账上成功"会让桥 commit 掉这一轮、她以为说过了。
      return outcome.failure === undefined
        ? { ok: true, detail: "onebot-http: 重复请求（60 秒内已发过同一句）" }
        : {
            ok: false,
            detail: `onebot-http: 重复请求但上次未发出（${outcome.failure.class}；at-most-once 不重发同一句）`,
          };
    }
    return {
      ok: false,
      detail: `onebot-http: ${outcome.status}${outcome.failure === undefined ? "" : ` ${outcome.failure.class}`}`,
    };
  };

  const sendImage = async (peer: number, imagePath: string): Promise<{ ok: boolean; detail: string }> => {
    if (input.sendImage === undefined) return { ok: false, detail: "onebot-image: 没接图片发送器" };
    const outcome = await gateway.execute<{ peer: number; imagePath: string }, { detail: string; bytes: number }>(
      "qq.sendOneBotImage",
      { peer, imagePath },
      { subject: `qq:${String(peer)}`, target: imagePath },
    );
    if (outcome.status === "succeeded") return { ok: true, detail: `onebot-image: ${outcome.result?.detail ?? "sent"}` };
    if (outcome.status === "deduplicated") {
      return outcome.failure === undefined
        ? { ok: true, detail: "onebot-image: 同一张图 24 小时内已经发过" }
        : { ok: false, detail: `onebot-image: 重复请求但上次未发出（${outcome.failure.class}）` };
    }
    return {
      ok: false,
      detail: `onebot-image: ${outcome.status}${outcome.failure === undefined ? "" : ` ${outcome.failure.class}`}`,
    };
  };
  if (input.sendImage !== undefined) {
    gateway.register(
      makeAdapter("qq.sendOneBotImage", async (payload: { peer: number; imagePath: string }) => {
        const r = await input.sendImage!(payload.peer, payload.imagePath);
        if (!r.ok) throw new Error(`onebot 发图失败：${r.detail}`);
        return { detail: r.detail, bytes: 0 };
      }, (r) => `bytes=${String(r.bytes)}`),
    );
  }
  const sendVoice = async (peer: number, text: string): Promise<{ ok: boolean; detail: string }> => {
    if (input.sendVoice === undefined) return { ok: false, detail: "onebot-voice: 没接语音发送器" };
    const outcome = await gateway.execute<{ peer: number; text: string }, { detail: string; chars: number }>(
      "qq.sendOneBotVoice",
      { peer, text },
      { subject: `qq:${String(peer)}`, target: String(peer) },
    );
    if (outcome.status === "succeeded") return { ok: true, detail: `onebot-voice: ${outcome.result?.detail ?? "sent"}` };
    if (outcome.status === "deduplicated") {
      return outcome.failure === undefined
        ? { ok: true, detail: "onebot-voice: 同一句话 24 小时内已经发过语音" }
        : { ok: false, detail: `onebot-voice: 重复请求但上次未发出（${outcome.failure.class}）` };
    }
    return {
      ok: false,
      detail: `onebot-voice: ${outcome.status}${outcome.failure === undefined ? "" : ` ${outcome.failure.class}`}`,
    };
  };
  if (input.sendVoice !== undefined) {
    gateway.register(
      makeAdapter("qq.sendOneBotVoice", async (payload: { peer: number; text: string }) => {
        const r = await input.sendVoice!(payload.peer, payload.text);
        if (!r.ok) throw new Error(`onebot 发语音失败：${r.detail}`);
        return { detail: r.detail, chars: payload.text.length };
      }, (r) => `chars=${String(r.chars)}`),
    );
  }
  return Object.assign(sendText, { image: sendImage, voice: sendVoice });
}

/**
 * P0-F：把 QQ 回信做成语义一致的记忆种子并直写（daemon 是唯一写者）。
 *
 * 失败隔离：remember 抛错只记日志，绝不冒泡到桥（回信已经发出去了）。
 * `stored:false` 是大脑侧的正常拒写（例如防火墙/去重），同样只记日志、不算错误。
 */
export function rememberReplyThrough(
  runtime: Pick<BrainPort, "remember">,
  log: (line: string) => void,
): (reply: string) => void {
  return (reply: string) => {
    try {
      const stored = runtime.remember(chatReplyMemorySeed({ reply, tags: ["chat", "qq"] }));
      log(`[qq] 回信记忆：${stored.stored ? `已写 ${stored.id}` : `未写（${stored.reason}）`}`);
    } catch (err) {
      log(`[qq] 回信写记忆失败（不影响已发出的消息）：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** 启动常驻进程侧的 QQ 接待。返回 null 表示没有可用模型凭据（不静默降级成"乱回"）。 */
export function startAutonomyQq(input: AutonomyQqInput): AutonomyQqHandle | null {
  if (input.llm === null) {
    input.log("[qq] 没有模型凭据：QQ 接待不启动（学习/内省仍按降级模板运行）");
    return null;
  }
  const llm = input.llm;
  const sendDeps: OneBotSendDeps = { baseUrl: input.onebot.baseUrl, token: input.onebot.token };
  const lockPath = join(input.dataDir, ".writer-lock");
  const holder = holdWriterLock({
    path: lockPath,
    pid: process.pid,
    owner: "autonomy",
    now: input.now,
    note: "自主进程接待中（DSH 插件只读）",
    log: input.log,
  });

  // 出站走执行层（at-most-once）：同一句话 60 秒内只发一次，重复由幂等表拦下并记事件。
  const sendGated = makeGatedSender({
    now: input.now,
    dataDir: input.dataDir,
    send: (peer, text) =>
      input.sendImpl === undefined ? sendPrivateText(sendDeps, { peer, text }) : input.sendImpl(peer, text),
    // 图片发送器由装配点注入（`scripts/autonomy/main.mjs`）：它可以读文件、转 base64、
    // 走 OneBot HTTP，但**不能在这个文件里直连发送**——H11「出站收口」查的就是这一行。
    ...(input.sendImageImpl === undefined ? {} : { sendImage: input.sendImageImpl }),
    ...(input.sendVoiceImpl === undefined ? {} : { sendVoice: input.sendVoiceImpl }),
    log: input.log,
  });

  // 脊髓反射（Phase 0 P0-3）：通道连续失败就熔断，熔断期间不生成、不发送，
  // 只上行一条。以前没有这层，QQ 断 4.5 小时被记成 34 次"重新想一句新台词"。
  const spinePath = input.spinePath;
  const spine = createSpineGate({
    now: input.now,
    log: input.log,
    // B.6：熔断以前只在内存里。状态一变就落盘快照，health 才看得见「通道断没断」。
    ...(spinePath === undefined ? {} : { onChange: (snapshot: Parameters<typeof writeSpineSnapshotFile>[1]) => {
      writeSpineSnapshotFile(spinePath, snapshot, input.log);
    } }),
    onUplink: (event) =>
      input.log(
        `[spine] 上行 ${event.kind === "channel-down" ? "QQ 通道断了" : "QQ 通道恢复"}` +
          `（连续失败 ${String(event.failures)} 次）`,
      ),
  });
  const sendWithSpine = async (
    peer: number,
    text: string,
    imagePath?: string,
  ): Promise<{ ok: boolean; detail: string }> => {
    if (!spine.canSend(input.now())) {
      return { ok: false, detail: "spine: 熔断中（通道未恢复，本次未尝试发送）" };
    }
    // 先发图再发字：图失败不能吞掉这句话（她的话比附件重要）。
    // 图上失败只记日志、不 recordSend(non-ok)——否则一张坏图会把文字通道熔断掉。
    if (imagePath !== undefined) {
      const img = await sendGated.image(peer, imagePath);
      input.log(img.ok
        ? `[qq] 画面已发 ${imagePath}（${img.detail}）`
        : `[qq] 画面没发出去（${img.detail}），只发文字`);
    }
    const result = await sendGated(peer, text);
    spine.recordSend(input.now(), result.ok);
    return result;
  };

  /**
   * 召回只在这里做一次（回信 / 主动开口共用），差别只在是否传「来源过滤选项」。
   * 回信不传 options → 旧行为逐位不变；主动开口传 excludeSources（task-169 A）。
   */
  const runRecall = (text: string, options?: RecallFilterOptions): DialogueRecall => {
    // §8.3：QQ 上目前只有用户一个人（OneBot 桥在入口就拒绝非 peer 的发信人），
    // 所以这里是**主人**视角。将来进群/多联系人时，这里要换成按发信人算出的访客身份，
    // 而不是把这一行删掉——删掉等于默认「谁都看得到整本日记」。
    // §5.2：具体性 streak 跨回合存在 data/ 里（插件唤醒进程与这里共用同一个文件）。
    const streakPath = workingSelfStatePathInDataDir(input.dataDir, input.characterId);
    const prev = readWorkingSelfState(streakPath, input.now());
    if (prev.errors.length > 0) {
      input.log(`[recall] 具体性状态文件损坏（${prev.errors[0] ?? ""}），本轮按 0 起算`);
    }
    const r = recallForDialogue(
      input.runtime,
      text,
      OWNER_VISITOR,
      "qq",
      {
        values: workingSelfValuesFrom(input.runtime.persona()?.personality),
        lowConcretenessStreak: prev.state.lowConcretenessStreak,
        relaxFactor: prev.state.relaxFactor,
      },
      options,
    );
    // §5.2：报警必须落日志；平时只带一行摘要，不刷屏
    const alarm = r.workingSelf === undefined ? null : describeWorkingSelfAlarm(r.workingSelf);
    if (alarm !== null) input.log(alarm);
    const next = advanceWorkingSelfState(prev.state, {
      concreteness: r.workingSelf?.concreteness ?? null,
      alarmNote: alarm ?? r.workingSelf?.selfNote ?? null,
      nowMs: input.now(),
    });
    try {
      writeWorkingSelfState(streakPath, next);
    } catch (err) {
      input.log(`[recall] 具体性 streak 写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    input.log(
      `[recall] q=${text.slice(0, 16)} m=${String(r.memories.length)} k=${String(r.knowledge.length)}` +
        (r.workingSelf === undefined ? "" : ` ws=${r.workingSelf.note} streak=${String(next.lowConcretenessStreak)}`),
    );
    // S3c：M3 睡眠产出采纳率——只落内部 id/source（无内容、无 query）。
    // 全文只有这一处落该日志（插件 host 两处按 S3c2 后置不落）。
    if (r.memoryHits !== undefined && r.memoryHits.length > 0) {
      input.log(formatRecallHitLog("qq", r.memoryHits));
    }
    return r;
  };

  const deps: OneBotBridgeDeps = {
    now: input.now,
    localHour: input.localHour,
    generate: async ({ system, prompt, task }) => {
      const reply = await chatComplete(
        llm,
        [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        { task: task ?? "chat" },
      );
      const usageLine = formatUsageLog(task ?? "chat", reply);
      if (usageLine !== undefined) input.log(usageLine);
      input.log(`[qq] generated ${String(reply.text.length)} chars via ${reply.model}`);
      // P0-2：QQ 回复也是一次模型调用，必须记进同一个频率账本。
      // 此前这里零记账 → 她在这里聊天完全不占额度，"每小时上限"只约束了自主活动。
      // 记账失败不阻断回复（说出去的话比账本更重要），但要留下痕迹。
      try {
        recordUsageOnce(join(input.dataDir, "autonomy-usage.json"), input.now());
      } catch (err) {
        input.log(`[qq] 记账失败（不影响回复）：${err instanceof Error ? err.message : String(err)}`);
      }
      return reply.text;
    },
    send: async ({ peer, text, imagePath }) => sendWithSpine(peer, text, imagePath),
    ...(input.shareImage === undefined ? {} : { shareImage: input.shareImage }),
    // 耳朵与嘴巴（镜像）：对方发语音就转写成文字进大脑，回话也用语音。
    // 两条都在装配点实现（python 小工具/本机 SAPI），这里只做接线与降级。
    ...(input.transcribeVoiceImpl === undefined
      ? {}
      : { transcribeVoice: async (ref: { name: string; path: string }) => input.transcribeVoiceImpl!(ref) }),
    ...(input.sendVoiceImpl === undefined
      ? {}
      : {
          // B.2：语音也过熔断前门（熔断中不尝试；语音失败不记入熔断计数）。
          sendVoice: async ({ peer, text }: { peer: number; text: string }) =>
            speakVoiceThroughSpine(spine, input.now(), async () => sendGated.voice(peer, text)),
        }),
    channelDown: () => spine.isOpen(input.now()),
    saveState: (state) => saveQQState(input.dataDir, input.characterId, state),
    // 装配点职责：把大脑的「嘴」装成端口交给工具层的桥（见 src/ports/dialogue.ts）
    dialogue: createDialoguePort(input.runtime.persona()),
    language: createLanguagePort(),
    // P2：共享对话历史（网页 ↔ QQ 同一段）。不传就退回桥内内存（旧行为）。
    ...(input.historyStore === undefined ? {} : { history: input.historyStore }),
    recall: (text) => runRecall(text),
    // task-169 A / F350 I2（案 A）：主动开口单独走「排除自述来源」的召回——否则她会把自己
    // 以前的主动发言/自言自语/网页回复当素材再讲一遍（回声室）。F350 去掉 proactive T2
    // 补位（不再从自述来源补 1 条）：主动开口只用 T1 真实互动素材，宁缺勿滥。
    // 回信仍用上面的 recall（完整召回）。
    recallForProactive: (text) =>
      runRecall(text, {
        excludeSources: SELF_AUTHORED_SOURCES,
      }),
    ...(input.echoCheck === undefined ? {} : { echoCheck: input.echoCheck }),
    // P0-F：回信真的发出去后写一条 chat_reply/outbound 记忆；失败只记日志。
    rememberReply: rememberReplyThrough(input.runtime, input.log),
    // S3b（M5）：回信成功后的时间一致性日志。只记计数/时长大数，不落回答原文；
    // 样本凑不齐（没有 peer 历史）时 elapsed 类 claim 会记 unverified，不编基准。
    recordTimeClaims: (reply: string): void => {
      try {
        if (!Number.isFinite(input.tzOffsetMinutes)) return;
        const nowMs = input.now();
        const history = input.historyStore?.recent(200) ?? [];
        let lastPeerAtMs: number | null = null;
        let lastOwnAtMs: number | null = null;
        for (const entry of history) {
          if (!Number.isFinite(entry.atMs) || entry.atMs > nowMs) continue;
          if (entry.who === "peer") lastPeerAtMs = Math.max(lastPeerAtMs ?? 0, entry.atMs);
          else lastOwnAtMs = Math.max(lastOwnAtMs ?? 0, entry.atMs);
        }
        const extracted = extractTimeClaims(reply);
        if (extracted.claims.length === 0) return;
        const snap = buildSpeakSnapshot({
          nowMs,
          tzOffsetMinutes: input.tzOffsetMinutes,
          awakeForHours: null,
          sinceLastUserMsgMin: lastPeerAtMs === null ? null : Math.max(0, (nowMs - lastPeerAtMs) / 60_000),
          sinceLastOwnMsgMin: lastOwnAtMs === null ? null : Math.max(0, (nowMs - lastOwnAtMs) / 60_000),
          lastSleepAtMs: null,
          presenceActive: null,
        });
        const compared = compareTimeClaims(extracted.claims, snap);
        input.log(
          formatSpeakLog("qq", snap, {
            claims: compared.claims + extracted.unverified,
            verifiable: compared.verifiable,
            mismatch: compared.mismatch,
            unverified: compared.unverified + extracted.unverified,
          }),
        );
      } catch {
        input.log("[time-claim] failed");
      }
    },
    gates: () => input.runtime.proactiveGates(),
    // F297：判定来自大脑层（这里只是装配）
    appraise: appraiseFromText,
    log: input.log,
  };

  const bridge = new OneBotBridge(
    input.runtime,
    makeOneBotOptions({
      peer: input.onebot.peer,
      dryRun: input.onebot.dryRun,
      quietFrom: input.quietFrom,
      quietTo: input.quietTo,
      minGapMs: input.minGapMs,
      maxPerHour: input.maxPerHour,
      ...(input.onebot.peerName === undefined ? {} : { peerName: input.onebot.peerName }),
    }),
    deps,
    loadQQState(input.dataDir, input.characterId),
  );

  const relay = startWsRelay({
    scriptPath: join(input.repoRoot, "scripts", "ws-relay.mjs"),
    wsUrl: input.onebot.wsUrl,
    token: input.onebot.wsToken,
    outFile: join(input.dataDir, `onebot-relay-${input.characterId}.jsonl`),
    onEvent: (event) => {
      void bridge
        .handle(event as never)
        .then((r) => {
          // 只记有用的：回复、非消息、以及「被闸拦下」的两类（否则测试注入会像没发生）
          if (r.reason !== "replied" && r.reason !== "not-message" && r.reason !== "test-held" && r.reason !== "selfcheck-held") return;
          input.log(`[onebot] ${r.reason}: ${r.detail}${r.reply === undefined ? "" : ` | ${r.reply}`}`);
        })
        .catch((err: unknown) => {
          input.log(`[onebot] error: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    log: input.log,
  });

  return {
    bridge,
    relay,
    lockPath,
    stop: () => {
      try {
        relay.stop("自主进程停止接待");
      } catch {
        // relay 已经停了就别再抛
      }
      holder.stop();
    },
  };
}
