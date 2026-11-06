import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, knobNumber, knobObject, knobStrings, knobText, tickHours } from "../src/engine/config.js";
import { clamp01, initialSState, relaxDt, tick, idleTick, type SState } from "../src/engine/state.js";
import { resolveMode, thresholdsFrom, MODE_ORDER } from "../src/engine/modes.js";

const cfg = loadConfig();
const TH = thresholdsFrom(cfg);
const TAU = tickHours(cfg);

function steady(s: SState, opts: { gain?: number; si?: number; rounds?: number } = {}): SState {
  const { gain = 0, si = 0, rounds = 400 } = opts;
  for (let i = 0; i < rounds; i++) tick(s, { dtHours: TAU, pressureGain: gain, suppressionIntensity: si }, cfg);
  return s;
}

describe("§9.3 初值与 schema 对齐", () => {
  it("13 项，含 rumination 与 taint_map", () => {
    const s = initialSState();
    expect(Object.keys(s).sort()).toEqual(
      [
        "affection", "arousal", "dissonance", "energy", "entropy", "jealousy", "maskIntegrity",
        "pressure", "rumination", "suppressionLoad", "taintMap", "trust", "valence",
      ].sort(),
    );
    expect(s.valence).toBe(0.5);
    expect(s.entropy).toBe(0.2);
    expect(s.dissonance).toBe(0.1);
    expect(s.rumination).toBe(0);
    expect(s.taintMap).toEqual({});
  });
});

describe("§4.5 pressure 稳态 p* = baseline + gain/κ（INV-7：只有一条衰减）", () => {
  it("无刺激时精确回到 baseline 0.2（不是 0.0882）", () => {
    const s = steady(initialSState());
    expect(s.pressure).toBeCloseTo(0.2, 12);
  });

  it("g=0.05 → 0.2909 / g=0.3 → 0.7455 / g=0.7 → 打顶 1.0", () => {
    expect(steady(initialSState(), { gain: 0.05 }).pressure).toBeCloseTo(0.29091, 4);
    expect(steady(initialSState(), { gain: 0.3 }).pressure).toBeCloseTo(0.745455, 5);
    expect(steady(initialSState(), { gain: 0.7 }).pressure).toBeCloseTo(1, 12);
  });

  it("impulse：第 1 轮 0.900 且 DEFENSE，第 2 轮 0.515 回 NORMAL（先松弛后加 gain 的指纹）", () => {
    const s = initialSState();
    tick(s, { dtHours: TAU, pressureGain: 0.7 }, cfg);
    expect(s.pressure).toBeCloseTo(0.9, 12);
    expect(resolveMode(s, TH)).toBe("DEFENSE");
    tick(s, { dtHours: TAU }, cfg);
    expect(s.pressure).toBeCloseTo(0.515, 12);
    expect(resolveMode(s, TH)).toBe("NORMAL");
  });

  it("松弛带 dt 换算：单步 1h ≡ 12×5min（差 < 1e-12）", () => {
    const a = relaxDt(0.9, 0.2, 0.55, 1, 0.005, TAU);
    let b = 0.9;
    for (let i = 0; i < 12; i++) b = relaxDt(b, 0.2, 0.55, TAU, 0.005, TAU);
    expect(Math.abs(a - b)).toBeLessThan(1e-12);
  });
});

describe("§4.7 suppression：s* = 0.1 + 0.15/0.2 = 0.85", () => {
  it("si=1 收敛到 0.85 / mask 0.15", () => {
    const s = steady(initialSState(), { si: 1 });
    expect(s.suppressionLoad).toBeCloseTo(0.85, 6);
    expect(s.maskIntegrity).toBeCloseTo(0.15, 6);
  });

  it("第 6 轮 mask 跌破 0.35 并触发 BREAK（需 si=1 且 gain=0.7 双驱动）", () => {
    const s = initialSState();
    let hit = 0;
    for (let i = 1; i <= 20; i++) {
      tick(s, { dtHours: TAU, pressureGain: 0.7, suppressionIntensity: 1 }, cfg);
      if (resolveMode(s, TH) === "BREAK") { hit = i; break; }
    }
    expect(hit).toBe(6);
    expect(s.maskIntegrity).toBeCloseTo(0.3466, 3);
  });

  it("只给 si 不给 gain 时 pressure 恒 0.2 → BREAK 永不可达（夹具必须双驱动）", () => {
    const s = initialSState();
    for (let i = 0; i < 20; i++) tick(s, { dtHours: TAU, suppressionIntensity: 1 }, cfg);
    expect(s.pressure).toBeCloseTo(0.2, 12);
    expect(resolveMode(s, TH)).not.toBe("BREAK");
  });
});

