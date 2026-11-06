import { describe, expect, it } from "vitest";

import { createSpineGate, SPINE_COOLDOWN_MS, SPINE_FAIL_THRESHOLD } from "../src/autonomy/spine.js";

/**
 * 脊髓熔断的三条硬要求（Phase 0 P0-3）：
 * 1. 连续失败到阈值就熔断——熔断期间 canSend=false（等于"不发送"），isOpen=true（等于"不生成"）；
 * 2. 一次故障只上行一条 channel-down，半开探针再失败不重复上行；
 * 3. 冷却到期只放一次探针，探针成功才上行 channel-up 并复位。
 */
function setup(startAt = 1_000_000): {
  readonly gate: ReturnType<typeof createSpineGate>;
  readonly uplinks: string[];
  readonly at: (deltaMs: number) => number;
} {
  const uplinks: string[] = [];
  const gate = createSpineGate({
    now: () => startAt,
    onUplink: (e) => uplinks.push(`${e.kind}:${String(e.failures)}`),
  });
  return { gate, uplinks, at: (deltaMs: number) => startAt + deltaMs };
}

describe("spine gate", () => {
  it("连续失败到阈值才熔断，熔断前仍可发送", () => {
    const { gate, at } = setup();
    for (let i = 0; i < SPINE_FAIL_THRESHOLD - 1; i += 1) {
      expect(gate.canSend(at(i))).toBe(true);
      gate.recordSend(at(i), false);
    }
    expect(gate.isOpen(at(10))).toBe(false);
    expect(gate.canSend(at(10))).toBe(true);
    gate.recordSend(at(11), false);
    expect(gate.isOpen(at(12))).toBe(true);
    expect(gate.canSend(at(12))).toBe(false);
  });

  it("一次故障只上行一条 channel-down", () => {
    const { gate, uplinks, at } = setup();
    for (let i = 0; i < 6; i += 1) gate.recordSend(at(i), false);
    expect(uplinks).toEqual([`channel-down:${String(SPINE_FAIL_THRESHOLD)}`]);
  });

  it("成功发送会复位计数，不触发上行", () => {
    const { gate, uplinks, at } = setup();
    gate.recordSend(at(0), false);
    gate.recordSend(at(1), false);
    gate.recordSend(at(2), true);
    gate.recordSend(at(3), false);
    gate.recordSend(at(4), false);
    expect(gate.isOpen(at(5))).toBe(false);
    expect(uplinks).toEqual([]);
  });

  it("冷却到期只放一次探针，探针成功才恢复", () => {
    const { gate, uplinks, at } = setup();
    for (let i = 0; i < SPINE_FAIL_THRESHOLD; i += 1) gate.recordSend(at(i), false);
    // 熔断从第 SPINE_FAIL_THRESHOLD 次失败那一刻起算
    const openedAt = at(SPINE_FAIL_THRESHOLD - 1) + SPINE_COOLDOWN_MS;
    expect(gate.canSend(openedAt - 1)).toBe(false);
    // 冷却未到：不放
    expect(gate.canSend(openedAt - 2)).toBe(false);
    // 冷却到期：放一次
    const probeAt = openedAt;
    expect(gate.canSend(probeAt)).toBe(true);
    expect(gate.canSend(probeAt + 1)).toBe(false);
    gate.recordSend(probeAt + 2, true);
    expect(gate.isOpen(probeAt + 3)).toBe(false);
    expect(uplinks).toEqual([`channel-down:${String(SPINE_FAIL_THRESHOLD)}`, "channel-up:0"]);
  });

  it("探针再失败：重新起算冷却，但不重复上行", () => {
    const { gate, uplinks, at } = setup();
    for (let i = 0; i < SPINE_FAIL_THRESHOLD; i += 1) gate.recordSend(at(i), false);
    const probeAt = at(10) + SPINE_COOLDOWN_MS;
    expect(gate.canSend(probeAt)).toBe(true);
    gate.recordSend(probeAt, false);
    expect(gate.isOpen(probeAt + 1)).toBe(true);
    expect(gate.canSend(probeAt + SPINE_COOLDOWN_MS - 1)).toBe(false);
    expect(uplinks).toEqual([`channel-down:${String(SPINE_FAIL_THRESHOLD)}`]);
  });
});
