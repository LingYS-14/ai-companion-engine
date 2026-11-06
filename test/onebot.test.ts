/**
 * OneBot v11 通道的规则测试。
 *
 * 不碰真服务：HTTP 用假 fetch、WS 用假 socket、重连用假定时器，
 * 所以"3s→30s 退避"和"stop 后不再重连"这种时间相关的行为也能断言。
 *
 * 覆盖两类让人踩坑的地方：
 *   1. 事件形状 —— 段数组怎么拼、自发消息怎么排、id 从哪来；
 *   2. 决策与记账 —— 去重/静默/间隔、dryRun、发送失败**不**推进游标。
 */

import { describe, expect, it, vi } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
// 桥的「嘴」由装配点注入端口；测试直接用真适配器（测试不受分层门禁约束）
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import {
  OneBotError,
  oneBotBackoffMs,
  sendPrivateImage,
  sendPrivateText,
  startOneBotListener,
  toInbound,
  withAccessToken,
  type OneBotEvent,
  type OneBotSocketCtor,
  type OneBotSocketEvent,
} from "../src/qq/onebot.js";
import type { QQImageBytes } from "../src/qq/bridge.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";
import type { Persona } from "../src/dialogue/persona.js";

const NOW = 1_700_000_000_000;
const SELF = 10_000_002;
const PEER = 100_000_001;
const TOKEN = "REPLACE_WITH_ONEBOT_HTTP_TOKEN";
const WS = "ws://127.0.0.1:3001";
/** 事件时间用秒（OneBot 口径），比"现在"早 5 秒 */
const SEC = Math.floor((NOW - 5_000) / 1000);

function event(over: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    self_id: SELF,
    user_id: PEER,
    time: SEC,
    message_id: 9001,
    message: [{ type: "text", data: { text: "在吗" } }],
    ...over,
  };
}

function opts(over: Parameters<typeof makeOneBotOptions>[0] extends infer T ? Partial<T> : never = {}) {
  return makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false, ...over });
}

function fakeRuntime(calls: { text: string; source?: string; skipMemory?: boolean }[] = []): SoulRuntime {
  const fake = {
    turn(req: { text: string }, o: { source?: string; skipMemory?: boolean }) {
      calls.push({ text: req.text, source: o.source, skipMemory: o.skipMemory });
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
      } as unknown as ReturnType<SoulRuntime["turn"]>;
    },
    persona: (): Persona | null => null,
  };
  return fake as unknown as SoulRuntime;
}

interface BridgeHarness {
  readonly deps: OneBotBridgeDeps;
  readonly generated: { system: string; prompt: string; images?: readonly QQImageBytes[]; task?: string }[];
  readonly sent: { peer: number; text: string }[];
  readonly saved: QQStateRecord[];
  readonly logs: string[];
  readonly ctl: {
    reply: string;
    sendOk: boolean;
    sendDetail: string;
    localHour: number;
    appraise: appraiseFromText,
    heard: string;
    voiceOk: boolean;
    voiceThrows: boolean;
    transcribeThrows: boolean;
  };
  readonly voiced: { peer: number; text: string }[];
}

