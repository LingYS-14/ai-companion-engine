/**
 * §7.1 里程碑修复（`learning/learn.ts` 的 computeRepairDelta + runtime.tryMilestone）。
 *
 * 这条捷径的规格来源于 v5.2 B8/B9 两条修正：cap 永不 bind 的 bug、trust 一步到 1.0 的 bug。
 * 公式早就修好了，测试也早就有——**但没有一个真对话会调用它**（V52-GAP M7-02）。
 * 这里验的是"接上以后行为对不对"：没有破裂不修、强度不够不修、修一次就记账、
 * 类型不在 TYPE_SET 的补偿动作（gift）不走捷径、修复窗口过了不补。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

/** 一次"她很受伤"的评价：goal_congruence 为负 → trust 掉到 TRUST_MAX_STEP 上限（-0.1） */
const HURT = {
  goal_congruence: -1,
  goal_relevance: 1,
  coping_potential: 0.1,
  novelty: 0.5,
  legitimacy: 0,
};

/** 一次普通的正面交流 */
const WARM = {
  goal_congruence: 0.9,
  goal_relevance: 1,
  coping_potential: 0.8,
  novelty: 0.1,
  legitimacy: 0.9,
};

describe("SoulRuntime.tryMilestone：里程碑修复的入口", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-milestone-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("没破裂过：给再高的强度也不修（修复期是入口条件）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const r = rt.turn(
      { text: "抱抱", appraisal: WARM },
      { eventType: "comfort", eventIntensity: 1, skipMemory: true },
    );
    expect(r.repair).toBeUndefined();
  });

  it("破裂了但这次安慰对她不重（goal_relevance 低）：不假装它是高强度修复", async () => {
    // 强度来源：显式 `eventIntensity` 优先；没给就用 appraisal.goal_relevance（§7.2 期望模型同源，
    // 见 runtime.turnInner 的注释——规格的事件强度通道被删了，M5-04）。
    // 阈值 0.9 意味着只有"这件事对她很重"的补偿才算修复，轻描淡写的一句安慰不算。
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    const light = { ...WARM, goal_relevance: 0.4 };
    const r = rt.turn({ text: "嗯", appraisal: light }, { eventType: "comfort", skipMemory: true });
    expect(r.repair).toBeUndefined();
    expect(r.expectation?.actual).toBe(0.4);
  });

  it("破裂之后的高强度 comfort → 走捷径，bond 与 trust 都往上走", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    const bondBefore = rt.bondProgress;
    const trustBefore = rt.state.trust;

    const r = rt.turn(
      { text: "对不起，我在", appraisal: WARM },
      { eventType: "comfort", eventIntensity: 0.95, skipMemory: true },
    );

    expect(r.repair?.type).toBe("comfort");
    expect(r.repair?.deltaBond ?? 0).toBeGreaterThan(0);
    expect(rt.bondProgress).toBeGreaterThan(bondBefore);
    expect(rt.state.trust).toBeGreaterThan(trustBefore);
  });

  it("同一个类型只修一次（规格：里程碑每题仅一次）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    const first = rt.turn(
      { text: "对不起", appraisal: WARM },
      { eventType: "comfort", eventIntensity: 0.95, skipMemory: true },
    );
    expect(first.repair).toBeDefined();
    const second = rt.turn(
      { text: "我一直在", appraisal: WARM },
      { eventType: "comfort", eventIntensity: 0.95, skipMemory: true },
    );
    expect(second.repair).toBeUndefined();
  });

  it("gift 在 eligible 里但不在 TYPE_SET：补偿性动作不走捷径", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    const r = rt.turn(
      { text: "给你买了花", appraisal: WARM },
      { eventType: "gift", eventIntensity: 1, skipMemory: true },
    );
    expect(r.repair).toBeUndefined();
  });

  it("修复窗口过了（>24h）就不补", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    clock.advance(25 * 3_600_000);
    const r = rt.turn(
      { text: "对不起", appraisal: WARM },
      { eventType: "comfort", eventIntensity: 1, skipMemory: true },
    );
    expect(r.repair).toBeUndefined();
  });

  it("再破裂一次会重置「已用过」的记录（新的修复期重新开始）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "滚开", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    expect(
      rt.turn({ text: "对不起", appraisal: WARM }, { eventType: "comfort", eventIntensity: 1, skipMemory: true }).repair,
    ).toBeDefined();
    // 再伤一次 → 新的修复期
    rt.turn({ text: "你又这样", appraisal: HURT }, { eventType: "insult", skipMemory: true });
    expect(
      rt.turn({ text: "对不起", appraisal: WARM }, { eventType: "comfort", eventIntensity: 1, skipMemory: true }).repair,
    ).toBeDefined();
  });
});
