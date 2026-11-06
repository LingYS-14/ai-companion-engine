import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P3-3 接线锁（字符串锁，同 F309/F312 先例）：
 * 只防「有人把分档/热榜分支改回死代码」，不证明逻辑正确——正确性靠 energy-budget 单测。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("装配层 learnImpl 按档位接线（P3-3）", () => {
  it("main.mjs 用 shouldSearchOf / shouldFetchHotOf / deepReadLimitOf，而不是自己读能量", () => {
    const src = read("scripts/autonomy/main.mjs");
    expect(src).toContain("shouldSearchOf(tier)");
    expect(src).toContain("shouldFetchHotOf(tier)");
    expect(src).toContain("deepReadLimitOf(tier");
    // R4：装配点不判档——learnImpl 里不得出现 learnTierOf（档位在脊髓层判）
    expect(src).not.toContain("learnTierOf(");
  });

  it("hot 分支只拉热榜、提前返回，且不可达 advanceLearnState", () => {
    const src = read("scripts/autonomy/main.mjs");
    const start = src.indexOf("if (!shouldSearchOf(tier))");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("const exploreNow", start);
    expect(end).toBeGreaterThan(start);
    const hotBranch = src.slice(start, end);
    expect(hotBranch).toContain("captureHotSnapshot");
    expect(hotBranch).toContain("{ topic: \"hot\", keyword: \"热榜\", deepReads: 0 }");
    expect(hotBranch).not.toContain("advanceLearnState(");
    expect(hotBranch).not.toContain("searchVideos(");
  });

  it("独立说明：装配层学习通路带 deepReads 回报（计量在脊髓，不在 main 扣）", () => {
    const src = read("scripts/autonomy/main.mjs");
    expect(src).toContain("deepReads: enriched");
    // 深读耗能统一在 standalone 扣（防双扣）；main 里不应再出现 learn_deep 的 spendEnergy 调用
    expect(src).not.toContain("spendEnergy(energyCostFor(cfg, \"learn_deep\"))");
  });

  it("explore 越阈改走 port.learn（task-72）：不得再直调 learnImpl", () => {
    const src = read("scripts/autonomy/main.mjs");
    expect(src).not.toContain("void learnImpl()");
    expect(src).toContain("runLearnThroughPort?.().catch");
    // W1（spec v2.3 §5.3）：explore 越阈入口是 explore-only——固定传 {exploreNow:true}，
    // 所以必须 async 包一层 await port.learn(...)，不能是裸的 () => port.learn()。
    expect(src).toContain("runLearnThroughPort = async () => {");
    expect(src).toContain("port.learn({ exploreNow: true })");
    const idx = src.indexOf('log("[intent] explore 越阈');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(idx, idx + 400)).toContain("runLearnThroughPort?.()");
  });
});

describe("hot 档前移（task-72）：热榜永不因审核/频率被拦", () => {
  it("standalone 的顺序：睡眠 → tier → hot 快路径 → suspended/rateAlert", () => {
    const src = read("src/autonomy/standalone.ts");
    const hot = src.indexOf("if (tier === \"hot\")");
    const suspended = src.indexOf("if (suspended())", src.indexOf("learn: async"));
    expect(hot).toBeGreaterThan(0);
    expect(suspended).toBeGreaterThan(hot);
    const branch = src.slice(hot, suspended);
    // W1（spec v2.3 §5.3）：learn(input) 的入参要透传——hot 档也让装配层看到同一个 input，
    // 避免「同一次学习调用不同档位拿到不同上下文」的分叉。
    expect(branch).toContain("return await deps.learnImpl(\"hot\", input)");
  });
});

describe("脊髓层 tier 判定与计费（P3-3）", () => {
  it("standalone.learn 先判档、skip 早退，recordCall 只在常规路径", () => {
    const src = read("src/autonomy/standalone.ts");
    expect(src).toContain("learnTierOf(energy)");
    expect(src).toContain("tier === \"skip\"");
    expect(src).toContain("keyword: \"低能量\"");
    expect(src).toContain("      recordCall();");
    expect(src).toContain("spendEnergy?.(\"learn_deep\")");
  });
});

describe("注册表与能耗枚举（P3-3）", () => {
  it("overlay 注册 ENERGY_COST_LEARN_DEEP，state.ts 消费第六类", () => {
    const overlay = read("spec/config/v54.overlay.json");
    expect(overlay).toContain("\"ENERGY_COST_LEARN_DEEP\"");
    expect(overlay).toContain("\"cluster\": \"A.13\"");
    const state = read("src/engine/state.ts");
    expect(state).toContain("learn_deep");
    expect(state).toContain("\"ENERGY_COST_LEARN_DEEP\"");
  });

  it("energy-budget 是纯函数：不 import、不读时钟", () => {
    const src = read("src/learning/energy-budget.ts");
    expect(src).not.toMatch(/^import\s/m);
    expect(src).not.toContain("Date.now()");
    expect(src).not.toContain("new Date(");
  });
});
