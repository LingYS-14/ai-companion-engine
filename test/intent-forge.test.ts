import { describe, it, expect } from "vitest";
import {
  QUARANTINE_MS,
  advanceLadder,
  buildEffectivityTable,
  describeLedgerStats,
  gapFromEffectivity,
  initialCapabilityRecord,
  parseCapabilityLines,
  planForge,
  reviewForgePlan,
  toChangeSet,
  validateCapabilityRecord,
  validateEffectivity,
  CapabilityLedger,
  type EffectivityEntry,
  type ForgePlan,
  type LadderProgress,
} from "../src/orchestrator/intent/forge.js";
import type { AskHelpInput } from "../src/orchestrator/intent/capability.js";
import type { CapabilityRecord } from "../src/orchestrator/intent/types.js";

const NOW_MS = Date.parse("2026-10-31T04:00:00.000Z");
const NOW_ISO = "2026-10-31T04:00:00.000Z";

function entry(overrides: Partial<EffectivityEntry> = {}): EffectivityEntry {
  return { tool: "bili.search", declared: true, available: true, effectivity: 1, lastProbeAt: NOW_ISO, ...overrides };
}

function progress(overrides: Partial<LadderProgress> = {}): LadderProgress {
  return { probed: false, learned: false, rehearsed: false, attempts: 0, progressHistory: [], ...overrides };
}

