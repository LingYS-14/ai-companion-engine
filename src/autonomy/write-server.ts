/**
 * 写通道（批次 2b · 单写者 A 的落地方式）
 *
 * 为什么需要它：审计 P0-4 的问题是"两个进程都能写状态文件，谁后写谁赢"。
 * 插件（`src/plugin/index.ts`）跑在 DSH 宿主进程里，它拿到的状态是打开那一刻的快照；
 * 自主进程（`scripts/autonomy/main.mjs`）每拍都在推进。只要插件还自己 `save()`，
 * 就有可能把几十分钟前的状态写回去。
 *
 * 做法：**只有自主进程写盘**。插件把"要她做的事"（说话/记住/推进/巩固/洞见/归档）
 * 通过本机回环 HTTP 投递给自主进程，由它在自己的 runtime 上执行——状态永远是新鲜的，
 * 也永远只有一个写者。这里不做队列：请求是同步等回复的（交互工具等不起 5 分钟一拍）。
 *
 * 边界（有意为之）：
 * - 只监听 `127.0.0.1`，端口随机；每次启动生成新 token，写在
 *   `data/write-channel-<char>.json`（插件只读这个文件）。
 * - 只接受 `POST /apply`，body 上限 64KB；op 必须在白名单里，payload 由各 handler 自己校验。
 * - 不做重试/排队/鉴权重放：拿不到通道 = 报错给调用者（"她在自主进程那边"），
 *   **绝不回退成插件自己写**——那正是要消灭的东西。
 * - 进程退出/重启换 token：旧文件自然失效（插件读到 401 会提示"通道已换，重试一次"）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const WRITE_CHANNEL_VERSION = 1;
export const WRITE_CHANNEL_MAX_BODY = 64 * 1024;
export const WRITE_TIMEOUT_MS = 20_000;

// task-137（通道地基）：chat / web_search 只加名字与类型，业务由 task-138/139 填。
export const WRITE_OPS = [
  "turn",
  "remember",
  "advance",
  "reset",
  "consolidate",
  "insight",
  "archive",
  "chat", // 网页聊天：复用 QQ 回复链，历史共享
  "web_search", // soul_web_search 工具：由常驻进程持 key 执行
  "web_fetch", // soul_web_fetch 工具（F1）：只读抓取网页正文
] as const;
export type WriteOp = (typeof WRITE_OPS)[number];

export function isWriteOp(value: unknown): value is WriteOp {
  return typeof value === "string" && (WRITE_OPS as readonly string[]).includes(value);
}

export type WriteHandler = (payload: unknown) => unknown | Promise<unknown>;
export type WriteHandlers = Record<WriteOp, WriteHandler>;

export interface WriteResponse {
  ok: boolean;
  /** 成功时是 handler 的返回值（JSON 可序列化）。 */
  result?: unknown;
  /** 失败时是给人看的一句话。 */
  error?: string;
  /**
   * 失败时的机器可读错误码（task-137）。
   * handler 抛出的错误对象带 string `code` 时原样透传，例如 chat 的 `asleep` / `bad-request`；
   * 旧调用方只读 ok/result/error，多这个字段不影响它们。
   */
  code?: string;
}

/** handler 抛出的错误可能带机器可读 code（chat 的 asleep/bad-request 等）。 */
export function errorCodeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

export interface WriteChannelInfo {
  version: number;
  port: number;
  token: string;
  pid: number;
  atMs: number;
}

export function writeChannelPath(dataDir: string, characterId: string): string {
  return join(dataDir, `write-channel-${characterId}.json`);
}

/** 通道文件只读；形状不对返回 null（插件按"通道没开"处理，不回退自己写）。 */
export function readWriteChannel(raw: string): WriteChannelInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const port = value["port"];
  const token = value["token"];
  const pid = value["pid"];
  const atMs = value["atMs"];
  const version = value["version"];
  if (version !== WRITE_CHANNEL_VERSION) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (typeof token !== "string" || token.length < 16) return null;
  if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  return { version: WRITE_CHANNEL_VERSION, port, token, pid, atMs };
}

