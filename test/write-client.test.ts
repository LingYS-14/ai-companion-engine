import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { callWriteChannel, readChannel, WriteChannelUnavailableError } from "../src/plugin/write-client.js";
import {
  newWriteToken,
  startWriteServer,
  writeChannelFile,
  writeChannelPath,
  WRITE_CHANNEL_VERSION,
  type WriteHandlers,
  type WriteServerHandle,
} from "../src/autonomy/write-server.js";

const handlers: WriteHandlers = {
  turn: (payload) => ({ reply: "在呢", payload }),
  remember: () => ({ stored: 1, id: "mem-2", reason: "ok" }),
  advance: (payload) => ({ steps: Number((payload as { hours: number }).hours) * 12 }),
  reset: () => ({ reset: true }),
  consolidate: () => ({ clusters: 1, written: 0, accepted: [], rejected: [] }),
  insight: () => ({ stored: false, reason: "证据不足" }),
  archive: (payload) => ({ archived: 1, payload }),
  chat: () => ({ reply: "网页那边好呀" }),
  web_search: () => ({ ok: true, code: null, hits: [] }),
  web_fetch: () => ({ ok: true, code: null, url: null }),
};

describe("写通道客户端（插件侧，批次 2b）", () => {
  const dirs: string[] = [];
  const servers: WriteServerHandle[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function withServer(): Promise<{ dir: string; target: { dataDir: string; characterId: string } }> {
    const dir = mkdtempSync(join(tmpdir(), "write-client-"));
    dirs.push(dir);
    const server = await startWriteServer({ handlers, token: newWriteToken() });
    servers.push(server);
    const target = { dataDir: dir, characterId: "assistant" };
    writeChannelFile(writeChannelPath(dir, "assistant"), {
      version: WRITE_CHANNEL_VERSION,
      port: server.port,
      token: server.token,
      pid: 4321,
      atMs: Date.now(),
    });
    return { dir, target };
  }

  it("有通道：turn 投过去拿回结果", async () => {
    const { target } = await withServer();
    expect(readChannel(target)?.port).toBeGreaterThan(0);
    const res = await callWriteChannel({ ...target, op: "turn", payload: { args: { text: "在吗" }, opts: {} } });
    expect(res.ok).toBe(true);
    expect((res.result as { reply: string }).reply).toBe("在呢");
  });

  it("advance 的 payload 原样到达", async () => {
    const { target } = await withServer();
    const res = await callWriteChannel({ ...target, op: "advance", payload: { hours: 3 } });
    expect(res.ok).toBe(true);
    expect((res.result as { steps: number }).steps).toBe(36);
  });

  it("没有通道文件：抛 WriteChannelUnavailableError 且说明不自己写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-none-"));
    dirs.push(dir);
    await expect(callWriteChannel({ dataDir: dir, characterId: "assistant", op: "turn", payload: {} })).rejects.toThrow(
      WriteChannelUnavailableError,
    );
    await expect(callWriteChannel({ dataDir: dir, characterId: "assistant", op: "turn", payload: {} })).rejects.toThrow(
      /不自己写状态/,
    );
  });

  it("token 过期（她重启过）：提示重读通道文件", async () => {
    const { dir, target } = await withServer();
    writeChannelFile(writeChannelPath(dir, "assistant"), {
      version: WRITE_CHANNEL_VERSION,
      port: readChannel(target)!.port,
      token: newWriteToken(),
      pid: 4321,
      atMs: Date.now(),
    });
    await expect(callWriteChannel({ ...target, op: "turn", payload: {} })).rejects.toThrow(/token/);
  });

  it("端口不通：提示她可能刚重启", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-down-"));
    dirs.push(dir);
    writeChannelFile(writeChannelPath(dir, "assistant"), {
      version: WRITE_CHANNEL_VERSION,
      port: 1,
      token: newWriteToken(),
      pid: 4321,
      atMs: Date.now(),
    });
    await expect(callWriteChannel({ dataDir: dir, characterId: "assistant", op: "turn", payload: {}, timeoutMs: 500 })).rejects.toThrow(
      /连不上/,
    );
  });

  it("业务失败返回 ok:false（不抛）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-fail-"));
    dirs.push(dir);
    const server = await startWriteServer({
      token: newWriteToken(),
      handlers: { ...handlers, remember: () => { throw new Error("防火墙拒绝了这条"); } },
    });
    servers.push(server);
    writeChannelFile(writeChannelPath(dir, "assistant"), {
      version: WRITE_CHANNEL_VERSION,
      port: server.port,
      token: server.token,
      pid: 1,
      atMs: Date.now(),
    });
    const res = await callWriteChannel({ dataDir: dir, characterId: "assistant", op: "remember", payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("防火墙");
  });

  it("结果保留 daemon 的机器可读 code（task-137）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-code-"));
    dirs.push(dir);
    const server = await startWriteServer({
      token: newWriteToken(),
      handlers: {
        ...handlers,
        chat: () => {
          const err = new Error("她睡着了（asleep：quiet）");
          (err as Error & { code?: string }).code = "asleep";
          throw err;
        },
      },
    });
    servers.push(server);
    writeChannelFile(writeChannelPath(dir, "assistant"), {
      version: WRITE_CHANNEL_VERSION,
      port: server.port,
      token: server.token,
      pid: 1,
      atMs: Date.now(),
    });
    const res = await callWriteChannel({ dataDir: dir, characterId: "assistant", op: "chat", payload: { text: "在吗" } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("asleep");
    expect(res.error).toContain("睡着了");
  });

  it("泛型只影响类型：advance 的结果按调用方声明读", async () => {
    const { target } = await withServer();
    const res = await callWriteChannel<{ steps: number }>({ ...target, op: "advance", payload: { hours: 2 } });
    expect(res.ok).toBe(true);
    expect(res.result?.steps).toBe(24);
  });

  it("旧 daemon 不认新 op：400 回 ok:false，不崩也不重试（task-137 兼容矩阵）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-old-daemon-"));
    dirs.push(dir);
    // 模拟旧 daemon：7 op 白名单在 parseWriteRequest 就拒掉 chat，回 400 + 旧文案。
    const oldDaemon: Server = createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "请求形状不对（version/op 必须对得上）" }));
    });
    await new Promise<void>((resolve) => oldDaemon.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = oldDaemon.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      writeChannelFile(writeChannelPath(dir, "assistant"), {
        version: WRITE_CHANNEL_VERSION,
        port,
        token: newWriteToken(),
        pid: 1,
        atMs: Date.now(),
      });
      const res = await callWriteChannel({ dataDir: dir, characterId: "assistant", op: "chat", payload: { text: "在吗" } });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("请求形状不对");
      // supervisor task-142 B1：旧 daemon 对新 op 的 400 必须映射 CHANNEL_UNSUPPORTED
      expect(res.code).toBe("CHANNEL_UNSUPPORTED");
      // task-166：web_fetch 是同一兼容矩阵里的新 op，旧 daemon 同样回 400。
      const fetched = await callWriteChannel({ dataDir: dir, characterId: "assistant", op: "web_fetch", payload: { url: "https://example.com/" } });
      expect(fetched.ok).toBe(false);
      expect(fetched.code).toBe("CHANNEL_UNSUPPORTED");
    } finally {
      await new Promise<void>((resolve) => oldDaemon.close(() => resolve()));
    }
  });

  it("传输层错误带 CHANNEL_DOWN 码（调用方可直接展示/映射）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "write-client-down-code-"));
    dirs.push(dir);
    const err = await callWriteChannel({ dataDir: dir, characterId: "assistant", op: "chat", payload: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteChannelUnavailableError);
    expect((err as WriteChannelUnavailableError).code).toBe("CHANNEL_DOWN");
  });
});