function askHelp(overrides: Partial<AskHelpInput> = {}): AskHelpInput {
  return {
    attempts: 3,
    selfEfficacyEff: 0.5,
    empowermentGain: 0.4,
    hoursSinceLastAsk: null,
    asksTodayForGap: 0,
    asksTodayGlobal: 0,
    ...overrides,
  };
}

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    capId: "cap-1",
    kind: "tool",
    tool: "bili.search",
    sourceIntentionId: "itn-1",
    effectivityBefore: 0,
    effectivityAfter: 0.6,
    tests: [{ name: "smoke", passed: true }],
    riskCeiling: 1,
    status: "quarantined",
    createdAt: new Date(NOW_MS - 2 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("forge：效力探测", () => {
  it("effectivity 只能是 0/0.5/1；自相矛盾与坏时间都报错", () => {
    expect(validateEffectivity(entry())).toEqual([]);
    expect(validateEffectivity(entry({ effectivity: 0.7 as 0.5 }))[0]).toContain("只能是 0 / 0.5 / 1");
    expect(validateEffectivity(entry({ available: true, effectivity: 0 }))[0]).toContain("自相矛盾");
    expect(validateEffectivity(entry({ available: false, effectivity: 1 }))[0]).toContain("自相矛盾");
    expect(validateEffectivity(entry({ lastProbeAt: "昨天" }))[0]).toContain("ISO");
  });

  it("建表时重复工具与非法条目进 errors，不静默去重", () => {
    const { errors } = buildEffectivityTable([entry(), entry({ effectivity: 0.5 })]);
    expect(errors.join()).toContain("重复");
    expect(buildEffectivityTable([entry({ effectivity: 0.7 as 0.5 })]).errors.length).toBe(1);
  });

  it("declared 但 effectivity=0 → 缺口（permission）；effectivity=1 → 无缺口；0.5 → 走 rehearse 倾向", () => {
    const gap = gapFromEffectivity(entry({ effectivity: 0, available: false, reason: "no-login" }), {
      blockedIntentionId: "itn-9",
      missing: "想看她主页但要登录",
    });
    expect(gap).not.toBeNull();
    expect(gap?.kind).toBe("permission");
    expect(gap?.affordancePresent).toBe(1);
    expect(gap?.effectivity).toBe(0);

    expect(gapFromEffectivity(entry(), { blockedIntentionId: "x", missing: "y" })).toBeNull();

    const half = gapFromEffectivity(entry({ effectivity: 0.5, available: true }), { blockedIntentionId: "x", missing: "y" });
    expect(half?.progressEst).toBe(0.5);
  });

  it("没声明过的能力 → knowledge 类缺口（缺的是'世界上有这功能'）", () => {
    const gap = gapFromEffectivity(entry({ declared: false, effectivity: 0, available: false }), {
      blockedIntentionId: "itn-1",
      missing: "不知道有没有这个工具",
    });
    expect(gap?.kind).toBe("knowledge");
    expect(gap?.affordancePresent).toBe(0);
  });
});

describe("forge：四级阶梯", () => {
  it("按 probe → learn → rehearse → forge 前进，每级给一句理由", () => {
    expect(advanceLadder(progress(), { forgeWithinBudget: false, askHelp: askHelp(), stalled: false }).stage).toBe("probe");
    expect(advanceLadder(progress({ probed: true }), { forgeWithinBudget: false, askHelp: askHelp(), stalled: false }).stage).toBe("learn");
    expect(advanceLadder(progress({ probed: true, learned: true }), { forgeWithinBudget: false, askHelp: askHelp(), stalled: false }).stage).toBe("rehearse");
    const forge = advanceLadder(progress({ probed: true, learned: true, rehearsed: true }), {
      forgeWithinBudget: true,
      askHelp: askHelp({ attempts: 1 }),
      stalled: false,
    });
    expect(forge.stage).toBe("forge");
    expect(forge.requiresReview).toBe(false);
  });

  it("到 forge 但超预算：不自己造，标记需审核（不是抛异常给调用方）", () => {
    const decision = advanceLadder(progress({ probed: true, learned: true, rehearsed: true }), {
      forgeWithinBudget: false,
      askHelp: askHelp({ attempts: 1 }),
      stalled: false,
    });
    expect(decision.action).toBe("forge");
    expect(decision.requiresReview).toBe(true);
    expect(decision.reason).toContain("审核");
  });

  it("attempts ≥5 放弃，不再产生候选（这是规则，不是建议）", () => {
    const decision = advanceLadder(progress({ attempts: 5 }), { forgeWithinBudget: false, askHelp: askHelp(), stalled: false });
    expect(decision.action).toBe("give_up");
    expect(decision.stage).toBeNull();
  });

  it("试过 ≥2 次且停滞 → 先开口求助，而不是继续硬试", () => {
    const decision = advanceLadder(progress({ probed: true, learned: true, rehearsed: false, attempts: 3 }), {
      forgeWithinBudget: false,
      askHelp: askHelp({ attempts: 3 }),
      stalled: true,
    });
    expect(decision.action).toBe("ask_help");
    expect(decision.reason).toContain("tried");
  });

  it("attempts<2 时即使停滞也不能求助（没试过就叫撒娇，规格明确）", () => {
    const decision = advanceLadder(progress({ attempts: 1 }), {
      forgeWithinBudget: false,
      askHelp: askHelp({ attempts: 1 }),
      stalled: true,
    });
    expect(decision.action).not.toBe("ask_help");
    expect(decision.stage).toBe("probe");
  });
});

describe("forge：造具计划", () => {
  it("有组合方案时默认走组合级（不动代码，这是渴望的默认产物）", () => {
    const plan = planForge({
      gap: { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 },
      availableTools: ["bili.search", "knowledge.write"],
      chain: ["bili.search", "knowledge.write"],
      selfTests: [{ name: "dry-run", passed: true }],
    });
    expect(plan.kind).toBe("composition");
    expect(plan.chain).toEqual(["bili.search", "knowledge.write"]);
  });

  it("组合里用了当前不可用的工具直接拒（先 probe，不假设）", () => {
    expect(() =>
      planForge({
        gap: { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 },
        availableTools: ["bili.search"],
        chain: ["bili.search", "wechat.send"],
      }),
    ).toThrow(/不可用/);
  });

  it("脚本级只能写到 scripts/forge/ 下；组合不了又不想写脚本 → 应该去求助", () => {
    const gap = { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 } as const;
    expect(() => planForge({ gap, availableTools: [], scriptFile: "src/evil.mjs" })).toThrow(/scripts\/forge/);
    expect(() => planForge({ gap, availableTools: [] })).toThrow(/求助/);
    const plan = planForge({ gap, availableTools: [], scriptFile: "scripts/forge/tidy.mjs", scriptLines: { added: 30, removed: 0 } });
    expect(plan.kind).toBe("script");
  });

  it("接入级一律要新凭证（人审），不需要她写文件", () => {
    const plan = planForge({
      gap: { blockedIntentionId: "i", missing: "m", kind: "permission", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 },
      availableTools: [],
      requiresNewCredentials: true,
      touchesUserVisibleChannels: ["wechat"],
      selfTests: [{ name: "credential-scope", passed: true }],
    });
    expect(plan.kind).toBe("integration");
    expect(plan.requiresNewCredentials).toBe(true);
    const decision = reviewForgePlan(plan, { capId: "cap-x", intentionId: "itn-x" });
    expect(decision.level).toBe("C");
  });

  it("组合级也过 review：自测未过 → D；自测全过且在预算内 → A", () => {
    const gap = { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 } as const;
    const failing = planForge({ gap, availableTools: ["a.b"], chain: ["a.b"], selfTests: [{ name: "smoke", passed: false }] });
    expect(reviewForgePlan(failing, { capId: "c1", intentionId: "i1" }).level).toBe("D");

    const passing = planForge({ gap, availableTools: ["a.b"], chain: ["a.b"], selfTests: [{ name: "smoke", passed: true }] });
    const changeSet = toChangeSet(passing, { capId: "c2", intentionId: "i2" });
    expect(changeSet.selfTestPassed).toBe(true);
    expect(reviewForgePlan(passing, { capId: "c2", intentionId: "i2" }).level).toBe("A");
  });

  it("没有自测清单 = 自测未过 → D（三关缺一不可）", () => {
    const gap = { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 } as const;
    const plan = planForge({ gap, availableTools: ["a.b"], chain: ["a.b"] });
    expect(reviewForgePlan(plan, { capId: "c3", intentionId: "i3" }).level).toBe("D");
  });
});

describe("forge：能力账本", () => {
  it("添加/查询/统计；同 capId 视为新版本覆盖（历史在 WAL，不在账本）", () => {
    const ledger = new CapabilityLedger();
    ledger.add(record({ status: "quarantined" }));
    ledger.add(record({ status: "active" }));
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.get("cap-1")?.status).toBe("active");
    const stats = ledger.stats();
    expect(stats).toMatchObject({ total: 1, quarantined: 0, active: 1, retired: 0, improved: 1 });
    expect(stats.promotionRate).toBe(1);
    expect(describeLedgerStats(stats)).toContain("在用 1");
  });

  it("退役幂等；不存在的 capId 不能静默成功", () => {
    const ledger = CapabilityLedger.from([record()]);
    expect(ledger.retire("cap-1").status).toBe("retired");
    expect(ledger.retire("cap-1").status).toBe("retired");
    expect(() => ledger.retire("cap-404")).toThrow(/没有/);
  });

  it("观察期满且效力提升才给出可转正列表（不自动转正）", () => {
    const ledger = CapabilityLedger.from([
      record({ capId: "old-good", createdAt: new Date(NOW_MS - 2 * 24 * 3600_000).toISOString() }),
      record({ capId: "new-good", createdAt: new Date(NOW_MS - 3600_000).toISOString() }),
      record({ capId: "old-flat", createdAt: new Date(NOW_MS - 2 * 24 * 3600_000).toISOString(), effectivityBefore: 0.1, effectivityAfter: 0.1 }),
      record({ capId: "old-active", createdAt: new Date(NOW_MS - 2 * 24 * 3600_000).toISOString(), status: "active" }),
    ]);
    const due = ledger.promoteDue(NOW_MS).map((item) => item.capId);
    expect(due).toEqual(["old-good"]);
    expect(QUARANTINE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("记录不合法会抛错（不把坏数据放进账本）", () => {
    const ledger = new CapabilityLedger();
    expect(() => ledger.add(record({ capId: "" }))).toThrow(/不合法/);
    expect(() => ledger.add(record({ effectivityAfter: 1.5 }))).toThrow(/\[0,1\]/);
    expect(validateCapabilityRecord(record())).toEqual([]);
  });

  it("解析 WAL 行：坏行计数、wrapped/裸 record 都认", () => {
    const good = JSON.stringify({ record: record() });
    const bare = JSON.stringify(record({ capId: "cap-2" }));
    const { records, corrupt, errors } = parseCapabilityLines([good, "not json", bare, '{"capId":""}']);
    expect(records.map((item) => item.capId)).toEqual(["cap-1", "cap-2"]);
    expect(corrupt).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("由计划生成初始记录：kind 映射正确、默认 quarantined、测试清单带进去", () => {
    const gap = { blockedIntentionId: "i", missing: "m", kind: "skill", affordancePresent: 1, effectivity: 0, empowermentGain: 0.6, progressEst: 0.5, selfEfficacy: 0.5, selfEfficacy_eff: 0.5, learnCost: 0.2 } as const;
    const plan: ForgePlan = planForge({ gap, availableTools: ["a.b"], chain: ["a.b"], selfTests: [{ name: "smoke", passed: true }] });
    const initial = initialCapabilityRecord(plan, {
      capId: "cap-9",
      intentionId: "itn-9",
      effectivityBefore: 0,
      effectivityAfter: 0.5,
      riskCeiling: 1,
      createdAt: NOW_ISO,
    });
    expect(initial).toMatchObject({ capId: "cap-9", kind: "tool", tool: "a.b", status: "quarantined" });
    expect(initial.tests).toEqual([{ name: "smoke", passed: true }]);
  });
});
