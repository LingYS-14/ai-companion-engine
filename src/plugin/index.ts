/**
 * Anime Soul Engine —— DSH Host 插件入口。
 *
 * 形态决策（为什么是"注册工具"而不是"自己起一个 LLM 循环"）：
 *   DSH 里的 agent 本身就是 LLM，插件再去接一个模型只会引入第二套会话、
 *   API key 与供应商绑定，而且两个"谁在说话"会打架。所以插件只做**状态与记忆**，
 *   台词由当前会话的模型写；表达层给的是"怎么说"的结构化提示（composePrompt）。
 *
 * 注册约定照抄已实装的 Host 插件（`@changfenhuang/dsh-genui`）：
 *   `ctx.inject(['tools'], (toolsCtx) => toolsCtx.effect(() => { yield/return register(...) }))`
 * 这里用同步 effect：注册函数返回 disposer，effect 返回清理函数。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SoulRuntime, type SoulConfig } from "./runtime.js";
import { buildTools, type BiliFeedLike, type WebFetchToolPayload, type WebToolPayload } from "./tools.js";
import { ExecutionGateway, makeAdapter } from "../execution/index.js";
import { recordUsageOnce } from "../autonomy/usage.js";
import { PROTOCOL_TEXT } from "./protocol.js";
// F326 方案 A：人格卡不再加载/注入。名字与头像降级为 UI 标识（displayName + characterId），
// 提示词里的身份只来自机制层协议（dialogue/protocol-identity.ts）与记忆。
import { PROTOCOL_IDENTITY } from "../dialogue/protocol-identity.js";
import { ANSWER_PATH, AVATAR_ROUTE_PATH, BILI_QR_PATH, PANEL_STATE_PATH, createAnswerHandler, createAvatarHandler, createBiliQrHandler, createStateHandler } from "./web/handlers.js";
import { SOUL_CSS_PATH, SOUL_JS_PATH, SOUL_PAGE_PATH, createSoulAssetHandler, createSoulPageHandler } from "./web/soul.js";
import {
  CHAT_HISTORY_PATH,
  CHAT_META_PATH,
  CHAT_SEND_PATH,
  createChatHistoryHandler,
  createChatMetaHandler,
  createChatSendHandler,
  type ChatSendOutcome,
} from "./web/chat.js";
import { ChatChannelError, makeChannelChat } from "./channel-chat.js";
import { callWriteChannel, WriteChannelUnavailableError } from "./write-client.js";
import { panelPayload } from "../assembly/panel-payload.js";
import { readPanelFacts } from "../orchestrator/intent/panel-facts.js";
import { answerPanelRequest } from "../orchestrator/intent/panel-answer.js";
import { appraiseFromText } from "../psychology/appraisal-qq.js";
import { panelStateSnapshotPath, readPanelStateSnapshotFile } from "../orchestrator/intent/panel-snapshot.js";
import { recallForDialogue } from "../dialogue/recall.js";
import { chatReplyMemorySeed } from "../orchestrator/intent/close-loop.js";
import { describeWorkingSelfAlarm, workingSelfValuesFrom } from "../orchestrator/intent/working-self-recall.js";
import {
  readWorkingSelfState,
  workingSelfStatePathInDataDir,
} from "../orchestrator/intent/working-self-streak.js";
// 装配点才允许 import 大脑实现：把「嘴」装成端口塞给工具层的桥（见 src/ports/dialogue.ts）
import { createDialoguePort, createLanguagePort } from "../dialogue/port-adapter.js";
import { makeChannelTurn } from "./channel-turn.js";
import { OWNER_VISITOR } from "../ports/visitor.js";
import {
  fetchNav,
  fetchPopular,
  fetchVideoInfo,
  fetchVideoTags,
  loadBiliSession,
  searchVideos,
  type BiliDeps,
  type BiliVideo,
} from "../bili/public.js";
import { buildVideoNote, ingestVideoNote, notesConfig } from "../bili/notes.js";
import { resolveFfmpegPath } from "../bili/ffmpeg.js";
import { visualSummary } from "../bili/storyboard.js";
import { knobNumber } from "../engine/config.js";
import { ingestVideos } from "../bili/ingest.js";
import { LEARNING_PLAN, pickKeywords } from "../bili/topics.js";
import { SystemClock } from "../engine/clock.js";
import { QQBridge, type QQImageBytes } from "../qq/bridge.js";
import {
  loadQQState,
  makeDbProbe,
  makeHostDeps,
  makeScriptRunner,
  saveQQState,
  sniffImageMediaType,
  type HostQQDeps,
} from "../qq/host.js";
import type { InboundImage } from "../qq/inbound.js";
import { makeOneBotOptions, OneBotBridge } from "../qq/onebot-bridge.js";
import { redactSecret, sendPrivateRecord, sendPrivateText, type OneBotSendDeps } from "../qq/onebot.js";
import { startWsRelay } from "../qq/wsrelay.js";
import { acquireWriterLock, releaseWriterLock } from "../autonomy/lock.js";
import { DEFAULT_QQ_OPTIONS, type QQOptions } from "../qq/types.js";
import { fetchVoiceFile, synthesizeSpeech, transcribeAudio, type VoiceToolDeps } from "../qq/voice.js";

export const name = "ai-companion-engine";
export const inject = ["tools"];

/** 插件配置：全部可选，都有默认值（不引 zod / schemastery，避免多一条依赖链） */
export interface PluginConfig {
  /** 角色 id：决定状态文件名，支持一个插件带多个角色 */
  characterId?: string;
  /** 数据目录（状态 json + 记忆 ndjson）。默认放在本仓 data/ 下，方便审计 */
  dataDir?: string;
  /** 是否把每轮的关系/记忆变动写进日志 */
  trace?: boolean;
  /**
   * 依恋 D 层（§4.1 attachment{anxiety,avoidance}，0..1）。
   * 不填则落 secure 默认值——规格没有 archetype 取值表（F19/F20），默认值是实现侧决定。
   */
  attachment?: { anxiety?: number; avoidance?: number };
  /**
   * 显示名（F326 方案 A）：**只是 UI 标识**，不是人格设定。
   * 缺省回落到 `characterId`；提示词不读它——她说什么由记忆与关系决定。
   */
  displayName?: string;
  /**
   * QQ 桥：让插件自己盯 `qq-ops` 的收件箱，有人找她时自动回一句。
   *
   * 默认**关闭**且默认**试运行**：开启后她的回帖会真的发到 QQ 上，
   * 这是少数会"对外说话"的功能，必须先 dryRun 看一轮台词再决定。
   */
  qq?: QQConfig;
}

export interface QQConfig {
  /** 总开关；false/缺省 = 不读收件箱、不起轮询 */
  enabled?: boolean;
  /** 试运行：照常生成台词但不发送（默认 true） */
  dryRun?: boolean;
  /** 只回这个 QQ 昵称 */
  peer?: string;
  /** 轮询间隔秒（默认 15） */
  intervalSec?: number;
  /** 静默时段（本地小时，左闭右开；默认 0–7 不回） */
  quietFrom?: number;
  quietTo?: number;
  /** 两条回复的最小间隔秒（默认 8） */
  minGapSec?: number;
  /** 每小时最多几条（默认 30） */
  maxPerHour?: number;
  /** qq-ops 目录（默认 C:\\AI\\qq-ops） */
  root?: string;
  /** QQ 主窗口句柄；缺省读 QQ_HWND，再退回 460836 */
  hwnd?: number;
  /** 她主动开口（默认关闭；开启后按状态与时间自己说话） */
  proactive?: {
    enabled?: boolean;
    /** 两次主动开口的最小间隔分钟（默认 180） */
    minGapMin?: number;
    /** 一天最多几句（默认 3） */
    maxPerDay?: number;
    /** 检查间隔分钟（默认 5） */
    checkEveryMin?: number;
  };
  /**
   * OneBot v11 通道（HTTP 发 + WebSocket 收），与窗口自动化并存、互不依赖：
   * 可以只开这个、不开上面的 `enabled`。
   */
  onebot?: {
    /** 总开关；true 才会建监听 */
    enabled?: boolean;
    /** HTTP API，默认 `http://127.0.0.1:3000` */
    baseUrl?: string;
    /** Universal WebSocket，默认 `ws://127.0.0.1:3001` */
    wsUrl?: string;
    /** HTTP Bearer token；WS 没单独配 `wsToken` 时也用它；不进日志/报告 */
    token?: string;
    /**
     * WS 的 `access_token`。不少实现（含本机实测的这份）HTTP token 与 WS token
     * 是两套，所以留了这个覆盖位；缺省沿用 `token`。
     */
    wsToken?: string;
    /**
     * 桥归谁：`host`（默认，插件内起监听）或 `autonomy`（常驻进程接待，插件只观察）。
     * 移交后插件不建桥、不拿写锁——写权由常驻进程持有的 `.writer-lock` 表达。
     */
    owner?: "host" | "autonomy";
    /** 只回这个 QQ 号（**不是**昵称） */
    peer?: number;
    /** 试运行：照常生成台词但不发送（默认 true） */
    dryRun?: boolean;
  };
}

