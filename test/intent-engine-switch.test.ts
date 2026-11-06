/**
 * 意图引擎开关与写者锁的**配置锁**（D3，审计 §4 P0）。
 *
 * 为什么锁：开关语义与名字曾经对不上——`ACE_INTENT_SHADOW=1` 其实是真引擎（会主动开口、
 * 会写意图表），而文档叫它"影子"。改名是 D3 的决定：新名 `ACE_INTENT_ENGINE` 为准，
 * 旧名只兼容一版。这两条一旦被回退，线上会表现成"她突然不说话了"且很难查，所以用测试钉住。
 *
 * 另外钉住 singleWriterConflict 不再是硬编码 false（审计 §4：它不是缺信号，是没接）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");
const start = readFileSync(join(ROOT, "scripts", "autonomy", "start.ps1"), "utf8");

describe("D3：意图引擎开关（新名优先、旧名兼容一版）", () => {
  it("main.mjs 以 ACE_INTENT_ENGINE 为准，回退到旧名", () => {
    expect(main).toContain("process.env.ACE_INTENT_ENGINE");
    expect(main).toContain("process.env.ACE_INTENT_SHADOW");
    // 旧名只能是回退，不能覆盖新名
    expect(main).toContain("const intentEngineEnv = process.env.ACE_INTENT_ENGINE;");
    expect(main).toMatch(/\(intentEngineEnv \?\? process\.env\.ACE_INTENT_SHADOW\)/);
  });

  it("用旧名时留一行迁移提示（不静默）", () => {
    expect(main).toContain("正在用旧名 ACE_INTENT_SHADOW");
  });

  it("start.ps1 默认写新名，并把旧名同步成同一个值", () => {
    expect(start).toContain('$env:ACE_INTENT_ENGINE = "1"');
    expect(start).toContain('$env:ACE_INTENT_SHADOW = $env:ACE_INTENT_ENGINE');
  });
});

describe("写者冲突（审计 §4）不再硬编码", () => {
  it("situation 的 singleWriterConflict 来自真实写者锁", () => {
    expect(main).not.toContain("singleWriterConflict: false");
    expect(main).toContain("singleWriterConflictNow()");
  });

  it("只看别的 pid：自己持锁不算冲突", () => {
    expect(main).toContain('join(dataDir, ".writer-lock")');
    expect(main).toContain("ownerPid !== process.pid");
  });

  it("锁文件缺失/读坏时按不冲突处理（不因坏文件让她闭嘴）", () => {
    const idx = main.indexOf("function singleWriterConflictNow()");
    expect(idx).toBeGreaterThan(0);
    const body = main.slice(idx, idx + 700);
    expect(body).toContain("catch");
    expect(body).toContain("return false");
  });
});
