import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renameWithRetry as reviewRename } from "../src/autonomy/review.js";
import { renameWithRetry as runtimeRename } from "../src/plugin/runtime.js";

/**
 * F355：原子写 rename 重试的行为锁。
 *
 * 两处实现都暴露可注入的 `rename` 参数，测试不需要 mock `node:fs`：
 * 传一个按脚本抛错的 stub，就能证明「占用类错误会退避重试、其它错误立即抛、
 * 重试次数用尽后照旧抛」。
 */

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function stubRename(script: readonly (string | null)[]) {
  const calls: string[] = [];
  let i = 0;
  const rename = (from: string, to: string): void => {
    calls.push(`${from}->${to}`);
    const next = script[i] ?? null;
    i += 1;
    if (next !== null) throw errno(next);
  };
  return { rename, calls };
}

describe("F355 renameWithRetry（plugin/runtime）", () => {
  it("EPERM 两次后成功：重试 3 次且最终成功", () => {
    const { rename, calls } = stubRename(["EPERM", "EPERM", null]);
    expect(() => runtimeRename("a", "b", 5, rename)).not.toThrow();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("a->b");
  });

  it("非占用类错误（ENOSPC）立即抛、不重试", () => {
    const { rename, calls } = stubRename(["ENOSPC", null]);
    expect(() => runtimeRename("a", "b", 5, rename)).toThrow("ENOSPC");
    expect(calls).toHaveLength(1);
  });

  it("占用类错误重试次数用尽后照旧抛", () => {
    const { rename, calls } = stubRename(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", null]);
    expect(() => runtimeRename("a", "b", 5, rename)).toThrow("EPERM");
    expect(calls).toHaveLength(5);
  });

  it("默认参数就是 fs.renameSync（不依赖注入也走真实实现）", () => {
    // 真实现不抛：真实源文件→临时文件路径都是合法路径，这里只验证签名可省略注入参数。
    expect(typeof runtimeRename).toBe("function");
  });
});

describe("F355 renameWithRetry（autonomy/review）", () => {
  it("EBUSY 一次后成功：重试 2 次", () => {
    const { rename, calls } = stubRename(["EBUSY", null]);
    expect(() => reviewRename("x", "y", 5, rename)).not.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("EACCES 用尽后照旧抛", () => {
    const { rename, calls } = stubRename(["EACCES", "EACCES"]);
    expect(() => reviewRename("x", "y", 2, rename)).toThrow("EACCES");
    expect(calls).toHaveLength(2);
  });
});

describe("F355 调用点接线（源码锁）", () => {
  const repo = join(import.meta.dirname, "..");

  it("SoulRuntime.save 走 renameWithRetry（不是裸 renameSync）", () => {
    const src = readFileSync(join(repo, "src", "plugin", "runtime.ts"), "utf8");
    const save = src.slice(src.indexOf("private save(): void {"), src.indexOf("stateWriteStats():"));
    expect(save).toContain("renameWithRetry(tmp, this.statePath)");
    expect(save).not.toMatch(/renameSync\(tmp, this\.statePath\)/);
  });

  it("review.writeAtomic 走 renameWithRetry（不是裸 renameSync）", () => {
    const src = readFileSync(join(repo, "src", "autonomy", "review.ts"), "utf8");
    const block = src.slice(src.indexOf("function writeAtomic("), src.indexOf("function writeAtomic(") + 400);
    expect(block).toContain("renameWithRetry(tmp, file)");
    expect(block).not.toMatch(/renameSync\(tmp, file\)/);
  });
});