interface ToolService {
  register(definition: unknown): () => void;
}

interface EffectScope {
  effect(fn: () => (() => void) | void, label?: string): void;
}

interface ToolsContext extends EffectScope {
  tools: ToolService;
}

interface WebScope extends EffectScope {
  webServer?: WebServerLike;
}

interface PromptSection {
  name: string;
  text: string;
  order?: number;
}

interface PluginContext {
  logger?: { info(msg: string): void; warn?(msg: string): void };
  inject?(names: string[], fn: (scope: never) => void): void;
  effect?(fn: () => (() => void) | void, label?: string): void;
  get?(name: string): unknown;
  tools?: ToolService;
  /** 宿主定时器（cordis timer）；没有时退化成 setInterval */
  timer?: { interval(cb: () => void, ms: number): () => void };
  systemPrompt?: {
    section(section: PromptSection): void;
    getSectionOrder?(id: string): number;
  };
}

const DEFAULT_DATA_DIR = "data";

/**
 * 加载自检报告。
 *
 * 为什么不是日志：宿主把插件日志写进自己的 stdout，用户看不到；而"工具没出现"
 * 这类问题必须能自证——所以把注册结果落到数据目录里，一条 `cat` 就能判断
 * 是"没加载"还是"加载了但没注册成功"。
 *
 * `panelRoute` 是后来加的：面板出现但显示"读不到状态"时，必须能区分
 * "路由没注册"（宿主还没有 webServer / 注入没发生）与"注册了但请求被挡"（鉴权）。
 */
interface ApplyReport {
  injected: boolean;
  registered: string[] | null;
  error: string | null;
  panelRoute?: string;
  avatarRoute?: string;
  /** B 站扫码登录页的注册状态（同 panelRoute 口径） */
  biliQrRoute?: string;
  /** 面板「当场回一句」端点的注册状态（F299） */
  answerRoute?: string;
  /** 工作台静态页的注册状态（P4-4 P1：/soul + css/js） */
  soulRoute?: string;
  /** P2 网页聊天三条路由的注册状态（meta/history/send） */
  chatRoute?: string;
  /** OneBot 监听状态：`"listening"` | `"disabled"` | `"error:…"`（不含 token） */
  onebot?: string;
}

