import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import {
  bondDrive,
  bondDriveZero,
  deriveBondCurve,
  onRupture,
  pacingRates,
  rateForNextStage,
  STAGES,
  stageBands,
  stageOf,
  updateBondProgress,
  valenceAnchor,
  type Stage,
} from "../src/engine/bonds.js";

const cfg = loadConfig();
const bands = stageBands(cfg);
const rates = pacingRates(cfg);
/** A2 参数：锚点=情绪基线，零点=推进门槛（来自注册表，不在测试里写死） */
const A = valenceAnchor(cfg);
const Z = bondDriveZero(cfg);

/** 从 stranger 起、每轮 valence 恒定，推进到首次进入某档所需的轮数 */
function roundsToEnter(target: Stage, valence = 1): number {
  let p = 0;
  for (let n = 1; n <= 400; n++) {
    const stage = stageOf(p, bands);
    p = updateBondProgress(p, valence, rateForNextStage(stage, rates), A, Z);
    if (stageOf(p, bands) === target) return n;
  }
  return -1;
}

describe("§5.2 stage 判定：输入是 progress，不是曲线深度", () => {
  it("四档边界（右开区间，beloved 含 1.0）", () => {
    expect(stageOf(0, bands)).toBe("stranger");
    expect(stageOf(0.2499, bands)).toBe("stranger");
    expect(stageOf(0.25, bands)).toBe("familiar");
    expect(stageOf(0.5499, bands)).toBe("familiar");
    expect(stageOf(0.55, bands)).toBe("close");
    expect(stageOf(0.7999, bands)).toBe("close");
    expect(stageOf(0.8, bands)).toBe("beloved");
    expect(stageOf(1, bands)).toBe("beloved");
    expect(stageOf(1.7, bands)).toBe("beloved"); // 夹取而非静默 stranger
  });

  it("pacing 15/40/80：线性速率 × 分档，逐档命中", () => {
    expect(roundsToEnter("familiar")).toBe(15);
    expect(roundsToEnter("close")).toBe(40);
    expect(roundsToEnter("beloved")).toBe(80);
  });

  it("pacing_table 与 pacing_rate 自洽（F4）：每档速率 = 档宽 / 该档轮数", () => {
    const table = cfg.knobs["PACING_TABLE"]!.value as Record<string, number>;
    const widths = {
      shallow: bands.familiar[0] - bands.stranger[0],
      mid: bands.close[0] - bands.familiar[0],
      deep: bands.beloved[0] - bands.close[0],
    };
    const rounds = { shallow: table.familiar!, mid: table.close! - table.familiar!, deep: table.beloved! - table.close! };
    for (const key of ["shallow", "mid", "deep"] as const) {
      expect(rates[key]).toBeCloseTo(widths[key] / rounds[key], 3);
    }
  });

  it("负向 valence（< 零点）回退，且比推进慢一半", () => {
    const up = updateBondProgress(0.5, 1.0, 0.012, A, Z);
    const down = updateBondProgress(0.5, 0.0, 0.012, A, Z);
    expect(up - 0.5).toBeCloseTo(0.012, 6);
    expect(0.5 - down).toBeCloseTo(0.006, 6);
  });

  it("A2：锚点 valence 满速推进（平静不再等于不推进）", () => {
    expect(updateBondProgress(0.42, A, 0.012, A, Z)).toBeCloseTo(0.432, 12);
  });

  it("A2：零点是停止线，低于零点才倒退", () => {
    expect(updateBondProgress(0.42, Z, 0.012, A, Z)).toBeCloseTo(0.42, 12);
    expect(updateBondProgress(0.42, 0.2, 0.012, A, Z)).toBeLessThan(0.42);
  });

  it("A2：drive 归一化（A=锚点 → 1；Z=零点 → 0；两端夹取）", () => {
    expect(bondDrive(0.5, A, Z)).toBeCloseTo(1, 12);
    expect(bondDrive(0.45, A, Z)).toBeCloseTo(0.75, 12);
    expect(bondDrive(0.4, A, Z)).toBeCloseTo(0.5, 12);
    expect(bondDrive(0.35, A, Z)).toBeCloseTo(0.25, 12);
    expect(bondDrive(0.3, A, Z)).toBeCloseTo(0, 12);
    expect(bondDrive(0.2, A, Z)).toBeCloseTo(-0.5, 12);
    expect(bondDrive(0.1, A, Z)).toBeCloseTo(-1, 12);
    expect(bondDrive(0, A, Z)).toBeCloseTo(-1, 12);
  });

  it("A2：低 valence 下仍能按 15/40/80 的节奏推进", () => {
    expect(roundsToEnter("familiar", 0.45)).toBe(20);
    expect(roundsToEnter("familiar", 0.4)).toBe(30);
    expect(roundsToEnter("familiar", Z)).toBe(-1); // 零点不推进（400 轮内到不了）
  });

  it("非法参数抛错", () => {
    expect(() => bondDrive(Number.NaN, A, Z)).toThrow(RangeError);
    expect(() => bondDrive(A, Number.NaN, Z)).toThrow(RangeError);
    expect(() => bondDrive(A, Z, Number.NaN)).toThrow(RangeError);
    expect(() => bondDrive(A, A, A)).toThrow(RangeError); // 零点必须小于锚点
    expect(() => bondDrive(0.5, 0.5, 0.5)).toThrow(RangeError); // 零点必须小于锚点
  });

  it("progress 不会越界", () => {
    expect(updateBondProgress(0.999, 1, 0.05, A, Z)).toBe(1);
    expect(updateBondProgress(0.001, 0, 0.05, A, Z)).toBe(0);
  });
});

describe("§5.1 依恋：降级为表达层", () => {
  it("四象限映射", () => {
    expect(deriveBondCurve(0.2, 0.2)).toBe("secure");
    expect(deriveBondCurve(0.8, 0.2)).toBe("preoccupied");
    expect(deriveBondCurve(0.2, 0.8)).toBe("dismissive");
    expect(deriveBondCurve(0.8, 0.8)).toBe("fearful");
  });

  it("依恋类型不再影响可达档位：四种依恋都能走到 beloved", () => {
    for (const [anx, avo] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] as const) {
      expect(deriveBondCurve(anx, avo)).toBeTypeOf("string");
      expect(stageOf(0.95, bands)).toBe("beloved"); // 判定函数里没有依恋参数
    }
  });
});

describe("§5.2 破裂：progress×0.6 且一次最多掉一档", () => {
  it("beloved 破裂后最多退到 close", () => {
    const r = onRupture(0.85, "beloved", bands);
    expect(r.progress).toBeCloseTo(0.51, 6);
    expect(r.stage).toBe("close"); // 0.51 本应判 familiar，棘轮把它挡在 close
    expect(r.regressed).toBe(true);
  });

  it("close 破裂退到 familiar", () => {
    const r = onRupture(0.6, "close", bands);
    expect(r.stage).toBe("familiar");
  });

  it("stranger 破裂无档可掉", () => {
    const r = onRupture(0.1, "stranger", bands);
    expect(r.stage).toBe("stranger");
    expect(r.regressed).toBe(false);
  });

  it("stage 序列单调可用（indexOf 是棘轮实现的前提）", () => {
    expect([...STAGES]).toEqual(["stranger", "familiar", "close", "beloved"]);
  });
});
