import { describe, expect, it } from "vitest";

import { makeOneBotOptions, OneBotBridge, type OneBotBridgeDeps } from "../src/qq/onebot-bridge.js";
import { createDialoguePort, createLanguagePort } from "../src/dialogue/port-adapter.js";
import { emptyQQState, type QQStateRecord } from "../src/qq/types.js";
import type { SoulRuntime } from "../src/plugin/runtime.js";

/**
 * Phase 0 P0-3 的接线断言：脊髓说「通道断着」时，大脑连**想**都不该想。
 * 断网那 4 小时半的账单是 34 次模型调用 + 34 条重复台词，这里把那条路堵死。
 */
const NOW = 1_700_000_000_000;
const PEER = 100_000_001;

function runtime(pressure = 0.9): SoulRuntime {
  const fake = {
    snapshot: () => ({ mode: "NORMAL", state: { pressure, rumination: 0, energy: 1, entropy: 0 } }),
    wonder: () => ({ score: 0, push: null, reason: "测试：不给动机层加分" }),
    persona: () => null,
  };
  return fake as unknown as SoulRuntime;
}

function harness(channelDown: boolean): {
  readonly bridge: OneBotBridge;
  readonly counters: { generated: number; sent: number };
} {
  const counters = { generated: 0, sent: 0 };
  const deps: OneBotBridgeDeps = {
    now: () => NOW,
    localHour: () => 12,
    dialogue: createDialoguePort(),
    language: createLanguagePort(),
    generate: async () => {
      counters.generated += 1;
      return "好呀♪";
    },
    send: async () => {
      counters.sent += 1;
      return { ok: true, detail: "onebot: 已发送" };
    },
    saveState: (_state: QQStateRecord) => {},
    channelDown: () => channelDown,
    log: () => {},
  };
  const bridge = new OneBotBridge(
    runtime(),
    makeOneBotOptions({ peer: PEER, peerName: "用户", dryRun: false }),
    deps,
    emptyQQState(),
  );
  return { bridge, counters };
}

describe("脊髓熔断接进主动开口", () => {
  it("通道断着：不生成、不发送，理由写明是脊髓熔断", async () => {
    const h = harness(true);
    const r = await h.bridge.proactive();
    expect(r.acted).toBe(false);
    expect(r.verdict).toBe("send-failed");
    expect(r.detail).toContain("脊髓熔断");
    expect(h.counters.generated).toBe(0);
    expect(h.counters.sent).toBe(0);
  });

  it("通道正常：照常生成并发送（熔断层不改变旧行为）", async () => {
    const h = harness(false);
    const r = await h.bridge.proactive();
    expect(r.acted).toBe(true);
    expect(h.counters.generated).toBe(1);
    expect(h.counters.sent).toBe(1);
  });
});