function writeReport(conf: SoulConfig, atMs: number, report: ApplyReport): void {
  try {
    mkdirSync(conf.dataDir, { recursive: true });
    writeFileSync(
      join(conf.dataDir, "apply-report.json"),
      `${JSON.stringify({ atMs, ...report }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // 自检报告写不出去不能反过来弄坏插件
  }
}

/**
 * 注入系统提示的**可执行协议**（内容在 protocol.ts，那里有测试盯着）。
 *
 * 这里只负责挂上去：用 STRUCTURED_OUTPUT 的 order 紧随其后，保证它排在
 * 结构化输出约束之后、不被更长的段落挤到看不见的地方。
 */
const PROMPT_SECTION = PROTOCOL_TEXT;

export async function apply(ctx: PluginContext, config: PluginConfig = {}): Promise<void> {
  const conf: SoulConfig = {
    characterId: config.characterId ?? "default",
    ...(config.displayName === undefined ? {} : { displayName: config.displayName }),
    dataDir: config.dataDir ?? DEFAULT_DATA_DIR,
    trace: config.trace ?? false,
    ...(config.attachment === undefined
      ? {}
      : {
          attachment: {
            anxiety: config.attachment.anxiety ?? 0.35,
            avoidance: config.attachment.avoidance ?? 0.3,
          },
        }),
    // 批次 2a：插件是次要写者。状态文件被 daemon 推进过之后，插件不再用旧快照整份覆盖。
    stateWriter: "secondary",
    stateLog: (line) => {
      try {
        appendQQLog(conf, clock.now(), line);
      } catch {
        /* 日志失败不影响回合 */
      }
    },
  };

  const report: ApplyReport = { injected: true, registered: null, error: null };
  const flush = (): void => writeReport(conf, runtime.now(), report);
  // OneBot 的状态槽：工具注册与监听启动是两条时序，两边读同一个「此刻的值」
  const onebotSlot: { state: string; bridge: OneBotBridge | null } = { state: "disabled", bridge: null };

  let runtime: SoulRuntime;
  // 时钟由插件自己造一份并复用：QQ 桥的 now()/localHour() 必须和引擎同一口径，
  // 否则 dry-run 的静默时段判断会和状态机的时间漂移。
  const clock = new SystemClock();
  try {
    runtime = await SoulRuntime.open(conf, clock);
  } catch (err) {
    writeReport(conf, 0, { injected: false, registered: null, error: `SoulRuntime.open 失败：${String(err)}` });
    throw err;
  }
  ctx.logger?.info(
    `ai-companion-engine: 角色 ${conf.characterId} 已装载（数据目录 ${conf.dataDir}，规格 ${runtime.config.meta.spec}）`,
  );

  // QQ 桥：只在显式 enabled=true 时构造（读收件箱要扫目录，不该默认发生）
  const qqBridge = config.qq !== undefined && config.qq.enabled === true
    ? makeQQBridge(ctx, clock, runtime, conf, config.qq)
    : null;

  // B 站公开读取：apply 阶段不联网，只有 soul_bili_feed / soul_bili_me 被调用时才发请求。
  // 登录态同样是惰性的：每次工具调用现读 `data/bili-<characterId>.json`（文件很小），
  // 这样把 cookie 文件丢进 data/ 之后**不用 reload 插件**就能自检；读不到就按匿名跑，
  // 启动阶段绝不因为凭据文件缺失/损坏而抛错。
  const biliSession = (): ReturnType<typeof loadBiliSession> => loadBiliSession(conf.dataDir, conf.characterId);

  const biliDeps = (session: ReturnType<typeof loadBiliSession>): BiliDeps => ({
    fetchFn: fetch,
    now: () => clock.now(),
    ...(session === null ? {} : { session }),
  });

  // 写进 runtime 里那个 KnowledgeStore 实例——另起一个会读到同一份文件，
  // 但内存索引是两份，has() 的幂等判重会失效（同一视频每拉一次多一行）。
  // 榜单兜底用：热门榜刷新慢（实测同一批 10 分钟后再拉仍全重复），
  // 所以 feed 在「榜单一条都吸收不进」时，改用计划里的下一个关键词去搜。
  // 轮转游标放在闭包里而不是文件里：它是"这一小时该搜哪个"，不是需要持久化的状态。
  let feedFallbackRotation = 0;

  // 执行层（P1）：B 站取数/入库也走 gateway（指纹去重、限速、失败分类、事件日志）。
  // gateway 在 register() 里才建出来，所以这里用引用而不是快照；为 null 时退回直连（等价于执行层未启用）。
  let gatewayRef: ExecutionGateway | null = null;

  const biliFetch = async (input: {
    source: "popular" | "search";
    pageSize: number;
    keyword?: string;
  }): Promise<readonly BiliVideo[]> => {
    const deps = biliDeps(biliSession());
    const run = async (): Promise<readonly BiliVideo[]> =>
      input.source === "popular"
        ? fetchPopular(deps, { pageSize: input.pageSize })
        : searchVideos(deps, { keyword: input.keyword ?? "", pageSize: input.pageSize });
    if (gatewayRef === null) return run();
    const outcome = await gatewayRef.execute<typeof input, readonly BiliVideo[]>(
      "bili.fetch",
      input,
      { subject: `bili:${input.source === "popular" ? "popular" : (input.keyword ?? "search")}` },
    );
    if (outcome.status === "succeeded" && outcome.result !== undefined) return outcome.result;
    if (outcome.status === "deduplicated" && outcome.result !== undefined) return outcome.result;
    if (outcome.status === "deduplicated") return [];
    throw new Error(`bili.fetch 失败：${outcome.failure?.message ?? outcome.status}`);
  };

  const biliIngest = async (videos: Parameters<typeof ingestVideos>[1]) => {
    if (gatewayRef === null) return ingestVideos(runtime.knowledgeWritePort(), videos, clock.now());
    const outcome = await gatewayRef.execute<{ videos: Parameters<typeof ingestVideos>[1] }, ReturnType<typeof ingestVideos>>(
      "bili.ingest",
      { videos },
      { subject: "bili:ingest" },
    );
    if (outcome.status === "succeeded" && outcome.result !== undefined) return outcome.result;
    throw new Error(`bili.ingest 失败：${outcome.failure?.message ?? outcome.status}`);
  };

  const biliFeed: BiliFeedLike = {
    async feed(limit: number) {
      const popular = await biliFetch({ source: "popular", pageSize: limit });
      let videos = popular;
      let result = await biliIngest(videos);
      let source: "popular" | "search" = "popular";
      let keyword: string | undefined;
      // 兜底条件刻意写成「一条都没吸收」而不是「吸收了少于 N 条」：
      // 热门榜本来就会混入已学内容，只要还有新的就不该切；只有整批重复才说明它没刷新。
      if (result.ingested === 0) {
        const picked = pickKeywords(LEARNING_PLAN, feedFallbackRotation);
        feedFallbackRotation = (feedFallbackRotation + 1) % 10;
        keyword = picked.keyword;
        const searched = await biliFetch({ source: "search", keyword: picked.keyword, pageSize: limit });
        if (searched.length > 0) {
          videos = searched;
          result = await biliIngest(videos);
          source = "search";
        }
      }
      return {
        fetched: videos.length,
        ingested: result.ingested,
        skipped: result.skipped,
        blocked: result.blocked,
        offTopic: result.offTopic,
        videos: videos.map((v) => ({ bvid: v.bvid, title: v.title, owner: v.owner })),
        source,
        ...(keyword === undefined ? {} : { keyword }),
      };
    },
    async me() {
      // 先看有没有会话文件：没有就不发请求（自检工具据此报「未登录（…缺失或无 sessdata）」）
      const session = biliSession();
      if (session === null) return { session: false, nav: null };
      return { session: true, nav: await fetchNav(biliDeps(session)) };
    },
    async learn(opts) {
      // 关键词由固定计划轮转决定（本层不管「学什么」）；limit 由工具层夹好，这里只给默认值
      const picked = pickKeywords(LEARNING_PLAN, opts.rotation ?? 0);
      const limit = opts.limit ?? 5;
      const videos = await biliFetch({ source: "search", keyword: picked.keyword, pageSize: limit });
      // 与 feed 同一套摄取：同一个 KnowledgeStore 实例 + 同一个 now()，幂等判重才连得上
      const result = await biliIngest(videos);
      return {
        topic: picked.topic,
        keyword: picked.keyword,
        fetched: videos.length,
        ingested: result.ingested,
        skipped: result.skipped,
        blocked: result.blocked,
        offTopic: result.offTopic,
        items: videos.map((v) => ({ bvid: v.bvid, title: v.title })),
      };
    },
    async read(bvid, opts) {
      // 深读一条：按 bvid 取元信息 + 标签 + 字幕引用 + 取样帧，拼成一段人话。
      // 与学习轮次里的深读共用 buildVideoNote —— 同一套降级顺序（字幕 → 画面 → 只剩标题），
      // 所以两条路径不会给出互相矛盾的说法。
      const deps = biliDeps(biliSession());
      const video = await fetchVideoInfo(deps, bvid);
      if (video === null) throw new Error(`查不到这条视频：${bvid}（可能已删除、私密，或被风控拦了）`);
      const tags = await fetchVideoTags(deps, bvid).catch(() => [] as readonly string[]);
      const base = notesConfig({ read: (name) => knobNumber(runtime.config, name) }, {
        ffmpegPath: resolveFfmpegPath({
          env: {
            ACE_FFMPEG: process.env["ACE_FFMPEG"],
            USERPROFILE: process.env["USERPROFILE"],
            USERNAME: process.env["USERNAME"],
          },
          exists: existsSync,
        }),
        frameRoot: join(conf.dataDir, "frames"),
        spriteDir: join(conf.dataDir, "frames", ".sprites"),
      });
      const requestedQuotes = opts.quotes === undefined ? base.quotes : Math.min(base.quotes, Math.max(1, opts.quotes));
      const note = await buildVideoNote(deps, video, {
        ...base,
        quotes: requestedQuotes,
        // frames:false 时不碰故事板与 ffmpeg（只是"读文字"的便宜路径）
        frameSamples: opts.frames === false ? 0 : base.frameSamples,
      });
      const ingested = opts.remember === true ? ingestVideoNote(runtime.knowledgeWritePort(), video, note, clock.now()) : false;
      return {
        bvid: video.bvid,
        title: video.title,
        owner: video.owner,
        durationSec: video.durationSec,
        view: video.view,
        like: video.like,
        tags,
        description: video.description,
        quotes: note.quotes,
        subtitleChars: note.subtitleChars,
        visual: visualSummary(note.frames),
        frameFiles: note.frameFiles,
        ingested,
      };
    },
  };

  const register = (scope: ToolsContext): void => {
    // 研究工具：默认关，靠 data/dev-exec.on 这个开关文件打开（不给通用后门常驻）。
    const devMark = join(conf.dataDir, "dev-exec.on");
    const scriptRunner = makeScriptRunner();
    const devExec =
      qqBridge === null
        ? null
        : async (script: string, args?: readonly string[]): Promise<string> => {
            if (!existsSync(devMark)) throw new Error("研究工具未启用：先创建 data/dev-exec.on");
            return scriptRunner(script, args);
          };
    // 执行层（P1）：宿主的出站动作从这里走——指纹去重、每分钟限速、失败分类、落 ndjson。
    const windowSender = makeWindowSender(conf, config.qq ?? {}, (line) => appendQQLog(conf, clock.now(), line));
    const gateway = new ExecutionGateway({
      now: () => clock.now(),
      eventsFile: join(conf.dataDir, "execution", "events.ndjson"),
      idemFile: join(conf.dataDir, "execution", "idem.json"),
      log: (line) => appendQQLog(conf, clock.now(), line),
    });
    gateway.register(
      makeAdapter<{ kind: "text" | "image" | "file"; payload: string }, { ok: boolean; detail: string }>(
        "qq.send",
        async (req) => {
          const r = await windowSender(req);
          if (!r.ok) throw new Error(`窗口发送失败：${r.detail}`);
          return r;
        },
        (r) => (r.ok ? "ok" : "not-ok"),
      ),
    );
    // B 站两条序列：fetch 只读（幂等，TTL 内重复请求回放上次结果）、ingest 入库（at-least-once）
    gateway.register(
      makeAdapter<{ source: "popular" | "search"; pageSize: number; keyword?: string }, readonly BiliVideo[]>(
        "bili.fetch",
        async (input) => {
          const deps = biliDeps(biliSession());
          return input.source === "popular"
            ? fetchPopular(deps, { pageSize: input.pageSize })
            : searchVideos(deps, { keyword: input.keyword ?? "", pageSize: input.pageSize });
        },
        (rows) => `n=${String(rows.length)}`,
      ),
    );
    gateway.register(
      makeAdapter<{ videos: Parameters<typeof ingestVideos>[1] }, ReturnType<typeof ingestVideos>>(
        "bili.ingest",
        async (input) => ingestVideos(runtime.knowledgeWritePort(), input.videos, clock.now()),
        (r) => `ingested=${String(r.ingested)}`,
      ),
    );
    gatewayRef = gateway;

    const dispatchQQSend: NonNullable<Parameters<typeof buildTools>[1]>["dispatch"] = async (toolId, input, opts) => {
      const outcome = await gateway.execute(toolId, {
        kind: input.kind as "text" | "image" | "file",
        payload: input.payload,
      }, { subject: opts.subject, ...(opts.target === undefined ? {} : { target: opts.target }) });
      const detail = outcome.status === "succeeded"
        ? String((outcome.result as { detail?: string } | undefined)?.detail ?? "sent")
        : outcome.status === "deduplicated"
          ? "60 秒内同一句已发过，这次拦下（at-most-once）"
          : (outcome.failure?.message ?? "未知失败");
      return { status: outcome.status, detail };
    };

    const defs = buildTools(runtime, {
      // 宿主插件就是"开发面"：她活着时默认只读，写要人显式放行 data/dev-write.on（目标 ④）
      devReadOnly: true,
      // 批次 2b（单写者 A）：插件不写状态。写类工具把请求投给自主进程（唯一写者），
      // 自己只读；通道没开就报错，绝不回退成本进程写。
      channel: { dataDir: conf.dataDir, characterId: conf.characterId },
      qq: qqBridge,
      qqDbProbe: qqBridge === null ? null : makeDbProbe(),
      devExec,
      onebot: onebotSlot,
      bili: biliFeed,
      // F326：soul_persona 没有卡可读，只回报 UI 标识（显示名），不暴露任何设定内容。
      displayName: conf.displayName ?? conf.characterId,
      // task-138：soul_web_search 的业务在 daemon（唯一写者持 key 与共享额度账本）。
      // 插件只转发 + 把 daemon 的 code 交回工具层渲染；通道不可用时给可读错误，不假装搜过。
      webSearch: async (input) => {
        try {
          const res = await callWriteChannel<WebToolPayload>({
            dataDir: conf.dataDir,
            characterId: conf.characterId,
            op: "web_search",
            payload: input,
            // 搜索侧 8s 超时 + 一次 250ms 重试；通道给 25s 余量，别让宿主先判失败。
            timeoutMs: 25_000,
          });
          if (res.ok && res.result !== undefined) return res.result;
          return {
            ok: false,
            code: res.code ?? "CHANNEL_DOWN",
            hits: [],
            failure: null,
            message: res.error ?? "写通道没给原因",
            retryAfterMs: null,
            stats: { searchCount: 0, dailyCap: 0 },
            fresh: false,
          };
        } catch (err) {
          return {
            ok: false,
            code: err instanceof WriteChannelUnavailableError ? err.code : "CHANNEL_DOWN",
            hits: [],
            failure: null,
            message: err instanceof Error ? err.message : String(err),
            retryAfterMs: null,
            stats: { searchCount: 0, dailyCap: 0 },
            fresh: false,
          };
        }
      },
      // F1：soul_web_fetch 与搜索同一套路——业务在 daemon（持 key/抓取额度），插件只转发。
      webFetch: async (input) => {
        try {
          const res = await callWriteChannel<WebFetchToolPayload>({
            dataDir: conf.dataDir,
            characterId: conf.characterId,
            op: "web_fetch",
            payload: input,
            // 抓取侧 8s 超时 + 最多一次 250ms 重试 + 读完再截；通道给 25s 余量。
            timeoutMs: 25_000,
          });
          if (res.ok && res.result !== undefined) return res.result;
          return {
            ok: false,
            code: res.code ?? "CHANNEL_DOWN",
            url: null,
            finalUrl: null,
            title: null,
            text: null,
            truncated: false,
            bytes: 0,
            fetchedAtMs: null,
            failure: null,
            message: res.error ?? "写通道没给原因",
            retryAfterMs: null,
            stats: { fetchCount: 0, dailyCap: 0 },
          };
        } catch (err) {
          return {
            ok: false,
            code: err instanceof WriteChannelUnavailableError ? err.code : "CHANNEL_DOWN",
            url: null,
            finalUrl: null,
            title: null,
            text: null,
            truncated: false,
            bytes: 0,
            fetchedAtMs: null,
            failure: null,
            message: err instanceof Error ? err.message : String(err),
            retryAfterMs: null,
            stats: { fetchCount: 0, dailyCap: 0 },
          };
        }
      },
      // 桌面只读观察（F145 的工具层）：执行器是仓库里的 PowerShell 脚本，路径由宿主算好递进来，
      // 工具层不猜仓库在哪。输入动作不经过这里——那要人在命令行显式开闸。
      desktop: {
        powershellExe: process.env.ACE_POWERSHELL ?? "powershell",
        scriptPath: join(fileURLToPath(new URL("../../", import.meta.url)), "tools", "desktop", "desktop.ps1"),
        outDir: join(conf.dataDir, "screens"),
        // 只用来**读**租约状态（soul_desktop action=lease）；这个装配点永远不开输入闸
        leasePath: join(conf.dataDir, "desktop-lease.json"),
      },
      // 窗口通道的"发内容"能力与 qq.enabled 解耦：只开 OneBot 收消息时，
      // 工具里照样能让她往 QQ 发文件/图片（走同一条输入桥 + 剪贴板）。
      sender: windowSender,
      dispatch: dispatchQQSend,
      // 用 getter 而不是快照：OneBot 桥在 startOneBot 里才建出来，而工具调用发生在 apply 之后。
      // 优先级与后台线程一致（OneBot 优先）；两个桥都没有时返回 null，工具自己报"未启用"。
      get proactive() {
        return onebotSlot.bridge ?? qqBridge;
      },
    });
    scope.effect(() => {
      try {
        const disposers = defs.map((d) => scope.tools.register(d));
        ctx.logger?.info(`ai-companion-engine: 已注册 ${disposers.length} 个 soul_* 工具`);
        report.registered = disposers.map((_, i) => defs[i]?.name ?? `#${i}`);
        report.panelRoute = report.panelRoute ?? "pending";
        flush();
        return () => {
          for (const dispose of disposers) dispose();
        };
      } catch (err) {
        report.error = `注册失败：${String(err)}`;
        flush();
        throw err;
      }
    }, "ai-companion-engine: soul tools");
  };

  if (typeof ctx.inject === "function") ctx.inject(["tools"], register as (scope: never) => void);
  else if (ctx.tools !== undefined && typeof ctx.effect === "function") {
    // 兜底：宿主没提供 inject 时直接用当前 ctx（老 profile 的 ctx 本身带 tools）
    register({ tools: ctx.tools, effect: ctx.effect.bind(ctx) });
  } else {
    throw new Error("宿主上下文既没有 inject 也没有 tools——ai-companion-engine 无法注册工具");
  }

  try {
    const order = ctx.systemPrompt?.getSectionOrder?.("STRUCTURED_OUTPUT");
    const section: PromptSection = { name: "ai-companion-engine:usage", text: PROMPT_SECTION };
    if (typeof order === "number") section.order = order;
    ctx.systemPrompt?.section(section);
    // F326 方案 A：人格卡删掉后，DSH 侧「她是谁」只剩这段机制协议（不含名字/设定）。
    // 它排在工具协议之前：先定身份协议（4 条），再说怎么调工具。
    const identity: PromptSection = { name: "ai-companion-engine:identity", text: PROTOCOL_IDENTITY };
    if (typeof order === "number") identity.order = order - 1;
    ctx.systemPrompt?.section(identity);
  } catch (err) {
    ctx.logger?.warn?.(`ai-companion-engine: 系统提示注入失败（不影响工具）：${String(err)}`);
  }

  // F326 方案 A：人格卡注入整段删除。DSH 系统提示里不再出现「她是谁」的静态内容；
  // 身份由 PROTOCOL_IDENTITY（4 条身份协议）+ 召回段（记忆）承担。
  registerPanelRoute(ctx, runtime, conf, report, flush);
  registerAvatarRoute(ctx, conf, report, flush);
  registerAnswerRoute(ctx, runtime, conf, report, flush);
  registerBiliQrRoute(ctx, conf, report, flush);
  registerSoulRoute(ctx, report, flush);
  registerChatRoutes(ctx, conf, clock, report, flush);
  if (qqBridge !== null) startQQPolling(ctx, clock, conf, qqBridge, config.qq ?? {});
  // OneBot 与窗口通道独立：qq.enabled=false 也能只开它
  const onebotBridge = startOneBot(ctx, clock, runtime, conf, config.qq ?? {}, onebotSlot, report, flush);
  // 主动开口只在常驻进程里（意向引擎的 speak 出口）：插件不再有自己的定时主动路径。
  // 这条路径 2026-11-01 删除（F271，审计 L3/附录 C 改判：插件不产生自主行为）。
}

