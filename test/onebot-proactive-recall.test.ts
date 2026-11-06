/**
 * 批次1A：OneBot 桥「主动开口」的两处接线。
 *
 * 这一层只锁接线，不重测判据（判据在 proactive.test.ts / composer.test.ts）：
 *   1. `deps.recall` 的结果真的进了 composeProactive（system 里出现知识文本），
 *      种子是她这一拍想开口的由头（自述优先，其次话题描述），不是用户原句；
 *   2. 没有 recall 依赖时，提示词与旧组装一字不差（向后兼容）；
 *   3. 拼 history 时丢掉 who==="her" 的行——不让她顺着自己的上一句往下续写。
 *
 * 不碰真服务：生成/发送/存状态全是假的，WS 根本不参与。
 */

import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { TOPIC_NOTE } from "../src/dialogue/proactive.js";
import type { DialogueRecall } from "../src/dialogue/recall.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import type { OneBotEvent } from "../src/qq/onebot.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const SELF = 10_000_002;
const PEER = 100_000_001;
/** 事件时间用秒（OneBot 口径），比「现在」早 5 秒 */
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

/** 主动开口用 snapshot/wonder/persona；历史那条用例还要先跑一轮 handle（turn）。 */
function runtime(pressure = 0.9): SoulRuntime {
  const fake = {
    snapshot: () => ({
      mode: "NORMAL",
      state: { pressure, rumination: 0, energy: 1, entropy: 0, trust: 0.8 },
    }),
    wonder: () => ({ score: 0, push: null, reason: "测试：不给动机层加分" }),
    persona: () => null,
    turn: () => ({
      mode: "NORMAL",
      stage: "stranger",
      bondProgress: 0,
      state: {},
      style: { modeStyle: "平常", stageStyle: "客气", expressionStyle: "稳", suppressInstruction: "不必压", signals: {} },
      expression: { tone: "稳", move: "聊", avoid: "别急", quadrant: "secure", stage: "stranger", source: "table" },
      eventStyle: null,
      memory: { wrote: 1, rejected: 0 },
      bandit: { actionTag: "care", ucb: 0, source: "fallback", candidates: [], scored: false },
    }),
  };
  return fake as unknown as SoulRuntime;
}

interface Harness {
  readonly bridge: OneBotBridge;
  readonly generated: { system: string; prompt: string; task?: string }[];
  readonly sent: { peer: number; text: string }[];
  readonly saved: QQStateRecord[];
  /** 每次召回用的种子（按调用顺序） */
  readonly seeds: string[];
  /** 回信路径召回次数 */
  readonly recallCalls: number;
  /** 主动路径召回种子（recallForProactive） */
  readonly proactiveSeeds: string[];
  /** 回声自检看到的候选句子 */
  readonly echoChecked: string[];
  /** 可控时钟：跨回合的用例要往前拨，否则被最小间隔拦下 */
  readonly clock: { now: number };
}

interface HarnessOptions {
  readonly recall?: (text: string) => DialogueRecall;
  readonly recallForProactive?: (text: string) => DialogueRecall;
  readonly echoCheck?: (text: string) => { readonly hit: boolean; readonly score: number };
  /** generate 依次返回；用完回落「主动一句♪」 */
  readonly replies?: readonly string[];
}

function harness(over: HarnessOptions = {}): Harness {
  const clock = { now: NOW };
  const generated: Harness["generated"] = [];
  const sent: Harness["sent"] = [];
  const saved: QQStateRecord[] = [];
  const seeds: string[] = [];
  const proactiveSeeds: string[] = [];
  const echoChecked: string[] = [];
  let replyIndex = 0;
  const recallCalls = { count: 0 };
  const deps: OneBotBridgeDeps = {
    now: () => clock.now,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async ({ system, prompt, task }) => {
      generated.push({ system, prompt, task });
      return over.replies?.[replyIndex++] ?? "主动一句♪";
    },
    send: async (input) => {
      sent.push(input);
      return { ok: true, detail: "onebot: 已发送" };
    },
    saveState: (state) => {
      saved.push(state);
    },
    log: () => {},
    ...(over.recall === undefined
      ? {}
      : {
          recall: (text: string) => {
            seeds.push(text);
            recallCalls.count += 1;
            return over.recall!(text);
          },
        }),
    ...(over.recallForProactive === undefined
      ? {}
      : {
          recallForProactive: (text: string) => {
            proactiveSeeds.push(text);
            return over.recallForProactive!(text);
          },
        }),
    ...(over.echoCheck === undefined
      ? {}
      : {
          echoCheck: (text: string) => {
            echoChecked.push(text);
            return over.echoCheck!(text);
          },
        }),
  };
  const bridge = new OneBotBridge(
    runtime(),
    makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: "用户", dryRun: false }),
    deps,
    emptyQQState(),
  );
  return {
    bridge,
    generated,
    sent,
    saved,
    seeds,
    proactiveSeeds,
    echoChecked,
    clock,
    get recallCalls() {
      return recallCalls.count;
    },
  };
}

const KNOWLEDGE = "《白鹭》它停在河面上一动不动";
const MEMORY = "她记得：窗台上那盆花昨天开了";