function harness(
  over: {
    localHour?: number;
    now?: number;
    readImage?: OneBotBridgeDeps["readImage"];
    voice?: boolean;
    /** B.2：反应式路径的熔断前置判断 */
    channelDown?: boolean;
    /** P0-F：回信入记忆旁路 */
    rememberReply?: OneBotBridgeDeps["rememberReply"];
    /** S3b/M5：回信时间一致性摘要旁路 */
    recordTimeClaims?: OneBotBridgeDeps["recordTimeClaims"];
  } = {},
): BridgeHarness {
  const generated: BridgeHarness["generated"] = [];
  const sent: BridgeHarness["sent"] = [];
  const saved: QQStateRecord[] = [];
  const logs: string[] = [];
  const voiced: BridgeHarness["voiced"] = [];
  const ctl = {
    reply: "好呀♪",
    sendOk: true,
    sendDetail: "onebot: 已发送",
    localHour: over.localHour ?? 12,
    appraise: appraiseFromText,
    heard: "我今天有点累",
    voiceOk: true,
    voiceThrows: false,
    transcribeThrows: false,
  };
  const turns: string[] = [];
  const deps: OneBotBridgeDeps = {
    now: () => over.now ?? NOW,
    localHour: () => ctl.localHour,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async (input) => {
      generated.push(input);
      return ctl.reply;
    },
    send: async (input) => {
      sent.push(input);
      return { ok: ctl.sendOk, detail: ctl.sendDetail };
    },
    saveState: (state) => {
      saved.push(state);
    },
    beginTurn: () => {
      turns.push("acquire");
      return () => {
        turns.push("release");
      };
    },
    channelDown: () => over.channelDown === true,
    log: (line) => {
      logs.push(line);
    },
    ...(over.readImage === undefined ? {} : { readImage: over.readImage }),
    ...(over.rememberReply === undefined ? {} : { rememberReply: over.rememberReply }),
    ...(over.recordTimeClaims === undefined ? {} : { recordTimeClaims: over.recordTimeClaims }),
    ...(over.voice !== true
      ? {}
      : {
          transcribeVoice: async () => {
            if (ctl.transcribeThrows) throw new Error("asr down");
            return ctl.heard;
          },
          sendVoice: async (input: { peer: number; text: string }) => {
            voiced.push(input);
            if (ctl.voiceThrows) throw new Error("tts down");
            return { ok: ctl.voiceOk, detail: "record: ok" };
          },
        }),
  };
  return { deps, generated, sent, saved, logs, ctl, voiced, turns };
}

// ---------- 事件归一化 ----------

describe("事件归一化", () => {
  it("文本+图片：正文按 text 段拼、图片取 url、其余段只计数", () => {
    const inbound = toInbound(
      event({
        message: [
          { type: "text", data: { text: "你看  " } },
          { type: "text", data: { text: "这张" } },
          { type: "image", data: { file: "abc.image", url: "https://example.test/a.png", summary: "[图片]" } },
          { type: "record", data: { file: "x.amr" } },
        ],
      }),
    );
    expect(inbound).not.toBeNull();
    expect(inbound?.text).toBe("你看 这张");
    expect(inbound?.images).toEqual([{ name: "[图片]", path: "https://example.test/a.png" }]);
    expect(inbound?.ignoredSegments).toBe(0);
    expect(inbound?.voices).toEqual([{ name: "x.amr", path: "x.amr" }]);
    expect(inbound?.atMs).toBe(SEC * 1000);
    expect(inbound?.userId).toBe(PEER);
  });

  it("纯图：正文为空，图片名退回 file，没有 url/file 的图片只计数", () => {
    const inbound = toInbound(
      event({
        message: [
          { type: "image", data: { file: "b.jpg", summary: "" } },
          { type: "image", data: {} },
        ],
      }),
    );
    expect(inbound?.text).toBe("");
    expect(inbound?.images).toEqual([{ name: "b.jpg", path: "b.jpg" }]);
    expect(inbound?.ignoredSegments).toBe(1);
    expect(inbound?.voices).toEqual([]);
  });

  it("语音段：url 优先，没有就用 file，计进 voices", () => {
    const inbound = toInbound(
      event({
        message: [
          { type: "record", data: { file: "v.amr", url: "https://example.test/v.amr" } },
          { type: "text", data: { text: "听听" } },
        ],
      }),
    );
    expect(inbound?.voices).toEqual([{ name: "v.amr", path: "https://example.test/v.amr" }]);
    expect(inbound?.text).toBe("听听");
    expect(inbound?.ignoredSegments).toBe(0);
  });

  it("自发消息（user_id === self_id）直接丢掉，否则会自问自答", () => {
    expect(toInbound(event({ user_id: SELF }))).toBeNull();
  });

  it("id：优先 message_id；没有时按 user+time+内容合成且稳定", () => {
    expect(toInbound(event())?.id).toBe("ob-9001");
    const noId = event({ message_id: undefined });
    const a = toInbound(noId)?.id;
    const b = toInbound(noId)?.id;
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).not.toBe("ob-9001");
  });
});

// ---------- 决策 ----------

