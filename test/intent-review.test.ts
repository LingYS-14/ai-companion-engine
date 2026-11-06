import { describe, it, expect } from "vitest";
import {
  ALLOWED_PATH_ROOTS,
  CHANGE_BUDGET,
  buildReviewRequest,
  calibrateThresholds,
  checkBudget,
  classifyChangeSet,
  describeCalibration,
  parseReviewRequest,
  validateChangeSet,
  type ChangeSet,
  type ReviewLogEntry,
} from "../src/orchestrator/intent/review.js";

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function cs(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    capId: "cap-001",
    intentionId: "itn-001",
    files: ["scripts/forge/tidy.mjs"],
    addedLines: 40,
    removedLines: 5,
    newDependencies: [],
    newToolPermissions: [],
    touchesUserVisibleChannels: [],
    requiresNewCredentials: false,
    selfTestPassed: true,
    ...overrides,
  };
}

function entry(overrides: Partial<ReviewLogEntry> = {}): ReviewLogEntry {
  return {
    at: new Date(NOW - DAY).toISOString(),
    capId: "cap-001",
    level: "A",
    dimensions: { files: 1, lines: 45, deps: 0, pathOk: true, permOk: true },
    verdict: "auto",
    reasonCode: "within-budget",
    ...overrides,
  };
}

describe("review：四维预算", () => {
  it("预算内：2 文件 120 行、无依赖、路径合法、无权限", () => {
    const verdict = checkBudget(cs({ files: ["scripts/forge/a.mjs", "data/forge/b.json"], addedLines: 100, removedLines: 20 }));
    expect(verdict.budgetFiles).toBe(true);
    expect(verdict.budgetLines).toBe(true);
    expect(verdict.allowedPaths).toBe(true);
    expect(verdict.overBudget).toBe(false);
    expect(CHANGE_BUDGET.maxFiles).toBe(2);
  });

  it("超规模：3 文件或 121 行 → overBudget，并给出是哪一维", () => {
    expect(checkBudget(cs({ files: ["scripts/forge/a.mjs", "scripts/forge/b.mjs", "scripts/forge/c.mjs"] })).budgetFiles).toBe(false);
    expect(checkBudget(cs({ addedLines: 121 })).budgetLines).toBe(false);
    expect(checkBudget(cs({ addedLines: 121 })).overBudget).toBe(true);
  });

  it("路径黑名单与白名单外都列出来（不合并成一个布尔）", () => {
    const verdict = checkBudget(cs({ files: ["src/engine/state.ts", "docs/x.md"] }));
    expect(verdict.blockedPaths).toEqual(["src/engine/state.ts"]);
    expect(verdict.outsideAllowedPaths).toEqual(expect.arrayContaining(["src/engine/state.ts", "docs/x.md"]));
    expect(verdict.allowedPaths).toBe(false);
    expect(ALLOWED_PATH_ROOTS).toContain("scripts/forge/");
  });
});

describe("review：ChangeSet 校验", () => {
  it("合法改动无错误；非对象/缺字段给中文错误", () => {
    expect(validateChangeSet(cs())).toEqual([]);
    expect(validateChangeSet(null)).toEqual(["(root): 不是对象"]);
    expect(validateChangeSet({ capId: "c" }).length).toBeGreaterThan(3);
  });

  it("绝对路径、反斜杠、..、重复文件都拒（宁可多拒）", () => {
    expect(validateChangeSet(cs({ files: ["/abs/x"] }))).toEqual(expect.arrayContaining([expect.stringContaining("仓库相对路径")]));
    expect(validateChangeSet(cs({ files: ["a\\b"] }))).toEqual(expect.arrayContaining([expect.stringContaining("仓库相对路径")]));
    expect(validateChangeSet(cs({ files: ["scripts/forge/../src/x.ts"] }))).toEqual(expect.arrayContaining([expect.stringContaining("..")]));
    expect(validateChangeSet(cs({ files: ["scripts/forge/a.mjs", "scripts/forge/a.mjs"] }))).toEqual(expect.arrayContaining([expect.stringContaining("重复")]));
  });
});

