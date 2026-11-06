import { describe, it, expect } from "vitest";
import {
  DASHBOARD_MIN_TICKS,
  buildDashboard,
  renderDashboard,
  type DashboardInput,
} from "../src/orchestrator/intent/dashboard.js";
import { metricsReport } from "../src/orchestrator/intent/metrics.js";
import { runAblation } from "../src/orchestrator/intent/ablation.js";
import type { IntentTickInput } from "../src/orchestrator/intent/tick.js";
import type { Stage } from "../src/engine/bonds.js";
import { initialSState } from "../src/engine/state.js";

const generatedAt = "2026-10-31T05:20:00Z";

function metrics() {
  return metricsReport({ intentions: [], ticks: [] });
}

function ablationReport(samples = 6) {
  const base: IntentTickInput = {
    situation: {
      at: "2026-10-31T06:00:00.000Z",
      localHour: 14,
      channel: "qq",
      participants: ["用户"],
      affordances: [
        { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
        { tool: "bili.search", risk: 0, requiresLogin: false, rateLimited: false },
      ],
      sinceLastContactMin: 30,
      activeIntents: [],
      budget: { rph: 8, peak: false },
      singleWriterConflict: false,
    },
    state: { ...initialSState(), energy: 0.6, suppressionLoad: 0.2 },
    stage: "stranger" as Stage,
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 5,
    valueDeviation: 0.1,
    coverageGap: 0.3,
    trust: 0.5,
    trustFloor: 0.2,
    threads: [{ id: "t1", title: "上次说要给她看的东西", staleMin: 120 }],
  };
  const samplesList = Array.from({ length: samples }, (_, index) => ({ label: `样本 ${String(index)}`, input: base }));
  return runAblation(samplesList, ["knowledge_gap"]);
}

function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    generatedAt,
    source: "data/intent-shadow-assistant.ndjson",
    ticks: 30,
    metrics: metrics(),
    ablation: ablationReport(),
    ...overrides,
  };
}

describe("指标看板：拼装", () => {
  it("头部带时间/来源/样本数——没有来源的看板不可信", () => {
    const dashboard = buildDashboard(input());
    expect(dashboard.lines[0]).toBe("意向引擎指标看板");
    expect(dashboard.lines[1]).toContain("2026-10-31T05:20:00Z");
    expect(dashboard.lines[1]).toContain("data/intent-shadow-assistant.ndjson");
    expect(dashboard.lines[1]).toContain("30 条 tick");
  });

  it("六指标逐行进页面；未测项写「未测」而不是 0", () => {
    const dashboard = buildDashboard(input());
    const text = renderDashboard(dashboard);
    expect(text).toContain("【六指标】");
    expect(text).toContain("自发发起率");
    expect(text).toContain("未测");
    expect(text).toContain("记忆—行为因果性");
  });

  it("消融没跑：明说未跑 + 提醒，不拿别的指标顶替因果性", () => {
    const dashboard = buildDashboard(input({ ablation: null }));
    const text = renderDashboard(dashboard);
    expect(text).toContain("未跑");
    expect(dashboard.warnings.join()).toContain("因果性仍然是「未测」");
  });

  it("消融有报告：逐组件一行 + 结论，样本不足时给提醒", () => {
    const dashboard = buildDashboard(input());
    const text = renderDashboard(dashboard);
    expect(text).toContain("knowledge_gap");
    expect(text).toContain("结论：");
    expect(text).toContain("说明");

    const small = buildDashboard(input({ ablation: ablationReport(3) }));
    expect(small.warnings.join()).toContain("消融样本不足");
  });

  it("样本少于看板阈值：提醒「只能当有数，不能当稳定」", () => {
    const dashboard = buildDashboard(input({ ticks: DASHBOARD_MIN_TICKS - 1 }));
    expect(dashboard.warnings.join()).toContain("只能当");
    const enough = buildDashboard(input({ ticks: DASHBOARD_MIN_TICKS }));
    expect(enough.warnings.join()).not.toContain("只能当");
  });

  it("页脚写明离线边界与「不做评价」——看板不是打分", () => {
    const text = renderDashboard(buildDashboard(input()));
    expect(text).toContain("不代表她真实运行时行为");
    expect(text).toContain("指标不是打分");
    expect(text).not.toContain("很棒");
    expect(text).not.toContain("优秀");
  });

  it("来源为空/样本数为负/generatedAt 为空都抛错（不生成一份不可信的看板）", () => {
    expect(() => buildDashboard(input({ source: " " }))).toThrow(RangeError);
    expect(() => buildDashboard(input({ ticks: -1 }))).toThrow(RangeError);
    expect(() => buildDashboard(input({ generatedAt: "" }))).toThrow(RangeError);
  });

  it("renderDashboard 就是 lines 用换行拼起来（不额外加工）", () => {
    const dashboard = buildDashboard(input());
    expect(renderDashboard(dashboard)).toBe(dashboard.lines.join("\n"));
  });
});