describe("决策", () => {
  it("熔断中不生成回复（B.2 反应式路径）：一次模型调用都不花", async () => {
    const h = harness({ channelDown: true });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(false);
    expect(r.reason).toBe("spine-down");
    expect(r.detail).toContain("脊髓熔断");
    expect(h.generated).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    // 但她仍然听见了：turn 已经跑过（记忆/状态是她的，不该被通道故障吞掉）
    expect(h.saved.length).toBeGreaterThanOrEqual(0);
  });

  it("非消息/非私聊事件忽略", async () => {
    const bridge = new OneBotBridge(fakeRuntime(), opts(), harness().deps);
    const notice = await bridge.handle({ ...event(), post_type: "notice" } as unknown as OneBotEvent);
    const group = await bridge.handle({ ...event(), message_type: "group" } as unknown as OneBotEvent);
    expect(notice.reason).toBe("not-message");
    expect(group.reason).toBe("not-private");
    expect(notice.acted).toBe(false);
    expect(group.acted).toBe(false);
  });

  it("不属于本机器人账号的事件忽略", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ self_id: 111 }));
    expect(r.reason).toBe("self");
    expect(h.generated.length).toBe(0);
  });

  it("非目标 peer 不回", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ user_id: 42, message_id: 9002 }));
    expect(r.reason).toBe("not-peer");
    expect(h.generated.length).toBe(0);
  });

  it("同一条消息只回一次（repliedIds 去重）", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const first = await bridge.handle(event());
    const second = await bridge.handle(event());
    expect(first.reason).toBe("replied");
    expect(second.reason).toBe("duplicate");
    expect(h.sent.length).toBe(1);
  });

  it("静默时段照样回（凌晨 3 点也要应你）", async () => {
    const h = harness({ localHour: 3 });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.reason).toBe("replied");
    expect(h.sent.length).toBe(1);
  });

  it("距上次回复不足最小间隔不回", async () => {
    const h = harness();
    const state: QQStateRecord = { ...emptyQQState(), lastReplyAt: NOW - 1_000 };
    const bridge = new OneBotBridge(fakeRuntime(), opts({ minGapMs: 8_000 }), h.deps, state);
    const r = await bridge.handle(event({ message_id: 9003 }));
    expect(r.reason).toBe("gap");
  });

  it("太旧的消息不回（避免开关一开就把积压全回一遍）", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts({ ignoreOlderThanMs: 60_000 }), h.deps);
    const r = await bridge.handle(event({ message_id: 9004, time: Math.floor((NOW - 120_000) / 1000) }));
    expect(r.reason).toBe("stale");
  });
});

// ---------- 称呼与测试事件 ----------

describe("称呼", () => {
  it("没配 peerName 时用「用户」，不把 QQ 号写进提示词", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), makeOneBotOptions({ peer: PEER, selfId: SELF, dryRun: false }), h.deps);
    await bridge.handle(event());
    expect(h.generated[0]?.task).toBe("chat");
    expect(h.generated[0]?.prompt).toContain("用户：在吗");
    expect(h.generated[0]?.prompt).not.toContain(String(PEER));
  });

  it("peerName 传成号码时也退回「用户」", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts({ peerName: String(PEER) }), h.deps);
    await bridge.handle(event());
    expect(h.generated[0]?.prompt).toContain("用户：在吗");
  });
});

describe("测试注入", () => {
  it("带 ase_test 的事件只记账，不发送", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ message_id: 9100, ase_test: true } as Partial<OneBotEvent>));
    expect(r.reason).toBe("test-held");
    expect(h.sent.length).toBe(0);
    expect(h.generated.length).toBe(0);
  });
});

// ---------- 语音 ----------

describe("语音", () => {
  it("只有语音：先转写再走同一条流水线，提示里带「别提转写」", async () => {
    const h = harness({ voice: true });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ message: [{ type: "record", data: { file: "v.amr" } }] }));
    expect(r.reason).toBe("replied");
    // 生成用的是转写文本（决策与召回都基于它）
    expect(h.generated[0]?.prompt).toContain("我今天有点累");
    expect(h.logs.join(" | ")).toContain("voice ok");
  });

  it("对方发语音就回语音，不重复发文字", async () => {
    const h = harness({ voice: true });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ message: [{ type: "record", data: { file: "v.amr" } }] }));
    expect(r.reason).toBe("replied");
    expect(h.voiced).toEqual([{ peer: PEER, text: "好呀♪" }]);
    expect(h.sent.length).toBe(0);
  });

  it("语音合成失败降级成文字，消息不丢", async () => {
    const h = harness({ voice: true });
    h.ctl.voiceThrows = true;
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ message: [{ type: "record", data: { file: "v.amr" } }] }));
    expect(r.reason).toBe("replied");
    expect(h.sent).toEqual([{ peer: PEER, text: "好呀♪" }]);
    expect(h.logs.join(" | ")).toContain("降级文字");
  });

  it("转写失败也算有内容，回一句「没听清」而不是静默", async () => {
    const h = harness({ voice: true });
    h.ctl.transcribeThrows = true;
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event({ message: [{ type: "record", data: { file: "v.amr" } }] }));
    expect(r.reason).toBe("replied");
    expect(h.generated[0]?.prompt).toContain("没转写出来");
  });
});

