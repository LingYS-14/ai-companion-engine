// 一次性数值探针：从构建产物取真实 tick 行为，用来写测试断言（不进 CI）
import { loadConfig } from "../dist/engine/config.js";
import { initialSState, tick, idleTick } from "../dist/engine/state.js";
import { resolveMode, thresholdsFrom } from "../dist/engine/modes.js";

const cfg = loadConfig();
const th = thresholdsFrom(cfg);
const p = (x) => Number(x.toFixed(6));

// idle
let s = initialSState();
for (let i = 0; i < 200; i++) idleTick(s, 1 / 12, cfg);
console.log("idle p", p(s.pressure), "mask", p(s.maskIntegrity));

// sustained gain 0.3
s = initialSState();
for (let i = 0; i < 400; i++) tick(s, { dtHours: 1 / 12, pressureGain: 0.3 }, cfg);
console.log("sustained 0.3 p", p(s.pressure));

// impulse
s = initialSState();
tick(s, { dtHours: 1 / 12, pressureGain: 0.7 }, cfg);
console.log("impulse r1", p(s.pressure), resolveMode(s, th));
tick(s, { dtHours: 1 / 12 }, cfg);
console.log("impulse r2", p(s.pressure), resolveMode(s, th));

// BREAK
s = initialSState();
for (let i = 1; i <= 20; i++) {
  tick(s, { dtHours: 1 / 12, pressureGain: 0.7, suppressionIntensity: 1 }, cfg);
  if (resolveMode(s, th) === "BREAK") { console.log("BREAK round", i, "mask", p(s.maskIntegrity), "p", p(s.pressure)); break; }
}

// OBSESSION
s = initialSState();
let eR = 0, vR = 0, both = 0;
for (let i = 1; i <= 30; i++) {
  tick(s, { dtHours: 1 / 12, emotions: { shame: 1, surprise: 1 } }, cfg);
  if (!eR && s.entropy > 0.75) eR = i;
  if (!vR && s.valence < 0.3) vR = i;
  if (!both && s.entropy > 0.75 && s.valence < 0.3) both = i;
}
console.log("OBSESSION entropy", eR, "valence", vR, "both", both, "e4", p(s.entropy));

// LAZY
s = initialSState();
let lazy = 0;
for (let i = 1; i < 200; i++) {
  tick(s, { dtHours: 1 / 12, suppressionIntensity: 1 }, cfg);
  if (s.energy < 0.2) { lazy = i; break; }
}
console.log("LAZY round", lazy, "energy", s.energy);
s = initialSState(); s.energy = 0.18;
tick(s, { dtHours: 1 / 12 }, cfg);
console.log("recover 1 round energy", p(s.energy));

// valence 收敛/回落
s = initialSState();
for (let i = 0; i < 60; i++) tick(s, { dtHours: 1 / 12, emotions: { joy: 0.8 } }, cfg);
console.log("valence saturated", p(s.valence), "arousal", p(s.arousal));
for (let i = 0; i < 60; i++) tick(s, { dtHours: 1 / 12 }, cfg);
console.log("valence back", p(s.valence), "arousal", p(s.arousal));

// suppression
s = initialSState();
for (let i = 1; i <= 12; i++) {
  tick(s, { dtHours: 1 / 12, suppressionIntensity: 1 }, cfg);
  if (i === 8 || i === 12) console.log("s@" + i, p(s.suppressionLoad), "mask", p(s.maskIntegrity));
}

// dt invariance：12x5min vs 1x1h（无输入）
const a = initialSState(); a.pressure = 0.9;
const b = initialSState(); b.pressure = 0.9;
for (let i = 0; i < 12; i++) idleTick(a, 1 / 12, cfg);
idleTick(b, 1, cfg);
console.log("dt invariance", a.pressure, b.pressure, Math.abs(a.pressure - b.pressure));