describe("OneBot 桥主动开口：接召回", () => {
  it("recall 注入后 system 里出现记忆与知识文本，user 不掺知识", async () => {
    const h = harness({ recall: () => ({ memories: [MEMORY], knowledge: [KNOWLEDGE] }) });
    const r = await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "" } });

    expect(r.acted).toBe(true);
    expect(h.generated).toHaveLength(1);
    const { system, prompt } = h.generated[0]!;
    expect(system).toContain(KNOWLEDGE);
    expect(system).toContain(MEMORY);
    expect(system).toContain("【你最近看到的东西】");
    // 知识只进 system（当资料），不进 user（那会像是对方说的话）
    expect(prompt).not.toContain(KNOWLEDGE);
    expect(prompt).not.toContain(MEMORY);
  });

  it("召回种子优先用自述的由头，不是话题描述", async () => {
    const h = harness({ recall: () => ({ memories: [], knowledge: [KNOWLEDGE] }) });
    await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "因为我想他了" } });
    expect(h.seeds).toEqual(["我想跟他说昨晚梦里的海"]);
  });

  it("没有自述时，用话题描述当种子（主动路径没有用户原句）", async () => {
    const h = harness({ recall: () => ({ memories: [], knowledge: [KNOWLEDGE] }) });
    await h.bridge.proactive();
    expect(h.seeds).toEqual([TOPIC_NOTE.held_back]);
  });

  it("没有 recall 依赖时，提示词与「不传召回」的旧组装一字不差", async () => {
    const h = harness();
    await h.bridge.proactive();

    const expected = createDialoguePort().composeProactive({
      intent: "proactive",
      persona: null,
      mode: "NORMAL",
      topic: "held_back",
      peerName: "用户",
      localHour: 12,
      history: [],
    });
    expect(h.generated[0]).toEqual({ system: expected.system, prompt: expected.user, task: "proactive" });
    expect(h.generated[0]!.system).not.toContain("【你最近看到的东西】");
    expect(h.generated[0]!.system).not.toContain("【你记得的事】");
  });
});

describe("OneBot 桥主动开口：history 过滤掉她自己", () => {
  it("只把对方说过的话拼进 prompt，不含她上一句", async () => {
    const h = harness();
    // 先跑一轮回信：历史里会落下 {peer:"在吗"} + {her:"主动一句♪"}
    const first = await h.bridge.handle(event());
    expect(first.reason).toBe("replied");

    const r = await h.bridge.proactive();
    expect(r.acted).toBe(true);
    expect(h.generated.at(-1)!.task).toBe("proactive");

    const prompt = h.generated.at(-1)!.prompt;
    expect(prompt).toContain("用户：在吗");
    expect(prompt).not.toContain("主动一句♪");
    expect(prompt).not.toContain("我：");
  });

  it("回信路径的 history 语义不动：她说过的话仍然进【刚刚聊过的】", async () => {
    const h = harness();
    await h.bridge.handle(event());
    await h.bridge.proactive();

    // 跨过最小间隔再来一条：回信路径应能看到「她上一句」和「对方上一句」
    h.clock.now += 60_000;
    const second = await h.bridge.handle(event({ message_id: 9002, time: SEC + 60 }));
    expect(second.reason).toBe("replied");

    const prompt = h.generated.at(-1)!.prompt;
    expect(prompt).toContain("用户：在吗");
    expect(prompt).toContain("你：主动一句♪");
  });
});

describe("task-169 A：主动开口走独立召回（排除自述素材）", () => {
  it("有 recallForProactive 时优先用它，回信用的 recall 一次都不碰", async () => {
    const h = harness({
      recall: () => ({ memories: [MEMORY], knowledge: [] }),
      recallForProactive: () => ({ memories: [], knowledge: ["【主动专用】河边那只白鹭"] }),
    });
    const r = await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "" } });

    expect(r.acted).toBe(true);
    expect(h.proactiveSeeds).toEqual(["我想跟他说昨晚梦里的海"]);
    expect(h.recallCalls).toBe(0);
    expect(h.generated[0]!.system).toContain("【主动专用】河边那只白鹭");
    expect(h.generated[0]!.system).not.toContain(MEMORY);
  });

  it("没注入 recallForProactive 时退回 recall（旧行为）", async () => {
    const h = harness({ recall: () => ({ memories: [MEMORY], knowledge: [KNOWLEDGE] }) });
    await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "" } });

    expect(h.seeds).toEqual(["我想跟他说昨晚梦里的海"]);
    expect(h.generated[0]!.system).toContain(KNOWLEDGE);
  });
});

describe("task-169 C：主动开口生成侧回声闸门", () => {
  it("第一句像最近说过的 → 换一句重生成一次，发第二句", async () => {
    const h = harness({
      replies: ["今天的雨下得很轻，我一直在窗边看着水痕往下走", "我在抽屉里翻到一张旧车票，是去海边的"],
      echoCheck: (text) => ({ hit: text.includes("雨下得很轻"), score: 0.9 }),
    });
    const r = await h.bridge.proactive(undefined, { note: { line: "随便说点什么", whyLine: "" } });

    expect(r.acted).toBe(true);
    expect(r.verdict).toBe("spoke");
    expect(h.generated).toHaveLength(2);
    // 重生成时提示词里带了「换一个话题」的约束
    expect(h.generated[1]!.system).toContain("换一个具体的话题或细节");
    expect(h.sent).toEqual([{ peer: PEER, text: "我在抽屉里翻到一张旧车票，是去海边的" }]);
    expect(h.echoChecked).toHaveLength(2);
  });

  it("两次都像最近说过的 → 这一拍收住（held/echo-repeat），不发、不记状态", async () => {
    const h = harness({
      replies: ["今天的雨下得很轻，我一直在窗边看着水痕往下走", "今天下午我在窗边看雨，风把窗帘吹起来"],
      echoCheck: () => ({ hit: true, score: 0.95 }),
    });
    const r = await h.bridge.proactive(undefined, { note: { line: "随便说点什么", whyLine: "" } });

    expect(r.acted).toBe(false);
    expect(r.verdict).toBe("held");
    expect(r.detail).toBe("echo-repeat");
    expect(h.generated).toHaveLength(2);
    expect(h.sent).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});
