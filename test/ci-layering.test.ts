/**
 * CI 快慢分层的**配置锁**（M12-05，v5.2 §12.2 P-C）。
 *
 * 为什么要锁配置：分层本身是"一个字符串"，很容易在某次改 gate 时被悄悄改回单层
 * （把 `test:fast` 换回 `test`），而慢速套件一进 gate，日常迭代就会从 5 秒变成 8 秒，
 * 接着有人为了"快一点"去删重仿真。所以这里把三件事写成断言：
 *   1. gate 只跑快层（`test:fast`），不跑全量 `test`；
 *   2. 快层显式排除 `test/nightly/**`；
 *   3. 慢层跑的就是 `test/nightly`，且那个目录里真的有测试文件。
 *
 * 这个文件本身属于快层（跑一次 ~1ms），不会拖慢 gate。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const runner = readFileSync(join(ROOT, "tools", "run-vitest.mjs"), "utf8");

describe("CI 分层：快层进 gate，慢层单独跑", () => {
  it("gate 链最后一步是 test:fast（不是全量 test）", () => {
    const gate = pkg.scripts["gate"] ?? "";
    expect(gate).toContain("npm run test:fast");
    // `npm run test:fast` 里也包含 "test"，所以要断"整词 test"而不是子串
    expect(gate.split("&&").map((s) => s.trim())).not.toContain("npm run test");
  });

  it("快层显式排除 test/nightly/**", () => {
    const fast = pkg.scripts["test:fast"] ?? "";
    expect(fast).toContain("--exclude");
    expect(fast).toMatch(/test\/nightly\/\*\*/);
    // 排除要真的交给 vitest：包装器必须透传 argv
    expect(runner).toContain("process.argv.slice(2)");
  });

  it("慢层跑的是 test/nightly，而且那个目录里有测试", () => {
    const nightly = pkg.scripts["test:nightly"] ?? "";
    expect(nightly).toContain("test/nightly");
    const dir = join(ROOT, "test", "nightly");
    expect(existsSync(dir), "test/nightly 目录必须存在（分层不能是空壳）").toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length, "夜间层至少要有 1 个测试文件").toBeGreaterThan(0);
  });

  it("全量 test 仍然保留（手动跑得动全量）", () => {
    expect(pkg.scripts["test"]).toBe("node tools/run-vitest.mjs");
  });
});
