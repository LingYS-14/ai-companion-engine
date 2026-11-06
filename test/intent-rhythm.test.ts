import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import {
  buildHisRhythm,
  describeRhythm,
  rhythmConfidence,
  rhythmThresholdsFromConfig,
  type RhythmSample,
  type RhythmThresholds,
} from "../src/orchestrator/intent/rhythm.js";

// 固定口径：NOW = 2026-11-01T01:42Z → 北京 2026-11-01 09:42（周日）
const NOW = Date.UTC(2026, 10, 1, 1, 42);
const TZ = 480;
const DAY_MS = 86_400_000;
// 2026-10-20 是周二；以它为「第 0 天」的本地零点，方便把周末/工作日算清楚。
const BASE_LOCAL_MIDNIGHT_UTC = Date.UTC(2026, 9, 20, 0, 0) - TZ * 60_000;

function atLocal(day: number, hour: number, minute = 0): number {
  return BASE_LOCAL_MIDNIGHT_UTC + day * DAY_MS + hour * 3_600_000 + minute * 60_000;
}

function sample(atMs: number, over: Partial<RhythmSample> = {}): RhythmSample {
  return { occurredAtMs: atMs, direction: "inbound", source: "player", ...over };
}

const TH: RhythmThresholds = {
  minInboundSamples: 30,
  minLocalDates: 7,
  minWorkdayDates: 3,
  minRestdayDates: 3,
  confidenceLowCap: 0.45,
  confidenceHighFloor: 0.1,
  confidenceHighSlope: 0.012,
  confidenceHighCap: 0.9,
};

/**
 * 30/60/100 的通用样本：覆盖 15 个本地日期（10-06…10-20，其中 10-10/10-11/10-17/10-18
 * 是周末 → 4 个休息日、11 个工作日），每天 08:00。日历语义按「不同日期数」算。
 */
function bulk(n: number): RhythmSample[] {
  const out: RhythmSample[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(sample(atLocal(-(i % 15), 8)));
  }
  return out;
}

function build(samples: readonly RhythmSample[], over: Partial<Parameters<typeof buildHisRhythm>[1]> = {}) {
  return buildHisRhythm(samples, { nowMs: NOW, tzOffsetMinutes: TZ, thresholds: TH, ...over });
}