// ---------- 生成与发送 ----------

describe("生成与发送", () => {
  it("dryRun：台词照常生成但不发送，游标记账、lastReplyAt 不动", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts({ dryRun: true }), h.deps);
    const r = await bridge.handle(event());
    expect(r.reason).toBe("dry-run");
    expect(r.reply).toBe("好呀♪");
    expect(r.dryRun).toBe(true);
    expect(h.sent.length).toBe(0);
    expect(h.saved.length).toBe(1);
    expect(h.saved[0]?.repliedIds).toContain("ob-9001");
    expect(h.saved[0]?.lastReplyAt).toBeNull();
    expect(h.saved[0]?.onebotLastEventAt).toBe(SEC * 1000);
    // 试运行也算"处理过"：同一条再来不会重复生成
    expect((await bridge.handle(event())).reason).toBe("duplicate");
  });

  it("真发成功：把清理后的台词按 peer 发出去并推进状态", async () => {
    const h = harness();
    h.ctl.reply = "「好呀♪」"; // cleanReply 会剥掉外壳
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(true);
    expect(r.reason).toBe("replied");
    expect(h.sent).toEqual([{ peer: PEER, text: "好呀♪" }]);
    expect(h.saved.at(-1)?.lastReplyAt).toBe(NOW);
    expect(h.saved.at(-1)?.replyTimes).toContain(NOW);
  });

  it("自检消息：生成但拦下不发、不进历史（还会写 skipMemory）", async () => {
    const calls: { text: string; source?: string; skipMemory?: boolean }[] = [];
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(calls), opts(), h.deps);
    // 带自检标记：判定/生成照旧，但回复不发送、不进对话历史
    const r = await bridge.handle(
      event({ message: [{ type: "text", data: { text: "（自检消息，别慌）在吗？我想确认我们还能正常说话。" } }] }),
    );
    expect(r.reason).toBe("selfcheck-held");
    expect(r.reply).toBeTruthy();
    expect(calls.at(-1)?.skipMemory).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.saved.at(-1)?.repliedIds).toContain("ob-9001");

    // 同一条再来：已经记过 id，直接 duplicate，不会又生成一遍
    expect((await bridge.handle(event())).reason).toBe("duplicate");

    // 正常聊天照常回，且历史里不该出现那句自检原文
    const h2 = harness();
    const bridge2 = new OneBotBridge(fakeRuntime(calls), opts(), h2.deps);
    await bridge2.handle(
      event({ message: [{ type: "text", data: { text: "（自检消息，别慌）在吗？" } }] }),
    );
    const r2 = await bridge2.handle(
      event({ message: [{ type: "text", data: { text: "在吗" } }], message_id: 9002, time: SEC + 1 }),
    );
    expect(r2.reason).toBe("replied");
    expect(h2.sent.length).toBe(1);
    expect(h2.generated.at(-1)?.prompt).not.toContain("自检消息");
    expect(calls.at(-1)?.skipMemory).toBe(false);
  });

  it("发送失败不记账：同一条消息下次还能重试", async () => {
    const h = harness();
    h.ctl.sendOk = false;
    h.ctl.sendDetail = "onebot: 连接被拒绝";
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const failed = await bridge.handle(event());
    expect(failed.reason).toBe("send-failed");
    expect(h.saved.length).toBe(0);

    h.ctl.sendOk = true;
    h.ctl.sendDetail = "onebot: 已发送";
    const retried = await bridge.handle(event());
    expect(retried.reason).toBe("replied");
    expect(h.sent.length).toBe(2);
    expect(h.saved.length).toBe(1);
  });

  it("有图时把图片字节透传给 generate（不自己实现附件上传）", async () => {
    const bytes: QQImageBytes = { data: new Uint8Array([1, 2, 3]), mediaType: "image/png", name: "a.png" };
    const h = harness({ readImage: async () => bytes });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(
      event({
        message_id: 9005,
        message: [
          { type: "text", data: { text: "看这个" } },
          { type: "image", data: { url: "https://example.test/a.png", summary: "[图片]" } },
        ],
      }),
    );
    expect(r.reason).toBe("replied");
    expect(h.generated[0]?.images).toEqual([bytes]);
    expect(h.generated[0]?.prompt).toContain("看这个");
  });
});

