import { describe, expect, it } from "vitest";

import { ChatTurnError, runChatTurn, type ChatTurnDeps } from "../src/autonomy/chat-turn.js";
import { CHAT_REPLY_MEMORY_SOURCE, chatReplyMemorySeed } from "../src/orchestrator/intent/close-loop.js";
import { createDialoguePort } from "../src/dialogue/port-adapter.js";
import type { ChatReply, LlmConfig } from "../src/autonomy/llm.js";
import type { ChatHistoryEntry, ChatHistoryStore } from "../src/ports/chat-history.js";
import type { TurnOptions, TurnRequest, TurnText } from "../src/ports/index.js";

/**
 * P2（task-139）：网页聊天 daemon 侧一轮。
 *
 * 锁的是语义而不是措辞：睡着不聊、双向入记忆、共享历史、空回复不发、
 * 模型失败不吞用户这句话（历史里 peer 那条已经写进去了）。
 */

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const PEER = "用户";

const LLM: LlmConfig = { baseUrl: "https://api.example.com", apiKey: "k", model: "fake-model", timeoutMs: 1_000 };

class FakeHistory implements ChatHistoryStore {
  entries: ChatHistoryEntry[] = [];
  recentLimits: number[] = [];

  constructor(private readonly flags: { readonly recentThrows?: boolean; readonly appendThrows?: boolean } = {}) {}

  recent(limit: number): readonly ChatHistoryEntry[] {
    this.recentLimits.push(limit);
    if (this.flags.recentThrows === true) throw new Error("历史读坏了");
    return this.entries.slice(-limit);
  }

  append(entry: ChatHistoryEntry): void {
    if (this.flags.appendThrows === true) throw new Error("历史写坏了");
    this.entries.push(entry);
  }
}

function turnText(overrides: Partial<TurnText> = {}): TurnText {
  return {
    mode: "NORMAL",
    stage: "熟悉的伙伴",
    bondProgress: 0.42,
    state: {},
    style: {
      modeStyle: "平常",
      stageStyle: "亲近",
      expressionStyle: "稳",
      suppressInstruction: "不必压",
    },
    expression: { quadrant: "暖", label: "平静", source: "quadrant" },
    eventStyle: { permission: "可以撒娇", avoid: null },
    memory: { wrote: 1, rejected: 0 },
    bandit: { strategy: "安抚", scored: false },
    wonder: { kind: "calm", topic: null, note: null },
    ...overrides,
  } as unknown as TurnText;
}

interface Harness {
  readonly deps: ChatTurnDeps;
  readonly history: FakeHistory;
  readonly calls: {
    turns: Array<{ req: TurnRequest; opts: TurnOptions }>;
    remembered: Array<Record<string, unknown>>;
    completed: Array<{ system: string; user: string; task: string | undefined; maxTokens: number | undefined; temperature: number | undefined }>;
    logs: string[];
    /** task-169 E3：网页回复只把 text 传给 recall，不接来源过滤。 */
    recallArgs: string[];
  };
  setPhase(phase: string): void;
}

interface HarnessOptions {
  readonly asleep?: boolean;
  readonly llm?: LlmConfig | null;
  readonly replyText?: string;
  /** S3b：网页回信时间一致性日志回调（生产由装配层注入） */
  readonly recordTimeClaims?: (reply: string) => void;
  readonly rememberThrows?: boolean;
  readonly completeThrows?: boolean;
  readonly turnOverride?: () => TurnText;
  // B2（task-148）：业务段抛错必须折成 chat-engine-failed，而不是漏给插件兜成 503。
  readonly appraiseThrows?: boolean;
  readonly composeThrows?: boolean;
  readonly cleanThrows?: boolean;
  readonly vetoThrows?: boolean;
  readonly recentThrows?: boolean;
  readonly appendThrows?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const history = new FakeHistory({ recentThrows: options.recentThrows, appendThrows: options.appendThrows });
  const calls: Harness["calls"] = { turns: [], remembered: [], completed: [], logs: [], recallArgs: [] };
  let phase = options.asleep === true ? "asleep" : "awake";
  const baseDialogue = createDialoguePort();
  const dialogue: ChatTurnDeps["dialogue"] = {
    ...baseDialogue,
    composeReply: (input) => {
      if (options.composeThrows === true) throw new Error("compose 坏了");
      return baseDialogue.composeReply(input);
    },
    cleanReply: (raw, maxChars, peerId) => {
      if (options.cleanThrows === true) throw new Error("clean 坏了");
      return baseDialogue.cleanReply(raw, maxChars, peerId);
    },
    vetoTaboo: (text) => {
      if (options.vetoThrows === true) throw new Error("veto 坏了");
      return baseDialogue.vetoTaboo(text);
    },
  };

