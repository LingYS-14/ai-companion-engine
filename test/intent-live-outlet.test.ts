import { describe, expect, it } from "vitest";
import { appraiseFromText } from "../src/psychology/appraisal-qq.js";

import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";
import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

/**
 * P1 真出口的接线断言（2026-10-31 用户批准）。
 *
 * 这一层测的是「桥有没有把意向引擎给的两样东西递进去」：
 *   1. `gate`（四否决结论）→ 决定该不该开口；
 *   2. `note`（自述）→ 进 system 提示，让模型说她真正想说的那件事。
 *
 * 判据本身（四否决怎么算、自述怎么拼）在 `test/intent-gate.test.ts` 与
 * `test/composer.test.ts` 里已经覆盖；这里只锁"接线没断"。
 */

const NOW = 1_700_000_000_000;
const PEER = 100_000_001;

function runtime(pressure = 0.9, trust = 0.8): SoulRuntime {
  const fake = {
    snapshot: () => ({
      mode: "NORMAL",
      state: { pressure, rumination: 0, energy: 1, entropy: 0, trust },
    }),
    wonder: () => ({ score: 0, push: null, reason: "测试：不给动机层加分" }),
    persona: () => null,
  };
  return fake as unknown as SoulRuntime;
}

function harness(input: {
  readonly pressure?: number;
  readonly trust?: number;
  readonly lastProactiveAt?: number;
  readonly reply?: string;
}): {
  readonly bridge: OneBotBridge;
  readonly systems: string[];
  readonly sent: string[];
} {
  const systems: string[] = [];
  const sent: string[] = [];
  const deps: OneBotBridgeDeps = {
    now: () => NOW,
    localHour: () => 12,
    appraise: appraiseFromText,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async ({ system }) => {
      systems.push(system);
      return input.reply ?? "好呀♪";
    },
    send: async (text: string) => {
      sent.push(text);
      return { ok: true, detail: "onebot: 已发送" };
    },
    saveState: (_state: QQStateRecord) => {},
    channelDown: () => false,
    gates: () => ({ energyFloor: 0.2, trustFloor: 0.3, trustSafeMin: 0.5, queueEmpty: true }),
    log: () => {},
  };
  const state = { ...emptyQQState(), ...(input.lastProactiveAt === undefined ? {} : { lastProactiveAt: input.lastProactiveAt }) };
  const bridge = new OneBotBridge(
    runtime(input.pressure ?? 0.9, input.trust ?? 0.8),
    makeOneBotOptions({ peer: PEER, peerName: "用户", dryRun: false }),
    deps,
    state,
  );
  return { bridge, systems, sent };
}

describe("P1 真出口：意向引擎的硬闸接进主动开口", () => {
  it("gate 不允许（额度用完）：不生成、不发送，理由来自 gate", async () => {
    const h = harness({});
    const r = await h.bridge.proactive(undefined, {
      gate: { allowed: false, verdict: "quota", note: "这个小时的模型额度用完了" },
    });
    expect(r.acted).toBe(false);
    expect(r.verdict).toBe("quota");
    expect(h.systems.length).toBe(0);
    expect(h.sent.length).toBe(0);
  });

  it("gate 允许：照常生成并发送（gate 不改变允许后的旧行为）", async () => {
    const h = harness({});
    const r = await h.bridge.proactive(undefined, {
      gate: { allowed: true, verdict: "speak", note: "可以开口" },
    });
    expect(r.acted).toBe(true);
    expect(h.systems.length).toBe(1);
    expect(h.sent.length).toBe(1);
  });

  it("给了自述：system 里出现【此刻的由头】，且要求不复述", async () => {
    const h = harness({});
    const r = await h.bridge.proactive(undefined, {
      gate: { allowed: true, verdict: "speak", note: "可以开口" },
      note: { line: "我想找人说句话", whyLine: "因为想有人陪（缺口 0.62）" },
    });
    expect(r.acted).toBe(true);
    const system = h.systems[0] ?? "";
    expect(system).toContain("【此刻的由头】");
    expect(system).toContain("我想找人说句话");
    expect(system).toContain("不要复述这一句");
  });

  it("不给自述：system 与旧行为一致（不出现由头段）", async () => {
    const h = harness({});
    await h.bridge.proactive(undefined, { gate: { allowed: true, verdict: "speak", note: "可以开口" } });
    expect(h.systems[0] ?? "").not.toContain("【此刻的由头】");
  });
});

describe("A5：情境自觉与 HOLD 出口协议", () => {
  it("处境进了 system，而且不进去 user（不把事实当成对方说的话）", async () => {
    const h = harness({});
    const r = await h.bridge.proactive(undefined, {
      gate: { allowed: true, verdict: "speak", note: "可以开口" },
      situation: { lines: ["现在是凌晨 2 点，他多半已经睡了"] },
    });
    expect(r.acted).toBe(true);
    const system = h.systems[0] ?? "";
    expect(system).toContain("## 此刻的处境");
    expect(system).toContain("现在是凌晨 2 点");
    expect(system).toContain("HOLD");
  });

  it("她只回 HOLD：不发送、verdict=held，但仍然生成过（花了钱）", async () => {
    const h = harness({ reply: "HOLD" });
    const r = await h.bridge.proactive(undefined, {
      gate: { allowed: true, verdict: "speak", note: "可以开口" },
      situation: { lines: ["现在是凌晨 2 点，他多半已经睡了"] },
    });
    expect(r.acted).toBe(false);
    expect(r.verdict).toBe("held");
    expect(r.reply).toBeUndefined();
    expect(h.systems.length).toBe(1);
    expect(h.sent.length).toBe(0);
  });

  it("大小写/空白不影响 HOLD 判定（同一协议的宽容面）", async () => {
    const h = harness({ reply: "  hold  " });
    const r = await h.bridge.proactive(undefined, { situation: { lines: ["他 5 小时没出现了"] } });
    expect(r.verdict).toBe("held");
    expect(h.sent.length).toBe(0);
  });

  it("HOLD 后面还带话 = 不是纯 HOLD，按原样发送（不吞掉她想说的内容）", async () => {
    const h = harness({ reply: "HOLD 但我还是想跟你说一声" });
    const r = await h.bridge.proactive(undefined, { situation: { lines: ["他 5 小时没出现了"] } });
    expect(r.acted).toBe(true);
    expect(h.sent).toEqual([expect.objectContaining({ text: "HOLD 但我还是想跟你说一声" })]);
  });
});
