/**
 * 隐式反应推断的测试（§7.4 bandit 记分的前置）。
 *
 * 两层：纯函数（哪些信号能给分、给什么结局）与接线（桥真的把 reaction 递进 turn）。
 * 不碰真服务：生成/发送/saveState 全假，只断言"这一轮有没有带上反应、带的是什么"。
 */

import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { inferReaction, REACTION_THRESHOLDS } from "../src/dialogue/reaction.js";
import type { Persona } from "../src/dialogue/persona.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { emptyQQState } from "../src/qq/types.js";
import type { OneBotEvent } from "../src/qq/onebot.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

describe("inferReaction：纯函数", () => {
  it("首轮（没有上一句）不打分", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: null, text: "谢谢你" })).toBeNull();
  });

  it("空消息不打分", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW - MIN, text: "   " })).toBeNull();
  });

  it("好话在窗口内 → 升温", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW - MIN, text: "谢谢你，今天真的很开心" })).toBe("升温");
  });

  it("好话但隔了很久 → 安抚（他冷静了一会儿才回好话）", () => {
    const late = NOW - REACTION_THRESHOLDS.warmWindowMs - MIN;
    expect(inferReaction({ now: NOW, lastReplyAt: late, text: "谢谢你" })).toBe("安抚");
  });

  it("坏话 → 冷战，且坏话优先于好话", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW - MIN, text: "谢谢你，但我有点失望" })).toBe("冷战");
  });

  it("隔了 6 小时以上才回来 → 离开", () => {
    const gone = NOW - REACTION_THRESHOLDS.goneMs - MIN;
    expect(inferReaction({ now: NOW, lastReplyAt: gone, text: "我回来了" })).toBe("离开");
  });

  it("秒回且说了不少 → 升温", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW - 10_000, text: "刚看到你发的消息，我正在做饭" })).toBe("升温");
  });

  it("只回一个「嗯」：读不出来就不猜（不返回无视）", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW - 10_000, text: "嗯" })).toBeNull();
  });

  it("时钟回拨（now < lastReplyAt）不猜", () => {
    expect(inferReaction({ now: NOW, lastReplyAt: NOW + MIN, text: "谢谢" })).toBeNull();
  });
});

describe("端口：inferReaction 由适配器转发", () => {
  it("端口拿到的是同一个判断", () => {
    const port = createDialoguePort();
    expect(port.inferReaction({ now: NOW, lastReplyAt: NOW - MIN, text: "谢谢你" })).toBe("升温");
  });
});

describe("接线：桥把反应递进 turn", () => {
  const PEER = 100_000_001;
  const SELF = 10_000_002;

  function event(text: string): OneBotEvent {
    return {
      post_type: "message",
      message_type: "private",
      self_id: SELF,
      user_id: PEER,
      time: Math.floor((NOW - 5_000) / 1000),
      message_id: 4321,
      message: [{ type: "text", data: { text } }],
    } as OneBotEvent;
  }

  function harness(): { deps: OneBotBridgeDeps; rt: SoulRuntime; seen: { reaction?: string }[] } {
    const seen: { reaction?: string }[] = [];
    const rt = {
      turn(_req: unknown, opts: { reaction?: string }) {
        seen.push({ ...(opts.reaction === undefined ? {} : { reaction: opts.reaction }) });
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
        };
      },
      persona: (): Persona | null => null,
    };
    const deps: OneBotBridgeDeps = {
      now: () => NOW,
      localHour: () => 12,
      appraise: appraiseFromText,
      dialogue: createDialoguePort(),
      language: createLanguagePort(),
      generate: async () => "嗯，我在♪",
      send: async () => ({ ok: true, detail: "onebot: 已发送" }),
      saveState: () => {},
      log: () => {},
    };
    return { deps, rt: rt as unknown as SoulRuntime, seen };
  }

  it("上一句回过、这一句是好话 → turn 带上 reaction=升温", async () => {
    const { deps, rt, seen } = harness();
    const state = { ...emptyQQState(), lastReplyAt: NOW - MIN };
    const bridge = new OneBotBridge(
      rt,
      makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false }),
      deps,
      state,
    );
    await bridge.handle(event("谢谢你，今天真的很开心"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reaction).toBe("升温");
  });

  it("读不出来（首轮/短消息）→ 不带 reaction 字段", async () => {
    const { deps, rt, seen } = harness();
    const bridge = new OneBotBridge(
      rt,
      makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false }),
      deps,
      emptyQQState(),
    );
    await bridge.handle(event("在吗"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({});
  });
});