export function serializeWriteChannel(info: WriteChannelInfo): string {
  return `${JSON.stringify({
    version: info.version,
    port: info.port,
    token: info.token,
    pid: info.pid,
    atMs: info.atMs,
  })}\n`;
}

/** 解析请求体：形状不对返回 null（调用方回 400 并说明是哪个字段）。 */
export function parseWriteRequest(raw: unknown): { op: WriteOp; payload: unknown } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value["version"] !== WRITE_CHANNEL_VERSION) return null;
  const op = value["op"];
  if (!isWriteOp(op)) return null;
  return { op, payload: value["payload"] };
}

export interface WriteServerOptions {
  handlers: WriteHandlers;
  token: string;
  log?: (line: string) => void;
  /** 测试用：0 = 让系统分配。 */
  port?: number;
}

export interface WriteServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

function respond(res: ServerResponse, status: number, body: WriteResponse): void {
  const text = `${JSON.stringify(body)}\n`;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WRITE_CHANNEL_MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * 起一个只给本机插件用的写通道。测试可以传 port:0，拿真实的 `address().port`。
 * `close()` 幂等。
 */
export async function startWriteServer(options: WriteServerOptions): Promise<WriteServerHandle> {
  if (options.token.length < 16) throw new RangeError("写通道 token 太短（至少 16 位）");
  let server: Server | null = null;
  let closed = false;

  server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/apply") {
        respond(res, 404, { ok: false, error: "写通道只接受 POST /apply" });
        return;
      }
      const token = req.headers["x-ase-token"];
      if (token !== options.token) {
        options.log?.("[write] 写通道拒绝：token 不对（可能是旧进程留下的通道文件）");
        respond(res, 401, { ok: false, error: "写通道 token 不对（她可能刚重启过，读一次新文件再试）" });
        return;
      }
      const text = await readBody(req);
      if (text === null) {
        respond(res, 413, { ok: false, error: `请求体超过 ${WRITE_CHANNEL_MAX_BODY} 字节` });
        return;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        respond(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }
      const request = parseWriteRequest(parsedJson);
      if (request === null) {
        // task-137 地基（supervisor task-142 B2）：未知 op 明确回 CHANNEL_UNSUPPORTED，
        // 旧插件只读 error 字段、会忽略多出来的 code，因此对旧插件是向后兼容的。
        const rawOp = typeof parsedJson === "object" && parsedJson !== null
          ? (parsedJson as Record<string, unknown>)["op"]
          : undefined;
        if (typeof rawOp === "string" && !isWriteOp(rawOp)) {
          respond(res, 400, {
            ok: false,
            error: `未知 op：${rawOp}（这个 daemon 版本不支持）`,
            code: "CHANNEL_UNSUPPORTED",
          });
          return;
        }
        respond(res, 400, { ok: false, error: "请求形状不对（version/op 必须对得上）" });
        return;
      }
      try {
        const result = await options.handlers[request.op](request.payload);
        respond(res, 200, { ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = errorCodeOf(err);
        options.log?.(`[write] ${request.op} 失败（不影响自主进程）：${message}${code === undefined ? "" : ` [code=${code}]`}`);
        respond(res, 200, code === undefined ? { ok: false, error: message } : { ok: false, error: message, code });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port <= 0) throw new Error("写通道没能拿到端口");

  return {
    port,
    token: options.token,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * 生成一次启动用的 token。不要用固定值：进程重启后旧通道文件自然失效。
 */
export function newWriteToken(): string {
  return randomBytes(24).toString("hex");
}

/** 把通道信息写到 data 目录（失败抛，由调用方决定是否让进程继续）。 */
export function writeChannelFile(path: string, info: WriteChannelInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeWriteChannel(info), { encoding: "utf8" });
}

/** 一行说明，只给日志用。 */
export function describeWriteChannel(info: WriteChannelInfo): string {
  return `写通道：127.0.0.1:${info.port} pid=${info.pid}（只有本机插件能用；重启会换 token）`;
}
