/**
 * §5.4 人格漂移（双层判据 + 阻尼回 baseline）。
 *
 * 为什么值得一个测试文件：`classifyDrift` / `driftDelta` / `applyOceanDelta` 在
 * `src/learning/learn.ts` 里从 v5.3 就写好了，但**零调用点**（V52-GAP M5-06）。
 * 也就是说「她会慢慢变成另一个样子」这件事在代码里从来没发生过——人格卡永远是出生值。
 *
 * 这里守三条线：
 * 1. 慢：一晚只结一次账，单次步长被 MAGNITUDE_CAP.ocean（0.02）限死；
 * 2. 稳：证据不足时只往 baseline 拉，绝不因为一两句情绪改性格；
 * 3. 诚实：O/C 没有可信代理就不漂（不是漏了，是决定，见 drift.ts 文件头）。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { loadConfig } from "../src/engine/config.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import type { Persona } from "../src/ports/index.js";
import { buildTools } from "../src/plugin/tools.js";
import {
  DRIFT_DIMS,
  DRIFT_HISTORY_MIN,
  TRAIT_SAMPLE_MIN,
  baselineFrom,
  driftConfig,
  driftOffsets,
  estimateTraits,
  settleDrift,
  type DriftOcean,
  type DriftState,
  type TraitSample,
} from "../src/learning/drift.js";

const cfg = loadConfig();
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

/** 造一批样本：各维度固定，便于手算均值 */
function samples(n: number, s: Partial<Omit<TraitSample, "at">> = {}): TraitSample[] {
  return Array.from({ length: n }, (_, i) => ({
    at: NOW + i * 60_000,
    valence: s.valence ?? 0.5,
    arousal: s.arousal ?? 0.3,
    pressure: s.pressure ?? 0.2,
    rumination: s.rumination ?? 0,
  }));
}

/**
 * F326 方案 A：随包人格卡已删除，漂移 baseline 改为测试内固定的 OCEAN 质心。
 * 机制本身不变（漂移仍需 baseline）；这只是"出生值"来源从卡换成常量，
 * 回退 B 恢复卡时把这里换回 loadPersonaFile 即可。
 */
const OCEAN = { O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 } as const;
const BASELINE = baselineFrom(OCEAN);
/** F326 后没有随包卡；漂移测试只需要一个带 ocean 的 persona 载体。 */
const CARD = { name: "AI助手", description: "测试载体", personality: { ocean: OCEAN } } as unknown as Persona;

describe("estimateTraits：三个维度各自的代理", () => {
  it("A = valence 均值，E = arousal 均值，N = pressure 均值 + 0.5×rumination 均值", () => {
    const est = estimateTraits([
      { at: 0, valence: 0.6, arousal: 0.8, pressure: 0.2, rumination: 0 },
      { at: 1, valence: 0.4, arousal: 0.2, pressure: 0.4, rumination: 0.2 },
    ]);
    expect(est.A).toBeCloseTo(0.5, 10);
    expect(est.E).toBeCloseTo(0.5, 10);
    // pressure 均值 0.3，rumination 均值 0.1 → 0.3 + 0.05
    expect(est.N).toBeCloseTo(0.35, 10);
  });

  it("空样本 → 空表（不结账，不做 0 填充）", () => {
    expect(estimateTraits([])).toEqual({});
  });

  it("结果 clamp 在 [0,1]：极端样本不会算出 1.4", () => {
    const est = estimateTraits(samples(3, { pressure: 1, rumination: 1 }));
    expect(est.N).toBe(1);
  });
});

