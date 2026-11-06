/**
 * 写通道的调用端（插件进程用）。
 *
 * 插件不写状态：把"要她做的事"投给自主进程（唯一写者），拿回结果。
 * 通道没开 / token 过期 → 抛错，让调用者知道"她现在没在自主进程那边"，
 * **绝不回退成插件自己写**——那正是要消灭的"两个写者"。
 *
 * task-137：`chat` / `web_search` 的通道地基在这里补两件事——
 * 1) 结果保留 daemon 回的机器可读 `code`（旧 daemon 没有该字段，读不到就是 undefined）；
 * 2) 传输层错误统一带 `code:"CHANNEL_DOWN"`，调用方（网页聊天/工具）据此给可读提示，
 *    不需要去猜错误文本。
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request } from "node:http";

import {
  readWriteChannel,
  writeChannelPath,
  WRITE_CHANNEL_VERSION,
  WRITE_TIMEOUT_MS,
  type WriteOp,
} from "../autonomy/write-server.js";

export interface WriteChannelTarget {
  dataDir: string;
  characterId: string;
}

/** 结果泛型只服务调用方阅读；通道层不校验 result 形状（那是各 handler 的事）。 */
export interface WriteChannelResult<R = unknown> {
  ok: boolean;
  result?: R | undefined;
  error?: string;
  /** daemon 返回的机器可读错误码（task-137）。成功时通常不存在。 */
  code?: string;
}

export interface CallWriteChannelInput extends WriteChannelTarget {
  op: WriteOp;
  payload?: unknown;
  timeoutMs?: number;
}

export class WriteChannelUnavailableError extends Error {
  /** 传输层/通道层的机器可读码（task-137）；网页聊天与工具据此映射提示。 */
  readonly code: string;

  constructor(message: string, code = "CHANNEL_DOWN") {
    super(message);
    this.name = "WriteChannelUnavailableError";
    this.code = code;
  }
}

/** 读通道文件；没有/形状不对返回 null。 */
export function readChannel(target: WriteChannelTarget) {
  const path = writeChannelPath(target.dataDir, target.characterId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return readWriteChannel(raw);
}

function postJson(
  port: number,
  token: string,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/apply",
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "x-ase-token": token,
        },
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * 把一次写请求投给自主进程并等结果。
 * - 没通道文件 → WriteChannelUnavailableError（说明她在不在）。
 * - 连不上/超时 → WriteChannelUnavailableError（可能刚重启）。
 * - 401 → WriteChannelUnavailableError（token 换了，让调用者重读文件重试）。
 * - 业务失败（handler 抛错）→ 返回 {ok:false,error,code?}，不抛。
 *
 * 泛型 `R` 只是给调用方省一次断言；通道层不校验 result 形状。
 */
export async function callWriteChannel<R = unknown>(input: CallWriteChannelInput): Promise<WriteChannelResult<R>> {
  const channel = readChannel(input);
  if (channel === null) {
    throw new WriteChannelUnavailableError(
      "写通道没开：她的自主进程可能没在跑。这一条不写（不自己写状态，免得覆盖她的推进）。",
    );
  }
  const timeoutMs = input.timeoutMs ?? WRITE_TIMEOUT_MS;
  const body = `${JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: input.op, payload: input.payload })}\n`;
  let response: { status: number; text: string };
  try {
    response = await postJson(channel.port, channel.token, body, timeoutMs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WriteChannelUnavailableError(`写通道连不上（${detail}）：她可能刚重启，等一拍再试。`);
  }
  if (response.status === 401) {
    throw new WriteChannelUnavailableError("写通道 token 已换（她重启过）：重读通道文件后再试一次。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new WriteChannelUnavailableError(`写通道回了看不懂的内容（HTTP ${response.status}）。`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WriteChannelUnavailableError(`写通道回了空内容（HTTP ${response.status}）。`);
  }
  const value = parsed as Record<string, unknown>;
  if (value["ok"] === true) {
    return { ok: true, result: value["result"] as R | undefined };
  }
  const error = typeof value["error"] === "string" ? value["error"] : "写通道没给原因";
  let code = typeof value["code"] === "string" && value["code"] !== "" ? value["code"] : undefined;
  // task-137 地基（supervisor task-142 B1）：旧 daemon 不认识 chat/web_search 时回 400
  // 且没有 code；插件侧把它映射成 CHANNEL_UNSUPPORTED，调用方才能给「需要发布/重启」的
  // 可读提示，而不是一句模糊的 400。新 daemon 的未知 op 现在也会带同一个 code。
  if (code === undefined && response.status === 400 && (input.op === "chat" || input.op === "web_search" || input.op === "web_fetch")) {
    code = "CHANNEL_UNSUPPORTED";
  }
  return code === undefined ? { ok: false, error } : { ok: false, error, code };
}