  const deps: ChatTurnDeps = {
    runtime: {
      sleepInfo: () => ({ phase }),
      turn: (req, opts) => {
        calls.turns.push({ req, opts });
        return options.turnOverride === undefined ? turnText() : options.turnOverride();
      },
      remember: (input) => {
        calls.remembered.push({ ...input });
        if (options.rememberThrows === true) throw new Error("记忆库坏了");
        return { stored: true, reason: "ok", id: "mem-1" };
      },
      persona: () => null,
    },
    llm: options.llm === undefined ? LLM : options.llm,
    dialogue,
    // R4：判定/语言/落记忆由装配层注入；测试给最小假件。
    appraise: () => {
      if (options.appraiseThrows === true) throw new Error("appraise 坏了");
      return { appraisal: {}, eventType: "conversation", features: {} } as unknown as ReturnType<
        ChatTurnDeps["appraise"]
      >;
    },
    language: {} as ChatTurnDeps["language"],
    replySeed: (reply) => ({
      content: `我说：「${reply}」`,
      source: "chat_reply",
      tags: ["chat"],
      vividness: 0.5,
      selfRelevance: 0.6,
      direction: "outbound",
    }),
    recall: (text) => {
      calls.recallArgs.push(text);
      return { memories: ["她记得你喜欢花"], knowledge: [] };
    },
    history,
    peerName: PEER,
    ...(options.recordTimeClaims === undefined ? {} : { recordTimeClaims: options.recordTimeClaims }),
    now: () => NOW,
    log: (line) => calls.logs.push(line),
    complete: async (_cfg, messages, opts) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      calls.completed.push({ system, user, task: opts.task, maxTokens: opts.maxTokens, temperature: opts.temperature });
      if (options.completeThrows === true) throw new Error("boom");
      const reply: ChatReply = {
        text: options.replyText ?? "在呢♪",
        model: "fake-model",
        usage: { promptTokens: 10, completionTokens: 3 },
      };
      return reply;
    },
  };

  return {
    deps,
    history,
    calls,
    setPhase: (next) => {
      phase = next;
    },
  };
}

