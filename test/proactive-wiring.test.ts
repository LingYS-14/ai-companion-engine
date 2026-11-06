/**
 * 主动开口的接线测试：线上配置（qq.enabled=false + qq.onebot.enabled=true）下它也必须活着。
 *
 * 为什么单独一个文件：这里测的是**接线**（哪条桥被选中、定时器有没有起、工具能不能跑），
 * 而不是决策规则——判据本身的数值断言在 proactive.test.ts 里，别重复。
 *
 * 两条路都要覆盖，因为线上就是这样：
 *   1. 工具层：`soul_qq_proactive` 优先用 OneBot 桥，只有窗口桥时退回它；
 *   2. 后台线程：有任一桥 + proactive.enabled=true 就起，日志里能看出用的哪种桥。
 *
 * 不碰真实环境：WS relay 被 mock（否则 apply 会 spawn 子进程），发送/生成/saveState 全是假的。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { apply, type PluginConfig } from "../src/plugin/index.js";
import { buildTools, type QQBridgeLike, type ToolDefinition } from "../src/plugin/tools.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";

/**
 * 把 WS relay 换成假的：apply 里真起 OneBot 会 `spawn` 一个 Node 子进程去连 WS，
 * 单测既没有服务也不该起进程。apply 只用它的 `stop()`，所以假到够用即可。
 */
const relay = vi.hoisted(() => ({ started: 0 }));
vi.mock("../src/qq/wsrelay.js", () => ({
  startWsRelay: () => {
    relay.started += 1;
    return { stop: () => {}, state: () => "stopped" };
  },
}));

const NOW = 1_700_000_000_000;
const PEER = 100_000_001;

function proactiveRuntime(pressure = 0.9): SoulRuntime {
  // 只给 proactive() 用到的三个方法：状态快照、动机层、人格卡
  const fake = {
    snapshot: () => ({
      mode: "NORMAL",
      state: { pressure, rumination: 0, energy: 1, entropy: 0 },
    }),
    wonder: () => ({ score: 0, push: null, reason: "测试：不给动机层加分" }),
    persona: () => null,
  };
  return fake as unknown as SoulRuntime;
}

interface OneBotHarness {
  readonly bridge: OneBotBridge;
  readonly sent: { peer: number; text: string }[];
  readonly saved: QQStateRecord[];
  readonly reply: { text: string };
}

function onebotHarness(): OneBotHarness {
  const sent: OneBotHarness["sent"] = [];
  const saved: OneBotHarness["saved"] = [];
  const reply = { text: "好呀♪" };
  const deps: OneBotBridgeDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async () => reply.text,
    send: async (input) => {
      sent.push(input);
      return { ok: true, detail: "onebot: 已发送" };
    },
    saveState: (state) => {
      saved.push(state);
    },
    log: () => {},
  };
  const bridge = new OneBotBridge(
    proactiveRuntime(),
    makeOneBotOptions({ peer: PEER, peerName: "用户", dryRun: false }),
    deps,
    emptyQQState(),
  );
  return { bridge, sent, saved, reply };
}

/** 只用窗口桥的工具测试：验证 `extras.qq` 回退路径没被这次改动弄坏 */
function windowBridgeStub(): QQBridgeLike {
  return {
    status: () => ({
      dryRun: false,
      peer: "用户",
      replied: 0,
      lastReplyAt: null,
      cursorEpochNs: 0,
      repliesLastHour: 0,
    }),
    poll: async () => ({ acted: false, reason: "idle", detail: "" }),
    sendContent: async () => ({ ok: false, detail: "测试里不发文件" }),
    proactive: async () => ({ acted: false, verdict: "calm", detail: "状态平稳，没有非说不可的话" }),
  };
}

async function runProactiveTool(defs: readonly ToolDefinition[]): Promise<string> {
  const tool = defs.find((d) => d.name === "soul_qq_proactive");
  expect(tool).toBeDefined();
  return tool!.execute({});
}

// ---------- 工具层：桥的选择 ----------

describe("soul_qq_proactive：桥的选择", () => {
  it("只有 OneBot 桥（线上 qq.enabled=false）也能执行，并真的调用到它的 proactive", async () => {
    const { bridge, sent, saved, reply } = onebotHarness();
    const out = await runProactiveTool(buildTools(proactiveRuntime(), { proactive: bridge }));

    // 关键：不再是"未启用"，而是真的跑了一轮
    expect(out).not.toContain("未启用");
    const lines = out.split("\n");
    expect(lines[0]).toBe("[soul_qq_proactive] acted=true verdict=spoke topic=held_back");
    expect(lines[1]).toBe("onebot: 已发送");
    expect(lines[2]).toBe(`[said] ${reply.text}`);
    // 断言打到 OneBot 桥的发送上：意味着 proactive() 是它执行的（窗口桥此刻不存在）
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ peer: PEER, text: reply.text });
    // 记账也落了：滚动 24 小时的计数与 lastProactiveAt
    expect(saved).toHaveLength(1);
    expect(saved[0]?.lastProactiveAt).toBe(NOW);
    expect(saved[0]?.proactiveAt).toEqual([NOW]);
  });

  it("两个桥都没有：仍然回答未启用（文案不变）", async () => {
    const out = await runProactiveTool(buildTools(proactiveRuntime(), {}));
    expect(out).toBe("[soul_qq_proactive] 未启用（config.qq.enabled=false）");

    const out2 = await runProactiveTool(buildTools(proactiveRuntime(), { proactive: null, qq: null }));
    expect(out2).toBe("[soul_qq_proactive] 未启用（config.qq.enabled=false）");
  });

  it("只有窗口桥时仍走它：回退路径与输出格式没变", async () => {
    const out = await runProactiveTool(buildTools(proactiveRuntime(), { qq: windowBridgeStub() }));
    expect(out).toContain("[soul_qq_proactive] acted=false verdict=calm");
    expect(out).toContain("状态平稳");
  });
});

