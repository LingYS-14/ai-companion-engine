/**
 * OneBot v11 客户端（不是适配器的全部，只是「收发两端」）。
 *
 * 为什么要有这条通道：窗口自动化那条路（`send.ts` + 剪贴板）必须让 QQ 窗口保持
 * 可见、可点击，一次发送要 1–2 秒点五次，还会跟人抢鼠标键盘。OneBot 是
 * 「HTTP 发 + WebSocket 收」，一样是机器人账号在说话，但不碰桌面。
 *
 * 这个文件只做三件事，**不含任何业务判断**（判定在 onebot-bridge.ts）：
 *   1. 事件归一化：OneBot 的段数组 → 复用的 `InboundImage` + 正文；
 *   2. 发送：`POST {baseUrl}/send_private_msg`，非 0 retcode 或非 2xx 直接抛错；
 *   3. 长连接：全局 `WebSocket` 连 `wsUrl`，断了按 3s→30s 指数退避重连。
 *
 * 三条硬约束：
 *   - 不读墙钟：重连退避一律走注入的 `setTimeoutFn`，否则测试没法控制时间；
 *   - 不打印 token：错误信息统一过 `redact()`，token 只出现在 Authorization 头里；
 *   - 不引依赖：Node 22+ 自带 `WebSocket` 与 `fetch`。
 */

import type { InboundImage } from "./inbound.js";

// ---------- 事件模型（OneBot v11） ----------

export interface OneBotTextData {
  readonly text: string;
}

/**
 * 图片段。三个字段各实现的填法不一样：
 *   - `url` 是可直接 HTTP 取的地址（最可靠）；
 *   - `file` 是本地文件名，或 `base64://…`——跨机器时取不到；
 *   - `summary` 是 QQ 给的占位文字（`[图片]`）。
 */
export interface OneBotImageData {
  readonly file?: string;
  readonly url?: string;
  readonly summary?: string;
}

export interface OneBotTextSegment {
  readonly type: "text";
  readonly data: OneBotTextData;
}

export interface OneBotImageSegment {
  readonly type: "image";
  readonly data: OneBotImageData;
}

/**
 * 其余所有段（record/file/face/at/reply/json/forward…）。
 * `type` 保留原样——用来计数和排查，不参与正文。
 */