/**
 * 造一个"只负责发"的窗口通道：不读 inbox、不判定该不该回、不碰状态文件。
 * 单独拉出来是因为它跟 `qq.enabled` 没有关系——那个开关管的是"要不要收消息"。
 */
function makeWindowSender(
  conf: SoulConfig,
  cfg: QQConfig,
  log: (line: string) => void,
): (target: { readonly kind: "text" | "image" | "file"; readonly payload: string }) => Promise<{
  readonly ok: boolean;
  readonly detail: string;
}> {
  const root = cfg.root ?? "qq-ops";
  const deps = makeHostDeps({
    root,
    dataDir: conf.dataDir,
    characterId: conf.characterId,
    clock: new SystemClock(),
    qq: DEFAULT_QQ_OPTIONS,
    ...(cfg.hwnd === undefined ? {} : { hwnd: cfg.hwnd }),
    log,
  });
  const sendContent = deps.sendContent;
  if (sendContent === undefined) {
    return async () => ({ ok: false, detail: "窗口通道没有提供 sendContent（这个宿主版本不支持发内容）" });
  }
  return (target) => sendContent(target);
}

/**
 * 窗口通道与 OneBot 共用同一条判定口径（静默时段、最小间隔、限速）。
 * 只有 dryRun 各管各的：想先让 OneBot 试运行、窗口照旧，也说得通。
 */
