import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startWriteChannel, type WriteChannelRuntime } from "../src/assembly/write-channel-wiring.js";
import { callWriteChannel } from "../src/plugin/write-client.js";

interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

function fakeRuntime(): { runtime: WriteChannelRuntime; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record =
    (op: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      return result;
    };
  const runtime: WriteChannelRuntime = {
    turn: record("turn", { reply: "嗯" }),
    remember: record("remember", { stored: true }),
    advance: record("advance", { steps: 1 }),
    reset: record("reset", { ok: true }),
    consolidate: record("consolidate", { accepted: 0 }),
    submitInsight: record("submitInsight", { accepted: true }),
    archiveCold: record("archiveCold", { run: 1 }),
    restoreCold: record("restoreCold", { restored: true }),
    purgeCold: record("purgeCold", { purged: 1 }),
  };
  return { runtime, calls };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "ase-write-wiring-"));
}

const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

async function start(
  options: {
    now?: () => number;
    port?: number;
    chat?: (payload: unknown) => unknown;
    webSearch?: (payload: unknown) => unknown;
    webFetch?: (payload: unknown) => unknown;
  } = {},
) {
  const dataDir = makeDir();
  const { runtime, calls } = fakeRuntime();
  const handle = await startWriteChannel({
    dataDir,
    characterId: "assistant",
    runtime,
    log: () => {},
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.chat === undefined ? {} : { chat: options.chat }),
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
    ...(options.webFetch === undefined ? {} : { webFetch: options.webFetch }),
  });
  handles.push(handle);
  const call = (op: string, payload: unknown) =>
    callWriteChannel({ dataDir, characterId: "assistant", op: op as never, payload: payload as never });
  return { dataDir, handle, calls, call };
}