describe("§4.5 energy：LAZY 第 8 轮、清醒单轮不恢复", () => {
  it("si=1 持续时 8 轮跌到 0.2 以下（含 A 毛值 1.04/h）", () => {
    const s = initialSState();
    let round = 0;
    for (let i = 1; i < 200; i++) {
      tick(s, { dtHours: TAU, suppressionIntensity: 1 }, cfg);
      if (s.energy < 0.2) { round = i; break; }
    }
    expect(round).toBe(8);
    expect(resolveMode(s, TH)).toBe("LAZY");
  });

  it("energy=0.18 时清醒单轮净耗能，仍 LAZY（v2.2 A 生效）", () => {
    const s = initialSState();
    s.energy = 0.18;
    tick(s, { dtHours: TAU }, cfg);
    // 每拍 +1.0/12（恢复）−1.04/12（A）= −0.003333，落回 0.176667
    expect(s.energy).toBeCloseTo(0.1766666667, 10);
    expect(s.energy).toBeLessThan(0.2);
    expect(resolveMode(s, TH)).toBe("LAZY");
  });
});

describe("§4.5 情绪信号：绝对锚定 EMA（有界、可回落）", () => {
  it("joy=0.8 收敛到 valence 0.74 / arousal 0.54；撤掉输入回 0.5 / 0.3", () => {
    const s = initialSState();
    for (let i = 0; i < 60; i++) tick(s, { dtHours: TAU, emotions: { joy: 0.8 } }, cfg);
    expect(s.valence).toBeCloseTo(0.74, 3);
    expect(s.arousal).toBeCloseTo(0.54, 3);
    for (let i = 0; i < 60; i++) tick(s, { dtHours: TAU }, cfg);
    expect(s.valence).toBeCloseTo(0.5, 3);
    expect(s.arousal).toBeCloseTo(0.3, 3);
  });

  it("有界：joy=1.0 连续 500 轮的极限是锚点+刻度=0.80，不会正反馈打顶", () => {
    const s = initialSState();
    for (let i = 0; i < 500; i++) tick(s, { dtHours: TAU, emotions: { joy: 1 } }, cfg);
    expect(s.valence).toBeCloseTo(0.8, 6);
    expect(s.arousal).toBeCloseTo(0.6, 6);
  });
});

describe("§4.6 OBSESSION：entropy 第 4 轮、valence 第 4 轮、交集第 4 轮", () => {
  it("shame=surprise=1.0 驱动", () => {
    const s = initialSState();
    let eR = 0, vR = 0, both = 0;
    for (let i = 1; i <= 30; i++) {
      tick(s, { dtHours: TAU, emotions: { shame: 1, surprise: 1 } }, cfg);
      if (eR === 0 && s.entropy > 0.75) eR = i;
      if (vR === 0 && s.valence < 0.3) vR = i;
      if (both === 0 && s.entropy > 0.75 && s.valence < 0.3) both = i;
    }
    expect([eR, vR, both]).toEqual([4, 4, 4]);
    expect(resolveMode(s, TH)).toBe("OBSESSION");
  });
});

