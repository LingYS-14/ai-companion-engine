import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeWriteChannel,
  isWriteOp,
  newWriteToken,
  parseWriteRequest,
  readWriteChannel,
  serializeWriteChannel,
  startWriteServer,
  writeChannelFile,
  writeChannelPath,
  WRITE_CHANNEL_VERSION,
  type WriteHandlers,
  type WriteServerHandle,
} from "../dist/autonomy/write-server.js";
import { request } from "node:http";

const TOKEN = "0123456789abcdef0123456789abcdef";

function handlers(): WriteHandlers {
  return {
    turn: (payload) => ({ echoed: payload, kind: "turn" }),
    remember: () => ({ stored: 1, id: "mem-1", reason: "ok" }),
    advance: () => ({ steps: 12 }),
    reset: () => ({ reset: true }),
    consolidate: () => ({ clusters: 0, written: 0, accepted: [], rejected: [] }),
    insight: () => ({ stored: false, id: "x", verdict: "rejected", reason: "证据不足" }),
    archive: (payload) => ({ archived: 2, ids: ["a", "b"], payload }),
    // task-138：通道层已认识这两个 op（旧 dist 版本忽略这两个键，不影响旧断言）。
    chat: (payload) => ({ echoed: payload, kind: "chat" }),
    web_search: (payload) => ({ echoed: payload, kind: "web_search" }),
  };
}

function post(port: number, body: string, token = TOKEN, path = "/apply"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-ase-token": token } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("写通道服务端（批次 2b）", () => {
  const servers: WriteServerHandle[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it("turn 请求走 handler 并回 result", async () => {
    const server = await startWriteServer({ handlers: handlers(), token: TOKEN });
    servers.push(server);
    const body = JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "turn", payload: { args: { text: "在吗" }, opts: {} } });
    const res = await post(server.port, body);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { ok: boolean; result: { kind: string; echoed: unknown } };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.kind).toBe("turn");
    expect(parsed.result.echoed).toEqual({ args: { text: "在吗" }, opts: {} });
  });

  it("token 不对回 401 且不执行 handler", async () => {
    let called = 0;
    const server = await startWriteServer({
      handlers: { ...handlers(), turn: () => { called += 1; return {}; } },
      token: TOKEN,
    });
    servers.push(server);
    const res = await post(server.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "turn", payload: {} }), "wrong-token-0000");
    expect(res.status).toBe(401);
    expect(res.text).toContain("token");
    expect(called).toBe(0);
  });

  it("未知 op / 版本不对 / 非 JSON 都回 400", async () => {
    const server = await startWriteServer({ handlers: handlers(), token: TOKEN });
    servers.push(server);
    expect((await post(server.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "drop-table", payload: {} }))).status).toBe(400);
    expect((await post(server.port, JSON.stringify({ version: 99, op: "turn", payload: {} }))).status).toBe(400);
    expect((await post(server.port, "{not json")).status).toBe(400);
  });

  it("GET /apply 回 404（只接受 POST）", async () => {
    const server = await startWriteServer({ handlers: handlers(), token: TOKEN });
    servers.push(server);
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/apply", method: "GET" }, (r) => {
        r.resume();
        resolve({ status: r.statusCode ?? 0 });
      });
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it("handler 抛错回 ok:false + 原因，服务不挂", async () => {
    const server = await startWriteServer({
      handlers: { ...handlers(), turn: () => { throw new Error("记忆文件锁住了"); } },
      token: TOKEN,
    });
    servers.push(server);
    const body = JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "turn", payload: {} });
    const res = await post(server.port, body);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("锁住");
    // 仍然能用
    const again = await post(server.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "remember", payload: {} }));
    expect((JSON.parse(again.text) as { ok: boolean }).ok).toBe(true);
  });

  it("close 幂等", async () => {
    const server = await startWriteServer({ handlers: handlers(), token: TOKEN });
    await server.close();
    await server.close();
  });

  it("token 太短直接拒绝启动", async () => {
    await expect(startWriteServer({ handlers: handlers(), token: "short" })).rejects.toThrow(/token/);
  });

  it("通道文件：写出去能读回来，形状不对返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-channel-"));
    try {
      const path = writeChannelPath(dir, "assistant");
      expect(path.endsWith("write-channel-assistant.json")).toBe(true);
      const info = { version: WRITE_CHANNEL_VERSION, port: 45678, token: TOKEN, pid: 1234, atMs: 1_800_000_000_000 };
      writeChannelFile(path, info);
      expect(readWriteChannel(readFileSync(path, "utf8"))).toEqual(info);
      expect(readWriteChannel("not json")).toBeNull();
      expect(readWriteChannel(JSON.stringify({ ...info, port: 0 }))).toBeNull();
      expect(readWriteChannel(JSON.stringify({ ...info, token: "short" }))).toBeNull();
      expect(readWriteChannel(JSON.stringify({ ...info, version: 9 }))).toBeNull();
      expect(serializeWriteChannel(info)).toContain(`"version":${WRITE_CHANNEL_VERSION}`);
      expect(describeWriteChannel(info)).toContain("45678");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseWriteRequest / isWriteOp / newWriteToken", () => {
    expect(isWriteOp("turn")).toBe(true);
    expect(isWriteOp("nope")).toBe(false);
    expect(parseWriteRequest({ version: WRITE_CHANNEL_VERSION, op: "advance", payload: { hours: 2 } })).toEqual({
      op: "advance",
      payload: { hours: 2 },
    });
    expect(parseWriteRequest({ version: WRITE_CHANNEL_VERSION, op: "nope" })).toBeNull();
    expect(parseWriteRequest(null)).toBeNull();
    expect(newWriteToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(newWriteToken()).not.toBe(newWriteToken());
  });
});