describe("写通道接线（F286）", () => {
  it("九个 op 都映射到运行时的对应方法", async () => {
    const { call, calls } = await start();
    const reply = await call("turn", { args: { text: "在吗" }, opts: { source: "player" } });
    expect(reply).toEqual({ ok: true, result: { reply: "嗯" } });
    expect(calls[0]).toEqual({ op: "turn", args: [{ text: "在吗" }, { source: "player" }] });

    await call("advance", { hours: 3 });
    await call("reset", { confirm: true });
    await call("insight", { tag: "x" });
    await call("consolidate", { minSize: 2 });
    await call("remember", { content: "记一下" });
    expect(calls.slice(1).map((c) => c.op)).toEqual([
      "advance",
      "reset",
      "submitInsight",
      "consolidate",
      "remember",
    ]);
    expect(calls[1]?.args[0]).toBe(3);
    expect(calls[2]?.args[0]).toBe(true);
    expect(calls[4]?.args[0]).toEqual({ minSize: 2 });
  });

  it("archive 的 run / restore / purge 三个分支", async () => {
    const { call, calls } = await start();
    for (const payload of [
      { action: "run" },
      { action: "restore", memoryId: "m1" },
      { action: "purge", confirm: true },
    ]) {
      const reply = await call("archive", payload);
      expect(reply.ok).toBe(true);
    }
    expect(calls.map((c) => c.op)).toEqual(["archiveCold", "restoreCold", "purgeCold"]);
    expect(calls[1]?.args[0]).toBe("m1");
    expect(calls[2]?.args[0]).toBe(true);
  });

  it("archive 不认识的 action 明确报错，不静默成功", async () => {
    const { call } = await start();
    const reply = await call("archive", { action: "nuke" });
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain("archive 不支持 action=nuke");
  });

  it("通道文件写着 version/port/token/pid，位置在 data 下", async () => {
    const { dataDir, handle } = await start({ now: () => 1_700_000_000_000 });
    expect(handle.channelPath).toBe(join(dataDir, "write-channel-assistant.json"));
    const info = JSON.parse(readFileSync(handle.channelPath, "utf8")) as Record<string, unknown>;
    expect(info["version"]).toBe(1);
    expect(info["port"]).toBe(handle.port);
    expect(String(info["token"]).length).toBeGreaterThanOrEqual(16);
    expect(info["pid"]).toBe(process.pid);
    expect(info["atMs"]).toBe(1_700_000_000_000);
  });

  it("打开时日志与旧实现一字不差（含 127.0.0.1 和 token 提醒）", async () => {
    const dataDir = makeDir();
    const { runtime } = fakeRuntime();
    const lines: string[] = [];
    const handle = await startWriteChannel({
      dataDir,
      characterId: "assistant",
      runtime,
      log: (line) => lines.push(line),
      now: () => 1,
      port: 0,
    });
    handles.push(handle);
    expect(lines).toEqual([
      `[write] 写通道已开：127.0.0.1:${String(handle.port)}（只有本机插件能用；重启会换 token）`,
    ]);
  });

  it("close 删掉通道文件，且重复调用不抛错", async () => {
    const { dataDir, handle } = await start();
    const channelPath = join(dataDir, "write-channel-assistant.json");
    expect(existsSync(channelPath)).toBe(true);
    await handle.close();
    expect(existsSync(channelPath)).toBe(false);
    await expect(handle.close()).resolves.toBeUndefined();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("装配点锁：main.mjs 用 startWriteChannel，不再自己映射 handler", () => {
    const main = readFileSync(join(process.cwd(), "scripts", "autonomy", "main.mjs"), "utf8");
    expect(main).toContain("startWriteChannel(");
    expect(main).toContain("writeChannel.close()");
    expect(main).not.toContain("startWriteServer({");
    expect(main).not.toContain("newWriteToken()");
  });

  it("port 冲突时抛错且不留下通道文件", async () => {
    const first = await start();
    const dataDir = makeDir();
    const { runtime } = fakeRuntime();
    await expect(
      startWriteChannel({
        dataDir,
        characterId: "assistant",
        runtime,
        log: () => {},
        port: first.handle.port,
      }),
    ).rejects.toBeTruthy();
    expect(existsSync(join(dataDir, "write-channel-assistant.json"))).toBe(false);
  });

  it("task-137：chat / web_search handler 由装配层注入并原样拿到 payload", async () => {
    const seen: Array<{ op: string; payload: unknown }> = [];
    const { call } = await start({
      chat: (payload) => {
        seen.push({ op: "chat", payload });
        return { reply: "在呀", mode: "NORMAL", historyWritten: true };
      },
      webSearch: (payload) => {
        seen.push({ op: "web_search", payload });
        return { ok: true, code: null, hits: [] };
      },
    });
    const chat = await call("chat", { text: "在吗", clientId: "web-1" });
    expect(chat.ok).toBe(true);
    expect((chat.result as { reply: string }).reply).toBe("在呀");
    const search = await call("web_search", { query: "AI助手", maxResults: 3 });
    expect(search.ok).toBe(true);
    expect(seen).toEqual([
      { op: "chat", payload: { text: "在吗", clientId: "web-1" } },
      { op: "web_search", payload: { query: "AI助手", maxResults: 3 } },
    ]);
  });

  it("task-137：没有注入 handler 时回 CHANNEL_UNSUPPORTED，且旧 op 不受影响", async () => {
    const { call } = await start();
    const chat = await call("chat", { text: "在吗" });
    expect(chat.ok).toBe(false);
    expect(chat.code).toBe("CHANNEL_UNSUPPORTED");
    const search = await call("web_search", { query: "x" });
    expect(search.ok).toBe(false);
    expect(search.code).toBe("CHANNEL_UNSUPPORTED");
    // 通道没崩：旧 op 仍然正常。
    const turn = await call("turn", { args: { text: "在吗" }, opts: {} });
    expect(turn.ok).toBe(true);
  });

  it("task-166：web_fetch handler 由装配层注入；没注入时明确 CHANNEL_UNSUPPORTED 不 500", async () => {
    const seen: unknown[] = [];
    const { call } = await start({
      webFetch: (payload) => {
        seen.push(payload);
        return { ok: true, code: null, url: "https://example.com/", text: "你好", truncated: false };
      },
    });
    const fetched = await call("web_fetch", { url: "https://example.com/", maxChars: 2000 });
    expect(fetched.ok).toBe(true);
    expect(seen).toEqual([{ url: "https://example.com/", maxChars: 2000 }]);

    const missing = await start();
    const unsupported = await missing.call("web_fetch", { url: "https://example.com/" });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.code).toBe("CHANNEL_UNSUPPORTED");
  });
});
