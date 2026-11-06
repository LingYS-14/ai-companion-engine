/**
 * F300：QQ 接待接线搬进装配层后，"交不交给常驻进程"第一次有了单测。
 *
 * 这里锁三件事：
 * 1. 三种不交的情况（没配置 / 一次性模式 / 桥归宿主）——不启动、不抛错、日志说清原因；
 * 2. 交的时候参数与洞都接对了（静默窗 23–7、间隔、spine 快照路径、时钟、四个注入的洞）；
 * 3. 入口脚本不再自己拼这段，但出站直连仍留在入口（H11：扫描面内不许新增直连发送）。
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  QQ_MAX_PER_HOUR,
  QQ_MIN_GAP_MS,
  QQ_QUIET_FROM,
  QQ_QUIET_TO,
  startQqBridge,
  type QqBridgeInput,
} from "../src/assembly/qq-wiring.js";
import type { AutonomyQqHandle, AutonomyQqInput } from "../src/autonomy/qq-runner.js";
import type { OneBotConn } from "../src/autonomy/onebot-config.js";

const CONN: OneBotConn = {
  baseUrl: "http://127.0.0.1:3000",
  token: "t",
  peer: 10000001,
  dryRun: true,
  wsUrl: "ws://127.0.0.1:3001",
  wsToken: "t",
  owner: "autonomy",
};

const LLM = { baseUrl: "https://x.test", apiKey: "k", model: "m", timeoutMs: 1000 };

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "qq-wiring-"));
}

function holes(): Pick<QqBridgeInput, "sendImage" | "shareImage" | "sendVoice" | "transcribeVoice"> {
  return {
    sendImage: async () => ({ ok: true, detail: "image" }),
    shareImage: () => null,
    sendVoice: async () => ({ ok: true, detail: "voice" }),
    transcribeVoice: async () => "转写",
  };
}

function baseInput(overrides: Partial<QqBridgeInput> = {}): QqBridgeInput {
  return {
    dataDir: tempDataDir(),
    characterId: "assistant",
    repo: "C:/repo",
    conn: CONN,
    once: false,
    runtime: {} as never,
    llm: LLM,
    tzOffsetMinutes: 480,
    now: () => 1_793_500_000_000,
    log: () => undefined,
    ...holes(),
    ...overrides,
  };
}

function fakeHandle(stop: () => void = () => undefined): AutonomyQqHandle {
  return { bridge: {} as never, relay: {} as never, stop, lockPath: "lock" };
}

describe("startQqBridge：什么时候不交", () => {
  it("没有 OneBot 配置 → 不启动、不记这句（入口已经记过）", () => {
    const logs: string[] = [];
    let called = 0;
    const out = startQqBridge(
      baseInput({
        conn: null,
        log: (line) => logs.push(line),
        startBridge: () => {
          called += 1;
          return fakeHandle();
        },
      }),
    );
    expect(out).toBeNull();
    expect(called).toBe(0);
    expect(logs).toEqual([]);
  });

  it("一次性的 --say 模式 → 不启动", () => {
    let called = 0;
    const out = startQqBridge(
      baseInput({
        once: true,
        startBridge: () => {
          called += 1;
          return fakeHandle();
        },
      }),
    );
    expect(out).toBeNull();
    expect(called).toBe(0);
  });

  it("桥归宿主 → 不启动并写明原因", () => {
    const logs: string[] = [];
    let called = 0;
    const out = startQqBridge(
      baseInput({
        conn: { ...CONN, owner: "host" },
        log: (line) => logs.push(line),
        startBridge: () => {
          called += 1;
          return fakeHandle();
        },
      }),
    );
    expect(out).toBeNull();
    expect(called).toBe(0);
    expect(logs.join("\n")).toContain("owner=host");
  });
});

describe("startQqBridge：交的时候接对了吗", () => {
  it("静默窗/间隔/spine 路径/时钟/四个洞都按装配默认值给", () => {
    let captured: AutonomyQqInput | null = null;
    const now = Date.UTC(2026, 10, 1, 18, 0, 0); // 东八区 02:00
    const handle = fakeHandle();
    const dataDir = tempDataDir();
    const injected = holes();
    const out = startQqBridge(
      baseInput({
        dataDir,
        now: () => now,
        ...injected,
        startBridge: (input) => {
          captured = input;
          return handle;
        },
      }),
    );
    expect(out).toBe(handle);
    const seen = captured as unknown as AutonomyQqInput;
    expect(seen.quietFrom).toBe(QQ_QUIET_FROM);
    expect(seen.quietTo).toBe(QQ_QUIET_TO);
    expect(seen.minGapMs).toBe(QQ_MIN_GAP_MS);
    expect(seen.maxPerHour).toBe(QQ_MAX_PER_HOUR);
    expect(seen.spinePath).toBe(join(dataDir, "spine-assistant.json"));
    expect(seen.localHour()).toBe(2);
    // 洞是同一个函数对象（不是重新包一层、也不是被替换）
    expect(seen.sendImageImpl).toBe(injected.sendImage);
    expect(seen.shareImage).toBe(injected.shareImage);
    expect(seen.sendVoiceImpl).toBe(injected.sendVoice);
    expect(typeof seen.transcribeVoiceImpl).toBe("function");
  });

  it("没有凭据时桥工厂返回 null，日志说明「未启动」", () => {
    const logs: string[] = [];
    const out = startQqBridge(
      baseInput({
        llm: null,
        log: (line) => logs.push(line),
        startBridge: () => null,
      }),
    );
    expect(out).toBeNull();
    expect(logs.join("\n")).toContain("没有凭据：QQ 接待未启动");
  });

  it("转写：把文件路径交给注入的转写洞", async () => {
    let got = "";
    let captured: AutonomyQqInput | null = null;
    startQqBridge(
      baseInput({
        transcribeVoice: async (path) => {
          got = path;
          return "转写";
        },
        startBridge: (input) => {
          captured = input;
          return fakeHandle();
        },
      }),
    );
    const seen = captured as unknown as AutonomyQqInput;
    const text = await seen.transcribeVoiceImpl?.({ name: "a.silk", path: "C:/x/a.silk" });
    expect(text).toBe("转写");
    expect(got).toBe("C:/x/a.silk");
  });
});

describe("接线锁（F300）", () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("入口只调 startQqBridge，不再自己拼桥参数", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).toContain("startQqBridge({");
    expect(main).not.toContain("startAutonomyQq(");
    expect(main).not.toContain("quietFrom: 23");
  });

  it("出站直连仍留在入口（H11 收口），装配层不 import 发送函数", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).toContain("sendPrivateImage");
    expect(main).toContain("sendPrivateRecord");
    expect(main).toContain("pickShareableImage");

    const module = read("src/assembly/qq-wiring.ts");
    expect(module).not.toContain("../qq/onebot.js");
    expect(module).not.toContain("attachments.js");
    expect(module).toContain("spine-");
    expect(QQ_QUIET_FROM).toBe(23);
    expect(QQ_QUIET_TO).toBe(7);
  });
});
