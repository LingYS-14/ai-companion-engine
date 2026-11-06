/**
 * F297：appraisal 判定搬进大脑层（审计 P1-2「工具层做业务判断」）。
 *
 * 这条锁保护的是"判断落在哪一层"，不是函数行为：
 *   - 文件必须在大脑目录（`src/psychology/`），不能在 `src/qq/`；
 *   - 工具层（`src/qq/`）不许再 import 它的实现——只能从 ports 拿 `QqAppraiseFn` 类型；
 *   - 两个桥的 deps 都有 `appraise` 字段（装配点注入），桥自己不再"猜这句话算不算冒犯"；
 *   - 装配点（`plugin/index.ts`、`qq-runner.ts`）真的把大脑实现接进去了。
 *
 * 为什么用源码锁而不是类型锁：类型锁只能保证"编译得过"，
 * 而"工具层偷偷 import 大脑实现"恰好是编译得过、门禁看不见的那类越界（F295 同款教训）。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("appraisal 判定在大脑层（F297）", () => {
  it("实现文件在大脑层，旧位置已不存在", () => {
    expect(existsSync(join(ROOT, "src", "psychology", "appraisal-qq.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "qq", "appraisal.ts"))).toBe(false);
  });

  it("工具层两个桥不再 import 实现，只认 ports 的类型", () => {
    for (const rel of ["src/qq/bridge.ts", "src/qq/onebot-bridge.ts"]) {
      const s = read(rel);
      expect(s).not.toContain("appraisal-qq.js");
      expect(s).toContain("QqAppraiseFn");
      expect(s).toMatch(/appraise\s*:\s*QqAppraiseFn/);
      expect(s).toContain("this.deps.appraise(");
    }
  });

  it("ports 只给类型，不给实现", () => {
    const ports = read("src/ports/index.ts");
    expect(ports).toContain("export type QqAppraiseFn");
    expect(ports).toContain("export interface QqAppraisal");
    expect(ports).not.toMatch(/from "\.\.\/psychology\/appraisal-qq/);
  });

  it("装配点真的把大脑实现注入两个桥", () => {
    const plugin = read("src/plugin/index.ts");
    expect(plugin).toContain('from "../psychology/appraisal-qq.js"');
    expect((plugin.match(/appraise: appraiseFromText/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const runner = read("src/autonomy/qq-runner.ts");
    expect(runner).toContain("appraise: appraiseFromText");
  });

  it("宿主侧 deps 不假装能自己造判断", () => {
    const host = read("src/qq/host.ts");
    expect(host).toContain('Omit<QQDeps, "dialogue" | "language" | "appraise">');
    expect(host).not.toContain("appraiseFromText");
  });
});
