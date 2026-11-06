import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  errorCodeOf,
  isWriteOp,
  newWriteToken,
  parseWriteRequest,
  startWriteServer,
  WRITE_CHANNEL_VERSION,
  WRITE_OPS,
  type WriteHandlers,
  type WriteServerHandle,
} from "../src/autonomy/write-server.js";
import { startWriteChannel } from "../src/assembly/write-channel-wiring.js";
import { callWriteChannel } from "../src/plugin/write-client.js";
import { emptyWebUsage } from "../src/web/budget.js";
import type { WebConfig } from "../src/web/config.js";
import { runWebToolSearch } from "../src/web/tool-run.js";
import type { ChatRequest, ChatResult, WebFetchResult, WebSearchRequest, WebSearchResult } from "../src/autonomy/write-protocol.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function handlers(): WriteHandlers {
  return {
    turn: (payload) => ({ echoed: payload, kind: "turn" }),
    remember: () => ({ stored: 1 }),
    advance: () => ({ steps: 12 }),
    reset: () => ({ reset: true }),
    consolidate: () => ({ clusters: 0 }),
    insight: () => ({ stored: false }),
    archive: () => ({ archived: 0 }),
    chat: (payload) => ({ reply: "在呀", payload }),
    web_search: (payload) => ({ ok: true, code: null, hits: [], payload }),
    web_fetch: (payload) => ({ ok: true, code: null, payload }),
  };
}

function post(port: number, body: string, token = TOKEN): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/apply",
        method: "POST",
        headers: { "content-type": "application/json", "x-ase-token": token },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const servers: WriteServerHandle[] = [];
async function server(token = TOKEN): Promise<WriteServerHandle> {
  const handle = await startWriteServer({ handlers: handlers(), token });
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of servers.splice(0)) await handle.close();
});

describe("写通道地基（task-137/task-166：10 个 op 的集合）", () => {
  it("WRITE_OPS 恰好 10 个，顺序稳定（旧 7 个 + chat/web_search/web_fetch）", () => {
    expect([...WRITE_OPS]).toEqual([
      "turn",
      "remember",
      "advance",
      "reset",
      "consolidate",
      "insight",
      "archive",
      "chat",
      "web_search",
      "web_fetch",
    ]);
    for (const op of WRITE_OPS) expect(isWriteOp(op)).toBe(true);
    expect(isWriteOp("chat")).toBe(true);
    expect(isWriteOp("web_search")).toBe(true);
    expect(isWriteOp("web_fetch")).toBe(true);
    expect(isWriteOp("nope")).toBe(false);
  });

  it("parseWriteRequest 接受 chat / web_search 的 payload 形状", () => {
    const chat: ChatRequest = { text: "在吗", clientId: "web-abc", sentAtMs: 1 };
    const search: WebSearchRequest = { query: "AI助手", maxResults: 5, fresh: true };
    expect(parseWriteRequest({ version: WRITE_CHANNEL_VERSION, op: "chat", payload: chat })).toEqual({
      op: "chat",
      payload: chat,
    });
    expect(parseWriteRequest({ version: WRITE_CHANNEL_VERSION, op: "web_search", payload: search })).toEqual({
      op: "web_search",
      payload: search,
    });
  });
});

describe("写通道地基（task-137：错误码透传）", () => {
  it("handler 抛出的 err.code 原样进响应（chat 的 asleep / bad-request 靠它）", async () => {
    const handle = await startWriteServer({
      token: TOKEN,
      handlers: {
        ...handlers(),
        chat: () => {
          const err = new Error("她睡着了（asleep：quiet）");
          (err as Error & { code?: string }).code = "asleep";
          throw err;
        },
      },
    });
    servers.push(handle);
    const res = await post(handle.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "chat", payload: {} }));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text) as { ok: boolean; error: string; code?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("睡着了");
    expect(parsed.code).toBe("asleep");
  });

  it("普通 Error 不带 code 字段（旧调用方一字不差）", async () => {
    const handle = await startWriteServer({
      token: TOKEN,
      handlers: {
        ...handlers(),
        web_search: () => {
          throw new Error("搜索层超时");
        },
      },
    });
    servers.push(handle);
    const res = await post(handle.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "web_search", payload: {} }));
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(false);
    expect(parsed["error"]).toContain("超时");
    expect("code" in parsed).toBe(false);
  });

  it("errorCodeOf 只认非空 string，其余一律 undefined", () => {
    const withCode = new Error("x") as Error & { code?: unknown };
    withCode.code = "asleep";
    expect(errorCodeOf(withCode)).toBe("asleep");
    expect(errorCodeOf(new Error("no code"))).toBeUndefined();
    withCode.code = "";
    expect(errorCodeOf(withCode)).toBeUndefined();
    withCode.code = 42;
    expect(errorCodeOf(withCode)).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
    expect(errorCodeOf("asleep")).toBeUndefined();
  });
});

