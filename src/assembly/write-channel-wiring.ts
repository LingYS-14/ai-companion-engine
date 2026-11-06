/**
 * 写通道的启动与拆除（装配层，F286）。
 *
 * 批次 2b 决定「插件只读、写操作投给自主进程」，于是在常驻进程里要起一个只监听
 * 127.0.0.1 的 HTTP 写通道。原来这段（handler 映射 + 写通道文件 + 日志）直接摊在
 * `scripts/autonomy/main.mjs` 里，没法单测、也让入口继续变厚。
 *
 * 这里只做装配：把运行时的九个写方法翻译成通道的 op（外加 task-137 的 chat/web_search
 * 两个由装配层注入的 handler），起服务、落通道文件、返回一个带 `close()` 的句柄。
 * 映射错一个 op，插件那边就会「请求成功但什么都没做」——所以映射和归档 action 的分支
 * 都用测试锁住。
 */

import { rmSync } from "node:fs";

import {
  newWriteToken,
  startWriteServer,
  writeChannelFile,
  writeChannelPath,
  WRITE_CHANNEL_VERSION,
  type WriteHandler,
} from "../autonomy/write-server.js";

/** 只需要这些方法：窄接口让测试可以塞假运行时，也避免把整个 SoulRuntime 拖进装配层类型。 */
export interface WriteChannelRuntime {
  turn(args: unknown, opts: unknown): unknown;
  remember(payload: unknown): unknown;
  advance(hours: unknown): unknown;
  reset(confirm: unknown): unknown;
  consolidate(payload: unknown): unknown;
  submitInsight(payload: unknown): unknown;
  archiveCold(): unknown;
  restoreCold(memoryId: string): unknown;
  purgeCold(confirm: unknown): unknown;
}

export interface StartWriteChannelInput {
  readonly dataDir: string;
  readonly characterId: string;
  readonly runtime: WriteChannelRuntime;
  readonly log: (line: string) => void;
  /**
   * task-137：chat / web_search 的 handler 由装配层闭包注入（两者都需要 llm/dialogue/
   * 历史或 web 执行层，不属于 runtime 的窄接口）。缺省时通道仍**认识**这两个 op，
   * 但返回 `{ok:false, code:"CHANNEL_UNSUPPORTED"}`，而不是让旧 daemon 报 400 形状错误。
   */
  readonly chat?: WriteHandler;
  readonly webSearch?: WriteHandler;
  /** F1：soul_web_fetch 的 handler（需要 daemon 的 fetch 依赖与共享额度账本）；缺省同上。 */
  readonly webFetch?: WriteHandler;
  /** 通道文件里的 atMs；默认取系统时间（测试注入固定值） */
  readonly now?: () => number;
  /** 服务端口；默认由系统分配（测试用 0 也可以） */
  readonly port?: number;
}

export interface WriteChannelHandle {
  readonly port: number;
  readonly channelPath: string;
  /** 关服务 + 删通道文件；幂等，不抛错 */
  close(): Promise<void>;
}

/** 通道的 payload 是 unknown；这里统一收窄成对象盒（非对象按空对象处理）。 */
function asBox(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/** 未知 action 抛错（让插件看到原因，而不是静默成功）。 */
function archiveHandler(runtime: WriteChannelRuntime, payload: unknown): unknown {
  const box = asBox(payload);
  const action = String(box["action"] ?? "");
  if (action === "run") return runtime.archiveCold();
  if (action === "restore") return runtime.restoreCold(String(box["memoryId"] ?? ""));
  if (action === "purge") return runtime.purgeCold(box["confirm"] === true);
  throw new Error(`archive 不支持 action=${action}`);
}

/** 通道认识这个 op，但装配层还没注入业务 handler（task-138/139 之前）。 */
function unsupportedHandler(op: "chat" | "web_search" | "web_fetch"): WriteHandler {
  return () => {
    const err = new Error(`${op} 未接线：装配层还没注入 handler（daemon 版本较旧，需要发布/重启）`);
    (err as Error & { code?: string }).code = "CHANNEL_UNSUPPORTED";
    throw err;
  };
}

export async function startWriteChannel(input: StartWriteChannelInput): Promise<WriteChannelHandle> {
  const server = await startWriteServer({
    token: newWriteToken(),
    log: input.log,
    ...(input.port === undefined ? {} : { port: input.port }),
    handlers: {
      turn: (payload) => {
        const box = asBox(payload);
        return input.runtime.turn(box["args"], box["opts"]);
      },
      remember: (payload) => input.runtime.remember(payload),
      advance: (payload) => input.runtime.advance(asBox(payload)["hours"]),
      reset: (payload) => input.runtime.reset(asBox(payload)["confirm"] === true),
      consolidate: (payload) => input.runtime.consolidate(payload === undefined || payload === null ? {} : payload),
      insight: (payload) => input.runtime.submitInsight(payload),
      archive: (payload) => archiveHandler(input.runtime, payload),
      chat: input.chat ?? unsupportedHandler("chat"),
      web_search: input.webSearch ?? unsupportedHandler("web_search"),
      web_fetch: input.webFetch ?? unsupportedHandler("web_fetch"),
    },
  });
  const channelPath = writeChannelPath(input.dataDir, input.characterId);
  writeChannelFile(channelPath, {
    version: WRITE_CHANNEL_VERSION,
    port: server.port,
    token: server.token,
    pid: process.pid,
    atMs: (input.now ?? Date.now)(),
  });
  input.log(`[write] 写通道已开：127.0.0.1:${String(server.port)}（只有本机插件能用；重启会换 token）`);
  let closed = false;
  return {
    port: server.port,
    channelPath,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
      try {
        rmSync(channelPath, { force: true });
      } catch {
        // 删不掉通道文件不影响退出：旧文件里的 token 在下次启动时就失效了。
      }
    },
  };
}