function makeQQOptions(cfg: QQConfig, dryRun: boolean): QQOptions {
  return {
    peer: cfg.peer ?? DEFAULT_QQ_OPTIONS.peer,
    selfSenders: DEFAULT_QQ_OPTIONS.selfSenders,
    quietFrom: cfg.quietFrom ?? DEFAULT_QQ_OPTIONS.quietFrom,
    quietTo: cfg.quietTo ?? DEFAULT_QQ_OPTIONS.quietTo,
    minGapMs: Math.max(1, cfg.minGapSec ?? DEFAULT_QQ_OPTIONS.minGapMs / 1000) * 1000,
    maxPerHour: Math.max(1, cfg.maxPerHour ?? DEFAULT_QQ_OPTIONS.maxPerHour),
    ignoreOlderThanMs: DEFAULT_QQ_OPTIONS.ignoreOlderThanMs,
    dryRun,
    tag: DEFAULT_QQ_OPTIONS.tag,
  };
}

/**
 * P0-F：插件 host 侧的回信记忆旁路（OneBot 与窗口桥共用）。
 *
 * 插件自己持有 runtime，直接 `runtime.remember`（不走写通道）；失败只记日志，
 * 不影响已经发出去的回复。当前 owner=autonomy 时这两条桥不是生产路径，
 * 但接口对称，切回宿主 owner 时不会「换通道就失忆」。
 */
function makeRememberReply(
  runtime: SoulRuntime,
  conf: SoulConfig,
  clock: SystemClock,
): (reply: string) => void {
  return (reply: string) => {
    try {
      const seed = chatReplyMemorySeed({ reply, tags: ["chat", "qq"] });
      runtime.remember({ ...seed, tags: [...seed.tags] });
    } catch (err) {
      appendQQLog(conf, clock.now(), `[qq] 回信写记忆失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/**
 * 造一个 QQ 桥实例。
 *
 * 依赖注入点只有三处：收件箱目录、`qqbus.sh`、宿主 `llm`。前两者来自 qq-ops 的约定，
 * 后者是宿主服务（可选）——拿不到 llm 时桥仍能当"筛选器"用，只是生成会抛错并被记录。
 */
function makeQQBridge(
  ctx: PluginContext,
  clock: SystemClock,
  runtime: SoulRuntime,
  conf: SoulConfig,
  cfg: QQConfig,
): QQBridge {
  const root = cfg.root ?? "qq-ops";
  // 默认试运行：开启桥不等于允许她真的往外说话
  const opts: QQOptions = makeQQOptions(cfg, cfg.dryRun ?? true);
  const deps = makeHostDeps({
    root,
    dataDir: conf.dataDir,
    characterId: conf.characterId,
    clock,
    qq: opts,
    ...(cfg.hwnd === undefined ? {} : { hwnd: cfg.hwnd }),
    ...(ctx.get?.("llm") === undefined ? {} : { llm: ctx.get("llm") as never }),
    ...(ctx.get?.("agentDefaultModel") === undefined ? {} : { defaultModel: ctx.get("agentDefaultModel") as never }),
    attachments: () => ctx.get?.("attachments") as never,
    log: (line) => appendQQLog(conf, clock.now(), line),
  });
  // 记忆与知识按「对方这句话」召回，接在系统提示后面：没有这一句，她的回答会只剩气氛
  const depsWithRecall = {
    ...deps,
    // F297：判断在大脑层，宿主只把它接进来（工具层不再自己决定"这句话算不算冒犯"）
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    recall: (text: string) => {
      // §8.3：窗口桥只在宿主里跑、面向用户本人，所以是主人视角（同 qq-runner 的说明）
      // §5.2：具体性 streak 跨回合存在 data/ 里——丢了它，「连续 20 次」永远凑不满，放宽条件等于不存在。
      const streakPath = workingSelfStatePathInDataDir(conf.dataDir, conf.characterId);
      const prev = readWorkingSelfState(streakPath, clock.now());
      if (prev.errors.length > 0) {
        appendQQLog(conf, clock.now(), `[recall] 具体性状态文件损坏（${prev.errors[0] ?? ""}），本轮按 0 起算`);
      }
      const r = recallForDialogue(runtime, text, OWNER_VISITOR, "gui", {
        values: workingSelfValuesFrom(runtime.persona()?.personality),
        lowConcretenessStreak: prev.state.lowConcretenessStreak,
        relaxFactor: prev.state.relaxFactor,
      });
      // §5.2 的可观测要求：没有报警时不刷屏，有报警时一定落日志
      const alarm = r.workingSelf === undefined ? null : describeWorkingSelfAlarm(r.workingSelf);
      if (alarm !== null) appendQQLog(conf, clock.now(), alarm);
      // F285（批次 2c）：具体性 streak 曾经在这里写盘，和常驻进程的 qq-runner 是**两个写者**，
      // 后写的人会用旧值盖掉新值（「连续 20 次」永远凑不满）。现在宿主侧只读不写：
      // 这个文件的唯一写者是持写锁的自主进程；宿主拿到的 streak 只用于本回合是否放宽。
      appendQQLog(conf, clock.now(), `[recall] q=${text.slice(0, 16)} m=${r.memories.length} k=${r.knowledge.length}${r.workingSelf === undefined ? "" : ` ws=${r.workingSelf.note}`}`);
      return r;
    },
    // P0-F：回信入记忆。插件 host 当前在 owner=autonomy 下不是生产路径，但同一接口不该只修一半；
    // 直写本进程 runtime（不走写通道），失败只记日志、不影响已发出的回复。
    rememberReply: makeRememberReply(runtime, conf, clock),
    // F272：桥不再直接调本进程 turn（那是第二个写者），投给自主进程的写通道。
    turn: makeChannelTurn({
      dataDir: conf.dataDir,
      characterId: conf.characterId,
      reload: () => {
        runtime.reloadState();
      },
    }),
  };
  return new QQBridge(runtime, opts, depsWithRecall, loadQQState(conf.dataDir, conf.characterId));
}

/** 轮询循环。并发保护是必要的：一轮里要读文件、推状态、调模型、发消息，可能超过间隔 */
function startQQPolling(
  ctx: PluginContext,
  clock: SystemClock,
  conf: SoulConfig,
  bridge: QQBridge,
  cfg: QQConfig,
): void {
  const intervalMs = Math.max(5, cfg.intervalSec ?? 15) * 1000;
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void bridge
      .poll()
      .then((r) => {
        if (r.reason !== "idle") appendQQLog(conf, clock.now(), `[qq] ${r.reason}: ${r.detail}`);
      })
      .catch((err: unknown) => {
        appendQQLog(conf, clock.now(), `[qq] error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        busy = false;
      });
  };
  try {
    if (ctx.timer !== undefined) {
      const off = ctx.timer.interval(tick, intervalMs);
      ctx.effect?.(() => off, "ai-companion-engine: qq polling");
    } else {
      const handle = setInterval(tick, intervalMs);
      (handle as unknown as { unref?: () => void }).unref?.();
      ctx.effect?.(() => () => clearInterval(handle), "ai-companion-engine: qq polling");
    }
    ctx.logger?.info(`ai-companion-engine: QQ 桥已启动（间隔 ${intervalMs / 1000}s，dryRun=${String(bridge.status().dryRun)}）`);
  } catch (err) {
    ctx.logger?.warn?.(`ai-companion-engine: QQ 轮询启动失败（不影响工具）：${String(err)}`);
  }
}

