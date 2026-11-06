/**
 * P2：网页聊天的三条路由（meta / history / send）。
 *
 * 分工（设计 §7.1）：工具层只做 HTTP 协议与 CSRF，业务在 daemon 的 `op:"chat"`。
 * 这里不 import 大脑实现（R3）、不 import spine（工具层不碰自治编排），
 * 历史读取直接读 `data/chat-<id>.ndjson`（与 daemon 的 ChatLog 同一个文件）。
 *
 * 安全口径：
 * - CSRF：插件启动生成一次 token，页面从 meta 取，POST 必须带 `x-soul-csrf`；
 * - 同源：拒绝 `sec-fetch-site: cross-site`，有 Origin 时校验 host；
 * - 限长：JSON、≤8KB、消息 ≤2000 字；写通道 90s 超时；
 * - 节流：默认 1 请求 / 1.5s（单用户本地页面，防连点）。
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChatHistoryEntry } from "../../ports/chat-history.js";

import type { RouteHandler, WebResponseLike } from "./handlers.js";

export const CHAT_META_PATH = "/plugins/ai-companion-engine/chat/meta";
export const CHAT_HISTORY_PATH = "/plugins/ai-companion-engine/chat/history";
export const CHAT_SEND_PATH = "/plugins/ai-companion-engine/chat/send";

export const CHAT_MAX_CHARS = 2_000;
export const CHAT_MAX_BODY = 8 * 1024;
export const CHAT_POLL_MS = 2_000;
export const CHAT_THROTTLE_MS = 1_500;
/** 历史默认/上限（设计 §7.1）。 */
export const CHAT_HISTORY_DEFAULT_LIMIT = 50;
export const CHAT_HISTORY_MAX_LIMIT = 100;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(res: WebResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { ...JSON_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * 统一错误体（设计 §7.3：`{ok:false, code, detail}`）。
 * `message` 保留给旧前端分支判断，`detail` 是同一句的更细解释（前端可只读其一）。
 */
function fail(
  res: WebResponseLike,
  status: number,
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  json(res, status, { ok: false, code, message, detail: message, ...extra });
}

interface ChatRequestLike {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

function headerOf(req: ChatRequestLike, name: string): string | null {
  const raw = req.headers?.[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function parseHistoryLine(line: string): ChatHistoryEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const atMs = body.atMs;
  const who = body.who;
  const text = body.text;
  const channel = body.channel;
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  if (who !== "peer" && who !== "her") return null;
  if (typeof text !== "string") return null;
  if (channel !== "qq" && channel !== "web") return null;
  return { atMs, who, text, channel };
}

/** `GET /chat/meta`：页面拿 CSRF 与轮询/上限参数。 */
export function createChatMetaHandler(input: { csrf: string }): RouteHandler {
  return (req, res) => {
    void req;
    json(res, 200, { csrf: input.csrf, maxChars: CHAT_MAX_CHARS, pollMs: CHAT_POLL_MS });
  };
}

/**
 * `GET /chat/history?limit=50`：读共享历史的尾部。
 *
 * 只读文件、不做缓冲：插件与 daemon 是两个进程，文件是唯一同步面；
 * 读失败（缺文件/坏行）都降级成"没有历史"，不能把聊天页打挂。
 */
export function createChatHistoryHandler(input: { dataDir: string; characterId: string }): RouteHandler {
  return (req, res) => {
    let limit = CHAT_HISTORY_DEFAULT_LIMIT;
    try {
      const url = new URL(String((req as ChatRequestLike | null)?.url ?? ""), "http://localhost");
      const raw = url.searchParams.get("limit");
      if (raw !== null) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) limit = Math.max(1, Math.min(CHAT_HISTORY_MAX_LIMIT, n));
      }
    } catch {
      // 坏 url 用默认值
    }
    const path = join(input.dataDir, `chat-${input.characterId}.ndjson`);
    const messages: ChatHistoryEntry[] = [];
    try {
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split(/\r?\n/u);
        for (const line of lines) {
          if (line.trim() === "") continue;
          const entry = parseHistoryLine(line);
          if (entry !== null) messages.push(entry);
        }
      }
    } catch (err) {
      json(res, 200, { messages: [], detail: `历史读取失败：${String(err)}` });
      return;
    }
    json(res, 200, { messages: messages.slice(-limit) });
  };
}

/** `call` 的两种结局：成功给出回复，或失败给出插件要映射的错误码。 */
export type ChatSendOutcome =
  | { readonly ok: true; readonly reply: string; readonly mode?: string; readonly stage?: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 业务错误码 → HTTP 状态（设计 §7.3 的映射表）。 */
export function chatStatusOf(code: string): number {
  switch (code) {
    case "asleep":
      return 409;
    case "bad-request":
      return 400;
    case "chat-model-unavailable":
    case "daemon-unavailable":
    case "CHANNEL_DOWN":
    case "CHANNEL_UNSUPPORTED":
      return 503;
    case "timeout":
      // P2.1（task-157）：设计 §7.3「客户端超时」→ 504，与 503 的「通道不可用」区分开。
      return 504;
    case "chat-empty-reply":
      return 502;
    default:
      return 500;
  }
}

/**
 * `POST /chat/send`：CSRF + 同源 + 限长 + 节流，然后交给 daemon。
 *
 * `now` 与 `throttleMs` 都可注入：测试要能控制节流窗口。
 */
export function createChatSendHandler(input: {
  csrf: string;
  call: (text: string) => Promise<ChatSendOutcome>;
  now: () => number;
  throttleMs?: number;
}): RouteHandler {
  const throttleMs = input.throttleMs ?? CHAT_THROTTLE_MS;
  let lastAt = -Infinity;
  return (req, res) => {
    const request = req as ChatRequestLike;
    if (request.method !== "POST") {
      res.writeHead(405, { ...JSON_HEADERS, allow: "POST" });
      res.end(JSON.stringify({ ok: false, code: "method", message: "这个端点只收 POST", detail: "这个端点只收 POST" }));
      return;
    }
    const csrf = headerOf(request, "x-soul-csrf");
    if (csrf === null || !safeEqual(csrf, input.csrf)) {
      fail(res, 403, "csrf", "CSRF 校验失败：刷新页面重试");
      return;
    }
    if (headerOf(request, "sec-fetch-site") === "cross-site") {
      fail(res, 403, "cross-site", "拒绝跨站请求");
      return;
    }
    const origin = headerOf(request, "origin");
    const host = headerOf(request, "host");
    if (origin !== null && host !== null) {
      try {
        if (new URL(origin).host !== host) {
          fail(res, 403, "origin", "拒绝非同源请求");
          return;
        }
      } catch {
        fail(res, 403, "origin", "Origin 不合法");
        return;
      }
    }
    const contentType = headerOf(request, "content-type");
    if (contentType === null || !contentType.toLowerCase().includes("application/json")) {
      fail(res, 415, "content-type", "请求体必须是 JSON");
      return;
    }
    const at = input.now();
    if (Number.isFinite(lastAt) && at - lastAt < throttleMs) {
      fail(res, 429, "throttled", "点得太快了，缓一下再发", {
        retryAfterMs: Math.max(0, Math.trunc(throttleMs - (at - lastAt))),
      });
      return;
    }
    lastAt = at;

    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooBig = false;
    const finish = (raw: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(res, 400, "bad-request", "请求体不是合法 JSON");
        return;
      }
      const text = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).text : undefined;
      if (typeof text !== "string") {
        fail(res, 400, "bad-request", "缺少 text 字段");
        return;
      }
      const trimmed = text.trim();
      if (trimmed === "") {
        fail(res, 400, "bad-request", "消息是空的");
        return;
      }
      if (Array.from(trimmed).length > CHAT_MAX_CHARS) {
        fail(res, 400, "bad-request", `消息太长（上限 ${String(CHAT_MAX_CHARS)} 字）`);
        return;
      }
      void (async () => {
        try {
          const outcome = await input.call(trimmed);
          if (outcome.ok) {
            json(res, 200, {
              ok: true,
              reply: outcome.reply,
              ...(outcome.mode === undefined ? {} : { mode: outcome.mode }),
              ...(outcome.stage === undefined ? {} : { stage: outcome.stage }),
            });
            return;
          }
          fail(res, chatStatusOf(outcome.code), outcome.code, outcome.message);
        } catch (err) {
          fail(res, 500, "engine-error", `这一轮没走完：${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
    request.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > CHAT_MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooBig) {
        fail(res, 413, "too-large", "请求体太大（上限 8 KB）");
        return;
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => {
      fail(res, 400, "bad-request", "请求体读失败");
    });
  };
}
