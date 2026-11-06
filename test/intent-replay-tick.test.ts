/**
 * P2 接线契约：回放选出的线头要真的能进候选（不是只写日志）。
 *
 * 这里不测 replay.ts / replay-source.ts 的内部打分（各自有测试），
 * 只锁两个模块之间的**形状与效果**：回放线程 → `runIntentTick({threads})` → 出现 continue_thread 候选。
 */

import { describe, expect, it } from "vitest";

import type { Stage } from "../src/engine/bonds.js";
import { initialSState, type SState } from "../src/engine/state.js";
import { initialAccumulator } from "../src/orchestrator/intent/bus.js";
import { replaySource } from "../src/orchestrator/intent/replay-source.js";
import { runIntentTick, type IntentTickInput } from "../src/orchestrator/intent/tick.js";
import type { Affordance } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T06:00:00.000Z";
const NOW = Date.parse(AT);
const QQ: Affordance = { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false };

function state(overrides: Partial<SState> = {}): SState {
  return { ...initialSState(), ...overrides };
}

function input(overrides: Partial<IntentTickInput> = {}): IntentTickInput {
  return {
    situation: {
      at: AT,
      localHour: 14,
      channel: "qq",
      participants: ["用户"],
      affordances: [QQ],
      sinceLastContactMin: 30,
      activeIntents: [],
      budget: { rph: 8, peak: false },
      singleWriterConflict: false,
    },
    state: state({ energy: 0.6, suppressionLoad: 0.2 }),
    stage: "stranger" as Stage,
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 5,
    valueDeviation: 0.1,
    coverageGap: 0.3,
    trust: 0.5,
    trustFloor: 0.2,
    ...overrides,
  };
}

/** 一条"心事"：没闭合、鲜明，会被回放成 unfinished 线头 */
const UNFINISHED = {
  id: "mem-1",
  content: "用户说回来说一声，我还没等到",
  tags: ["聊天"],
  created_at: NOW - 3 * 3_600_000,
  vividness: 0.8,
  self_relevance: 0.7,
  unresolved_score: 0.7,
  access_count: 2,
  last_accessed: NOW - 3_600_000,
  participants: ["用户"],
  encode_ctx: { channel: "qq", mode: "NORMAL", place: "QQ" },
};

describe("回放线头真的进候选（P2 接线契约）", () => {
  it("有心事可回放时，tick 的候选里出现 continue_thread，且线程来自 replay:", () => {
    const replay = replaySource([UNFINISHED], NOW, true);
    // 同一条记忆可能同时算「未闭合」和「余响」（selectReplay 不去重），
    // 但转成线头时按记忆去重（replayThreads 的职责）——所以 items≥1、threads=1。
    expect(replay.items.length).toBeGreaterThanOrEqual(1);
    expect(replay.threads.length).toBe(1);

    const r = runIntentTick(input({ threads: replay.threads }));
    const kinds = r.candidates.map((c) => c.kind);
    expect(kinds).toContain("continue_thread");
    const thread = replay.threads[0];
    expect(thread).toBeDefined();
    expect(thread?.id.startsWith("replay:")).toBe(true);
  });

  it("没有记忆可回放时：不伪造线头，候选里也没有 continue_thread", () => {
    const replay = replaySource([], NOW, true);
    expect(replay.threads).toEqual([]);
    const r = runIntentTick(input());
    expect(r.candidates.map((c) => c.kind)).not.toContain("continue_thread");
  });

  it("同一份记忆重复回放：线程 id 稳定（可审计、不抖）", () => {
    const a = replaySource([UNFINISHED], NOW, true);
    const b = replaySource([UNFINISHED], NOW + 60_000, true);
    expect(a.threads.map((t) => t.id)).toEqual(b.threads.map((t) => t.id));
  });
});