/** QQ 桥的流水账：一行一个 JSON，用户 `tail -f data/qq-*.log` 就能看见她回了什么 */
function appendQQLog(conf: SoulConfig, atMs: number, line: string): void {
  try {
    mkdirSync(conf.dataDir, { recursive: true });
    writeFileSync(
      join(conf.dataDir, `qq-${conf.characterId}.log`),
      `${JSON.stringify({ at: atMs, line })}\n`,
      { encoding: "utf8", flag: "a" },
    );
  } catch {
    // 日志写不出去不影响回帖
  }
}

/**
 * 立绘端点：`GET /plugins/ai-companion-engine/avatar?f=<文件名>`。
 *
 * 安全边界（这是插件里唯一按外部参数读文件的入口）：
 *   1. 只接受**单个文件名**：含 `/`、`\`、`..`、空串一律 404；
 *   2. 解析后的绝对路径必须仍在包内 `assets/` 之下（防止符号链接/拼接穿越）；
 *   3. 只给几个明确的白名单扩展名，其余 404；
 *   4. 未配置人格卡或卡里没 `avatar` 时 404——不猜、不回退到别的角色图。
 */
/**
 * 面板「当场回一句」端点（F299 / 审计 P1-9 交互半）。
 *
 * 工具层负责协议（`createAnswerHandler`），业务是大脑层的 `answerPanelRequest`：
 * 先确认收件箱里真有这条请求，再写人侧回执（不是她的状态，所以不违反单写者纪律）。
 * 注册状态写进自检报告，headless profile 下注册不到 webServer 是正常现象。
 */
function registerAnswerRoute(
  ctx: PluginContext,
  runtime: SoulRuntime,
  conf: SoulConfig,
  report: ApplyReport,
  flush: () => void,
): void {
  const route = {
    kind: "exact" as const,
    path: ANSWER_PATH,
    handler: createAnswerHandler({
      answer: (body) =>
        answerPanelRequest({
          dataDir: conf.dataDir,
          characterId: conf.characterId,
          nowMs: runtime.now(),
          request: body,
        }),
    }),
  };

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.answerRoute = "no-webServer（headless profile 正常现象）";
      flush();
      return;
    }
    const bind = (): (() => void) | void => {
      const off = web.register(route);
      report.answerRoute = "registered";
      flush();
      if (typeof off === "function") {
        return () => {
          try {
            off();
          } catch {
            // 拆除失败不该阻断卸载流程
          }
        };
      }
      return undefined;
    };
    try {
      scope.effect(bind, "ai-companion-engine: panel answer route");
    } catch (err) {
      report.answerRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], mount as (scope: never) => void);
    return;
  }
  const service = ctx.get?.("webServer") ?? ctx.get?.("httpServer");
  if (service === undefined) return;
  mount({
    webServer: service as WebServerLike,
    effect: (fn) => {
      if (typeof ctx.effect === "function") ctx.effect(fn, "ai-companion-engine: panel answer route");
      else fn();
    },
  });
}

function registerAvatarRoute(
  ctx: PluginContext,
  conf: SoulConfig,
  report: ApplyReport,
  flush: () => void,
): void {
  const route = {
    kind: "exact" as const,
    path: AVATAR_ROUTE_PATH,
    handler: createAvatarHandler(conf),
  };

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.avatarRoute = "no-webServer（headless profile 正常现象）";
      flush();
      return;
    }
    try {
      scope.effect(() => {
        const off = web.register(route);
        report.avatarRoute = "registered";
        flush();
        if (typeof off === "function") {
          return () => {
            try {
              off();
            } catch {
              // 拆除失败不阻断卸载
            }
          };
        }
        return undefined;
      }, "ai-companion-engine: avatar route");
    } catch (err) {
      report.avatarRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  try {
    ctx.inject?.(["webServer"], mount);
  } catch (err) {
    report.avatarRoute = `inject 失败：${String(err)}`;
    flush();
  }
}

function registerBiliQrRoute(
  ctx: PluginContext,
  conf: SoulConfig,
  report: ApplyReport,
  flush: () => void,
): void {
  const route = {
    kind: "exact" as const,
    path: BILI_QR_PATH,
    handler: createBiliQrHandler({ conf, log: (line: string) => ctx.logger?.info(line) }),
  };

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.biliQrRoute = "no-webServer（headless profile 正常现象）";
      flush();
      return;
    }
    try {
      scope.effect(() => {
        const off = web.register(route);
        report.biliQrRoute = "registered";
        flush();
        if (typeof off === "function") {
          return () => {
            try {
              off();
            } catch {
              // 拆除失败不阻断卸载
            }
          };
        }
        return undefined;
      }, "ai-companion-engine: bili qr route");
    } catch (err) {
      report.biliQrRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  try {
    ctx.inject?.(["webServer"], mount);
  } catch (err) {
    report.biliQrRoute = `inject 失败：${String(err)}`;
    flush();
  }
}

/**
 * 工作台（P4-4 P1）：三条只读静态路由。
 *
 * 与面板状态端点同一个坑（见 registerPanelRoute）：宿主可能还没绑定 webServer，
 * 所以走 `ctx.inject(['webServer'], …)`；注册结果写进自检报告（`soulRoute`），
 * 页面打不开时能区分"没有 webServer"与"注册失败/被挡"。
 */
function registerSoulRoute(
  ctx: PluginContext,
  report: ApplyReport,
  flush: () => void,
): void {
  const routes = [
    { kind: "exact" as const, path: SOUL_PAGE_PATH, handler: createSoulPageHandler() },
    { kind: "exact" as const, path: SOUL_CSS_PATH, handler: createSoulAssetHandler("soul.css", "text/css; charset=utf-8") },
    { kind: "exact" as const, path: SOUL_JS_PATH, handler: createSoulAssetHandler("soul.js", "text/javascript; charset=utf-8") },
  ];

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.soulRoute = "no-webServer（headless profile 正常现象）";
      flush();
      return;
    }
    try {
      scope.effect(() => {
        const offs: (() => void)[] = [];
        for (const route of routes) {
          const off = web.register(route);
          if (typeof off === "function") offs.push(off);
        }
        report.soulRoute = "registered";
        flush();
        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              // 拆除失败不阻断卸载
            }
          }
        };
      }, "ai-companion-engine: soul route");
    } catch (err) {
      report.soulRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  try {
    ctx.inject?.(["webServer"], mount);
  } catch (err) {
    report.soulRoute = `inject 失败：${String(err)}`;
    flush();
  }
}

/**
 * P2 网页聊天：三条路由（meta / history / send）+ CSRF token。
 *
 * token 在插件启动时生成一次：页面从 meta 取、POST 回带。
 * 它防的是"别的站点的页面拿本机浏览器当枪"，不是身份认证（本机单用户）。
 * 业务在 daemon 的 `op:"chat"`：插件只做 HTTP 与 CSRF，不 import 大脑（R3）。
 */
const CHAT_CSRF = randomBytes(16).toString("hex");

function registerChatRoutes(
  ctx: PluginContext,
  conf: SoulConfig,
  clock: SystemClock,
  report: ApplyReport,
  flush: () => void,
): void {
  // P2.1（task-157）：写通道调用下沉到 channel-chat.ts（与 channel-turn.ts 同构），
  // 这里只做 ChatResult → ChatSendOutcome 的映射；通道错误码原样透传给路由层。
  const chatCall = makeChannelChat({ dataDir: conf.dataDir, characterId: conf.characterId });
  const call = async (text: string): Promise<ChatSendOutcome> => {
    try {
      const result = await chatCall(text);
      return {
        ok: true,
        reply: result.reply,
        ...(result.mode === undefined ? {} : { mode: result.mode }),
        ...(result.stage === undefined ? {} : { stage: result.stage }),
      };
    } catch (err) {
      const code = err instanceof ChatChannelError ? err.code : "daemon-unavailable";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code, message };
    }
  };

  const routes = [
    { kind: "exact" as const, path: CHAT_META_PATH, handler: createChatMetaHandler({ csrf: CHAT_CSRF }) },
    {
      kind: "exact" as const,
      path: CHAT_HISTORY_PATH,
      handler: createChatHistoryHandler({ dataDir: conf.dataDir, characterId: conf.characterId }),
    },
    {
      kind: "exact" as const,
      path: CHAT_SEND_PATH,
      handler: createChatSendHandler({ csrf: CHAT_CSRF, call, now: () => clock.now() }),
    },
  ];

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.chatRoute = "no-webServer（headless profile 正常现象）";
      flush();
      return;
    }
    try {
      scope.effect(() => {
        const offs: (() => void)[] = [];
        for (const route of routes) {
          const off = web.register(route);
          if (typeof off === "function") offs.push(off);
        }
        report.chatRoute = "registered";
        flush();
        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              // 拆除失败不阻断卸载
            }
          }
        };
      }, "ai-companion-engine: chat routes");
    } catch (err) {
      report.chatRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  try {
    ctx.inject?.(["webServer"], mount);
  } catch (err) {
    report.chatRoute = `inject 失败：${String(err)}`;
    flush();
  }
}