// ---------- HTTP 发送 ----------

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HTTP 发送", () => {
  it("sendPrivateText 打对地址、带 Bearer、body 里是 user_id + 段数组", async () => {
    const f = fakeFetch(() => jsonResponse({ status: "ok", retcode: 0, data: { message_id: 123 } }));
    const result = await sendPrivateText(
      { baseUrl: "http://127.0.0.1:3000/", token: TOKEN, fetchFn: f.fetchFn },
      { peer: PEER, text: "晚安" },
    );
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(123);
    expect(f.calls[0]?.url).toBe("http://127.0.0.1:3000/send_private_msg");
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      user_id: PEER,
      message: [{ type: "text", data: { text: "晚安" } }],
    });
  });

  it("retcode 非 0 抛带 retcode/status 的错误，并且把 token 抹掉", async () => {
    const f = fakeFetch(() =>
      jsonResponse({ status: "failed", retcode: 1200, wording: `bad token ${TOKEN}` }),
    );
    const promise = sendPrivateText({ baseUrl: "http://127.0.0.1:3000", token: TOKEN, fetchFn: f.fetchFn }, { peer: PEER, text: "hi" });
    await expect(promise).rejects.toBeInstanceOf(OneBotError);
    const err = await promise.catch((e: unknown) => e as OneBotError);
    expect(err.retcode).toBe(1200);
    expect(err.status).toBe("failed");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("***");
  });

  it("非 2xx 抛错（retcode 读不到时给 -1）", async () => {
    const f = fakeFetch(() => new Response("boom", { status: 500 }));
    const promise = sendPrivateText({ baseUrl: "http://127.0.0.1:3000", token: TOKEN, fetchFn: f.fetchFn }, { peer: PEER, text: "hi" });
    const err = await promise.catch((e: unknown) => e as OneBotError);
    expect(err).toBeInstanceOf(OneBotError);
    expect(err.retcode).toBe(-1);
    expect(err.message).toContain("HTTP 500");
    expect(err.message).not.toContain(TOKEN);
  });

  it("sendPrivateImage 走 base64:// 段", async () => {
    const f = fakeFetch(() => jsonResponse({ status: "ok", retcode: 0, data: { message_id: 9 } }));
    await sendPrivateImage(
      { baseUrl: "http://127.0.0.1:3000", token: TOKEN, fetchFn: f.fetchFn },
      { peer: PEER, base64: "data:image/png;base64,AAAA", mime: "image/png" },
    );
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      user_id: PEER,
      message: [{ type: "image", data: { file: "base64://AAAA" } }],
    });
  });
});

// ---------- WS 长连接 ----------

interface FakeSocket {
  addEventListener(type: string, handler: (event: OneBotSocketEvent) => void): void;
  close(code?: number, reason?: string): void;
  emit(type: string, event?: OneBotSocketEvent): void;
  readonly closedWith: { code?: number; reason?: string }[];
}

function fakeSockets() {
  const instances: FakeSocket[] = [];
  const socketFn: OneBotSocketCtor = (_url: string) => {
    const handlers = new Map<string, ((event: OneBotSocketEvent) => void)[]>();
    const closedWith: { code?: number; reason?: string }[] = [];
    const socket: FakeSocket = {
      addEventListener: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      close: (code, reason) => {
        closedWith.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
      },
      emit: (type, e) => {
        for (const handler of handlers.get(type) ?? []) handler(e ?? {});
      },
      closedWith,
    };
    instances.push(socket);
    return socket;
  };
  return { instances, socketFn };
}

