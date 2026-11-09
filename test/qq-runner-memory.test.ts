/**
 * P0-F（blocking）：daemon 装配必须把「回信入记忆」接到 OneBotBridge 的 deps 上。
 *
 * 这个文件故意 mock 掉桥本身，只验证 `startAutonomyQq` 组装出来的第 3 参 deps：
 *   - `rememberReply` 存在且可调用；
 *   - 真正写的是 `chat_reply`/`outbound`、tags 带通道；
 *   - `stop()` 释放写锁。
 *
 * 生产路径是 daemon（`scripts/autonomy/main.mjs` → startAutonomyQq），插件 host 只是备用。
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  deps: [] as unknown[],
  options: [] as unknown[],
}));

vi.mock("../src/qq/onebot-bridge.js", () => {
  class OneBotBridge {
    constructor(_runtime: unknown, options: unknown, deps: unknown) {
      captured.options.push(options);
      captured.deps.push(deps);
    }
    async handle(): Promise<{ reason: string; detail: string }> {
      return { reason: "not-message", detail: "mock bridge" };
    }
  }
  return {
    OneBotBridge,
    // 必须保留这个导出：装配点用 <OneBotBridge>(runtime, makeOneBotOptions(...), deps, state)
    makeOneBotOptions: (options: unknown) => options,
  };
});

vi.mock("../src/qq/wsrelay.js", () => ({
  startWsRelay: () => ({ stop: () => {} }),
}));

import { startAutonomyQq } from "../src/autonomy/qq-runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  captured.deps.length = 0;
  captured.options.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-qqrunner-memory-"));
  dirs.push(dir);
  return dir;
}

function start(
  dir: string,
  llm: unknown = { complete: async () => ({ text: "好呀♪", model: "mock" }) },
): { stop: () => void; remember: ReturnType<typeof vi.fn> } {
  const remember = vi.fn(() => ({ stored: true, reason: "", id: "m1" }));
  const handle = startAutonomyQq({
    runtime: {
      persona: () => null,
      remember,
      proactiveGates: () => ({ allowed: true }),
      recall: () => ({ memories: [], knowledge: [] }),
    } as never,
    llm: llm as never,
    dataDir: dir,
    characterId: "assistant",
    repoRoot: process.cwd(),
    onebot: {
      baseUrl: "http://127.0.0.1:3000",
      wsUrl: "ws://127.0.0.1:3001",
      token: "t",
      wsToken: "t",
      peer: 10000001,
      dryRun: false,
    },
    quietFrom: 23,
    quietTo: 7,
    minGapMs: 60_000,
    maxPerHour: 6,
    now: () => 1_700_000_000_000,
    localHour: () => 12,
    log: () => {},
  });
  expect(handle).not.toBeNull();
  return { stop: handle!.stop, remember };
}

describe("P0-F 装配：startAutonomyQq 把 rememberReply 接进 OneBotBridge deps", () => {
  it("deps.rememberReply 存在；调用后写 chat_reply/outbound + tags [chat, qq]", () => {
    const dir = tempDir();
    const { remember } = start(dir);
    expect(captured.deps).toHaveLength(1);
    const deps = captured.deps[0] as { rememberReply?: (reply: string) => void };
    expect(typeof deps.rememberReply).toBe("function");

    deps.rememberReply?.("好呀♪");
    expect(remember).toHaveBeenCalledTimes(1);
    const seed = remember.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(seed["content"]).toBe("我说：「好呀♪」");
    expect(seed["source"]).toBe("chat_reply");
    expect(seed["direction"]).toBe("outbound");
    expect(seed["tags"]).toEqual(["chat", "qq"]);
  });

  it("2026-11-09（单话题根因）：deps.rememberInbound 存在；调用后写 player/inbound + tags [chat, qq]", () => {
    const dir = tempDir();
    const { remember } = start(dir);
    const deps = captured.deps[0] as { rememberInbound?: (text: string) => void };
    expect(typeof deps.rememberInbound).toBe("function");

    deps.rememberInbound?.("我今天其实有点累");
    expect(remember).toHaveBeenCalledTimes(1);
    const seed = remember.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(seed["content"]).toBe("我今天其实有点累");
    expect(seed["source"]).toBe("player");
    expect(seed["direction"]).toBe("inbound");
    expect(seed["tags"]).toEqual(["chat", "qq"]);
  });

  it("stop() 释放写锁（existsSync .writer-lock === false）", () => {
    const dir = tempDir();
    const { stop } = start(dir);
    expect(existsSync(join(dir, ".writer-lock"))).toBe(true);
    stop();
    expect(existsSync(join(dir, ".writer-lock"))).toBe(false);
  });

  it("F353 B1：generate 把 task 透传给 chatComplete（proactive→flash/非思考；缺省→chat→pro）", async () => {
    const dir = tempDir();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: "mock", choices: [{ message: { content: "好" } }] }),
      };
    });
    try {
      start(dir, {
        baseUrl: "https://example.invalid",
        apiKey: "k",
        model: "deepseek-flash",
        proModel: "deepseek-v4-pro",
        timeoutMs: 5000,
      });
      const deps = captured.deps[0] as {
        generate: (input: { system: string; prompt: string; task?: "chat" | "proactive" }) => Promise<string>;
      };
      await deps.generate({ system: "s", prompt: "p", task: "proactive" });
      await deps.generate({ system: "s", prompt: "p" });
      await deps.generate({ system: "s", prompt: "p", task: "chat" });

      expect(bodies[0]?.["model"]).toBe("deepseek-flash");
      expect(bodies[0]?.["thinking"]).toEqual({ type: "disabled" });
      // 缺省按 chat 处理（回信/未知调用方不能悄悄掉到 flash）
      expect(bodies[1]?.["model"]).toBe("deepseek-v4-pro");
      expect(bodies[1]?.["thinking"]).toEqual({ type: "enabled" });
      expect(bodies[2]?.["model"]).toBe("deepseek-v4-pro");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
