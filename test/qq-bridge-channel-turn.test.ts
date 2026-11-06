/**
 * F272：QQ 桥的「回合」可以交给装配点执行（插件侧投给唯一写者）。
 *
 * 这里只测桥这一侧的接缝：给了 `deps.turn` 就不再调本进程 `rt.turn`，
 * 且请求/选项原样传过去。真正的投递（HTTP 写通道）在 channel-turn 的测试里。
 */
import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { QQBridge, type QQDeps } from "../src/qq/bridge.js";
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { DEFAULT_QQ_OPTIONS, emptyQQState, type InboxMessage, type QQOptions } from "../src/qq/types.js";
import type { TurnOptions, TurnRequest, TurnText } from "../src/ports/index.js";
import type { Persona } from "../src/dialogue/persona.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const opts = (over: Partial<QQOptions> = {}): QQOptions => ({ ...DEFAULT_QQ_OPTIONS, ignoreOlderThanMs: 60_000, ...over });

function msg(id: string, text: string): InboxMessage {
  return { id, epochNs: (NOW - 5_000) * 1e6, at: "12:00:00", sender: "用户", text };
}

function fakeTurnText(): TurnText {
  return {
    mode: "NORMAL",
    stage: "stranger",
    bondProgress: 0,
    state: {},
    style: { modeStyle: "平常", stageStyle: "客气", expressionStyle: "稳", suppressInstruction: "不必压", signals: {} },
    expression: { tone: "稳", move: "聊", avoid: "别急", quadrant: "secure", stage: "stranger", source: "table" },
    eventStyle: null,
    memory: { wrote: 1, rejected: 0 },
    bandit: { actionTag: "care", ucb: 0, source: "fallback", candidates: [], scored: false },
  } as unknown as TurnText;
}

function runtimeWith(turn: (req: TurnRequest) => TurnText): SoulRuntime {
  return { turn, persona: (): Persona | null => null } as unknown as SoulRuntime;
}

interface Harness {
  readonly deps: QQDeps;
  readonly inbox: InboxMessage[];
  readonly sent: string[];
  readonly channelTurns: { req: TurnRequest; opts?: TurnOptions }[];
}

function harness(over: Partial<QQDeps> = {}): Harness {
  const inbox: InboxMessage[] = [];
  const sent: string[] = [];
  const channelTurns: { req: TurnRequest; opts?: TurnOptions }[] = [];
  const deps: QQDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise: appraiseFromText,
    readInbox: () => inbox,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    saveState: () => {},
    generate: async () => "嗯，我在呢♪",
    send: async (text) => {
      sent.push(text);
      return { ok: true, detail: "sent" };
    },
    turn: async (req, o) => {
      channelTurns.push(o === undefined ? { req } : { req, opts: o });
      return fakeTurnText();
    },
    ...over,
  };
  return { deps, inbox, sent, channelTurns };
}

describe("F272：桥的回合可以交给装配点执行", () => {
  it("给了 deps.turn 就投给它，且不碰本进程 runtime.turn", async () => {
    const h = harness();
    const rt = runtimeWith(() => {
      throw new Error("不该直接调本进程 turn（F272）");
    });
    const bridge = new QQBridge(rt, opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("replied");
    expect(h.sent).toEqual(["嗯，我在呢♪"]);
    expect(h.channelTurns.length).toBe(1);
    expect(h.channelTurns[0]?.req.text).toBe("在吗");
    expect(h.channelTurns[0]?.opts?.source).toBe("qq_contact_verified");
  });

  it("没给 deps.turn 时退回本进程 turn（常驻进程/旧装配不变）", async () => {
    const h = harness();
    const calls: string[] = [];
    const rt = runtimeWith((req) => {
      calls.push(req.text);
      return fakeTurnText();
    });
    const { turn: _omit, ...depsWithoutTurn } = h.deps;
    void _omit;
    const bridge = new QQBridge(rt, opts({ dryRun: true }), depsWithoutTurn);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("dry-run");
    expect(calls).toEqual(["在吗"]);
  });

  it("投递抛错时按 engine-failed 记，不假装回过", async () => {
    const h = harness({
      turn: async () => {
        throw new Error("写通道连不上");
      },
    });
    const rt = runtimeWith(() => fakeTurnText());
    const bridge = new QQBridge(rt, opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("engine-failed");
    expect(r.detail).toContain("写通道连不上");
    expect(h.sent).toEqual([]);
  });

  // ---------- P0-F：窗口桥回信入记忆（与 OneBot 同契约，旁路失败不阻断） ----------

  it("P0-F：真发送成功后回调一次，参数是发出去的那句", async () => {
    const calls: string[] = [];
    const h = harness({ rememberReply: (reply: string) => calls.push(reply) });
    const bridge = new QQBridge(runtimeWith(() => fakeTurnText()), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("replied");
    expect(calls).toEqual(["嗯，我在呢♪"]);
  });

  it("P0-F：发送失败不写记忆", async () => {
    const calls: string[] = [];
    const h = harness({
      rememberReply: (reply: string) => calls.push(reply),
      send: async () => ({ ok: false, detail: "relay down" }),
    });
    const bridge = new QQBridge(runtimeWith(() => fakeTurnText()), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("send-failed");
    expect(calls).toEqual([]);
  });

  it("P0-F：回调异步拒绝不影响 acted，也不留 unhandled", async () => {
    const h = harness({ rememberReply: () => Promise.reject(new Error("async down")) });
    const bridge = new QQBridge(runtimeWith(() => fakeTurnText()), opts({ dryRun: false }), h.deps);
    h.inbox.push(msg("m1", "在吗"));
    const r = await bridge.poll();
    expect(r.reason).toBe("replied");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