describe("review：A/B/C/D 分级（不由她自选）", () => {
  it("A：预算内 + 白名单 + 无依赖 + 不扩权 + 自测过", () => {
    const decision = classifyChangeSet(cs());
    expect(decision.level).toBe("A");
    expect(decision.note).toContain("自动通过");
    expect(decision.reasons).toEqual([expect.stringContaining("预算内")]);
  });

  it("B：超规模、超行数、加依赖——但没碰权限/通道/黑名单", () => {
    expect(classifyChangeSet(cs({ files: ["scripts/forge/a.mjs", "scripts/forge/b.mjs", "scripts/forge/c.mjs"] })).level).toBe("B");
    expect(classifyChangeSet(cs({ addedLines: 121 })).level).toBe("B");
    expect(classifyChangeSet(cs({ newDependencies: ["lodash"] })).level).toBe("B");
  });

  it("C：用户可见通道 / 新凭证 / 白名单外的新建路径", () => {
    expect(classifyChangeSet(cs({ touchesUserVisibleChannels: ["qq"] })).level).toBe("C");
    expect(classifyChangeSet(cs({ requiresNewCredentials: true })).level).toBe("C");
    const outside = classifyChangeSet(cs({ files: ["docs/notes.md"] }));
    expect(outside.level).toBe("C");
    expect(outside.reasons.join()).toContain("白名单");
  });

  it("D：既有源码 / package.json / 扩权 / 未自测 / 状态文件", () => {
    expect(classifyChangeSet(cs({ files: ["src/orchestrator/intent/x.ts"] })).level).toBe("D");
    expect(classifyChangeSet(cs({ files: ["package.json"] })).level).toBe("D");
    expect(classifyChangeSet(cs({ newToolPermissions: ["qq.send"] })).level).toBe("D");
    expect(classifyChangeSet(cs({ selfTestPassed: false })).level).toBe("D");
    expect(classifyChangeSet(cs({ files: ["data/state-assistant.json"] })).level).toBe("D");
  });

  it("顺序：D 优先于 C 优先于 B（同时命中时按最严的级别）", () => {
    // 既碰 QQ 通道（C）又超预算（B）→ C
    expect(classifyChangeSet(cs({ touchesUserVisibleChannels: ["qq"], addedLines: 200 })).level).toBe("C");
    // 既碰 QQ 通道（C）又改 src（D）→ D
    expect(classifyChangeSet(cs({ files: ["src/engine/state.ts"], touchesUserVisibleChannels: ["qq"] })).level).toBe("D");
  });
});

describe("review：审核请求", () => {
  it("D 级不生成审核请求（立即拒绝是规格要求）", () => {
    expect(() => buildReviewRequest(cs({ files: ["src/x.ts"] }), "想改引擎", "风险很高", "2026-10-31T00:00:00.000Z")).toThrow(/D 级/);
  });

  it("摘要太短拒造；A 级请求 decision 为 null，级别与判定一致", () => {
    expect(() => buildReviewRequest(cs(), "嗯", "", "2026-10-31T00:00:00.000Z")).toThrow(/摘要/);
    const request = buildReviewRequest(cs(), "想把两个工具串起来", "无", "2026-10-31T00:00:00.000Z");
    expect(request.level).toBe("A");
    expect(request.decision).toBeNull();
    expect(request.budget.files).toBe(1);
  });

  it("序列化往返相等；坏 JSON/缺字段/D 级都给理由", () => {
    const request = buildReviewRequest(cs(), "想把两个工具串起来", "无新增权限", "2026-10-31T00:00:00.000Z");
    const again = parseReviewRequest(JSON.stringify(request));
    expect(again.errors).toEqual([]);
    expect(again.request).toEqual(request);

    expect(parseReviewRequest("{oops").errors[0]).toContain("JSON 解析失败");
    expect(parseReviewRequest(JSON.stringify({ ...request, level: "D" })).errors[0]).toContain("D 级");
    const badDecision = parseReviewRequest(
      JSON.stringify({ ...request, decision: { by: "lead", verdict: "approve", note: "" } }),
    );
    expect(badDecision.request).toBeNull();
    expect(badDecision.errors.join()).toContain("decision.note");
  });
});