describe("P2：runChatTurn 网页聊天一轮", () => {
  it("正常一轮：turn→召回→组提示词→模型→清洗→共享历史两边都写→回复记忆", async () => {
    const h = harness();
    const result = await runChatTurn(h.deps, { text: "在吗？" });

    expect(result).toMatchObject({ reply: "在呢♪", mode: "NORMAL", stage: "熟悉的伙伴", historyWritten: true });
    expect(h.calls.turns).toHaveLength(1);
    expect(h.calls.turns[0]?.opts).toMatchObject({ source: "player", audiencePresent: 0 });
    expect(h.calls.completed[0]?.task).toBe("chat");
    expect(h.calls.completed[0]?.system).toContain("不要自称 AI");
    expect(h.calls.completed[0]?.user).toContain("在吗？");

    // 历史顺序：对方先写（模型失败也不丢他说的话），她的话发送后才写。
    expect(h.history.entries.map((e) => [e.who, e.text, e.channel])).toEqual([
      ["peer", "在吗？", "web"],
      ["her", "在呢♪", "web"],
    ]);
    expect(h.history.recentLimits).toContain(12);

    const remembered = h.calls.remembered[0];
    expect(remembered).toMatchObject({ source: "chat_reply", direction: "outbound", tags: ["chat"] });
    expect(String(remembered?.content)).toContain("在呢♪");
    expect(h.calls.logs.join("\n")).toContain("[chat] web llm=fake-model");
  });

  it("睡着（asleep）直接拒：不 turn、不写历史、不写记忆", async () => {
    const h = harness({ asleep: true });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "asleep" });
    expect(h.calls.turns).toHaveLength(0);
    expect(h.history.entries).toHaveLength(0);
    expect(h.calls.remembered).toHaveLength(0);
  });

  it("drowsy 可以聊（只是困，不是睡死）", async () => {
    const h = harness();
    h.setPhase("drowsy");
    const result = await runChatTurn(h.deps, { text: "困了吗？" });
    expect(result.reply).toBe("在呢♪");
  });

  it("空消息与超长消息在调模型前就拒（bad-request）", async () => {
    const h = harness();
    await expect(runChatTurn(h.deps, { text: "   " })).rejects.toMatchObject({ code: "bad-request" });
    await expect(runChatTurn(h.deps, { text: "啊".repeat(2_001) })).rejects.toMatchObject({ code: "bad-request" });
    expect(h.calls.turns).toHaveLength(0);
  });

  it("没有模型凭据：chat-model-unavailable，且不写历史", async () => {
    const h = harness({ llm: null });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-model-unavailable" });
    expect(h.history.entries).toHaveLength(0);
  });

  it("模型调用失败：chat-engine-failed；用户那句仍留在历史里（不吞）", async () => {
    const h = harness({ completeThrows: true });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-engine-failed" });
    expect(h.history.entries).toHaveLength(1);
    expect(h.history.entries[0]).toMatchObject({ who: "peer", text: "在吗？" });
    expect(h.calls.remembered).toHaveLength(0);
  });

  it("模型给空白：chat-empty-reply，她的话不写历史、不写记忆", async () => {
    const h = harness({ replyText: "   " });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-empty-reply" });
    expect(h.history.entries.map((e) => e.who)).toEqual(["peer"]);
    expect(h.calls.remembered).toHaveLength(0);
  });

  it("回复记忆写失败不影响已经生成的话（只写日志）", async () => {
    const h = harness({ rememberThrows: true });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    expect(h.history.entries.map((e) => e.who)).toEqual(["peer", "her"]);
    expect(h.calls.logs.join("\n")).toContain("回复记忆写入失败");
  });

  it("引擎这一轮抛错：chat-engine-failed，不写历史", async () => {
    const h = harness({
      turnOverride: () => {
        throw new Error("state broken");
      },
    });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toBeInstanceOf(ChatTurnError);
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-engine-failed" });
    expect(h.history.entries).toHaveLength(0);
  });

  it("stage=null 时返回不带 stage 字段（不把 null 塞给插件）", async () => {
    const h = harness({ turnOverride: () => turnText({ stage: null }) });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect("stage" in result).toBe(false);
  });

  it("B2：appraise 抛错 → chat-engine-failed（不是插件兜的 daemon-unavailable）", async () => {
    const h = harness({ appraiseThrows: true });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-engine-failed" });
    expect(h.calls.turns).toHaveLength(0);
    expect(h.history.entries).toHaveLength(0);
  });

  it("B2：composeReply 抛错 → chat-engine-failed；他这句仍已在共享历史里", async () => {
    const h = harness({ composeThrows: true });
    await expect(runChatTurn(h.deps, { text: "在吗？" })).rejects.toMatchObject({ code: "chat-engine-failed" });
    expect(h.history.entries.map((e) => e.who)).toEqual(["peer"]);
    expect(h.calls.remembered).toHaveLength(0);
  });

  it("B2：cleanReply / vetoTaboo 抛错 → chat-engine-failed", async () => {
    await expect(
      runChatTurn(harness({ cleanThrows: true }).deps, { text: "在吗？" }),
    ).rejects.toMatchObject({ code: "chat-engine-failed" });
    await expect(
      runChatTurn(harness({ vetoThrows: true }).deps, { text: "在吗？" }),
    ).rejects.toMatchObject({ code: "chat-engine-failed" });
  });

  it("B2：读共享历史抛错只记日志，这一轮照常回复", async () => {
    const h = harness({ recentThrows: true });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    expect(h.calls.logs.join("\\n")).toContain("读历史失败");
    expect(h.history.entries.map((e) => e.who)).toEqual(["peer", "her"]);
  });

  it("B2：写共享历史抛错只记日志，这一轮照常回复", async () => {
    const h = harness({ appendThrows: true });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    expect(h.calls.logs.join("\\n")).toContain("写历史失败");
  });
});

