import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { SoulRuntime } from "../src/plugin/runtime.js";
import type { StandaloneRuntime } from "../src/autonomy/standalone.js";
import type {
  AdvanceSummary,
  BrainPort,
  ConsolidateSummary,
  RememberInput,
  RememberSummary,
} from "../src/ports/index.js";

const ROOT = resolve(__dirname, "..");

describe("BrainPort 补全（审计 P0-3：端口只挡工具层、没挡脊髓层）", () => {
  it("SoulRuntime 结构上满足 BrainPort 与脊髓的窄接口（编译期断言）", () => {
    expectTypeOf<SoulRuntime>().toMatchTypeOf<BrainPort>();
    expectTypeOf<SoulRuntime>().toMatchTypeOf<StandaloneRuntime>();
  });

  it("三条新契约带上了关键字段（防止被改名/掏空后测试静默失效）", () => {
    expectTypeOf<AdvanceSummary>().toHaveProperty("taintCleared");
    expectTypeOf<AdvanceSummary>().toHaveProperty("sleep");
    expectTypeOf<ConsolidateSummary>().toHaveProperty("accepted");
    expectTypeOf<ConsolidateSummary>().toHaveProperty("rejected");
    expectTypeOf<RememberInput>().toHaveProperty("content");
    expectTypeOf<RememberInput>().toHaveProperty("allowShare");
    expectTypeOf<RememberSummary>().toHaveProperty("stored");
  });

  it("来源锁：BrainPort 声明了 advance/consolidate/remember，SoulRuntime 真的 implements 它", () => {
    const ports = readFileSync(join(ROOT, "src", "ports", "index.ts"), "utf8");
    expect(ports).toContain("advance(hours: number): AdvanceSummary;");
    expect(ports).toContain("consolidate(opts?: { minSize?: number }): ConsolidateSummary;");
    expect(ports).toContain("remember(input: RememberInput): RememberSummary;");
    const runtime = readFileSync(join(ROOT, "src", "plugin", "runtime.ts"), "utf8");
    expect(runtime).toContain("export class SoulRuntime implements BrainPort {");
  });

  it("脊髓层不再 import 装配点（P0-3 要断的那条边）", () => {
    const standalone = readFileSync(join(ROOT, "src", "autonomy", "standalone.ts"), "utf8");
    expect(standalone).not.toContain("plugin/runtime.js");
    // 注释里可以提历史（"原来是 Pick<SoulRuntime,…>"），但代码里不许再出现这个类型引用。
    expect(standalone).not.toContain("Pick<SoulRuntime");
    expect(standalone).not.toContain(": SoulRuntime");
    expect(standalone).toContain("export interface StandaloneRuntime {");
  });

  it("依赖图可证：autonomy 层没有任何文件 import plugin/runtime", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(ROOT, "src", "autonomy");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("plugin/runtime.js"));
    expect(offenders).toEqual([]);
  });
});