export interface OneBotOtherSegment {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type OneBotSegment = OneBotTextSegment | OneBotImageSegment | OneBotOtherSegment;

/** 入站语音：只留下载/转写需要的信息，正文由 ASR 出 */
export interface InboundVoice {
  readonly name: string;
  /** url（优先，能直连下载）或 OneBot 给的 file */
  readonly path: string;
}

/** 只声明本通道真正消费的字段，其余字段原样忽略（不拒绝未知字段） */
export interface OneBotEvent {
  readonly post_type: "message";
  readonly message_type: "private";
  /** 机器人自己的 QQ 号；与 `user_id` 相同就是自己发出去的回声 */
  readonly self_id: number;
  readonly user_id: number;
  readonly message: readonly OneBotSegment[];
  /** 事件时间：秒级 Unix 时间戳（OneBot 口径，**不是**毫秒） */
  readonly time: number;
  /** 去重靠它最稳；没有时按 user_id+time+正文摘要合成 */
  readonly message_id?: number | string;
  readonly sender?: { readonly nick?: string; readonly user_id?: number };
}

/** 归一化产物：正文 + 图片 + 被忽略的段数 */
export interface OneBotInbound {
  /** 稳定的去重 id（同一条消息重复投递时不变） */
  readonly id: string;
  readonly userId: number;
  readonly selfId: number;
  /** text 段拼起来、去掉多余空白后的正文 */
  readonly text: string;
  /** 图片：`path` 放 url（优先）或 OneBot 的 file，语义同窗口通道的本地路径 */
  readonly images: readonly InboundImage[];
  /** 语音：`path` 同样 url 优先，交给宿主下载后转写（见 src/qq/voice.ts） */
  readonly voices: readonly InboundVoice[];
  /** 其它段（语音/文件/表情…）的条数：只记数，不进提示词 */
  readonly ignoredSegments: number;
  /** 事件时间换算成毫秒；`time` 缺失/为 0 时是 0（由调用方决定怎么处理） */
  readonly atMs: number;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** FNV-1a：只用来给「没有 message_id 的事件」做稳定摘要，不当哈希用 */
function digest(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function inboundId(event: OneBotEvent, text: string, images: readonly InboundImage[], voices: readonly InboundVoice[] = []): string {
  const rawId = event.message_id;
  if (typeof rawId === "number" && Number.isFinite(rawId)) return `ob-${String(rawId)}`;
  if (typeof rawId === "string" && rawId.trim() !== "") return `ob-${rawId.trim()}`;
  return `ob-${event.user_id}-${event.time}-${digest(text + "|" + images.map((i) => i.path).join(",") + "|" + voices.map((v) => v.path).join(","))}`;
}

/**
 * 把一条事件归一化。**自发消息返回 null**（`user_id === self_id`）——
 * 我们自己发出去的话会以 message 事件回流，不排掉就会自问自答。
 */
export function toInbound(event: OneBotEvent): OneBotInbound | null {
  if (event.user_id === event.self_id) return null;

  const parts: string[] = [];
  const images: InboundImage[] = [];
  const voices: InboundVoice[] = [];
  let ignored = 0;
  const segments = Array.isArray(event.message) ? event.message : [];

  for (const segment of segments) {
    const data: Readonly<Record<string, unknown>> = segment.data ?? {};
    if (segment.type === "text") {
      const text = asString(data["text"]);
      if (text !== "") parts.push(text);
      continue;
    }
    if (segment.type === "image") {
      const url = asString(data["url"]);
      const file = asString(data["file"]);
      const summary = asString(data["summary"]);
      // url 优先：file 常是对方机器上的文件名，本机取不到
      const path = url !== "" ? url : file;
      if (path === "") {
        ignored += 1;
        continue;
      }
      const fallback = `image-${images.length + 1}`;
      images.push({
        name: summary !== "" ? summary : file !== "" ? file : fallback,
        path,
      });
      continue;
    }
    if (segment.type === "record") {
      const url = asString(data["url"]);
      const file = asString(data["file"]);
      const path = url !== "" ? url : file;
      if (path === "") {
        ignored += 1;
        continue;
      }
      voices.push({ name: asString(data["summary"]) || file || `voice-${voices.length + 1}`, path });
      continue;
    }
    ignored += 1;
  }

  const text = parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .trim();

  return {
    id: inboundId(event, text, images, voices),
    userId: event.user_id,
    selfId: event.self_id,
    text,
    images,
    voices,
    ignoredSegments: ignored,
    atMs: typeof event.time === "number" && event.time > 0 ? event.time * 1000 : 0,
  };
}

// ---------- 发送（HTTP） ----------

export interface OneBotSendDeps {
  /** 形如 `http://127.0.0.1:3000`（末尾斜杠会被吃掉） */
  readonly baseUrl: string;
  /** Bearer token；空串表示服务端没开鉴权 */
  readonly token: string;
  /** 注入点：默认全局 `fetch`；测试给假实现 */
  readonly fetchFn?: typeof fetch;
}

export interface OneBotSendResult {
  readonly ok: boolean;
  /** OneBot 返回的 retcode（成功恒为 0） */
  readonly retcode: number;
  readonly detail: string;
  readonly messageId?: number | string;
}

/** OneBot 调用失败。`retcode` 与 `status` 都带出来，排查时不用再翻日志 */
export class OneBotError extends Error {
  readonly retcode: number;
  readonly status: string;

  constructor(message: string, retcode: number, status: string) {
    super(message);
    this.name = "OneBotError";
    this.retcode = retcode;
    this.status = status;
  }
}

/** token 只该出现在 Authorization 头里；任何要抛/要记的文本都先过这里 */
export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("***");
}

function redact(text: string, token: string): string {
  return redactSecret(text, token);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

function readRetcode(body: Readonly<Record<string, unknown>>): number {
  const raw = body["retcode"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : -1;
}

function readMessageId(data: unknown): number | string | undefined {
  const record = readRecord(data);
  const raw = record["message_id"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw !== "") return raw;
  return undefined;
}

/** 一个 API 调用：成功返回 `data` 字段，失败一律抛 `OneBotError` */
async function callApi(
  deps: OneBotSendDeps,
  action: string,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const url = `${base}/${action}`;
  const fetchFn: typeof fetch = deps.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OneBotError(redact(`${action} 请求失败：${message}`, deps.token), -1, "network");
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    // 读不出正文不影响后面按状态码判断
  }

  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  const record = readRecord(parsed);
  const retcode = readRetcode(record);
  const status = asString(record["status"]) !== "" ? asString(record["status"]) : `http-${response.status}`;
  const wording = asString(record["wording"]) !== "" ? asString(record["wording"]) : asString(record["msg"]);

  if (!response.ok) {
    throw new OneBotError(
      redact(`${action} HTTP ${response.status}（retcode=${retcode}, status=${status}${wording === "" ? "" : `, ${wording}`}）`, deps.token),
      retcode,
      status,
    );
  }
  if (retcode !== 0) {
    throw new OneBotError(
      redact(`${action} 失败：retcode=${retcode} status=${status}${wording === "" ? "" : ` ${wording}`}`, deps.token),
      retcode,
      status,
    );
  }
  return record["data"];
}

/** 文本段：一对一的聊天只需要一个 text 段 */
export function textSegments(text: string): readonly OneBotSegment[] {
  return [{ type: "text", data: { text } }];
}

/**
 * 图片段。OneBot v11 的 `base64://` 只带字节，不带媒体类型；
 * 兼容调用方偶尔传进来的 data URI 前缀。
 */
export function imageSegments(base64: string): readonly OneBotSegment[] {
  const cleaned = base64
    .replace(/^data:[^,]*;base64,/i, "")
    .replace(/^base64:\/\//i, "")
    .replace(/\s+/g, "");
  return [{ type: "image", data: { file: `base64://${cleaned}` } }];
}

/** 发一条私聊文本。空正文不发送（发出去也只是一条空气泡） */
export async function sendPrivateText(
  deps: OneBotSendDeps,
  input: { readonly peer: number; readonly text: string },
): Promise<OneBotSendResult> {
  if (input.text.trim() === "") {
    throw new OneBotError("正文为空，没有发送", -1, "empty");
  }
  const data = await callApi(deps, "send_private_msg", {
    user_id: input.peer,
    message: textSegments(input.text),
  });
  const messageId = readMessageId(data);
  return {
    ok: true,
    retcode: 0,
    detail: messageId === undefined ? "onebot: 已发送" : `onebot: 已发送 message_id=${String(messageId)}`,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

/** 语音段：`file` 支持本地路径 / `file://` / http(s) URL；本机实测 `file:///C:/...mp3` 可直接发。 */
export function recordSegments(file: string): readonly OneBotSegment[] {
  const cleaned = file.trim();
  if (cleaned === "") throw new OneBotError("语音文件为空，没有发送", -1, "empty");
  return [{ type: "record", data: { file: cleaned } }];
}

/** 发一条私聊语音（mp3/wav 交给 OneBot 端转码；失败由调用方降级成文字） */
export async function sendPrivateRecord(
  deps: OneBotSendDeps,
  input: { readonly peer: number; readonly file: string },
): Promise<OneBotSendResult> {
  const segments = recordSegments(input.file);
  const data = await callApi(deps, "send_private_msg", {
    user_id: input.peer,
    message: segments,
  });
  const messageId = readMessageId(data);
  return {
    ok: true,
    retcode: 0,
    detail: messageId === undefined ? "onebot: 语音已发送" : `onebot: 语音已发送 message_id=${String(messageId)}`,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

/**
 * 发一张私聊图片（base64 走 body，不需要先落盘）。
 * `mime` 只为调用方口径统一（附件服务判类型要用）；`base64://` 段本身不携带媒体类型。
 */
export async function sendPrivateImage(
  deps: OneBotSendDeps,
  input: { readonly peer: number; readonly base64: string; readonly mime?: string },
): Promise<OneBotSendResult> {
  const segments = imageSegments(input.base64);
  const first = segments[0];
  if (first === undefined || first.type !== "image" || first.data.file === "base64://") {
    throw new OneBotError("图片字节为空，没有发送", -1, "empty");
  }
  const data = await callApi(deps, "send_private_msg", {
    user_id: input.peer,
    message: segments,
  });
  const messageId = readMessageId(data);
  const mime = input.mime === undefined ? "" : ` mime=${input.mime}`;
  return {
    ok: true,
    retcode: 0,
    detail:
      messageId === undefined
        ? `onebot: 图片已发送${mime}`
        : `onebot: 图片已发送${mime} message_id=${String(messageId)}`,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

// ---------- 长连接（WebSocket） ----------

/** 全局 `WebSocket` 与本模块的最小接口形状不同（DOM Event vs 最小事件），这里只取用到的两个方法 */
export interface OneBotSocketEvent {
  readonly data?: unknown;
}

export interface OneBotSocket {
  addEventListener(type: string, handler: (event: OneBotSocketEvent) => void): void;
  close(code?: number, reason?: string): void;
}

export type OneBotSocketCtor = (url: string) => OneBotSocket;

export type OneBotListenerState = "connecting" | "open" | "closed" | "stopped";

export interface OneBotListenerDeps {
  /** 形如 `ws://127.0.0.1:3001`（已带 query 时会用 `&` 接 token） */
  readonly wsUrl: string;
  readonly token?: string;
  /** 收到一条 message 事件（已经过滤掉 meta_event/heartbeat） */
  onEvent(event: OneBotEvent): void | Promise<void>;
  log?(line: string): void;
  /** 注入点：默认全局 `WebSocket` */
  readonly socketFn?: OneBotSocketCtor;
  /** 注入点：默认 `setTimeout`；重连退避全部走它，测试才好控时 */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export interface OneBotListener {
  state(): OneBotListenerState;
  /** 断开并停止重连（幂等）；已排队的重连会被取消 */
  stop(): void;
}

/** 首次重连等 3s，之后每次翻倍 */
export const ONEBOT_BACKOFF_BASE_MS = 3_000;
/** 退避封顶：服务端长时间没起来时不该每分钟刷一条日志 */
export const ONEBOT_BACKOFF_MAX_MS = 30_000;

/** 第 `attempt` 次重连要等多久（attempt 从 0 开始：3s/6s/12s/24s/30s…） */
export function oneBotBackoffMs(attempt: number): number {
  const step = ONEBOT_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.floor(attempt));
  return Math.min(ONEBOT_BACKOFF_MAX_MS, step);
}

/** 拼 `?access_token=`：OneBot 的 WS 鉴权走 query，不走头 */
export function withAccessToken(wsUrl: string, token: string): string {
  if (token === "") return wsUrl;
  const sep = wsUrl.includes("?") ? "&" : "?";
  return `${wsUrl}${sep}access_token=${encodeURIComponent(token)}`;
}

function defaultSocketFn(): OneBotSocketCtor {
  return (url: string): OneBotSocket => {
    const ctor = (globalThis as { WebSocket?: new (target: string) => unknown }).WebSocket;
    if (ctor === undefined) {
      throw new Error("当前 Node 没有全局 WebSocket（需要 Node 22+）");
    }
    return new ctor(url) as OneBotSocket;
  };
}

/**
 * 起一个长连接。返回的 `stop()` 之后不会再有重连——
 * 这是插件卸载时唯一需要做的事，所以它必须幂等且不 await。
 */
export function startOneBotListener(deps: OneBotListenerDeps): OneBotListener {
  const socketFn = deps.socketFn ?? defaultSocketFn();
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = (line: string): void => deps.log?.(line);

  let state: OneBotListenerState = "connecting";
  let attempt = 0;
  let socket: OneBotSocket | null = null;
  let timer: unknown = null;
  let stopped = false;

  const cancelRetry = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const scheduleReconnect = (why: string): void => {
    if (stopped) return;
    const delay = oneBotBackoffMs(attempt);
    attempt += 1;
    state = "connecting";
    log(`[onebot] ${why}；${delay}ms 后重连（第 ${attempt} 次）`);
    timer = setTimeoutFn(() => {
      timer = null;
      connect();
    }, delay);
  };

  const handleFrame = (raw: unknown): void => {
    if (typeof raw !== "string") {
      log("[onebot] 收到非文本事件帧，忽略");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log("[onebot] 事件帧不是合法 JSON，忽略");
      return;
    }
    const record = readRecord(parsed);
    // heartbeat / lifecyle / notice / request 都走这里被跳过：桥只消费消息
    if (record["post_type"] !== "message") return;
    try {
      const pending = deps.onEvent(parsed as OneBotEvent);
      if (pending instanceof Promise) {
        void pending.catch((err: unknown) => {
          log(`[onebot] 处理事件抛错：${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      log(`[onebot] 处理事件抛错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  function connect(): void {
    if (stopped) return;
    state = "connecting";
    let next: OneBotSocket;
    try {
      next = socketFn(withAccessToken(deps.wsUrl, deps.token ?? ""));
    } catch (err) {
      scheduleReconnect(`建连失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    socket = next;
    let opened = false;
    next.addEventListener("open", () => {
      opened = true;
      attempt = 0;
      state = "open";
      log("[onebot] WS 已连接");
    });
    next.addEventListener("message", (event) => {
      handleFrame(event.data);
    });
    next.addEventListener("close", () => {
      socket = null;
      state = "closed";
      scheduleReconnect(opened ? "连接断开" : "连接被关闭");
    });
    next.addEventListener("error", (event) => {
      const rec = readRecord(event);
      const err = readRecord(rec["error"]);
      const message = asString(rec["message"]);
      const raw = event as { error?: unknown; message?: unknown; reason?: unknown };
      const detail = [message, asString(err["message"]), asString(err["code"]), asString(rec["type"]),
        String(raw.error ?? "").slice(0, 200), String(raw.message ?? ""), String(raw.reason ?? "")]
        .filter((x) => x !== "")
        .join(" / ");
      log(`[onebot] WS 错误${detail === "" ? "" : `：${detail}`}`);
    });
  }

  connect();

  return {
    state: () => state,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      state = "stopped";
      cancelRetry();
      const closing = socket;
      socket = null;
      try {
        closing?.close(1000, "stop");
      } catch {
        // 已经关了就不管
      }
    },
  };
}