describe("P2.1：chat_reply 记忆形状（verifier 缺口补测）", () => {
  it("她的回复写记忆：source=chat_reply、direction=outbound、tags=[chat]、只存不巩固", () => {
    const seed = chatReplyMemorySeed({ reply: "在呢♪" });
    expect(CHAT_REPLY_MEMORY_SOURCE).toBe("chat_reply");
    expect(seed.source).toBe("chat_reply");
    expect(seed.direction).toBe("outbound");
    expect(seed.tags).toEqual(["chat"]);
    expect(seed.content).toBe("我说：「在呢♪」");
    expect(seed.vividness).toBe(0.5);
    expect(seed.selfRelevance).toBe(0.6);
  });

  it("空回复不写记忆（只有真的发出去的话才该写）", () => {
    expect(() => chatReplyMemorySeed({ reply: "   " })).toThrow(/reply 为空/);
  });
});

describe("task-169 E3：网页回复路径不接来源过滤", () => {
  it("recall 只收到用户原句一个参数（不传 excludeSources/backfill 等）", async () => {
    const h = harness();
    await runChatTurn(h.deps, { text: "在吗？" });
    expect(h.calls.recallArgs).toEqual(["在吗？"]);
  });
});

describe("S3b：网页回信时间一致性日志的注入点（M5）", () => {
  it("回复发出后调一次 recordTimeClaims，参数是她实际发出去的那句", async () => {
    const seen: string[] = [];
    const h = harness({
      replyText: "现在是 20 点，你都 31 分钟没见了",
      recordTimeClaims: (reply) => seen.push(reply),
    });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("现在是 20 点，你都 31 分钟没见了");
    expect(seen).toEqual(["现在是 20 点，你都 31 分钟没见了"]);
    // 回调发生在 her 那条写进历史之后（UI 轮询可见、日志顺序稳定）。
    expect(h.history.entries.map((e) => e.who)).toEqual(["peer", "her"]);
  });

  it("回调抛错不改变本轮结果（回复照常返回），只进日志", async () => {
    const h = harness({
      replyText: "在呢♪",
      recordTimeClaims: () => {
        throw new Error("metrics down");
      },
    });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    expect(h.calls.logs.join("\n")).toContain("[time-claim] failed");
  });

  it("异步拒绝：回复照常返回，不留 unhandled rejection", async () => {
    const h = harness({
      replyText: "在呢♪",
      recordTimeClaims: () => Promise.reject(new Error("async metrics down")),
    });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.logs.join("\n")).toContain("[time-claim] failed");
  });

  it("不注入回调（旧装配）：照常回复，不产生日志", async () => {
    const h = harness({ replyText: "在呢♪" });
    const result = await runChatTurn(h.deps, { text: "在吗？" });
    expect(result.reply).toBe("在呢♪");
    expect(h.calls.logs.some((l) => l.startsWith("[time-claim]"))).toBe(false);
  });
});
