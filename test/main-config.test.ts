import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOG_ROTATE_BYTES,
  appendRuntimeLog,
  dataFile,
  loadEnvFile,
  localPartsOf,
  readHolidayFile,
  readOneBotConfig,
  readWorkdayFile,
} from "../src/assembly/main-config.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "ase-main-config-"));

describe("常驻入口的引导件（F278）", () => {
  it("写日志：带 ISO 时间戳、返回同一行、可以关掉 stdout 回显", () => {
    const logPath = join(dir(), "a.log");
    const text = appendRuntimeLog({
      logPath,
      line: "[autonomy] 测试",
      nowMs: Date.UTC(2026, 10, 1, 1, 2, 3),
      echo: false,
    });
    expect(text).toBe("2026-11-01T01:02:03Z [autonomy] 测试");
    expect(readFileSync(logPath, "utf8")).toBe(`${text}\n`);
  });

  it("写日志：超过 2MB 先轮转成 .1，新行进新文件", () => {
    const root = dir();
    const logPath = join(root, "a.log");
    writeFileSync(logPath, "x".repeat(LOG_ROTATE_BYTES + 1), "utf8");
    appendRuntimeLog({ logPath, line: "新的一行", nowMs: Date.UTC(2026, 10, 1), echo: false });
    expect(readFileSync(`${logPath}.1`, "utf8").length).toBe(LOG_ROTATE_BYTES + 1);
    expect(readFileSync(logPath, "utf8")).toContain("新的一行");
  });

  it("env 文件：不覆盖已有变量、跳过注释与坏行", () => {
    const path = join(dir(), "autonomy.env");
    writeFileSync(
      path,
      "# 注释\n\nA=1\nB = 2 \n坏行没有等号\n=C\n已存在=新值\n",
      "utf8",
    );
    const env: Record<string, string | undefined> = { 已存在: "旧值" };
    loadEnvFile(path, env);
    expect(env["A"]).toBe("1");
    expect(env["B"]).toBe("2");
    expect(env["已存在"]).toBe("旧值");
    expect(env[""]).toBeUndefined();
  });

  it("env 文件不存在是 no-op，不抛", () => {
    expect(() => loadEnvFile(join(dir(), "nope.env"), {})).not.toThrow();
  });

  it("节假日/调休表：读得到就解析，读不到就是空表", () => {
    const root = dir();
    writeFileSync(join(root, "holidays.txt"), "2026-10-01\n2026-10-02\n# 注释\n", "utf8");
    expect(readHolidayFile(join(root, "holidays.txt"))).toEqual(["2026-10-01", "2026-10-02"]);
    expect(readHolidayFile(join(root, "none.txt"))).toEqual([]);
    writeFileSync(join(root, "workdays.txt"), "2026-10-11\n", "utf8");
    expect(readWorkdayFile(join(root, "workdays.txt"))).toEqual(["2026-10-11"]);
    expect(readWorkdayFile(join(root, "none.txt"))).toEqual([]);
  });

  it("OneBot 配置：文件不存在或读不了都是 null（不猜连接）", () => {
    expect(readOneBotConfig(join(dir(), "cordis.patch.yml"))).toBeNull();
    const root = dir();
    writeFileSync(join(root, "cordis.patch.yml"), "这不是 yaml 结构\n", "utf8");
    expect(readOneBotConfig(join(root, "cordis.patch.yml"))).toBeNull();
  });

  it("本地时间换算：跨零点按固定偏移，日口径与 tick-plan 一致", () => {
    // UTC 17:30 + 8h = 本地 01:30（次日）
    expect(localPartsOf(Date.UTC(2026, 9, 31, 17, 30), 480)).toEqual({
      localHour: 1,
      localDay: "2026-11-01",
    });
    expect(localPartsOf(Date.UTC(2026, 10, 1, 0, 30), 480)).toEqual({
      localHour: 8,
      localDay: "2026-11-01",
    });
    expect(() => localPartsOf(Number.NaN, 480)).toThrow(RangeError);
    expect(() => localPartsOf(0, Number.NaN)).toThrow(RangeError);
  });

  it("dataFile 只拼路径，不做别的", () => {
    expect(dataFile("/x/data", "a.txt").replace(/\\/g, "/")).toBe("/x/data/a.txt");
  });

  it("装配锁：入口用引导件，不再自己写轮转与 env 解析", () => {
    const main = readFileSync(
      new URL("../scripts/autonomy/main.mjs", import.meta.url),
      "utf8",
    );
    expect(main).toContain('from "../../dist/assembly/main-config.js"');
    expect(main).toMatch(/appendRuntimeLog\(\{ logPath, line, nowMs: Date\.now\(\) \}\)/);
    expect(main).not.toContain("LOG_ROTATE_BYTES");
    expect(main).not.toContain("renameSync(logPath");
    expect(main).not.toContain("parseHolidayList(readFileSync");
  });
});