describe("settleDrift：证据不足只阻尼，不动人格", () => {
  it("少于 TRAIT_SAMPLE_MIN 条样本 → 全 NOISE 且值不动", () => {
    const state: DriftState = { ocean: BASELINE, history: { A: [], N: [], E: [] } };
    const r = settleDrift(BASELINE, state, samples(TRAIT_SAMPLE_MIN - 1, { valence: 1 }), cfg);
    expect(r.verdicts.A).toBe("NOISE");
    expect(r.ocean.A).toBeCloseTo(BASELINE.A, 12);
    expect(r.changed).toBe(false);
  });

  it("没有上次状态时从 baseline 起算（第一次结账不会突然改人格）", () => {
    const r = settleDrift(BASELINE, null, samples(TRAIT_SAMPLE_MIN + 4, { valence: 1, arousal: 1 }), cfg);
    // 历史只有 1 期 < DRIFT_HISTORY_MIN，所以仍是 NOISE
    expect(r.verdicts.A).toBe("NOISE");
    expect(r.ocean.A).toBeCloseTo(BASELINE.A, 12);
    expect(r.changed).toBe(false);
  });

  it("历史不够 DRIFT_HISTORY_MIN 期时不判签名级漂移（第一晚不改人格）", () => {
    let state: DriftState | null = null;
    // 连续 6 次高 valence 证据：第 1..6 次都还差一期
    for (let i = 0; i < DRIFT_HISTORY_MIN - 1; i += 1) {
      const r = settleDrift(BASELINE, state, samples(TRAIT_SAMPLE_MIN, { valence: 1 }), cfg);
      expect(r.verdicts.A).toBe("NOISE");
      state = { ocean: r.ocean, history: r.history };
    }
    expect(state?.history.A.length).toBe(DRIFT_HISTORY_MIN - 1);
  });

  it("连续 7 次同向证据 → 判 SIGNATURE_DRIFT，且单次步长被 MAGNITUDE_CAP.ocean 限死", () => {
    let last = settleDrift(BASELINE, null, samples(TRAIT_SAMPLE_MIN, { valence: 1 }), cfg);
    for (let i = 0; i < DRIFT_HISTORY_MIN - 1; i += 1) {
      last = settleDrift(
        BASELINE,
        { ocean: last.ocean, history: last.history },
        samples(TRAIT_SAMPLE_MIN, { valence: 1 }),
        cfg,
      );
    }
    // 第 7 期：classifyDrift 才第一次看到满窗的 7 个同号偏差
    expect(last.verdicts.A).toBe("SIGNATURE_DRIFT");
    // 前 6 次都是 NOISE（值没动），所以这一次的步长就是全部位移：必须 ≤ MAGNITUDE_CAP.ocean
    const step = last.ocean.A - BASELINE.A;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(0.02 + 1e-9);
  });

  it("判 NOISE 时把偏离往 baseline 拉（阻尼，不归零）", () => {
    const drifted: DriftState = {
      ocean: { ...BASELINE, A: BASELINE.A + 0.1 },
      // 7 期偏差全 0：EWMA=0 → NOISE
      history: { A: [0, 0, 0, 0, 0, 0, 0], N: [], E: [] },
    };
    const r = settleDrift(BASELINE, drifted, samples(TRAIT_SAMPLE_MIN, { valence: BASELINE.A }), cfg);
    expect(r.verdicts.A).toBe("NOISE");
    // raw = current - baseline = 0.1；step = -0.1 × DRIFT_DAMPING_RATE(0.02) = -0.002
    expect(r.ocean.A - drifted.ocean.A).toBeCloseTo(-0.002, 6);
    expect(r.changed).toBe(true);
    expect(r.note).toMatch(/A-0\.002/);
  });

  it("方向震荡（EWMA 够但一致性不够）→ OSCILLATION，同样只阻尼", () => {
    const drifted: DriftState = {
      ocean: { ...BASELINE, A: BASELINE.A + 0.1 },
      // 4 正 3 负（含本期 dev）：一致性 4/7 < 0.7，但 EWMA 够大 → OSCILLATION
      history: { A: [0.9, 0.9, 0.9, -0.1, -0.1, -0.1], N: [], E: [] },
    };
    const r = settleDrift(BASELINE, drifted, samples(TRAIT_SAMPLE_MIN, { valence: 1 }), cfg);
    expect(r.verdicts.A).toBe("OSCILLATION");
    expect(r.ocean.A).toBeLessThan(drifted.ocean.A);
  });

  it("history 只保留最近 DRIFT_HISTORY_MIN 期", () => {
    let last = settleDrift(BASELINE, null, samples(TRAIT_SAMPLE_MIN), cfg);
    for (let i = 0; i < 10; i += 1) {
      last = settleDrift(BASELINE, { ocean: last.ocean, history: last.history }, samples(TRAIT_SAMPLE_MIN), cfg);
    }
    for (const dim of DRIFT_DIMS) expect(last.history[dim].length).toBe(DRIFT_HISTORY_MIN);
  });
});

