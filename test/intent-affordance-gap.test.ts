import { describe, expect, it } from "vitest";
import {
  describeAffordanceGap,
  desiredKindsWithGaps,
  detectAffordanceGaps,
  capabilityGapKindOf,
  capabilityMissingOf,
  gapKey,
  hasFamilyFor,
  helpTextFor,
  summarizeGapProbes,
} from "../src/orchestrator/intent/capability-signal.js";
import type { Affordance, DriveVector } from "../src/orchestrator/intent/types.js";

/** 六维驱动：默认全 0，按需覆盖（只写这次要考的那几维，别让别的维串味）。 */
function drive(overrides: Partial<DriveVector> = {}): DriveVector {
  return { energy: 0, integrity: 0, connection: 0, competence: 0, novelty: 0, coherence: 0, ...overrides };
}

function affordance(tool: string): Affordance {
  return { tool, risk: 0, requiresLogin: false, rateLimited: false };
}

describe("capability-signal: 从驱动里找缺口", () => {
  it("reach_out 的缺口越过阈值就进入候选，continue_thread / repair / withdraw 永不出现", () => {
    // 文件头写明：后三类不靠数值缺口，所以即便六维全满也不该产缺口。
    const desired = desiredKindsWithGaps(drive({ connection: 1, integrity: 1, energy: 1 }));
    expect(desired.map((item) => item.kind)).toEqual(["reach_out"]);
  });

  it("阈值边界：等于阈值算缺口（≥），差一点不算", () => {
    expect(desiredKindsWithGaps(drive({ connection: 0.45 })).map((item) => item.kind)).toEqual(["reach_out"]);
    expect(desiredKindsWithGaps(drive({ connection: 0.449 }))).toEqual([]);
  });

  it("非有限数直接抛，不静默当成 0", () => {
    expect(() => desiredKindsWithGaps(drive({ novelty: Number.NaN }))).toThrow(RangeError);
    expect(() => desiredKindsWithGaps(drive({ coherence: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
  });
});

describe("capability-signal: 缺哪种能力族", () => {
  it("空族（withdraw / idle）视为不需要工具", () => {
    expect(hasFamilyFor("withdraw", [])).toBe(true);
    expect(hasFamilyFor("idle", [])).toBe(true);
  });

  it("有对应能力族就没有缺口；没有才产出，且带上缺口大小", () => {
    const hasRead = [affordance("knowledge.read")];
    expect(detectAffordanceGaps({ drive: drive({ novelty: 0.8 }), affordances: hasRead })).toEqual([]);

    const gaps = detectAffordanceGaps({ drive: drive({ novelty: 0.8 }), affordances: [] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "explore", missingFamily: "read", desire: 0.8 });
  });

  it("create 需要写文件或操作桌面：有其中一个就算有能力，都没有才算缺口（取第一个缺失族）", () => {
    const createDrive = drive({ coherence: 0.5 });
    expect(detectAffordanceGaps({ drive: createDrive, affordances: [affordance("desktop.screen")] })).toEqual([]);
    const gaps = detectAffordanceGaps({ drive: createDrive, affordances: [affordance("knowledge.read")] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "create", missingFamily: "write" });
  });

  it("多个缺口按缺口大小排序，同分按 INTENT_KINDS 顺序", () => {
    const both = detectAffordanceGaps({
      drive: drive({ connection: 0.5, novelty: 0.9, coherence: 0.9 }),
      affordances: [],
    });
    // 0.9 的 explore 与 0.9 的 create 同分 → explore 在前（INTENT_KINDS 里 explore 先）
    expect(both.map((gap) => gap.kind)).toEqual(["explore", "create", "reach_out"]);
  });

  it("gapKey 稳定、能跨拍累计同一个缺口", () => {
    const gap = { kind: "create" as const, missingFamily: "write" as const, desire: 0.5 };
    expect(gapKey(gap)).toBe("create:write");
    expect(gapKey({ kind: "create", missingFamily: "write" })).toBe(gapKey(gap));
  });

  it("一行日志带类别、缺失族和缺口值", () => {
    const line = describeAffordanceGap({ kind: "explore", missingFamily: "read", desire: 0.4321 });
    expect(line).toBe("explore 缺 read 能力（缺口 0.43）");
  });
});

describe("capability-signal: 求助正文（不编造尝试）", () => {
  it("create 缺写文件能力：what / ask / tried 三段人话，第 1 次只写看手边", () => {
    const text = helpTextFor({ kind: "create", missingFamily: "write", desire: 0.5 }, 1);
    expect(text.what).toContain("想做点东西");
    expect(text.what).toContain("写文件");
    expect(text.ask).toContain("写文件");
    expect(text.tried).toEqual(["先看看手边有什么能用的"]);
  });

  it("第 2 / 第 3 次起 tried 逐条增加，且不出现内部枚举词", () => {
    const second = helpTextFor({ kind: "create", missingFamily: "write", desire: 0.5 }, 2);
    expect(second.tried).toHaveLength(2);
    const third = helpTextFor({ kind: "create", missingFamily: "write", desire: 0.5 }, 3);
    expect(third.tried).toHaveLength(3);
    expect(third.tried[2]).toContain("3 次");
    // 三段都不该出现 kind / family 的机器名，否则等于把内部结构泄露给用户
    for (const part of [third.what, third.ask, ...third.tried]) {
      expect(part).not.toMatch(/create|write|desktop|reach_out|explore/);
    }
  });

  it("reach_out 缺发消息通道、explore 缺读能力，各自措辞不同", () => {
    expect(helpTextFor({ kind: "reach_out", missingFamily: "message", desire: 0.5 }, 1).what).toContain("找人说话");
    expect(helpTextFor({ kind: "explore", missingFamily: "read", desire: 0.5 }, 1).what).toContain("看看新东西");
  });

  it("attempts 非法直接抛，不把 0 次写成“试过了”", () => {
    const gap = { kind: "create" as const, missingFamily: "write" as const, desire: 0.5 };
    expect(() => helpTextFor(gap, 0)).toThrow(RangeError);
    expect(() => helpTextFor(gap, -1)).toThrow(RangeError);
    expect(() => helpTextFor(gap, Number.NaN)).toThrow(RangeError);
    expect(() => helpTextFor(gap, 1.9)).not.toThrow();
  });
});

describe("capability-signal: 观测汇总（按天算尝试）", () => {
  const DAY = 86_400_000;
  const base = Date.UTC(2026, 9, 31, 2, 0, 0);

  it("同一 UTC 日多次只算一次尝试；跨两天才是 2 次", () => {
    const probes = summarizeGapProbes(
      [
        { kind: "create", missingFamily: "write", at: base },
        { kind: "create", missingFamily: "write", at: base + 5 * 60_000 },
        { kind: "create", missingFamily: "write", at: base + DAY },
      ],
      base + DAY,
    );
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ kind: "create", missingFamily: "write", attempts: 2, firstAtMs: base, lastAtMs: base + DAY });
  });

  it("不同缺口分开汇总；想得久 / 更近的排前面；同分按 key 稳定", () => {
    const probes = summarizeGapProbes(
      [
        { kind: "explore", missingFamily: "read", at: base },
        { kind: "explore", missingFamily: "read", at: base + DAY },
        { kind: "create", missingFamily: "write", at: base },
      ],
      base + DAY,
    );
    expect(probes.map((probe) => gapKey(probe))).toEqual(["explore:read", "create:write"]);
  });

  it("窗口外的旧观测、以及落在 now 之后的行都不算", () => {
    const probes = summarizeGapProbes(
      [
        { kind: "create", missingFamily: "write", at: base - 8 * DAY },
        { kind: "create", missingFamily: "write", at: base + 5_000 },
      ],
      base,
    );
    expect(probes).toEqual([]);
  });

  it("desire 取见过的最大值；非法 nowMs / windowMs 抛", () => {
    const probes = summarizeGapProbes(
      [
        { kind: "explore", missingFamily: "read", at: base, desire: 0.4 },
        { kind: "explore", missingFamily: "read", at: base + 1, desire: 0.7 },
      ],
      base + DAY,
    );
    expect(probes[0]?.desire).toBe(0.7);
    expect(() => summarizeGapProbes([], Number.NaN)).toThrow(RangeError);
    expect(() => summarizeGapProbes([], 0, 0)).toThrow(RangeError);
  });

  it("缺口类别映射：读→knowledge、发消息→api、写/桌面→permission、别的→skill", () => {
    expect(capabilityGapKindOf({ missingFamily: "read" })).toBe("knowledge");
    expect(capabilityGapKindOf({ missingFamily: "message" })).toBe("api");
    expect(capabilityGapKindOf({ missingFamily: "write" })).toBe("permission");
    expect(capabilityGapKindOf({ missingFamily: "desktop" })).toBe("permission");
    expect(capabilityGapKindOf({ missingFamily: "other" })).toBe("skill");
    expect(capabilityMissingOf({ missingFamily: "write" })).toBe("写文件的能力");
  });
});
