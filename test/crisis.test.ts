import { describe, expect, it } from "vitest";
import { crisisEvent, immediateTickInput } from "../src/engine/crisis.js";
import { loadConfig, tickHours } from "../src/engine/config.js";
import { initialSState, tick } from "../src/engine/state.js";

const cfg = loadConfig();
const TAU = tickHours(cfg);

describe("§4.7 crisis_event", () => {
  it("低于 CRISIS_SEVERITY_MIN 返回 null（走普通队列）", () => {
    expect(crisisEvent({ id: "c1", severity: 0.79, summary: "被嘲讽" }, cfg)).toBeNull();
    expect(crisisEvent({ id: "c2", severity: 0.8, summary: "恰好在门槛" }, cfg)).not.toBeNull();
  });

  it("immediate gain = severity，suppression_add = 0.5 × severity", () => {
    const g = crisisEvent({ id: "c3", severity: 0.9, summary: "当众羞辱" }, cfg);
    expect(g).not.toBeNull();
    expect(g!.pressureGain).toBeCloseTo(0.9, 10);
    expect(g!.suppressionAdd).toBeCloseTo(0.45, 10);
    expect(g!.source).toBe("crisis_event");
  });

  it("severity 非有限值抛错", () => {
    expect(() => crisisEvent({ id: "c4", severity: Number.POSITIVE_INFINITY, summary: "x" }, cfg)).toThrow(/非有限值/);
  });

  it("immediateTickInput 把 si 置 0，避免与 suppressionAdd 双计", () => {
    const g = crisisEvent({ id: "c5", severity: 0.9, summary: "y" }, cfg)!;
    expect(immediateTickInput(g, TAU)).toEqual({
      dtHours: TAU,
      pressureGain: 0.9,
      suppressionAdd: 0.45,
      suppressionIntensity: 0,
    });
  });

  it("同一轮 si 与 suppressionAdd 同时出现直接抛错", () => {
    const s = initialSState();
    expect(() => tick(s, { dtHours: TAU, pressureGain: 0.1, suppressionIntensity: 1, suppressionAdd: 0.2 }, cfg)).toThrow(
      /双计/,
    );
  });

  it("危机在同一 tick 生效：矛盾立刻顶住、面具立刻下降", () => {
    const s = initialSState();
    const g = crisisEvent({ id: "c6", severity: 0.9, summary: "z" }, cfg)!;
    tick(s, immediateTickInput(g, TAU), cfg);
    expect(s.pressure).toBeGreaterThan(0.85); // 一轮就进 DEFENSE 区间
    expect(s.suppressionLoad).toBeCloseTo(0.1 + 0.45, 6);
    expect(s.maskIntegrity).toBeCloseTo(0.45, 6);
  });
});
