/**
 * 写通道 + 工具层（批次 2b）：插件工具"只投递、不自己写"。
 *
 * 这里用真实的 SoulRuntime（临时目录）当"自主进程"，用真实的小 HTTP 服务当通道，
 * 断言的是**投递到位**与**没投递时不写**——不是运行时的数值行为（那些在 state/plugin 测试里）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { buildTools } from "../src/plugin/tools.js";
import { WriteChannelUnavailableError } from "../src/plugin/write-client.js";
import {
  newWriteToken,
  startWriteServer,
  writeChannelFile,
  writeChannelPath,
  WRITE_CHANNEL_VERSION,
  type WriteOp,
  type WriteServerHandle,
} from "../src/autonomy/write-server.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;
const servers: WriteServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-channel-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  op: WriteOp;
  payload: unknown;
}

async function fakeChannel(result: unknown): Promise<{ seen: Seen[]; target: { dataDir: string; characterId: string } }> {
  const seen: Seen[] = [];
  const token = newWriteToken();
  const server = await startWriteServer({
    token,
    handlers: {
      turn: () => result,
      remember: (payload) => {
        seen.push({ op: "remember", payload });
        return { stored: 1, id: "fake-1", reason: "channel" };
      },
      advance: (payload) => {
        seen.push({ op: "advance", payload });
        return { steps: 1, pressure: 0, energy: 1, mask: 1, faded: 0, forgotten: 0, taintCleared: 0, sleep: null };
      },
      reset: () => ({ reset: true }),
      consolidate: () => ({ clusters: 0, written: 0, accepted: [], rejected: [] }),
      insight: () => ({ stored: true, id: "k-1", verdict: "accepted", reason: "" }),
      archive: () => ({ archived: 0, ids: [] }),
    },
  });
  servers.push(server);
  writeChannelFile(writeChannelPath(dir, "test"), {
    version: WRITE_CHANNEL_VERSION,
    port: server.port,
    token,
    pid: 1,
    atMs: clock.now(),
  });
  return { seen, target: { dataDir: dir, characterId: "test" } };
}

function tool(rt: SoulRuntime, target: { dataDir: string; characterId: string } | null, name: string) {
  const tools = buildTools(rt, { channel: target });
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`没有工具 ${name}`);
  return found;
}

describe("工具层：写类工具投递写通道（批次 2b）", () => {
  it("soul_remember 走通道，不写本进程 runtime", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const { seen, target } = await fakeChannel(null);
    const before = rt.memoryStore().all().length;
    const out = await tool(rt, target, "soul_remember").execute({ content: "用户说周末去看海", source: "player" });
    expect(out).toContain("stored=1");
    expect(out).toContain("id=fake-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.op).toBe("remember");
    expect((seen[0]!.payload as { content: string }).content).toContain("看海");
    // 本进程没有真的写：真实 store 里没有这条（通道返回的是假结果）
    expect(rt.memoryStore().all().length).toBe(before);
  });

  it("soul_advance 把 hours 原样投过去", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const { seen, target } = await fakeChannel(null);
    const out = await tool(rt, target, "soul_advance").execute({ hours: 6 });
    expect(out).toContain("steps=1");
    expect(seen[0]!.op).toBe("advance");
    expect(seen[0]!.payload).toEqual({ hours: 6 });
  });

  it("没有通道文件：报错，不回退成本进程写", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const before = rt.memoryStore().all().length;
    const t = tool(rt, { dataDir: join(dir, "no-such-dir"), characterId: "test" }, "soul_remember");
    await expect(t.execute({ content: "不该写进去", source: "player" })).rejects.toThrow(WriteChannelUnavailableError);
    expect(rt.memoryStore().all().length).toBe(before);
  });

  it("通道业务失败：把原因抛给调用者", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const server = await startWriteServer({
      token: newWriteToken(),
      handlers: {
        turn: () => ({}),
        remember: () => {
          throw new Error("防火墙拒绝了这条");
        },
        advance: () => ({}),
        reset: () => ({}),
        consolidate: () => ({}),
        insight: () => ({}),
        archive: () => ({}),
      },
    });
    servers.push(server);
    writeChannelFile(writeChannelPath(dir, "test"), {
      version: WRITE_CHANNEL_VERSION,
      port: server.port,
      token: server.token,
      pid: 1,
      atMs: clock.now(),
    });
    const t = tool(rt, { dataDir: dir, characterId: "test" }, "soul_remember");
    await expect(t.execute({ content: "x", source: "player" })).rejects.toThrow(/防火墙/);
  });

  it("channel=null（单测/脚本直接 buildTools）：退回直接调用本进程 runtime", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const out = await tool(rt, null, "soul_remember").execute({ content: "用户说周末去看海", source: "player" });
    expect(out).toContain("[soul_remember]");
    expect(rt.memoryStore().all().length).toBe(1);
  });
});
