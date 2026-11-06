import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/**
 * P4-2 L0（task-84）：dream-shadow 的装配接线用源码锁保护。
 * 这些行为在 main.mjs（dist 入口、不可直接 import）里，单测只能锁形状；
 * 真正跑梦要等发布后由用户观察。
 */
describe("dream-shadow 装配接线（源码锁）", () => {
  const main = source("scripts/autonomy/main.mjs");

  it("只在夜间巩固完成的那一拍调度，且不阻塞睡眠", () => {
    expect(main).toContain("if (work !== null && work.consolidated) scheduleDreamShadow(r.nightKey);");
    const logIndex = main.indexOf("if (work !== null) logSleepWork(work);");
    const hookIndex = main.indexOf("scheduleDreamShadow(r.nightKey)");
    expect(logIndex).toBeGreaterThan(-1);
    expect(hookIndex).toBeGreaterThan(logIndex);
  });

  it("先记夜额度再调模型；一次 240 token、0.7 度，结果按影子记录落盘", () => {
    const start = main.indexOf("async function dreamShadow(");
    const end = main.indexOf("const port = createStandalonePort(portDeps);");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = main.slice(start, end);

    const budgetIndex = body.indexOf("consumeNightBudget(nightBudget, 1)");
    const modelIndex = body.indexOf("await chatComplete(");
    expect(budgetIndex).toBeGreaterThan(-1);
    expect(modelIndex).toBeGreaterThan(budgetIndex);
    expect(body).toContain("runtime.setNightBudget(nightBudget)");
    expect(body).toContain('task: "dream"');
    expect(body).toContain("buildDreamPrompt(");
    expect(body).toContain("validateDreamShadow(");
    expect(body).toContain("appendDreamShadowLine(JSON.stringify(record))");
    // 失败只日志、不重试（不抛到循环）
    expect(body).toContain("errorText = err instanceof Error ? err.message : String(err);");
  });

  it("开关、影子文件与 14 夜修剪都在装配层；L0 绝不落库", () => {
    expect(main).toContain('if (process.env.ACE_DREAM_SHADOW === "0") return;');
    expect(main).toContain("dream-shadow-${characterId}.ndjson");
    expect(main).toContain("trimShadowLines(lines, DREAM_RETENTION_NIGHTS)");
    expect(main).toContain("dreamNightKey === nightKey");

    const start = main.indexOf("async function dreamShadow(");
    const end = main.indexOf("const port = createStandalonePort(portDeps);");
    const body = main.slice(start, end);
    // shadow 阶段只观测：不写 memory / knowledge / prompt
    expect(body).not.toContain("runtime.remember(");
    expect(body).not.toContain("store.write(");
    expect(body).not.toContain("makeMemory");
  });

  it("dream.ts 保持纯函数：零 IO、不取当前时间", () => {
    const dream = source("src/maintenance/dream.ts");
    expect(dream).not.toContain("node:fs");
    expect(dream).not.toContain("Date.now");
    expect(dream).not.toContain("new Date");
    expect(dream).not.toContain("import ");
  });
});