describe("§4.6 优先级与阈值真源", () => {
  it("LAZY 先于 OVERDRIVE（能量耗尽压过高唤醒）", () => {
    const s = initialSState();
    s.energy = 0.1;
    s.valence = 0.9;
    s.arousal = 0.9;
    expect(resolveMode(s, TH)).toBe("LAZY");
    expect(MODE_ORDER.indexOf("LAZY")).toBeLessThan(MODE_ORDER.indexOf("OVERDRIVE"));
  });

  it("阈值只有一份：注册表 MODE_THRESHOLDS 与 meta.modeThresholds 完全相同", () => {
    expect(knobObject<Record<string, number>>(cfg, "MODE_THRESHOLDS")).toEqual(cfg.meta.modeThresholds);
    expect(TH.breakMaskMax).toBe(cfg.meta.modeThresholds.break_mask_max);
  });

  it("OVERDRIVE 可达：valence>0.75 且 arousal>0.70", () => {
    const s = initialSState();
    s.valence = 0.9;
    s.arousal = 0.8;
    expect(resolveMode(s, TH)).toBe("OVERDRIVE");
  });
});

describe("注册表接入：不出现裸数字、不留静默默认", () => {
  it("附录 A 93 项 + v5.4 overlay（63 键，1 个 text 占位被结构化替换），计数三方一致", () => {
    // v5.4-P1 S0：overlay 只加不覆盖，唯一的例外是把 EMOTION_DYNAMICS 的 text 占位补成结构化值，
    // 所以总数 = 93 + 63 − 1 = 155（overlay 63 键 = v5.4-P1 的 23 键 + 内部言语 7 键 + 视频深读 4 键
    // + BOND_DRIVE_ZERO + 时间观 P2a 的 8 个 RHYTHM_* + P3-2a 的 6 个 ENERGY_* 与 3 个 SLEEP_*
    // + P3-3 的 ENERGY_COST_LEARN_DEEP + W1 的 6 个 WEB_* + 回声室 A.15 的 3 个 ECHO_*
    // + 2026-11 社交主动性的 ENERGY_COST_SOCIAL），
    // 而 meta.counts 描述的仍是 engine.json 基线（93）。
    expect(Object.keys(cfg.knobs).length).toBe(155);
    expect(cfg.meta.counts.total).toBe(93);
    expect(cfg.meta.counts.hot).toBe(18);
    expect(cfg.meta.counts.perArchetype).toBe(10);
    expect(cfg.meta.counts.perArchetype).toBeLessThanOrEqual(40);
  });

  it("kind 不对就抛错：text 型不能当数字取", () => {
    expect(() => knobNumber(cfg, "STATE_INIT")).toThrow(/kind/);
    expect(() => knobNumber(cfg, "no_such_knob")).toThrow(/未注册/);
    expect(knobText(cfg, "STATE_INIT")).toContain("§9.3");
  });

  it("字符串集合型：UNTRUSTED_SOURCES", () => {
    expect(knobStrings(cfg, "UNTRUSTED_SOURCES")).toContain("web");
    expect(() => knobNumber(cfg, "UNTRUSTED_SOURCES")).toThrow(/kind/);
  });

  it("TICK_HOURS 来自 meta.supplemental（1/12 h）", () => {
    expect(TAU).toBeCloseTo(1 / 12, 12);
  });
});

describe("INV-7：src/engine 里不得出现第二条衰减路径", () => {
  const dir = join(process.cwd(), "src", "engine");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("没有 decay_rate / suppression_self_decay 常量副本", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, `${f} 出现了 decay_rate`).not.toMatch(/decay_rate/i);
      expect(src, `${f} 出现了 suppression_self_decay`).not.toMatch(/suppression_self_decay/i);
    }
  });

  it("Math.exp 只允许出现在被 INV7-EXEMPT 标记的零基线衰减函数里", () => {
    for (const f of files) {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("Math.exp(")) return;
        const near = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
        expect(near, `${f}:${i + 1} Math.exp 未标 INV7-EXEMPT`).toContain("INV7-EXEMPT");
      });
    }
  });
});

describe("clamp01", () => {
  it("夹取到 [0,1]", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it("idleTick 等价于零输入 tick", () => {
    const a = initialSState();
    const b = initialSState();
    idleTick(a, TAU, cfg);
    tick(b, { dtHours: TAU }, cfg);
    expect(a.pressure).toBeCloseTo(b.pressure, 15);
  });
});