describe("写通道地基（task-137：新旧兼容）", () => {
  it("未知 op 回 400，服务不崩，随后合法 op 仍可用", async () => {
    const handle = await server();
    const bad = await post(handle.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "drop-table", payload: {} }));
    expect(bad.status).toBe(400);
    expect((JSON.parse(bad.text) as { code?: string }).code).toBe("CHANNEL_UNSUPPORTED");
    const ok = await post(handle.port, JSON.stringify({ version: WRITE_CHANNEL_VERSION, op: "turn", payload: {} }));
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.text) as { ok: boolean }).ok).toBe(true);
  });

  it("通道认识 chat/web_search，但装配层没注入 handler 时回 CHANNEL_UNSUPPORTED 且不崩", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "write-channel-unsupported-"));
    const handle = await startWriteChannel({
      dataDir,
      characterId: "assistant",
      runtime: {
        turn: () => ({}),
        remember: () => ({}),
        advance: () => ({}),
        reset: () => ({}),
        consolidate: () => ({}),
        submitInsight: () => ({}),
        archiveCold: () => ({}),
        restoreCold: () => ({}),
        purgeCold: () => ({}),
      },
      log: () => {},
    });
    try {
      const res = await callWriteChannel({ dataDir, characterId: "assistant", op: "chat", payload: {} });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("CHANNEL_UNSUPPORTED");
      const search = await callWriteChannel({ dataDir, characterId: "assistant", op: "web_search", payload: {} });
      expect(search.code).toBe("CHANNEL_UNSUPPORTED");
      const fetched = await callWriteChannel({ dataDir, characterId: "assistant", op: "web_fetch", payload: {} });
      expect(fetched.code).toBe("CHANNEL_UNSUPPORTED");
    } finally {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("注入的 chat / web_search handler 拿到原始 payload（业务在 task-138/139）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "write-channel-inject-"));
    const seen: unknown[] = [];
    const handle = await startWriteChannel({
      dataDir,
      characterId: "assistant",
      runtime: {
        turn: () => ({}),
        remember: () => ({}),
        advance: () => ({}),
        reset: () => ({}),
        consolidate: () => ({}),
        submitInsight: () => ({}),
        archiveCold: () => ({}),
        restoreCold: () => ({}),
        purgeCold: () => ({}),
      },
      log: () => {},
      chat: (payload) => {
        seen.push(payload);
        const result: ChatResult = { reply: "在呀", mode: "NORMAL", historyWritten: true };
        return result;
      },
      webSearch: (payload) => {
        seen.push(payload);
        const result: WebSearchResult = {
          ok: true,
          code: null,
          hits: [],
          failure: null,
          message: null,
          retryAfterMs: null,
          stats: { searchCount: 0, dailyCap: 20 },
        };
        return result;
      },
    });
    try {
      const chat = await callWriteChannel<ChatResult>({ dataDir, characterId: "assistant", op: "chat", payload: { text: "在吗" } });
      expect(chat.ok).toBe(true);
      expect(chat.result?.reply).toBe("在呀");
      const search = await callWriteChannel<WebSearchResult>({
        dataDir,
        characterId: "assistant",
        op: "web_search",
        payload: { query: "AI助手" },
      });
      expect(search.ok).toBe(true);
      expect(seen).toEqual([{ text: "在吗" }, { query: "AI助手" }]);
    } finally {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("task-138：web_search 业务往返（daemon 侧纯编排 + 通道）", () => {
  const NOW = Date.parse("2026-11-02T12:00:00+08:00");
  const WEB_CFG: WebConfig = {
    enabled: true,
    searchDailyCap: 20,
    fetchDailyCap: 10,
    minIntervalMs: 1_800_000,
    timeoutMs: 8_000,
    sourceCredibility: 0.55,
  };

  it("插件投 query → daemon 编排（fresh/条数原样）→ 插件拿到结构化 hits", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "write-channel-web-"));
    const handle = await startWriteChannel({
      dataDir,
      characterId: "assistant",
      runtime: {
        turn: () => ({}),
        remember: () => ({}),
        advance: () => ({}),
        reset: () => ({}),
        consolidate: () => ({}),
        submitInsight: () => ({}),
        archiveCold: () => ({}),
        restoreCold: () => ({}),
        purgeCold: () => ({}),
      },
      log: () => {},
      webSearch: async (raw) => {
        const req = raw as WebSearchRequest;
        const run = await runWebToolSearch({
          query: req.query,
          ...(req.maxResults === undefined ? {} : { maxResults: req.maxResults }),
          fresh: req.fresh === true,
          nowMs: NOW,
          cfg: WEB_CFG,
          usage: emptyWebUsage(NOW, 480),
          hasKey: true,
          search: () =>
            Promise.resolve({
              ok: true,
              hits: [
                {
                  title: "AI助手与往世乐土",
                  url: "https://example.com/a",
                  snippet: "一段摘要",
                  siteName: "example",
                  publishedAtMs: NOW - 60_000,
                  authority: 3,
                  rerankScore: 2,
                  summary: "更长的摘要正文",
                },
              ],
              failure: null,
              status: 200,
            }),
        });
        return run.result;
      },
    });
    try {
      const res = await callWriteChannel<WebSearchResult>({
        dataDir,
        characterId: "assistant",
        op: "web_search",
        payload: { query: "AI助手", maxResults: 2, fresh: true },
      });
      expect(res.ok).toBe(true);
      expect(res.result?.ok).toBe(true);
      expect(res.result?.fresh).toBe(true);
      expect(res.result?.hits).toHaveLength(1);
      expect(res.result?.hits[0]?.title).toBe("AI助手与往世乐土");
      expect(res.result?.stats.dailyCap).toBe(20);
    } finally {
      await handle.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
