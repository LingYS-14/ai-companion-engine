import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { ChatLog } from "../src/autonomy/chat-log.js";
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";
import type { ChatHistoryStore } from "../src/ports/chat-history.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import type { OneBotEvent } from "../src/qq/onebot.js";
import { emptyQQState } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

/**
 * P2（task-139）：QQ 桥接共享 ChatLog。
 *
 * 默认不传 `deps.history` 时桥内历史原样（旧行为）；传了之后：
 * - 回信/主动开口组提示词都读同一个 store（网页那边说的话，QQ 这边看得到）；
 * - 成功的这一轮把 peer/her 两条按 channel="qq" 追加进共享流水。
 */

const NOW = 1_700_000_000_000;
const SELF = 10_000_002;
const PEER = 100_000_001;
const SEC = Math.floor((NOW - 5_000) / 1000);
const PEER_NAME = "用户";

const dirs: string[] = [];

function tempLog(): ChatLog {
  const dir = mkdtempSync(join(tmpdir(), "qq-chat-"));
  dirs.push(dir);
  return ChatLog.open({ dataDir: dir, characterId: "test", now: () => NOW });
}

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

function runtime(): SoulRuntime {
  const fake = {
    snapshot: () => ({
      mode: "NORMAL",
      state: { pressure: 0.9, rumination: 0, energy: 1, entropy: 0, trust: 0.8 },
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
  readonly generated: { system: string; prompt: string }[];
  readonly clock: { now: number };
}

function harness(history?: ChatHistoryStore): Harness {
  const clock = { now: NOW };
  const generated: Harness["generated"] = [];
  const deps: OneBotBridgeDeps = {
    now: () => clock.now,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async ({ system, prompt }) => {
      generated.push({ system, prompt });
      return "回一句♪";
    },
    send: async () => ({ ok: true, detail: "onebot: 已发送" }),
    saveState: () => {},
    log: () => {},
    ...(history === undefined ? {} : { history }),
  };
  const bridge = new OneBotBridge(
    runtime(),
    makeOneBotOptions({ peer: PEER, selfId: SELF, peerName: PEER_NAME, dryRun: false }),
    deps,
    emptyQQState(),
  );
  return { bridge, generated, clock };
}

describe("P2：QQ 桥与网页共享 ChatLog", () => {
  it("传了 store：主动开口的 history 读共享流水，只看他说的，且能跨通道看到网页那句", async () => {
    const log = tempLog();
    log.append({ atMs: NOW - 3_000, who: "peer", text: "这是网页里说的话", channel: "web" });
    log.append({ atMs: NOW - 2_000, who: "her", text: "网页里她的那句", channel: "web" });

    const h = harness(log);
    const r = await h.bridge.proactive();
    expect(r.acted).toBe(true);

    const prompt = h.generated.at(-1)?.prompt ?? "";
    expect(prompt).toContain("这是网页里说的话");
    expect(prompt).not.toContain("网页里她的那句");
  });

  it("回信成功后向共享流水追加 peer/her 两条（channel=qq）", async () => {
    const log = tempLog();
    const h = harness(log);

    const first = await h.bridge.handle(event());
    expect(first.reason).toBe("replied");
    expect(log.recent(10).map((e) => [e.who, e.text, e.channel])).toEqual([
      ["peer", "在吗", "qq"],
      ["her", "回一句♪", "qq"],
    ]);
  });

  it("不传 store 时退回桥内历史（默认关闭，旧行为不变）", async () => {
    const h = harness();
    await h.bridge.handle(event());
    h.clock.now += 60_000;
    await h.bridge.handle(event({ message_id: 9002, time: SEC + 60 }));

    const prompt = h.generated.at(-1)?.prompt ?? "";
    expect(prompt).toContain(`${PEER_NAME}：在吗`);
    expect(prompt).toContain("你：回一句♪");
  });

  it("store 追加失败不影响这一轮回信（桥内历史仍兜底）", async () => {
    const failing: ChatHistoryStore = {
      recent: () => [],
      append: () => {
        throw new Error("磁盘满了");
      },
    };
    const h = harness(failing);
    await expect(h.bridge.handle(event())).resolves.toMatchObject({ reason: "replied" });
  });
});

// 清理：test 结束把临时目录删掉
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});