/**
 * UI 面板的数据端点：`GET /plugins/ai-companion-engine/state`。
 *
 * 两个坑（都是实测踩的）：
 *   1. **不能在 apply 里直接 `ctx.get('webServer')` 就用**：宿主可能还没绑定 webServer，
 *      取到 undefined 后永远不注册，表现为"面板在、但读不到状态"。所以优先走
 *      `ctx.inject(['webServer'], …)`——cordis 会在服务可用时才回调。
 *   2. 路由本身是否受鉴权保护由宿主的 web 层决定；这里不做假设，注册结果写进
 *      自检报告（`panelRoute`），把"没注册"和"被挡住"分开。
 */
function registerPanelRoute(
  ctx: PluginContext,
  runtime: SoulRuntime,
  conf: SoulConfig,
  report: ApplyReport,
  flush: () => void,
): void {
  const route = {
    kind: "exact" as const,
    path: PANEL_STATE_PATH,
    handler: createStateHandler({
      // F295：装配根注入"怎么算一页面板"，工具层只负责把 JSON 写出去。
      buildPayload: () => {
        const nowMs = runtime.now();
        const facts = readPanelFacts({ dataDir: conf.dataDir, characterId: conf.characterId, nowMs });
        const fresh = readPanelStateSnapshotFile(panelStateSnapshotPath(conf.dataDir, conf.characterId), { nowMs });
        return panelPayload(runtime, conf, facts, fresh);
      },
    }),
  };

  const mount = (scope: WebScope): void => {
    const web = scope.webServer;
    if (web === undefined || typeof web.register !== "function") {
      report.panelRoute = "no-webServer（headless profile 正常现象）";
      flush();
      ctx.logger?.info("ai-companion-engine: 没有 webServer，跳过面板端点");
      return;
    }
    // 必须把 register 返回的 disposer 交还给 cordis（effect 的返回值就是拆除函数）。
    // 忽略它会怎样：禁用/启用一次插件后旧路由仍在表里，新实例注册报
    // `webserver: duplicate exact route`，而**请求继续打到旧实例**——
    // 表现为"改了人格卡、面板名字没变"，非常难查（本轮实测踩到）。
    const bind = (): (() => void) | void => {
      const off = web.register(route);
      report.panelRoute = "registered";
      flush();
      if (typeof off === "function") {
        return () => {
          try {
            off();
          } catch {
            // 拆除失败不该阻断卸载流程
          }
        };
      }
      return undefined;
    };
    try {
      scope.effect(bind, "ai-companion-engine: panel state route");
    } catch (err) {
      report.panelRoute = `register 失败：${String(err)}`;
      flush();
    }
  };

  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], mount as (scope: never) => void);
    return;
  }
  const service = ctx.get?.("webServer") ?? ctx.get?.("httpServer");
  if (service === undefined) {
    ctx.logger?.info("ai-companion-engine: 没有 webServer，跳过面板端点");
    return;
  }
  const web = service as WebServerLike;
  const fallback: WebScope = {
    webServer: web,
    effect: (fn) => {
      if (typeof ctx.effect === "function") ctx.effect(fn, "ai-companion-engine: panel state route");
      else fn();
    },
  };
  mount(fallback);
}

interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  /** 宿主传进来的是 Node 的 ServerResponse，二进制（png/jpg）用 Uint8Array 写 */
  end(body: string | Uint8Array): void;
}

interface WebServerLike {
  register(route: { kind: "exact"; path: string; handler: (req: unknown, res: WebResponseLike) => void }): (() => void) | void;
}

// ---------- OneBot v11 通道 ----------

/** NapCat / LLOneBot 的默认 HTTP 端口 */
const ONEBOT_DEFAULT_BASE_URL = "http://127.0.0.1:3000";
/** Universal WebSocket（事件与 API 合用同一个连接） */
const ONEBOT_DEFAULT_WS_URL = "ws://127.0.0.1:3001";
/** 与窗口通道同一个上限：QQ 截图动辄几 MB */
const ONEBOT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * 只有这些「真的发生了一件事」的结果进流水账。
 * 静默时段/去重/非目标每来一条事件都会命中，全写进日志会把有用的行淹掉。
 */
const ONEBOT_LOG_REASONS: ReadonlySet<string> = new Set([
  "replied",
  "dry-run",
  "send-failed",
  "llm-failed",
  "engine-failed",
  "empty-reply",
]);

/**
 * 把事件里的图片引用读成字节。OneBot 给的 `url` 是可直接取的 HTTP 地址
 * （优先用它），`file` 多半是对方机器上的文件名——本地读不到就返回 null，
 * 桥那边会降级成「对方发来一张图片」的文字提示，不会瞎猜图里是什么。
 */
async function readOneBotImage(
  hostDeps: HostQQDeps,
  ref: InboundImage,
): Promise<QQImageBytes | null> {
  if (ref.path.startsWith("http://") || ref.path.startsWith("https://")) {
    const response = await fetch(ref.path, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > ONEBOT_MAX_IMAGE_BYTES) return null;
    // 按魔数判类型：URL 的 content-type 有时是 application/octet-stream
    const mediaType = sniffImageMediaType(data);
    if (mediaType === null) return null;
    return { data, mediaType, name: ref.name };
  }
  return (await hostDeps.readImage?.(ref.path)) ?? null;
}

/**
 * 启动 OneBot 监听。失败**不影响**插件其余部分：状态写进 apply-report
 * 与 `soul_qq_status`，由人去查为什么连不上。
 *
 * token 的唯一去处是请求头与 WS 的 query；日志与报告里只说「已设置/无」。
 */

/**
 * 一个回合的写锁（见 docs/OPERATIONS.md §单写者）：
 * 只在真正接待消息时占用，接待完就放；常驻进程在两次接待之间照常跑自己的轮次。
 * staleMs=0 表示"宿主优先"——用户在等回信，不能因为自主进程占了锁就不吭声。
 */
function turnWriteLock(ctx: PluginContext, clock: SystemClock, conf: SoulConfig, runtime: SoulRuntime): () => void {
  const lock = acquireWriterLock({
    path: join(conf.dataDir, ".writer-lock"),
    pid: process.pid,
    owner: "host",
    now: clock.now(),
    staleMs: 0,
    note: "QQ 接待中（本回合）",
  });
  if (lock === null) {
    // 拿不到锁 = daemon 正在推进。这时不重读、也不假装能落盘：save 会被 state-guard 拒绝，
    // 宁可这一回合的状态推进只留在内存里，也不要用旧快照覆盖她的状态（批次 2a）。
    ctx.logger?.warn?.("ai-companion-engine: 接待写锁没拿到（本回合不落盘，避免覆盖自主进程的状态）");
    return () => {
      /* no-op */
    };
  }
  // 拿到锁后先把状态文件重读一遍：这一回合基于 daemon 推进后的最新状态，而不是启动时的旧快照。
  runtime.reloadState();
  return () => {
    releaseWriterLock(lock);
  };
}