describe("review：阈值按分布校准（m04801）", () => {
  it("样本不足（<20）只报比例、不报警：告警阈值要样本量才成立", () => {
    const report = calibrateThresholds([entry(), entry()], NOW);
    expect(report.window.samples).toBe(2);
    expect(report.levelARate).toBe(1);
    expect(report.alarms).toEqual([]);
    expect(report.suggested).toBeNull();
  });

  it("A 级 ≥95% 且从未出现 B/C（≥20 条）→ 太松，建议收紧到 1 文件/80 行", () => {
    const entries = Array.from({ length: 25 }, () => entry());
    const report = calibrateThresholds(entries, NOW);
    expect(report.alarms).toContain("matrix-too-loose");
    expect(report.suggested).toEqual({ maxFiles: 1, maxLines: 80 });
    expect(describeCalibration(report)).toContain("太松");
  });

  it("A 级再高，只要出现过一条 B 就不判太松（阈值不等于形同虚设）", () => {
    const entries = [...Array.from({ length: 24 }, () => entry()), entry({ level: "B", verdict: "pending" })];
    const report = calibrateThresholds(entries, NOW);
    expect(report.alarms).not.toContain("matrix-too-loose");
  });

  it("B 级 ≥30% → 太紧；先怀疑判定逻辑而不是先放宽", () => {
    const entries = [...Array.from({ length: 14 }, () => entry()), ...Array.from({ length: 6 }, () => entry({ level: "B", verdict: "pending" }))];
    const report = calibrateThresholds(entries, NOW);
    expect(report.alarms).toContain("matrix-too-tight");
    expect(report.notes.join()).toContain("先查判定逻辑");
  });

  it("被 D 拒后 24h 内同 capId 反复重试 ≥3 → 判被绕过（硬闸，不自动放行）", () => {
    const denied = entry({ level: "D", verdict: "rejected", reasonCode: "blocked-path" });
    const retry = (hours: number): ReviewLogEntry => entry({ at: new Date(NOW - DAY + hours * 3600_000).toISOString(), level: "B", verdict: "pending" });
    const report = calibrateThresholds([denied, retry(1), retry(2), retry(3)], NOW);
    expect(report.alarms).toContain("matrix-bypassed");
    expect(report.notes.join()).toContain("第三次必须由人主动重启");
  });

  it("B 级超时 pending 每周 ≥3 → 判卡住，进早报待审区", () => {
    const timeout = (daysAgo: number): ReviewLogEntry =>
      entry({ at: new Date(NOW - daysAgo * DAY).toISOString(), level: "B", verdict: "timeout" });
    const report = calibrateThresholds([timeout(1), timeout(2), timeout(3)], NOW);
    expect(report.alarms).toContain("matrix-stalled");
  });

  it("窗口外旧记录不算；坏时间行的条目不进统计", () => {
    const old = entry({ at: new Date(NOW - 40 * DAY).toISOString() });
    const bad = entry({ at: "not-a-date" });
    const report = calibrateThresholds([old, bad, entry(), entry()], NOW);
    expect(report.window.samples).toBe(2);
  });

  it("一页纸结论：数字与报警都在，不写自评", () => {
    const report = calibrateThresholds([entry(), entry({ level: "B" })], NOW);
    const line = describeCalibration(report);
    expect(line).toContain("样本 2");
    expect(line).toContain("A 占比 50.0%");
    expect(line).toContain("无报警");
    expect(line).not.toContain("表现");
  });
});