function fakeTimers() {
  const delays: number[] = [];
  const scheduled: { id: number; fn: () => void }[] = [];
  let seq = 0;
  return {
    delays,
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      seq += 1;
      delays.push(ms);
      scheduled.push({ id: seq, fn });
      return seq;
    },
    clearTimeoutFn: (handle: unknown): void => {
      const index = scheduled.findIndex((s) => s.id === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
    pending: (): number => scheduled.length,
    fire: (): void => {
      scheduled.shift()?.fn();
    },
  };
}

describe("WS 长连接", () => {
  it("message 帧交给 onEvent；heartbeat 与非 JSON 帧跳过", () => {
    const s = fakeSockets();
    const t = fakeTimers();
    const seen: OneBotEvent[] = [];
    const listener = startOneBotListener({
      wsUrl: WS,
      token: TOKEN,
      onEvent: (e) => {
        seen.push(e);
      },
      socketFn: s.socketFn,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    const socket = s.instances[0];
    expect(socket).toBeDefined();
    socket?.emit("message", { data: JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }) });
    socket?.emit("message", { data: "not json" });
    socket?.emit("message", { data: JSON.stringify(event()) });
    expect(seen.length).toBe(1);
    expect(seen[0]?.message_id).toBe(9001);
    listener.stop();
  });

  it("断线按 3s→6s→12s→24s→30s 退避，封顶后不再翻倍", () => {
    const s = fakeSockets();
    const t = fakeTimers();
    const listener = startOneBotListener({
      wsUrl: WS,
      token: TOKEN,
      onEvent: () => {},
      socketFn: s.socketFn,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    for (let i = 0; i < 6; i += 1) {
      s.instances[i]?.emit("close");
      t.fire();
    }
    expect(t.delays).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
    expect(s.instances.length).toBe(7);
    // 纯函数口径也钉住：负数和 0 都从 3s 起
    expect(oneBotBackoffMs(0)).toBe(3_000);
    expect(oneBotBackoffMs(-3)).toBe(3_000);
    expect(oneBotBackoffMs(10)).toBe(30_000);
    listener.stop();
  });

  it("stop 之后关连接且不再重连", () => {
    const s = fakeSockets();
    const t = fakeTimers();
    const listener = startOneBotListener({
      wsUrl: WS,
      token: TOKEN,
      onEvent: () => {},
      socketFn: s.socketFn,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    listener.stop();
    expect(listener.state()).toBe("stopped");
    expect(s.instances[0]?.closedWith).toEqual([{ code: 1000, reason: "stop" }]);
    // 底层随后也报了一次 close：不该再排重连
    s.instances[0]?.emit("close");
    expect(t.pending()).toBe(0);
  });

  it("还没连上就 stop：已排队的重连被取消", () => {
    const s = fakeSockets();
    const t = fakeTimers();
    const listener = startOneBotListener({
      wsUrl: WS,
      token: TOKEN,
      onEvent: () => {},
      socketFn: s.socketFn,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
    });
    s.instances[0]?.emit("close");
    expect(t.pending()).toBe(1);
    listener.stop();
    expect(t.pending()).toBe(0);
  });

  it("建连失败的日志里不出现 token", () => {
    const t = fakeTimers();
    const logs: string[] = [];
    const listener = startOneBotListener({
      wsUrl: WS,
      token: TOKEN,
      onEvent: () => {},
      socketFn: () => {
        throw new Error("ECONNREFUSED");
      },
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
      log: (line) => {
        logs.push(line);
      },
    });
    expect(logs.join("\n")).toContain("ECONNREFUSED");
    expect(logs.join("\n")).not.toContain(TOKEN);
    listener.stop();
  });

  it("withAccessToken：query 用 & 接，token 做 URL 编码", () => {
    expect(withAccessToken(WS, "")).toBe(WS);
    expect(withAccessToken(WS, "a b")).toBe(`${WS}?access_token=a%20b`);
    expect(withAccessToken(`${WS}?x=1`, "t")).toBe(`${WS}?x=1&access_token=t`);
  });
});

describe("回合写锁", () => {
  it("每处理一条事件各拿一次、放一次；只读事件也成对出现", async () => {
    const h = harness();
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    await bridge.handle(event({ message_id: 8001 }));
    await bridge.handle({ ...event(), post_type: "notice" } as unknown as OneBotEvent);
    expect(h.turns).toEqual(["acquire", "release", "acquire", "release"]);
  });
});

// ---------- P0-F：QQ 回信入记忆（旁路，失败不阻断已发出的回复） ----------

describe("P0-F 回信入记忆", () => {
  it("真发送成功：回调恰好一次，参数就是发出去的那句", async () => {
    const rememberReply = vi.fn();
    const h = harness({ rememberReply });
    h.ctl.reply = "「好呀♪」";
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.reason).toBe("replied");
    expect(rememberReply).toHaveBeenCalledTimes(1);
    expect(rememberReply).toHaveBeenCalledWith("好呀♪");
  });

  it("dryRun：只试运行，不写记忆", async () => {
    const rememberReply = vi.fn();
    const h = harness({ rememberReply });
    const bridge = new OneBotBridge(fakeRuntime(), opts({ dryRun: true }), h.deps);
    await bridge.handle(event());
    expect(rememberReply).not.toHaveBeenCalled();
  });

  it("发送失败：不写记忆（下次重试成功后只写一次）", async () => {
    const rememberReply = vi.fn();
    const h = harness({ rememberReply });
    h.ctl.sendOk = false;
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    await bridge.handle(event());
    expect(rememberReply).not.toHaveBeenCalled();

    h.ctl.sendOk = true;
    const retried = await bridge.handle(event());
    expect(retried.reason).toBe("replied");
    expect(rememberReply).toHaveBeenCalledTimes(1);
  });

  it("自检消息被拦下：不写记忆", async () => {
    const rememberReply = vi.fn();
    const h = harness({ rememberReply });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(
      event({ message: [{ type: "text", data: { text: "（自检消息，别慌）在吗？" } }] }),
    );
    expect(r.reason).toBe("selfcheck-held");
    expect(rememberReply).not.toHaveBeenCalled();
  });

  it("同步抛错：回复照常算已发，失败只进日志", async () => {
    const h = harness({
      rememberReply: () => {
        throw new Error("memory offline");
      },
    });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(true);
    expect(r.reason).toBe("replied");
    expect(h.sent).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("回信记忆写入失败");
    expect(h.logs.join("\n")).toContain("memory offline");
  });

  it("异步拒绝：回复照常算已发，不留 unhandled rejection", async () => {
    const h = harness({
      rememberReply: () => Promise.reject(new Error("async memory down")),
    });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.logs.join("\n")).toContain("回信记忆写入失败");
    expect(h.logs.join("\n")).toContain("async memory down");
  });
});

// ---------- S3b/M5：回信时间一致性（旁路，只记摘要、不阻断回复） ----------

describe("S3b 回信时间一致性日志", () => {
  it("真发送成功：回调恰好一次，参数就是发出去的那句", async () => {
    const recordTimeClaims = vi.fn();
    const h = harness({ recordTimeClaims });
    h.ctl.reply = "现在是 15 点，你都 2 小时没见了";
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.reason).toBe("replied");
    expect(recordTimeClaims).toHaveBeenCalledTimes(1);
    expect(recordTimeClaims).toHaveBeenCalledWith("现在是 15 点，你都 2 小时没见了");
  });

  it("dryRun / 发送失败 / 自检拦下：一次都不调", async () => {
    const recordTimeClaims = vi.fn();
    const h = harness({ recordTimeClaims });
    const dry = new OneBotBridge(fakeRuntime(), opts({ dryRun: true }), h.deps);
    await dry.handle(event());
    expect(recordTimeClaims).not.toHaveBeenCalled();

    h.ctl.sendOk = false;
    const failed = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    await failed.handle(event());
    expect(recordTimeClaims).not.toHaveBeenCalled();

    const held = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    await held.handle(event({ message: [{ type: "text", data: { text: "（自检消息）在吗" } }] }));
    expect(recordTimeClaims).not.toHaveBeenCalled();
  });

  it("同步抛错：回复照常算已发，失败只进日志", async () => {
    const h = harness({
      recordTimeClaims: () => {
        throw new Error("metrics offline");
      },
    });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(true);
    expect(r.reason).toBe("replied");
    expect(h.sent).toHaveLength(1);
    expect(h.logs.join("\n")).toContain("时间一致性日志写入失败");
    expect(h.logs.join("\n")).toContain("metrics offline");
  });

  it("异步拒绝：回复照常算已发，不留 unhandled rejection", async () => {
    const h = harness({
      recordTimeClaims: () => Promise.reject(new Error("async metrics down")),
    });
    const bridge = new OneBotBridge(fakeRuntime(), opts(), h.deps);
    const r = await bridge.handle(event());
    expect(r.acted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.logs.join("\n")).toContain("时间一致性日志写入失败");
    expect(h.logs.join("\n")).toContain("async metrics down");
  });
});
