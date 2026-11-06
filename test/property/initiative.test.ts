/**
 * v5.4-P1 §4.9 阶段 0 门控（D4）：队列空 + energy/trust 双阈值 + 静默窗/冷却/日上限。
 *
 * 用户最在意的一条：**0–7 点绝不主动开口**。这条在 S1 里用属性测试扫全部 24 小时，
 * 而不是只测三个点——静默窗判定是 modulo 算术，边界错位只在某些小时暴露。
 */

import { describe, expect, it } from "vitest";
import { knobNumber, loadConfig } from "../../src/engine/config.js";
import { inQuietHours } from "../../src/engine/timewindow.js";
import { initiativeStrategy, shouldInitiate, type InitiativeInput } from "../../src/orchestrator/initiative.js";
import { DEFAULT_PROACTIVE } from "../../src/dialogue/proactive.js";
import { bool, float, forAll, int } from "../support/prop.js";

const cfg = loadConfig();
const opts = { ...DEFAULT_PROACTIVE, enabled: true };
const TH = {
  energyFloor: knobNumber(cfg, "PROACTIVE_ENERGY_THRESHOLD"),
  trustFloor: knobNumber(cfg, "PROACTIVE_TRUST_FLOOR"),
  trustSafeMin: knobNumber(cfg, "TRUST_SAFE_MIN"),
};

const input = (over: Partial<InitiativeInput> = {}): InitiativeInput => ({
  now: 1_000_000,
  localHour: 12,
  energy: 1,
  trust: 0.8,
  eventQueueEmpty: true,
  lastAt: null,
  todayCount: 0,
  opts,
  ...over,
});

describe("§4.9 阶段 0：门控顺序", () => {
  it("全部满足 → speak，且 strategy 由 trust 决定", () => {
    const d = shouldInitiate(input({ trust: TH.trustSafeMin }), TH);
    expect(d.act).toBe(true);
    expect(d.strategy).toBe("select");
  });

  it("trust 在 [FLOOR, SAFE_MIN) 之间只许安全话术", () => {
    const floor = knobNumber(cfg, "PROACTIVE_TRUST_FLOOR");
    const safe = knobNumber(cfg, "TRUST_SAFE_MIN");
    const d = shouldInitiate(input({ trust: (floor + safe) / 2 }), TH);
    expect(d.act).toBe(true);
    expect(d.strategy).toBe("initiate_meme");
    expect(initiativeStrategy(floor + 0.01, TH)).toBe("initiate_meme");
  });

  it("energy 恰好等于阈值不触发（> 才是条件）", () => {
    const e = knobNumber(cfg, "PROACTIVE_ENERGY_THRESHOLD");
    expect(shouldInitiate(input({ energy: e }), TH).verdict).toBe("energy");
    expect(shouldInitiate(input({ energy: e + 0.01 }), TH).act).toBe(true);
  });

  it("trust 恰好等于下限不触发", () => {
    const f = knobNumber(cfg, "PROACTIVE_TRUST_FLOOR");
    expect(shouldInitiate(input({ trust: f }), TH).verdict).toBe("distrust");
  });

  it("队列非空 / 冷却中 / 已到日上限 / 关闭 都按各自原因拦下", () => {
    expect(shouldInitiate(input({ eventQueueEmpty: false }), TH).verdict).toBe("queue");
    expect(shouldInitiate(input({ lastAt: 1_000_000 - 1_000 }), TH).verdict).toBe("gap");
    expect(shouldInitiate(input({ todayCount: opts.maxPerDay }), TH).verdict).toBe("daily");
    expect(shouldInitiate(input({ opts: { ...opts, enabled: false } }), TH).verdict).toBe("disabled");
  });
});

describe("§4.9 静默窗（0–7 点绝不主动开口）", () => {
  it("属性：0–6 点无论状态多高都不触发", () => {
    forAll(int(0, 6), (hour) => {
      const d = shouldInitiate(input({ localHour: hour, energy: 1, trust: 1, todayCount: 0, lastAt: null }), TH);
      expect(d.act).toBe(false);
      expect(d.verdict).toBe("quiet");
    }, { label: "静默窗不触发" });
  });

  it("7 点整开始解除（半开区间 [from, to)）", () => {
    expect(shouldInitiate(input({ localHour: 7 }), TH).act).toBe(true);
    expect(inQuietHours(6, 0, 7)).toBe(true);
    expect(inQuietHours(7, 0, 7)).toBe(false);
  });

  it("属性：静默窗跨零点也成立（22→7）", () => {
    forAll(int(0, 23), (hour) => {
      const crossed = inQuietHours(hour, 22, 7);
      expect(crossed).toBe(hour >= 22 || hour < 7);
    }, { label: "跨零点静默窗" });
  });

  it("属性：未开静默窗时任何小时都不因 quiet 被拦", () => {
    forAll(int(0, 23), (hour) => {
      const d = shouldInitiate(input({ localHour: hour, opts: { ...opts, quietFrom: 0, quietTo: 0 } }), TH);
      expect(d.verdict).not.toBe("quiet");
    }, { label: "无静默窗" });
  });
});

describe("§4.9 门控与状态解耦（A34 同族）", () => {
  it("门控是纯函数：同一输入重复调用结果一致", () => {
    forAll(float(0, 1), (trust) => {
      const a = shouldInitiate(input({ trust }), TH);
      const b = shouldInitiate(input({ trust }), TH);
      expect(a).toEqual(b);
    }, { label: "门控幂等" });
  });

  it("eventQueueEmpty 是硬条件：无论 energy/trust 多高都不抢话", () => {
    forAll(bool(), (energyHigh) => {
      const d = shouldInitiate(input({ eventQueueEmpty: false, energy: energyHigh ? 1 : 0, trust: 1 }), TH);
      expect(d.act).toBe(false);
    }, { label: "队列非空不抢话" });
  });
});
