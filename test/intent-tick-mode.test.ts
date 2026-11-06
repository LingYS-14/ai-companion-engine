/**
 * 空转节拍（planTickMode）：把 idle.ts 的计划翻译成 tick 动作
 */

import { describe, expect, it } from "vitest";

import { IDLE_MAX_MS, IDLE_MIN_MS, K_S_DEFAULT } from "../src/orchestrator/intent/idle.js";
import { planTickMode } from "../src/orchestrator/intent/tick-mode.js";

const NOW = Date.UTC(2026, 9, 31, 3, 0, 0);
const SEED = "assistant-2026-10-31";

describe("planTickMode：首次启动", () => {
  it("没落过盘 → 当作窗口已到，允许记新意图，下一次排在 20–40 分钟后", () => {
    const mode = planTickMode({ lastIdleAtMs: null, nowMs: NOW, openIntentions: 0, seed: SEED });
    expect(mode.due).toBe(true);
    expect(mode.mode).toBe("deliberate");
    expect(mode.recordNewIntentions).toBe(true);
    expect(mode.nextAtMs).not.toBeNull();
    const gap = (mode.nextAtMs ?? 0) - NOW;
    expect(gap).toBeGreaterThanOrEqual(IDLE_MIN_MS);
    expect(gap).toBeLessThanOrEqual(IDLE_MAX_MS);
  });

  it("首次启动但已经堆满意图 → 只消化，不记新的", () => {
    const mode = planTickMode({ lastIdleAtMs: null, nowMs: NOW, openIntentions: K_S_DEFAULT, seed: SEED });
    expect(mode.due).toBe(true);
    expect(mode.mode).toBe("digest");
    expect(mode.recordNewIntentions).toBe(false);
    expect(mode.reason).toContain("只消化");
  });
});

describe("planTickMode：窗口判定", () => {
  it("未到窗口 → due=false、只消化、给出下次时间", () => {
    const mode = planTickMode({ lastIdleAtMs: NOW - 60_000, nowMs: NOW, openIntentions: 0, seed: SEED });
    expect(mode.due).toBe(false);
    expect(mode.mode).toBe("digest");
    expect(mode.recordNewIntentions).toBe(false);
    expect(mode.nextAtMs).not.toBeNull();
    expect(mode.reason).toContain("未到空转窗口");
  });

  it("窗口到且意图不多 → deliberate 允许记新的", () => {
    const mode = planTickMode({ lastIdleAtMs: NOW - 45 * 60_000, nowMs: NOW, openIntentions: 1, seed: SEED });
    expect(mode.due).toBe(true);
    expect(mode.mode).toBe("deliberate");
    expect(mode.recordNewIntentions).toBe(true);
    expect(mode.nextAtMs).not.toBeNull();
  });

  it("窗口到但开着的意图 ≥ K_S → digest、不记新的", () => {
    const mode = planTickMode({ lastIdleAtMs: NOW - 45 * 60_000, nowMs: NOW, openIntentions: K_S_DEFAULT, seed: SEED });
    expect(mode.due).toBe(true);
    expect(mode.mode).toBe("digest");
    expect(mode.recordNewIntentions).toBe(false);
    expect(mode.reason).toContain("K_S");
  });

  it("kS 可覆盖（kS=1 时一条就把档位压成 digest）", () => {
    const mode = planTickMode({
      lastIdleAtMs: NOW - 45 * 60_000,
      nowMs: NOW,
      openIntentions: 1,
      seed: SEED,
      kS: 1,
    });
    expect(mode.mode).toBe("digest");
    expect(mode.recordNewIntentions).toBe(false);
  });
});

describe("planTickMode：确定性与纯函数", () => {
  it("同输入两次结果相同；不修改入参", () => {
    const input = { lastIdleAtMs: NOW - 60_000, nowMs: NOW, openIntentions: 2, seed: SEED } as const;
    const a = planTickMode(input);
    const b = planTickMode(input);
    expect(a).toEqual(b);
    expect(input).toEqual({ lastIdleAtMs: NOW - 60_000, nowMs: NOW, openIntentions: 2, seed: SEED });
  });

  it("不同种子的间隔都落在 20–40 分钟（节奏不固定死）", () => {
    const gaps = ["a", "b", "assistant-1", "assistant-2"].map(
      (seed) => (planTickMode({ lastIdleAtMs: null, nowMs: NOW, openIntentions: 0, seed }).nextAtMs ?? NOW) - NOW,
    );
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(IDLE_MIN_MS);
      expect(gap).toBeLessThanOrEqual(IDLE_MAX_MS);
    }
  });
});