describe("纯工具函数", () => {
  it("baselineFrom 只投影 A/N/E 并 clamp", () => {
    expect(baselineFrom({ O: 1, C: 1, E: 0.5, A: 0.2, N: 1.4 })).toEqual({ A: 0.2, N: 1, E: 0.5 });
  });

  it("driftOffsets 给出相对 baseline 的偏离（面板显示用）", () => {
    const off = driftOffsets({ A: 0.5, N: 0.3, E: 0.6 }, { A: 0.52, N: 0.29, E: 0.6 });
    expect(off.A).toBeCloseTo(0.02, 10);
    expect(off.N).toBeCloseTo(-0.01, 10);
    expect(off.E).toBe(0);
  });

  it("driftConfig 从注册表读三个阈值（缺失就抛，不静默用默认）", () => {
    const c = driftConfig(cfg);
    expect(c.ewma).toBeCloseTo(0.15, 10);
    expect(c.consistency).toBeCloseTo(0.7, 10);
    expect(c.damping).toBeCloseTo(0.02, 10);
  });
});

const APPRAISAL = {
  goal_congruence: 0.5,
  goal_relevance: 0.5,
  coping_potential: 0.8,
  novelty: 0.2,
  legitimacy: 0.8,
};

describe("SoulRuntime：真对话里攒证据、睡眠时结账", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-drift-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false, persona: CARD };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("配了人格卡：每回合记一条行为证据，且真的落盘", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < 3; i += 1) {
      rt.turn({ text: `第 ${String(i)} 句`, appraisal: APPRAISAL }, { skipMemory: true });
    }
    const raw = JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as {
      traitSamples?: readonly TraitSample[];
    };
    expect(raw.traitSamples?.length).toBe(3);
    expect(raw.traitSamples?.[0]?.at).toBe(NOW);
  });

  it("没配人格卡：不记样本（没有 baseline，记了也没意义）", async () => {
    const plain = { characterId: "test", dataDir: dir, trace: false };
    const rt = await SoulRuntime.open(plain, clock);
    rt.turn({ text: "随便说句", appraisal: APPRAISAL }, { skipMemory: true });
    const raw = JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as {
      traitSamples?: readonly TraitSample[];
    };
    expect(raw.traitSamples ?? []).toEqual([]);
  });

  it("样本与 drift 能跨重启读回（不把一天证据丢在内存里）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < TRAIT_SAMPLE_MIN; i += 1) {
      rt.turn({ text: `第 ${String(i)} 句`, appraisal: APPRAISAL }, { skipMemory: true });
    }
    const reopened = await SoulRuntime.open(conf, clock);
    const out = reopened.consolidate();
    // 历史不足 7 期 → 这一晚不会漂，但结账过程不该抛、也不该把样本吃掉
    expect(out.drift).toBeUndefined();
    const raw = JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as {
      traitSamples?: readonly TraitSample[];
    };
    expect(raw.traitSamples?.length).toBe(TRAIT_SAMPLE_MIN);
  });
});

describe("只读出口：面板与 soul_state 看得见漂移（F148 遗留）", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-drift-out-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false, persona: CARD };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("7 晚结账后 snapshot 带 drift，soul_state 打印相对出生值的偏移", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    for (let night = 0; night < DRIFT_HISTORY_MIN; night += 1) {
      for (let i = 0; i < TRAIT_SAMPLE_MIN; i += 1) {
        rt.turn({ text: `第${String(night)}-${String(i)}句`, appraisal: APPRAISAL }, { skipMemory: true });
      }
      rt.consolidate();
    }
    const snap = rt.snapshot() as { drift?: { ocean: DriftOcean; samples: number } };
    expect(snap.drift).toBeDefined();
    // 漂过之后 E（外向，代理是 arousal）应低于出生值：限幅一次 0.02
    expect(snap.drift?.ocean.E).toBeLessThan(BASELINE.E - 0.01);
    expect(snap.drift?.samples).toBeGreaterThan(0);

    const tools = buildTools(rt);
    const stateTool = tools.find((t) => t.name === "soul_state");
    const out = String(await stateTool?.execute({}));
    expect(out).toContain("人格漂移：");
    expect(out).toContain("E-");
  });

  it("没有人格卡：soul_state 不打印漂移（不拿 0 冒充没变）", async () => {
    const plain: SoulConfig = { characterId: "test", dataDir: dir, trace: false };
    const rt = await SoulRuntime.open(plain, clock);
    const tools = buildTools(rt);
    const out = String(await tools.find((t) => t.name === "soul_state")?.execute({}));
    expect(out).not.toContain("人格漂移");
  });
});
