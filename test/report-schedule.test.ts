import { describe, expect, it } from "vitest";

import { localHourOf, reportPaths, shouldGenerateReport } from "../src/autonomy/report-schedule.js";

const HOUR = 3_600_000;
// 2026-10-30T22:00:00Z = 本地 2026-10-30 06:00（+08:00）
const SIX_AM = Date.UTC(2026, 9, 29, 22, 0, 0);

describe("早报生成时机", () => {
  it("本地 6 点、今天还没生成过 → 该生成", () => {
    expect(localHourOf(SIX_AM, 480)).toBe(6);
    expect(shouldGenerateReport({ now: SIX_AM, tzOffsetMinutes: 480, generatedDay: null })).toBe(true);
  });

  it("今天已经生成过 → 不重复生成", () => {
    expect(shouldGenerateReport({ now: SIX_AM, tzOffsetMinutes: 480, generatedDay: "2026-10-30" })).toBe(false);
  });

  it("不在 6 点 → 不生成（哪怕今天没生成过）", () => {
    expect(shouldGenerateReport({ now: SIX_AM + 2 * HOUR, tzOffsetMinutes: 480, generatedDay: null })).toBe(false);
    expect(shouldGenerateReport({ now: SIX_AM - HOUR, tzOffsetMinutes: 480, generatedDay: null })).toBe(false);
  });

  it("跨日与 UTC 都算对：UTC 6 点在世界时区也成立", () => {
    const utcSix = Date.UTC(2026, 9, 30, 6, 0, 0);
    expect(localHourOf(utcSix, 0)).toBe(6);
    expect(shouldGenerateReport({ now: utcSix, tzOffsetMinutes: 0, generatedDay: null })).toBe(true);
  });

  it("路径按本地日期分文件", () => {
    const paths = reportPaths("data", "docs", SIX_AM, 480);
    expect(paths.day).toBe("2026-10-30");
    expect(paths.report).toBe("docs/MORNING-REPORT-2026-10-30.md");
    expect(paths.marker).toBe("data/.report-2026-10-30.done");
  });
});
