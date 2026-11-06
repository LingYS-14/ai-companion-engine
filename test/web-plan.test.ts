/**
 * W1（task-94）：脊髓层的网页触发公式（spec v2.3 §5.3）。
 *
 * 只有 full 档、且「现在去探索」或「B 站搜了但空」才允许查网页；
 * 关键词必须非空——plan 的 querySource 只由 exploreNow 决定。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildLearningWebPlan, createPortActions } from "../src/autonomy/port.js";
import type { AutonomyPort, LearnOutcome } from "../src/autonomy/port.js";

function source(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

function learnOutcome(over: Partial<LearnOutcome> = {}): LearnOutcome {
  return { topic: "崩坏三", keyword: "AI助手", deepReads: 0, ...over };
}

describe("buildLearningWebPlan", () => {
  it("full + exploreNow → 允许，来源 learning-plan", () => {
    expect(buildLearningWebPlan({ tier: "full", exploreNow: true, biliEmpty: false, keyword: "AI助手" })).toEqual({
      allowSearch: true,
      querySource: "learning-plan",
      keyword: "AI助手",
    });
  });

  it("full + biliEmpty → 允许，来源 hot-topic", () => {
    expect(buildLearningWebPlan({ tier: "full", exploreNow: false, biliEmpty: true, keyword: "往世乐土" })).toEqual({
      allowSearch: true,
      querySource: "hot-topic",
      keyword: "往世乐土",
    });
  });

  it("full 但没有触发（explore/biliEmpty 都 false）→ 不允许，但仍给 plan（供日志看来源）", () => {
    const plan = buildLearningWebPlan({ tier: "full", exploreNow: false, biliEmpty: false, keyword: "AI助手" });
    expect(plan.allowSearch).toBe(false);
    expect(plan.querySource).toBe("hot-topic");
    expect(plan.keyword).toBe("AI助手");
  });

  it("非 full 档一律不允许（search/hot/skip 都不查网页）", () => {
    for (const tier of ["search", "hot", "skip"]) {
      expect(buildLearningWebPlan({ tier, exploreNow: true, biliEmpty: true, keyword: "AI助手" }).allowSearch, tier).toBe(false);
    }
  });

  it("关键词为空/全空白 → 不允许（没有任何事实可查）", () => {
    expect(buildLearningWebPlan({ tier: "full", exploreNow: true, biliEmpty: true, keyword: "   " }).allowSearch).toBe(false);
    expect(buildLearningWebPlan({ tier: "full", exploreNow: true, biliEmpty: true, keyword: "" }).allowSearch).toBe(false);
  });

  it("关键词两端空白被裁掉（plan.keyword 就是发出去的 query）", () => {
    expect(buildLearningWebPlan({ tier: "full", exploreNow: true, biliEmpty: false, keyword: " AI助手 " }).keyword).toBe("AI助手");
  });
});

describe("createPortActions 的 afterLearn 钩子", () => {
  it("learn 完成后把 outcome 原样交给钩子；没接钩子时行为不变", async () => {
    const out = learnOutcome({ webPlan: { allowSearch: true, querySource: "learning-plan", keyword: "AI助手" } });
    const seen: LearnOutcome[] = [];
    const port: AutonomyPort = {
      advance: () => ({ ticks: 1 }),
      learn: () => out,
      consolidate: () => ({ accepted: 0, rejected: 0 }),
      proactive: () => ({ opened: false, reason: "test" }),
      selftalk: () => ({ kind: "wander", relation: "unrelated" }),
    };
    const logs: string[] = [];
    const actions = createPortActions(port, (line) => logs.push(line), { afterLearn: (o) => seen.push(o) });
    await actions.learn();
    expect(seen).toEqual([out]);
    expect(logs).toContain("[autonomy] learn 崩坏三 / AI助手");

    const plain = createPortActions(port, (line) => logs.push(line));
    await plain.learn();
    expect(seen).toHaveLength(1); // 没钩子不再触发
  });

  it("钩子失败会抛出（由循环捕获；单步失败不吞）", async () => {
    const port: AutonomyPort = {
      advance: () => ({ ticks: 1 }),
      learn: () => learnOutcome(),
      consolidate: () => ({ accepted: 0, rejected: 0 }),
      proactive: () => ({ opened: false, reason: "test" }),
      selftalk: () => ({ kind: "wander", relation: "unrelated" }),
    };
    const actions = createPortActions(port, () => undefined, {
      afterLearn: () => Promise.reject(new Error("web boom")),
    });
    await expect(actions.learn()).rejects.toThrow("web boom");
  });
});

describe("main.mjs 接线（源码锁；main 不能 import，只能用字面量锁结构）", () => {
  const main = source("scripts/autonomy/main.mjs");

  it("B5-2：explore 只认入参，不再读 lastIntentContext；learnImpl 透传第二参", () => {
    expect(main).toContain('const learnImpl = async (tier = "full", input) => {');
    expect(main).toContain("const exploreNow = input?.exploreNow === true;");
    expect(main).not.toContain('lastIntentContext?.emitted?.includes("explore")');
  });

  it("explore-only 入口固定传 exploreNow:true；普通 actions.learn 走 afterLearn 钩子", () => {
    expect(main).toContain("const out = await port.learn({ exploreNow: true });");
    expect(main).toContain("createPortActions(port, log, { afterLearn: executeWebPlan })");
  });

  it("执行条件：plan.allowSearch → 开关 → 额度；只走 searchForLearning + ingestHits", () => {
    expect(main).toContain("if (plan === undefined || plan.allowSearch !== true) return;");
    expect(main).toContain("if (!webCfg.enabled) return;");
    expect(main).toContain("const gate = canSearch(nowMs, webUsage, webCfg);");
    expect(main).toContain("await searchForLearning(plan, deps)");
    expect(main).toContain("ingestHits(runtime.knowledgeWritePort(), picked, nowMs, {");
    expect(main).toContain("hit.authority >= 1 && hit.rerankScore >= 1");
  });

  it("biliEmpty 只在「B 站搜索执行且为空」时为 true", () => {
    expect(main).toContain("biliEmpty: failure === null && fetched === 0,");
  });

  it("落盘唯一写者：data/web-usage-<characterId>.json，原子写", () => {
    expect(main).toContain("web-usage-${characterId}.json");
    expect(main).toContain("writeFileSync(tmp, JSON.stringify(webUsage), \"utf8\")");
    expect(main).toContain("renameSync(tmp, webUsagePath)");
  });
});