// ---------- apply：后台线程的接线 ----------

interface FakeHost {
  readonly ctx: unknown;
  readonly logs: string[];
  readonly labels: string[];
  readonly intervals: number[];
  readonly tools: ToolDefinition[];
}

/** 假宿主：只实现 apply 会用到的那几个面（logger/timer/effect/inject/get/systemPrompt） */
function fakeHost(): FakeHost {
  const logs: string[] = [];
  const labels: string[] = [];
  const intervals: number[] = [];
  const tools: ToolDefinition[] = [];

  const recordEffect = (fn: () => (() => void) | void, label?: string): void => {
    if (label !== undefined) labels.push(label);
    fn();
  };
  const ctx = {
    logger: {
      info: (msg: string) => {
        logs.push(msg);
      },
      warn: (msg: string) => {
        logs.push(msg);
      },
    },
    effect: recordEffect,
    inject(_names: string[], fn: (scope: never) => void): void {
      fn({
        tools: {
          register: (definition: ToolDefinition) => {
            tools.push(definition);
            return () => {};
          },
        },
        effect: recordEffect,
      } as never);
    },
    get: () => undefined,
    timer: {
      interval: (_cb: () => void, ms: number): (() => void) => {
        intervals.push(ms);
        return () => {};
      },
    },
    systemPrompt: { section: () => {}, getSectionOrder: () => undefined },
  };
  return { ctx, logs, labels, intervals, tools };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-proactive-wiring-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runApply(config: PluginConfig): Promise<FakeHost> {
  const host = fakeHost();
  await apply(host.ctx as never, { characterId: "wiring", dataDir: dir, ...config });
  return host;
}

const WINDOW_QQ = { enabled: true, intervalSec: 60, dryRun: true } as const;

describe("apply：主动开口已搬到常驻进程（F271，插件不再有定时主动路径）", () => {
  it("proactive.enabled=false：只起窗口轮询，不注册主动开口的检查定时器", async () => {
    const host = await runApply({ qq: { ...WINDOW_QQ, proactive: { enabled: false } } });

    // 窗口轮询 60s 是唯一一个定时器；主动开口默认 5 分钟，不该出现
    expect(host.intervals).toEqual([60_000]);
    expect(host.labels).not.toContain("ai-companion-engine: proactive");
    expect(host.logs.some((l) => l.includes("主动开口已启动"))).toBe(false);
  });

  it("proactive.enabled=true 也不再起线程：主动开口只归常驻进程", async () => {
    const host = await runApply({ qq: { ...WINDOW_QQ, proactive: { enabled: true } } });

    // 唯一允许的定时器是窗口轮询（60s）；旧的 5 分钟主动检查与它的日志都不该再出现。
    expect(host.intervals).toEqual([60_000]);
    expect(host.labels).not.toContain("ai-companion-engine: proactive");
    expect(host.logs.some((l) => l.includes("主动开口已启动"))).toBe(false);
  });

  it("qq.enabled=false 只开 OneBot：线程照样起（bridge=onebot），工具也能执行", async () => {
    relay.started = 0;
    const host = await runApply({
      qq: {
        enabled: false,
        peer: "用户",
        proactive: { enabled: true },
        onebot: { enabled: true, peer: PEER, dryRun: true },
      },
    });

    // OneBot 桥建起来了（mock 的 relay 收到了一次启动），主动开口选的是它
    expect(relay.started).toBe(1);
    expect(host.labels).toContain("ai-companion-engine: onebot ws");
    expect(host.logs.some((l) => l.includes("OneBot 已启动"))).toBe(true);
    // 主动线程已删除（F271）：OneBot 桥在，但不再有插件侧主动检查定时器。
    expect(host.intervals).not.toContain(300_000);
    expect(host.labels).not.toContain("ai-companion-engine: proactive");
    expect(host.logs.some((l) => l.includes("主动开口已启动"))).toBe(false);

    // 关键回归点：线上这个配置下 soul_qq_proactive 过去只会回"未启用"
    const out = await runProactiveTool(host.tools);
    expect(out).not.toContain("未启用");
    expect(out).toMatch(/^\[soul_qq_proactive\] acted=(true|false) verdict=\w+/);
  });
});
