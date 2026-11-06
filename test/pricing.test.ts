import { describe, expect, it } from "vitest";

import {
  deepseekPhase,
  isRestDay,
  pacingFor,
  parseHolidayList,
  rateAlert,
  scaledIntervalMs,
} from "../src/autonomy/pricing.js";

const BJ = 480;
/** 北京时间某日 hh:mm → 毫秒时间戳 */
function bj(day: string, hh: number, mm: number): number {
  return Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
}

describe("峰谷时段", () => {
  it("工作日 09:00–12:00 与 14:00–18:00（北京）为峰时，其余为谷时（边界都测到）", () => {
    const d = "2026-10-29"; // 周四
    expect(deepseekPhase({ now: bj(d, 8, 59), tzOffsetMinutes: BJ })).toBe("offpeak");
    expect(deepseekPhase({ now: bj(d, 9, 0), tzOffsetMinutes: BJ })).toBe("peak");
    expect(deepseekPhase({ now: bj(d, 11, 59), tzOffsetMinutes: BJ })).toBe("peak");
    expect(deepseekPhase({ now: bj(d, 12, 0), tzOffsetMinutes: BJ })).toBe("offpeak");
    expect(deepseekPhase({ now: bj(d, 13, 59), tzOffsetMinutes: BJ })).toBe("offpeak");
    expect(deepseekPhase({ now: bj(d, 14, 0), tzOffsetMinutes: BJ })).toBe("peak");
    expect(deepseekPhase({ now: bj(d, 17, 59), tzOffsetMinutes: BJ })).toBe("peak");
    expect(deepseekPhase({ now: bj(d, 18, 0), tzOffsetMinutes: BJ })).toBe("offpeak");
    expect(deepseekPhase({ now: bj(d, 3, 0), tzOffsetMinutes: BJ })).toBe("offpeak");
  });

  it("不传时区时按东八区算", () => {
    expect(deepseekPhase({ now: bj("2026-10-29", 3, 0) })).toBe("offpeak");
    expect(deepseekPhase({ now: bj("2026-10-29", 10, 0) })).toBe("peak");
  });

  it("休息日全天算谷时（官方：周末与法定节假日全谷时）", () => {
    expect(deepseekPhase({ now: bj("2026-10-31", 10, 0), tzOffsetMinutes: BJ, restDay: true })).toBe("offpeak");
    expect(deepseekPhase({ now: bj("2026-10-29", 10, 0), tzOffsetMinutes: BJ, restDay: true })).toBe("offpeak");
  });
});

describe("节奏缩放", () => {
  it("谷时更密、峰时更稀；休息日再密一档", () => {
    const peakAt = bj("2026-10-29", 10, 0);
    const offAt = bj("2026-10-29", 3, 0);
    const peak = pacingFor({ now: peakAt });
    const off = pacingFor({ now: offAt });
    const rest = pacingFor({ now: offAt, restDay: true });
    expect(off.intervalScale).toBeLessThan(peak.intervalScale);
    expect(rest.intervalScale).toBeLessThan(off.intervalScale);
    expect(off.maxCallsPerHour).toBeGreaterThan(peak.maxCallsPerHour);
    expect(pacingFor({ now: peakAt, restDay: true }).maxCallsPerHour).toBeGreaterThan(peak.maxCallsPerHour);
  });

  it("新 cap 不再比 API 严两个数量级（F353：峰 30/h、谷 60/h、休息日 ×1.5）", () => {
    expect(pacingFor({ now: bj("2026-10-29", 10, 0) }).maxCallsPerHour).toBe(30);
    expect(pacingFor({ now: bj("2026-10-29", 3, 0) }).maxCallsPerHour).toBe(60);
    expect(pacingFor({ now: bj("2026-10-31", 3, 0), restDay: true }).maxCallsPerHour).toBe(90);
  });

  it("缩放后的间隔仍夹在 5 分钟–3 小时", () => {
    const tight = scaledIntervalMs(60_000, pacingFor({ now: bj("2026-10-29", 3, 0), restDay: true }));
    const loose = scaledIntervalMs(100 * 3_600_000, pacingFor({ now: bj("2026-10-29", 10, 0) }));
    expect(tight).toBeGreaterThanOrEqual(300_000);
    expect(loose).toBeLessThanOrEqual(10_800_000);
  });
});

describe("频率审核", () => {
  it("达到上限就报（cap 是硬上限）；未到不报；超了退避并写原因", () => {
    const p = pacingFor({ now: bj("2026-10-29", 3, 0) });
    expect(rateAlert(0, p).alert).toBe(false);
    expect(rateAlert(p.maxCallsPerHour - 1, p).alert).toBe(false);
    // 已用满 cap 次：下一次不能再放行（旧实现 <= 会放行 cap+1，2026-11-02 F328 修）
    const atCap = rateAlert(p.maxCallsPerHour, p);
    expect(atCap.alert).toBe(true);
    expect(atCap.backoffScale).toBeGreaterThan(1);
    expect(atCap.reason).toContain("退避");
    expect(atCap.reason).toContain(">=");
    expect(rateAlert(p.maxCallsPerHour + 1, p).alert).toBe(true);
  });
});

describe("休息日与节假日表", () => {
  it("周末算休息日，工作日不算", () => {
    expect(isRestDay("2026-10-31")).toBe(true); // 周六
    expect(isRestDay("2026-11-01")).toBe(true); // 周日
    expect(isRestDay("2026-10-29")).toBe(false); // 周四
  });

  it("节假日表补上工作日，解析时忽略空行/注释/坏行", () => {
    const list = parseHolidayList("# 2026 法定节假日\n2026-10-01\n\nnot-a-date\n2026-10-29\n");
    expect(list).toEqual(["2026-10-01", "2026-10-29"]);
    expect(isRestDay("2026-10-29", list)).toBe(true);
  });

  it("调休上班日覆盖周末：周末被调成工作日就不算休息日", () => {
    // 2026-02-14、2026-02-28 是春节调休上班（周六）；2026-09-20 国庆调休（周日）
    expect(isRestDay("2026-02-14", [], ["2026-02-14"])).toBe(false);
    expect(isRestDay("2026-09-20", [], ["2026-09-20"])).toBe(false);
    // 不在调休表里就照旧按周末算
    expect(isRestDay("2026-02-21", [], ["2026-02-14"])).toBe(true);
    // 调休优先级高于节假日表（同一天两张表都写错时，按上班处理，避免假装放假）
    expect(isRestDay("2026-02-14", ["2026-02-14"], ["2026-02-14"])).toBe(false);
  });
});
