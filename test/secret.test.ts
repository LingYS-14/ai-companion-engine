import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  keyFileStatus,
  protectedKeyPath,
  protectToFile,
  readKeyEnv,
  readRawForTest,
  unprotectFromFile,
  writeRawForTest,
} from "../src/autonomy/secret.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-secret-"));
  dirs.push(dir);
  return join(dir, "llm-key.bin");
}

const isWindows = process.platform === "win32";

describe("凭据落盘（DPAPI）", () => {
  it.skipIf(!isWindows)("加密后文件里没有明文，解回来与原文一致", () => {
    const file = path();
    const key = "sk-test-roundtrip-0123456789";
    protectToFile(file, key);
    const bytes = Buffer.from(readRawForTest(file)).toString("latin1");
    expect(bytes.includes("sk-test")).toBe(false);
    expect(unprotectFromFile(file)).toBe(key);
    expect(keyFileStatus({ LOCALAPPDATA: join(file, "..") })).toEqual({ path: join(file, "..", "ai-companion-engine", "llm-key.bin"), exists: false });
  });

  it.skipIf(!isWindows)("ACE_KEY_DIR 覆盖路径只给测试用", () => {
    const dir = mkdtempSync(join(tmpdir(), "ase-keydir-"));
    dirs.push(dir);
    expect(protectedKeyPath({ ACE_KEY_DIR: dir })).toBe(join(dir, "llm-key.bin"));
    const localAppData = join("C:", "fake-local-appdata");
    expect(protectedKeyPath({ ACE_KEY_DIR: "  ", LOCALAPPDATA: localAppData })).toBe(
      join(localAppData, "ai-companion-engine", "llm-key.bin"),
    );
  });

  it.skipIf(!isWindows)("空 key 拒绝写入", () => {
    expect(() => protectToFile(path(), "  ")).toThrow(/空/);
  });

  it("文件不存在/被破坏都返回 null（降级模板，不崩）", () => {
    const file = path();
    expect(unprotectFromFile(file)).toBeNull();
    writeRawForTest(file, new Uint8Array([1, 2, 3, 4]));
    expect(unprotectFromFile(file)).toBeNull();
  });

  it("非 Windows 没有 LOCALAPPDATA 时没有落盘路径", () => {
    expect(keyFileStatus({})).toEqual({ path: null, exists: false });
  });
});

describe("环境变量别名（F75：设了 key 却说没有 key）", () => {
  it("DEEPSEEK_API_KEY 也能被认出来，且报出命中的变量名", () => {
    expect(readKeyEnv({ DEEPSEEK_API_KEY: " sk-deep " })).toEqual({ name: "DEEPSEEK_API_KEY", key: "sk-deep" });
  });

  it("AI_COMPANION_LLM_API_KEY 仍然可用；多个都存在时 DEEPSEEK_API_KEY 优先", () => {
    expect(readKeyEnv({ AI_COMPANION_LLM_API_KEY: "sk-old" })).toEqual({ name: "AI_COMPANION_LLM_API_KEY", key: "sk-old" });
    expect(readKeyEnv({ AI_COMPANION_LLM_API_KEY: "sk-old", DEEPSEEK_API_KEY: "sk-new" })?.key).toBe("sk-new");
  });

  it("空串/空白等于没设，别把空 key 写进 DPAPI", () => {
    expect(readKeyEnv({ DEEPSEEK_API_KEY: "   " })).toBeNull();
    expect(readKeyEnv({})).toBeNull();
  });
});