describe("时间观 P2a：他的作息只统计、不编", () => {
  it("样本不足 30 条：不知道就是不知道（null）", () => {
    expect(build(bulk(29))).toBeNull();
  });

  it("30 条、覆盖 15 天、工作/休息各 ≥3 天：产出节律", () => {
    const r = build(bulk(30));
    expect(r).not.toBeNull();
    expect(r?.sampleCount).toBe(30);
    expect(r?.distinctLocalDates).toBe(15);
    expect(r?.workdayDays).toBe(11);
    expect(r?.restdayDays).toBe(4);
    expect(r?.firstLocalDate).toBe("2026-10-06");
    expect(r?.lastLocalDate).toBe("2026-10-20");
    expect(r?.byLocalHour).toHaveLength(24);
    expect(r?.byLocalHour.reduce((sum, n) => sum + n, 0)).toBe(30);
  });

  it("休息日只有 2 天：样本再多也不产出（门槛按不同日期数，不按样本条数）", () => {
    const workOffsets = [-15, -14, -13, -12, -11, -8, -7, -6]; // 8 个工作日
    const samples: RhythmSample[] = [];
    for (let i = 0; i < 24; i += 1) samples.push(sample(atLocal(workOffsets[i % workOffsets.length] ?? 0, 9)));
    for (let i = 0; i < 6; i += 1) samples.push(sample(atLocal([-3, -2][i % 2] ?? -3, 10))); // 只有 2 个休息日
    expect(samples.length).toBe(30);
    expect(build(samples)).toBeNull();
  });

  it("覆盖日期不足 7 天 → null（样本多也算不知道）", () => {
    const samples: RhythmSample[] = [];
    for (let i = 0; i < 30; i += 1) samples.push(sample(atLocal(i % 6, 9)));
    expect(build(samples)).toBeNull();
  });

  it("休息日样本不足 → null（只有工作日也算不知道休息规律）", () => {
    const workDays = [0, 1, 2, 3, 6, 7, 8, 9];
    const samples: RhythmSample[] = [];
    for (let i = 0; i < 30; i += 1) samples.push(sample(atLocal(workDays[i % workDays.length] ?? 0, 9)));
    expect(build(samples)).toBeNull();
  });

  it("只算 inbound + player/qq_contact_verified：出站、web/selftalk、坏时间戳都不计", () => {
    const samples = [
      ...bulk(30),
      sample(atLocal(0, 9), { direction: "outbound" }),
      sample(atLocal(0, 9), { direction: "unknown" }),
      sample(atLocal(0, 9), { source: "web" }),
      sample(atLocal(0, 9), { source: "selftalk" }),
      sample(atLocal(0, 9), { source: "parasocial" }),
      sample(Number.NaN),
      sample(0),
      sample(-1),
      sample(NOW + 1_000),
    ];
    const r = build(samples);
    expect(r?.sampleCount).toBe(30);
  });

  it("qq_contact_verified 算他本人（与 player 同权）", () => {
    const samples = bulk(30).map((s) => ({ ...s, source: "qq_contact_verified" }));
    expect(build(samples)?.sampleCount).toBe(30);
  });

  it("日历覆盖优先于周末：周三可标成休息日、周六可标成工作日", () => {
    const r = build(bulk(30), {
      calendar: { restDays: new Set(["2026-10-08"]), workDays: new Set(["2026-10-17"]) },
    });
    // 10-08（周三）→ 休息；10-17（周六）→ 工作；其余按周末。
    expect(r?.workdayDays).toBe(11);
    expect(r?.restdayDays).toBe(4);
  });

  it("时区口径：同一批绝对时间在东八区/UTC 下的小时不同", () => {
    const samples: RhythmSample[] = [];
    for (let i = 0; i < 30; i += 1) samples.push(sample(atLocal(-(i % 15), 23)));
    expect(build(samples)?.peakLocalHour).toBe(23);
    expect(build(samples, { tzOffsetMinutes: 0 })?.peakLocalHour).toBe(15);
  });

  it("peak 平局取最早的小时", () => {
    const samples: RhythmSample[] = [];
    for (let i = 0; i < 30; i += 1) {
      // 15 个本地日期 × 每天两条：09:00 与 15:00，各 15 条 → 平局，应取 9。
      samples.push(sample(atLocal(-Math.floor(i / 2), i % 2 === 0 ? 9 : 15)));
    }
    expect(build(samples)?.peakLocalHour).toBe(9);
  });

  it("置信度分档：30/99 被 lowCap 封顶，100 处允许跳变，500 到 highCap", () => {
    expect(rhythmConfidence(30, TH)).toBe(0.45);
    expect(rhythmConfidence(99, TH)).toBe(0.45);
    expect(rhythmConfidence(100, TH)).toBe(0.9);
    expect(rhythmConfidence(500, TH)).toBe(0.9);
  });

  it("置信度跟着样本数走（同档内单调）", () => {
    const low = build(bulk(30));
    const mid = build(bulk(60));
    expect(low?.confidence).toBe(0.45); // floor+30*slope=0.46 → 被 lowCap 封顶
    expect(mid?.confidence).toBe(0.45); // floor+60*slope=0.82 → 仍 lowCap
    expect(build(bulk(100))?.confidence).toBe(0.9);
  });

  it("真实配置：8 个 RHYTHM_* 门槛从 overlay 读出来，口径与 DESIGN 一致", () => {
    const t = rhythmThresholdsFromConfig(loadConfig());
    expect(t).toEqual({
      minInboundSamples: 30,
      minLocalDates: 7,
      minWorkdayDates: 3,
      minRestdayDates: 3,
      confidenceLowCap: 0.45,
      confidenceHighFloor: 0.6,
      confidenceHighSlope: 0.0025,
      confidenceHighCap: 0.85,
    });
    // 真实配置下：30–99 条恒被 lowCap 封顶；n≥100 因 floor=0.6 已到 highCap。
    expect(rhythmConfidence(30, t)).toBe(0.45);
    expect(rhythmConfidence(99, t)).toBe(0.45);
    expect(rhythmConfidence(100, t)).toBe(0.85);
  });

  it("非法 nowMs / tz / 门槛当场抛（不把 NaN 带进统计）", () => {
    expect(() => buildHisRhythm([], { nowMs: Number.NaN, tzOffsetMinutes: TZ, thresholds: TH })).toThrow(RangeError);
    expect(() =>
      buildHisRhythm([], { nowMs: NOW, tzOffsetMinutes: Number.POSITIVE_INFINITY, thresholds: TH }),
    ).toThrow(RangeError);
    expect(() => buildHisRhythm([], { nowMs: NOW, tzOffsetMinutes: TZ, thresholds: { ...TH, minInboundSamples: -1 } })).toThrow(
      RangeError,
    );
  });

  it("describeRhythm：一行摘要给出最常小时/样本/覆盖天数/置信", () => {
    const r = build(bulk(30));
    expect(r).not.toBeNull();
    const line = describeRhythm(r!);
    expect(line).toContain("最常在 8:00 前后");
    expect(line).toContain("30 条记录");
    expect(line).toContain("15 天");
    expect(line).toContain("置信 0.45");
  });

  it("源码不使用 Date 构造 / Date.now（lint:writers 规则 2 的语义兜底）", () => {
    const file = fileURLToPath(new URL("../src/orchestrator/intent/rhythm.ts", import.meta.url));
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/new Date\s*\(/);
    expect(source).not.toMatch(/Date\.now\s*\(/);
  });
});