function startOneBot(
  ctx: PluginContext,
  clock: SystemClock,
  runtime: SoulRuntime,
  conf: SoulConfig,
  cfg: QQConfig,
  slot: { state: string; bridge: OneBotBridge | null },
  report: ApplyReport,
  flush: () => void,
): OneBotBridge | null {
  const onebot = cfg.onebot;
  if (onebot === undefined || onebot.enabled !== true) {
    slot.state = "disabled";
    report.onebot = "disabled";
    flush();
    return null;
  }
  if (onebot.owner === "autonomy") {
    // 桥已移交给常驻进程：插件不建监听、不抢写锁，只在报告里如实写"delegated"
    slot.state = "delegated";
    report.onebot = "delegated";
    flush();
    ctx.logger?.info("ai-companion-engine: OneBot 已移交常驻进程（qq.onebot.owner=autonomy），插件只观察");
    return null;
  }
  const peer = onebot.peer;
  if (peer === undefined) {
    slot.state = "error:qq.onebot.peer 未配置";
    report.onebot = slot.state;
    flush();
    ctx.logger?.warn?.("ai-companion-engine: OneBot 未启动（qq.onebot.peer 没有填 QQ 号）");
    return null;
  }

  const baseUrl = onebot.baseUrl ?? ONEBOT_DEFAULT_BASE_URL;
  const wsUrl = onebot.wsUrl ?? ONEBOT_DEFAULT_WS_URL;
  const token = onebot.token ?? "";
  // WebSocket 的 access_token 常常和 HTTP Bearer 不是同一个，分开取
  const wsToken = onebot.wsToken ?? token;
  const dryRun = onebot.dryRun ?? true;
  const tokenNote = token === "" ? "无 token" : "token 已设置";

  try {
    const hostOpts = makeQQOptions(cfg, dryRun);
    // 复用宿主 LLM 管道（与窗口通道同一条 generate），不另写一套模型调用
    const hostDeps = makeHostDeps({
      root: cfg.root ?? "qq-ops",
      dataDir: conf.dataDir,
      characterId: conf.characterId,
      clock,
      qq: hostOpts,
      ...(ctx.get?.("llm") === undefined ? {} : { llm: ctx.get("llm") as never }),
      ...(ctx.get?.("agentDefaultModel") === undefined ? {} : { defaultModel: ctx.get("agentDefaultModel") as never }),
      attachments: () => ctx.get?.("attachments") as never,
      log: (line) => appendQQLog(conf, clock.now(), line),
    });

    // 语音：TTS/ASR 都跑在宿主外的 python 小工具里（见 src/qq/voice.ts 的取舍注释）。
    // python 解释器默认走 PATH；装依赖时用的是同一个，换解释器只改 ACE_PYTHON。
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const voiceDeps: VoiceToolDeps = {
      pythonExe: process.env.ACE_PYTHON ?? "python",
      pylibsDir: join(repoRoot, ".pylibs"),
      asrScript: join(repoRoot, "tools", "voice", "asr.py"),
      asrModel: join(conf.dataDir, "whisper-base"),
      outDir: join(conf.dataDir, "voice"),
      tmpDir: join(repoRoot, ".tmp"),
      now: () => clock.now(),
      log: (line) => appendQQLog(conf, clock.now(), line),
    };
    const sendDeps: OneBotSendDeps = { baseUrl, token };

    const bridge = new OneBotBridge(
      runtime,
      makeOneBotOptions({
        peer,
        dryRun,
        quietFrom: hostOpts.quietFrom,
        quietTo: hostOpts.quietTo,
        minGapMs: hostOpts.minGapMs,
        maxPerHour: hostOpts.maxPerHour,
        ...(cfg.peer === undefined ? {} : { peerName: cfg.peer }),
      }),
      {
        now: () => clock.now(),
        localHour: () => clock.localHour(),
        // F297：OneBot 桥也不自己判断，判定从大脑层注入
        appraise: appraiseFromText,
        // 一回合一把锁：接待时宿主占写权，接待完释放，自主进程在间隙里照常跑
        beginTurn: () => turnWriteLock(ctx, clock, conf, runtime),
        // F272：回合本体投给唯一写者（写通道），插件不再自己 turn/落盘。
        turn: makeChannelTurn({
          dataDir: conf.dataDir,
          characterId: conf.characterId,
          reload: () => {
            runtime.reloadState();
          },
        }),
        readImage: (ref) => readOneBotImage(hostDeps, ref),
        // 审计 P0-2：宿主通道的模型调用也要进账本，否则 health 与额度只看得见 daemon 那一半。
        // 与 daemon 共用 data/autonomy-usage.json（read-modify-write）：两进程偶发同时写时
        // 最坏少记一条、不会多记（少记只会让审核偏严，不会让她被误判超额）。
        generate: async (input) => {
          const text = await hostDeps.generate(input);
          try {
            recordUsageOnce(join(conf.dataDir, "autonomy-usage.json"), clock.now());
          } catch (err) {
            ctx.logger?.warn?.(
              `ai-companion-engine: 记账失败（不影响回复）：${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return text;
        },
        send: async ({ peer: target, text }) => {
          void target;
          // 出站走窗口通道：电脑端 QQ 能看到她发的这句话（hook 代发不会渲染在本地）
          const sent = await hostDeps.send(text);
          const detail = `window: ${sent.detail}`;
          return { ok: sent.ok, detail };
        },
        transcribeVoice: async (ref) => {
          const file = await fetchVoiceFile(voiceDeps, ref.path);
          return transcribeAudio(voiceDeps, file);
        },
        sendVoice: async ({ peer: target, text }) => {
          const file = await synthesizeSpeech(voiceDeps, text);
          const sent = await sendPrivateRecord(sendDeps, { peer: target, file });
          return { ok: sent.ok, detail: `record: ${sent.detail}` };
        },
        saveState: (state) => saveQQState(conf.dataDir, conf.characterId, state),
        dialogue: createDialoguePort(),
        language: createLanguagePort(),
        recall: (text) => {
          const r = recallForDialogue(runtime, text, undefined, "gui", {
            values: workingSelfValuesFrom(runtime.persona()?.personality),
          });
          const alarm = r.workingSelf === undefined ? null : describeWorkingSelfAlarm(r.workingSelf);
          if (alarm !== null) appendQQLog(conf, clock.now(), alarm);
          appendQQLog(conf, clock.now(), `[recall] q=${text.slice(0, 16)} m=${r.memories.length} k=${r.knowledge.length}${r.workingSelf === undefined ? "" : ` ws=${r.workingSelf.note}`}`);
          return r;
        },
        // P0-F：回信入记忆（与窗口桥同语义；直写 runtime、失败只记日志）。
        rememberReply: makeRememberReply(runtime, conf, clock),
        // §4.9 阶段 0 的状态门：阈值从注册表取，qq 层不直接读配置
        gates: () => runtime.proactiveGates(),
        log: (line) => appendQQLog(conf, clock.now(), line),
      },
      loadQQState(conf.dataDir, conf.characterId),
    );

    const relayScript = fileURLToPath(new URL("../../scripts/ws-relay.mjs", import.meta.url));
    const listener = startWsRelay({
      scriptPath: relayScript,
      wsUrl,
      token: wsToken,
      outFile: join(conf.dataDir, `onebot-relay-${conf.characterId}.jsonl`),
      onEvent: (event) => {
        void bridge
          .handle(event as never)
          .then((r) => {
            if (!ONEBOT_LOG_REASONS.has(r.reason)) return;
            appendQQLog(
              conf,
              clock.now(),
              `[onebot] ${r.reason}: ${r.detail}${r.reply === undefined ? "" : ` | ${r.reply}`}`,
            );
          })
          .catch((err: unknown) => {
            appendQQLog(conf, clock.now(), `[onebot] error: ${err instanceof Error ? err.message : String(err)}`);
          });
      },
      log: (line) => appendQQLog(conf, clock.now(), line),
    });
    // 卸载插件时断开且不再重连。宿主 context 没有 effect 时不要把 stop 静默丢掉：
    // 那是"旧 relay 没人收尸"的经典入口，先告警，剩下的交给 startWsRelay 的单实例守卫兜底。
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => {
        // 带原因进日志：宿主卸载/热重载是"没有退出日志"的历史盲区，留一行能对上账
        listener.stop("宿主卸载（ctx.effect disposer）");
      }, "ai-companion-engine: onebot ws");
    } else {
      ctx.logger?.warn?.(
        "ai-companion-engine: 上下文没有 effect，无法在卸载时停 relay；靠 startWsRelay 的单实例守卫兜底",
      );
    }

    slot.bridge = bridge;
    slot.state = "listening";
    report.onebot = "listening";
    flush();
    ctx.logger?.info(
      `ai-companion-engine: OneBot 已启动（peer=${String(peer)} ws=${wsUrl} dryRun=${String(dryRun)} ${tokenNote}）`,
    );
    return bridge;
  } catch (err) {
    const message = redactSecret(err instanceof Error ? err.message : String(err), token);
    slot.state = `error:${message}`;
    report.onebot = slot.state;
    flush();
    ctx.logger?.warn?.(`ai-companion-engine: OneBot 启动失败：${message}`);
    return null;
  }
}
