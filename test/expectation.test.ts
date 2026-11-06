/**
 * §7.2 预测误差驱动（期望模型 + 落差学习）。
 *
 * 规格里这套东西（`ExpectationModel.predict_intensity` / `learnDelta`）从 v5.3 就写好了，
 * 公式和测试都齐——但**零调用点**（V52-GAP M7-03/M7-04）：她从来没有"预期"，
 * 于是"被辜负"和"被惊喜"都不存在，预测误差也无从谈起。
 *
 * 这里验的是接上以后的行为：预测来自历史样本、样本要真落盘、落差错得离谱才学、
 * 学到的偏置有硬边界（不能被一次意外改写整个人）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { ExpectationModel, learnDelta, type ActionRecord } from "../src/learning/learn.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

/** 一次"这件事对我很重"的交流：goal_relevance=1 → 强度代理 1.0 */
const HEAVY = {
  goal_congruence: 0.6,
  goal_relevance: 1,
  coping_potential: 0.8,
  novelty: 0.2,
  legitimacy: 0.8,
};

/** 一次"轻描淡写"的交流：goal_relevance=0.3 → 强度代理 0.3 */
const LIGHT = { ...HEAVY, goal_relevance: 0.3 };

describe("ExpectationModel：预测本身（纯函数，无状态副作用）", () => {
  it("没有历史时回落到先验 0.3", () => {
    const model = new ExpectationModel(cfg);
    expect(model.predictIntensity("care", [])).toBeCloseTo(0.3, 6);
  });

  it("取同类型样本的均值，不同类型不参与", () => {
    const model = new ExpectationModel(cfg);
    const history: ActionRecord[] = [
      { type: "care", intensity: 0.8 },
      { type: "tease", intensity: 0.1 },
      { type: "care", intensity: 0.4 },
    ];
    expect(model.predictIntensity("care", history)).toBeCloseTo(0.6, 6);
  });

  it("增量式缓存：窗口内新样本不够 RECALC_INTERVAL 时复用旧预测", () => {
    const model = new ExpectationModel(cfg);
    const history: ActionRecord[] = [{ type: "care", intensity: 1 }];
    expect(model.predictIntensityIncremental("care", history)).toBeCloseTo(1, 6);
    // 只多 3 条（< 5），缓存不重算
    history.push({ type: "care", intensity: 0 }, { type: "care", intensity: 0 }, { type: "care", intensity: 0 });
    expect(model.predictIntensityIncremental("care", history)).toBeCloseTo(1, 6);
    // 再多 6 条（> 5），重算
    for (let i = 0; i < 6; i += 1) history.push({ type: "care", intensity: 0 });
    expect(model.predictIntensityIncremental("care", history)).toBeLessThan(0.5);
  });
});

describe("learnDelta：学到的增量被 MAGNITUDE_CAP 截断", () => {
  it("证据越多学得越慢（alpha 随 evidenceCount 下降）", () => {
    const fresh = Math.abs(learnDelta(1, 0, 0, 0, cfg));
    const seasoned = Math.abs(learnDelta(1, 0, 20, 0, cfg));
    expect(seasoned).toBeLessThan(fresh);
    expect(fresh).toBeLessThanOrEqual(0.05 + 1e-12);
  });

  it("负向落差学成负值", () => {
    expect(learnDelta(0.1, 0.9, 0, 0, cfg)).toBeLessThan(0);
  });
});

describe("SoulRuntime：真对话里出现落差并学进偏置", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-expect-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("第一轮：没有样本 → 预测 0.3，落差 0.7，学到的增量被截到 0.05", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const r = rt.turn({ text: "你今天怎么样", appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    expect(r.expectation?.predicted).toBeCloseTo(0.3, 6);
    expect(r.expectation?.actual).toBeCloseTo(1, 6);
    expect(r.expectation?.error).toBeCloseTo(0.7, 6);
    expect(r.expectation?.learned).toBeCloseTo(0.05, 6);
  });

  it("第二轮：预测就已经被上一轮样本与偏置抬起来", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "一", appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    const r = rt.turn({ text: "二", appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    // 样本均值 1.0 + 偏置 0.05 → 截到 1.0
    expect(r.expectation?.predicted).toBeCloseTo(1, 6);
    expect(r.expectation?.error).toBeCloseTo(0, 6);
  });

  it("轻微偏差不学（|误差| 小时 learned 接近 0 且不越界）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "一", appraisal: LIGHT }, { eventType: "care", skipMemory: true });
    const r = rt.turn({ text: "二", appraisal: LIGHT }, { eventType: "care", skipMemory: true });
    expect(Math.abs(r.expectation?.learned ?? 1)).toBeLessThan(0.02);
  });

  it("样本与偏置真的落盘：重开 runtime 以后预测还认得你", async () => {
    const rt1 = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < 3; i += 1) {
      rt1.turn({ text: `第${String(i)}句`, appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    }
    const predictedBefore = rt1.turn({ text: "四", appraisal: HEAVY }, { eventType: "care", skipMemory: true })
      .expectation?.predicted;
    expect(predictedBefore).toBeCloseTo(1, 6);

    const rt2 = await SoulRuntime.open(conf, clock);
    const after = rt2.turn({ text: "五", appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    expect(after.expectation?.predicted).toBeCloseTo(1, 6);
  });

  it("偏置有硬边界：连续 20 次极端落差也只到 +0.3", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < 20; i += 1) {
      rt.turn({ text: `重${String(i)}`, appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    }
    const state = JSON.parse(
      // 直接从落盘文件读，验的是"她身上真实的数"，不是内存字段
      (await import("node:fs")).readFileSync(join(dir, "state-test.json"), "utf8"),
    ) as { expectationBias?: Record<string, number> };
    expect(state.expectationBias?.["care"]).toBeLessThanOrEqual(0.3 + 1e-12);
    expect(state.expectationBias?.["care"]).toBeGreaterThan(0);
  });

  it("不同类型各记各的，不互相污染", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "一", appraisal: HEAVY }, { eventType: "care", skipMemory: true });
    const r = rt.turn({ text: "二", appraisal: LIGHT }, { eventType: "tease", skipMemory: true });
    // tease 没有自己的样本 → 先验 0.3，而不是 care 的 1.0
    expect(r.expectation?.predicted).toBeCloseTo(0.3, 6);
  });
});
