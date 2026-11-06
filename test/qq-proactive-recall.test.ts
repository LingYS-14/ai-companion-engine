/**
 * 批次1A：窗口桥（`src/qq/bridge.ts`）「主动开口」的两处接线。
 *
 * 和 `test/onebot-proactive-recall.test.ts` 同一组断言，区别只在这条通道：
 *   - 它拉 `bus/inbox/*.json`，peer 是昵称（`opts.peer`）；
 *   - 主动开口没有 runtime 的 gates，但 history / recall 的接线语义必须与 OneBot 一致。
 *
 * 判据本身不在这里重测（见 test/proactive.test.ts / test/composer.test.ts）。
 */

import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { QQBridge, type QQDeps } from "../src/qq/bridge.js";
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { TOPIC_NOTE } from "../src/dialogue/proactive.js";
import type { DialogueRecall } from "../src/dialogue/recall.js";
import { DEFAULT_QQ_OPTIONS, emptyQQState, type InboxMessage, type QQOptions, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

const NOW = 1_700_000_000_000;
const PEER = "用户";

function opts(over: Partial<QQOptions> = {}): QQOptions {
  return { ...DEFAULT_QQ_OPTIONS, dryRun: false, ...over };
}

function msg(id: string, text: string, atMs = NOW): InboxMessage {
  return { id, epochNs: (atMs - 5_000) * 1e6, at: "12:00:00", sender: PEER, text };
}

/** 主动开口用 snapshot/wonder/persona；历史那条用例还要先跑一轮 poll（turn）。 */
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
  readonly bridge: QQBridge;
  readonly inbox: InboxMessage[];
  readonly generated: { system: string; prompt: string }[];
  readonly sent: string[];
  readonly saved: QQStateRecord[];
  /** 每次召回用的种子（按调用顺序） */
  readonly seeds: string[];
  /** 可控时钟：跨回合的用例要往前拨，否则被最小间隔拦下 */
  readonly clock: { now: number };
}

function harness(over: { recall?: (text: string) => DialogueRecall } = {}): Harness {
  const clock = { now: NOW };
  const inbox: InboxMessage[] = [];
  const generated: Harness["generated"] = [];
  const sent: string[] = [];
  const saved: QQStateRecord[] = [];
  const seeds: string[] = [];
  const deps: QQDeps = {
    now: () => clock.now,
    localHour: () => 12,
    appraise: appraiseFromText,
    readInbox: () => inbox,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async ({ system, prompt }) => {
      generated.push({ system, prompt });
      return "主动一句♪";
    },
    send: async (text) => {
      sent.push(text);
      return { ok: true, detail: "sent at 700,1200" };
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
            return over.recall!(text);
          },
        }),
  };
  const bridge = new QQBridge(runtime(), opts(), deps, emptyQQState());
  return { bridge, inbox, generated, sent, saved, seeds, clock };
}

const KNOWLEDGE = "《白鹭》它停在河面上一动不动";
const MEMORY = "她记得：窗台上那盆花昨天开了";

describe("窗口桥主动开口：接召回", () => {
  it("recall 注入后 system 里出现记忆与知识文本，user 不掺知识", async () => {
    const h = harness({ recall: () => ({ memories: [MEMORY], knowledge: [KNOWLEDGE] }) });
    const r = await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "" } });

    expect(r.acted).toBe(true);
    expect(h.generated).toHaveLength(1);
    const { system, prompt } = h.generated[0]!;
    expect(system).toContain(KNOWLEDGE);
    expect(system).toContain(MEMORY);
    expect(system).toContain("【你最近看到的东西】");
    expect(prompt).not.toContain(KNOWLEDGE);
    expect(prompt).not.toContain(MEMORY);
  });

  it("召回种子优先用自述的由头，不是话题描述", async () => {
    const h = harness({ recall: () => ({ memories: [], knowledge: [KNOWLEDGE] }) });
    await h.bridge.proactive(undefined, { note: { line: "我想跟他说昨晚梦里的海", whyLine: "" } });
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
      peerName: PEER,
      localHour: 12,
      history: [],
    });
    expect(h.generated[0]).toEqual({ system: expected.system, prompt: expected.user });
    expect(h.generated[0]!.system).not.toContain("【你最近看到的东西】");
    expect(h.generated[0]!.system).not.toContain("【你记得的事】");
  });
});

describe("窗口桥主动开口：history 过滤掉她自己", () => {
  it("只把对方说过的话拼进 prompt，不含她上一句", async () => {
    const h = harness();
    h.inbox.push(msg("m1", "在吗"));
    // 先跑一轮回信：历史里会落下 {peer:"在吗"} + {her:"主动一句♪"}
    const first = await h.bridge.poll();
    expect(first.reason).toBe("replied");

    const r = await h.bridge.proactive();
    expect(r.acted).toBe(true);

    const prompt = h.generated.at(-1)!.prompt;
    expect(prompt).toContain(`${PEER}：在吗`);
    expect(prompt).not.toContain("主动一句♪");
    expect(prompt).not.toContain("我：");
  });

  it("回信路径的 history 语义不动：她说过的话仍然进【刚刚聊过的】", async () => {
    const h = harness();
    h.inbox.push(msg("m1", "在吗"));
    await h.bridge.poll();
    await h.bridge.proactive();

    h.clock.now += 60_000;
    h.inbox.push(msg("m2", "还在吗", h.clock.now));
    const second = await h.bridge.poll();
    expect(second.reason).toBe("replied");

    const prompt = h.generated.at(-1)!.prompt;
    expect(prompt).toContain(`${PEER}：在吗`);
    expect(prompt).toContain("你：主动一句♪");
  });
});
