/**
 * §10.4 接线一段：桥真的把「这一句用到了哪条知识」报给 runtime 吗。
 *
 * 纯函数与结算逻辑在 `test/knowledge-feedback.test.ts`；这里只验工具层那一步：
 * 回复发送**成功之后**才上报、没用到就不上报、发送失败一次也不上报
 * （没发出去的话没进对话，不该产生任何反馈）。
 */

import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import type { DialogueRecall } from "../src/dialogue/recall.js";
import type { Persona } from "../src/dialogue/persona.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { emptyQQState } from "../src/qq/types.js";
import type { OneBotEvent } from "../src/qq/onebot.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const PEER = 100_000_001;
const SELF = 10_000_002;

const RECALL: DialogueRecall = {
  memories: [],
  knowledge: ["《标题甲》：摘要甲", "《标题乙》：摘要乙"],
  knowledgeIds: ["k1", "k2"],
  mandatory: false,
};

function event(text: string): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    self_id: SELF,
    user_id: PEER,
    time: Math.floor(NOW / 1000),
    message_id: 99,
    message: [{ type: "text", data: { text } }],
  } as OneBotEvent;
}

function harness(opts: { reply: string; sendOk?: boolean; recall?: DialogueRecall }) {
  const noted: string[] = [];
  const rt = {
    turn() {
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
    noteKnowledgeUsed: (id: string) => noted.push(id),
  };
  const deps: OneBotBridgeDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async () => opts.reply,
    send: async () => ({ ok: opts.sendOk ?? true, detail: "onebot: 已发送" }),
    saveState: () => {},
    log: () => {},
    ...(opts.recall === undefined ? {} : { recall: () => opts.recall! }),
  };
  const bridge = new OneBotBridge(
    rt as unknown as SoulRuntime,
    makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false }),
    deps,
    emptyQQState(),
  );
  return { bridge, noted };
}

describe("桥 → runtime：知识使用上报", () => {
  it("回复里真有标题甲 → 只报 k1", async () => {
    const { bridge, noted } = harness({ reply: "我今天才知道标题甲那件事", recall: RECALL });
    const r = await bridge.handle(event("在吗"));
    expect(r.acted).toBe(true);
    expect(noted).toEqual(["k1"]);
  });

  it("回复里一条都没提 → 一条都不报", async () => {
    const { bridge, noted } = harness({ reply: "在呀，怎么了？", recall: RECALL });
    await bridge.handle(event("在吗"));
    expect(noted).toEqual([]);
  });

  it("发送失败 → 一次都不报（没发出去那句没进对话）", async () => {
    const { bridge, noted } = harness({ reply: "我今天才知道标题甲", recall: RECALL, sendOk: false });
    const r = await bridge.handle(event("在吗"));
    expect(r.acted).toBe(false);
    expect(noted).toEqual([]);
  });

  it("没有召回（deps.recall 未接）→ 不上报也不报错", async () => {
    const { bridge, noted } = harness({ reply: "我今天才知道标题甲" });
    const r = await bridge.handle(event("在吗"));
    expect(r.acted).toBe(true);
    expect(noted).toEqual([]);
  });
});
