/**
 * 休息日额度的**配置锁**（F238，审计修复 A 的收口缺口）。
 *
 * 为什么锁：`pacingFor` 的 `restDay` 默认 false。常驻进程第一版没传它，于是周六仍按
 * 峰时 6/h 算额度；health 也犯过同一个错（F235）。两处任一漏传，线上都会表现成
 * "她被额度卡住、后台却不觉得该让路"——很像她自己的错，其实是漏了一个布尔。
 *
 * 锁的是「调用点有没有把 restDay 传进去」，不锁具体上限（上限在 pricing.ts 里，另有测试）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");
const health = readFileSync(join(ROOT, "scripts", "autonomy", "health.mjs"), "utf8");

describe("F238：休息日额度口径（intent tick 与 health 必须一致）", () => {
  it("main.mjs 的 tick 额度计算带 restDay", () => {
    expect(main).toContain("isRestDay");
    expect(main).toMatch(/pacingFor\(\{[^}]*restDay/);
    // 必须按本地日判断休息日，不能用 UTC 日
    expect(main).toMatch(/isRestDay\(localParts\(nowMs\)\.localDay\)/);
  });

  it("health.mjs 的额度计算也带 restDay（F235 不能被回退）", () => {
    expect(health).toContain("isRestDay");
    expect(health).toMatch(/restDay/);
  });
});
