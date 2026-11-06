/**
 * P1：`shouldInitiate` 在给 intentGate 时的门控（引擎路径）。
 *
 * 旧行为（不给 intentGate）= D4 的机械门 + 状态门，一个字节都没变；
 * 新行为（给 intentGate）= 四否决（gate.ts）+ 温和兜底两道机械刹车（gap / daily）。
 *
 * 为什么改：用户 2026-11-01 裁决「最小间隔 30 分钟 + 每天上限 10 条」，
 * 而 A6 裁决仍然有效——夜间 quiet 只能作为情境事实，不得在引擎路径当否决门。
 * 所以这里锁的是：energy / 队列仍不看；gap / daily 必须挡；quiet 不得因时段被挡。
 *
 * 这两个路径必须**同时**锁住：默认路径回归、新路径不被旧门串进来。
 */

import { describe, expect, it } from "vitest";
import { knobNumber, loadConfig } from "../src/engine/config.js";
import { DEFAULT_PROACTIVE } from "../src/dialogue/proactive.js";
import { shouldInitiate, type InitiativeInput, type IntentGateLike } from "../src/orchestrator/initiative.js";

const cfg = loadConfig();
const TH = {
  energyFloor: knobNumber(cfg, "PROACTIVE_ENERGY_THRESHOLD"),
  trustFloor: knobNumber(cfg, "PROACTIVE_TRUST_FLOOR"),
  trustSafeMin: knobNumber(cfg, "TRUST_SAFE_MIN"),
};
const opts = { ...DEFAULT_PROACTIVE, enabled: true };

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

const gate = (over: Partial<IntentGateLike> = {}): IntentGateLike => ({ allowed: true, verdict: "speak", note: "", ...over });

describe("P1：给 intentGate = 只认四否决", () => {
  it("放行时 energy=0、队列非空也开口（状态门/队列不再串回引擎路径）", () => {
    const d = shouldInitiate(input({ energy: 0, eventQueueEmpty: false }), TH, { intentGate: gate() });
    expect(d.act).toBe(true);
    expect(d.verdict).toBe("speak");
  });

  it("距上次开口不足 30 分钟 → gap（温和兜底之一，用户裁决）", () => {
    const near = shouldInitiate(input({ lastAt: 1_000_000 - (30 * 60_000 - 1) }), TH, { intentGate: gate() });
    expect(near.act).toBe(false);
    expect(near.verdict).toBe("gap");
    // 刚好 30 分钟即放行（判据是 <，不是 ≤）
    const edge = shouldInitiate(input({ lastAt: 1_000_000 - 30 * 60_000 }), TH, { intentGate: gate() });
    expect(edge.act).toBe(true);
  });

  it("当天已开口 10 条 → daily（温和兜底之二，用户裁决）", () => {
    const full = shouldInitiate(input({ todayCount: 10 }), TH, { intentGate: gate() });
    expect(full.act).toBe(false);
    expect(full.verdict).toBe("daily");
    expect(shouldInitiate(input({ todayCount: 9 }), TH, { intentGate: gate() }).act).toBe(true);
  });

  it("夜间 quiet 时段不再因安静被挡（A6：静默只是事实，不是引擎路径的门）", () => {
    const d = shouldInitiate(input({ localHour: 3 }), TH, { intentGate: gate() });
    expect(d.act).toBe(true);
    expect(d.verdict).toBe("speak");
  });

  it("额度用完 → quota", () => {
    const d = shouldInitiate(input(), TH, { intentGate: gate({ allowed: false, verdict: "quota", note: "本小时额度用完了" }) });
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("quota");
    expect(d.note).toBe("本小时额度用完了");
  });

  it("静默时段 → quiet（沿用语汇，不新造第二套名字）", () => {
    expect(shouldInitiate(input(), TH, { intentGate: gate({ allowed: false, verdict: "quiet", note: "静默" }) }).verdict).toBe("quiet");
  });

  it("单写者冲突 → single_writer", () => {
    expect(
      shouldInitiate(input(), TH, { intentGate: gate({ allowed: false, verdict: "single_writer", note: "锁在别人手里" }) }).verdict,
    ).toBe("single_writer");
  });

  it("关系信任不够 → distrust（即使 S 层 trust 很高）", () => {
    const d = shouldInitiate(input({ trust: 1 }), TH, { intentGate: gate({ allowed: false, verdict: "distrust", note: "信任不够" }) });
    expect(d.verdict).toBe("distrust");
  });

  it("未知否决结论 fail-closed 成 distrust（不猜、不放过）", () => {
    const d = shouldInitiate(input(), TH, { intentGate: gate({ allowed: false, verdict: "who-knows", note: "?" }) });
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("distrust");
  });

  it("总开关关着时，硬闸放行也不开口", () => {
    const d = shouldInitiate(input({ opts: { ...DEFAULT_PROACTIVE, enabled: false } }), TH, { intentGate: gate() });
    expect(d.act).toBe(false);
    expect(d.verdict).toBe("disabled");
  });

  it("策略仍由 trustSafeMin 决定（硬闸只决定能不能说，不决定怎么说）", () => {
    const floor = knobNumber(cfg, "PROACTIVE_TRUST_FLOOR");
    const safe = knobNumber(cfg, "TRUST_SAFE_MIN");
    const meme = shouldInitiate(input({ trust: (floor + safe) / 2 }), TH, { intentGate: gate() });
    expect(meme.strategy).toBe("initiate_meme");
    const select = shouldInitiate(input({ trust: safe }), TH, { intentGate: gate() });
    expect(select.strategy).toBe("select");
  });
});

describe("P1：不给 intentGate = 旧行为逐条不变（回归锁）", () => {
  it("energy 低于阈值仍然 energy 拦下", () => {
    expect(shouldInitiate(input({ energy: 0 }), TH).verdict).toBe("energy");
  });

  it("队列非空仍然 queue 拦下", () => {
    expect(shouldInitiate(input({ eventQueueEmpty: false }), TH).verdict).toBe("queue");
  });

  it("静默时段仍然 quiet 拦下", () => {
    expect(shouldInitiate(input({ localHour: 3 }), TH).verdict).toBe("quiet");
  });

  it("门控是纯函数：同一输入 + 同一 gate 重复调用结果一致", () => {
    const a = shouldInitiate(input(), TH, { intentGate: gate() });
    const b = shouldInitiate(input(), TH, { intentGate: gate() });
    expect(a).toEqual(b);
  });
});
