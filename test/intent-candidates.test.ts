import { describe, expect, it } from "vitest";
import {
  MAX_PER_KIND,
  PROBE_SEED,
  affordanceFamily,
  composePlanSeeds,
  generateCandidates,
  isFeasible,
  type CandidateContext,
} from "../src/orchestrator/intent/candidates.js";
import { buildSituation } from "../src/orchestrator/intent/situation.js";
import { validateDriveImpact } from "../src/orchestrator/intent/scoring.js";
import { MAX_CANDIDATES, type Affordance, type DriveVector } from "../src/orchestrator/intent/types.js";

const ALL_AFFORDANCES: Affordance[] = [
  { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
  { tool: "bili.read", risk: 0, requiresLogin: true, rateLimited: false },
  { tool: "local.write", risk: 1, requiresLogin: false, rateLimited: false },
  { tool: "desktop.screen", risk: 0, requiresLogin: false, rateLimited: false },
];

const DRIVE: DriveVector = {
  energy: 0.8,
  integrity: 0.6,
  connection: 0.7,
  competence: 0.4,
  novelty: 0.6,
  coherence: 0.5,
};

function frame(overrides: { localHour?: number; affordances?: Affordance[] } = {}) {
  return buildSituation({
    at: "2026-10-31T14:00:00.000Z",
    localHour: overrides.localHour ?? 14,
    channel: "qq",
    participants: ["owner"],
    affordances: overrides.affordances ?? ALL_AFFORDANCES,
    sinceLastContactMin: 200,
    activeIntents: [],
    budget: { rph: 8, peak: false },
  });
}

function ctx(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    frame: frame(),
    drive: DRIVE,
    threads: [
      { id: "m-1", title: "昨晚的事", staleMin: 320 },
      { id: "m-2", title: "待办的截图", staleMin: 90 },
    ],
    needsRepair: true,
    identityFit: { reach_out: 0.8 },
    experienceSeeds: { reach_out: ["上次直接问「在吗」她回了"] },
    ...overrides,
  };
}

describe("B1 候选生成（§4.5：按类别覆盖，不按分数取前 N）", () => {
  it("工具能力族只认已知前缀，未知归 other（不猜）", () => {
    expect(affordanceFamily("qq.send_text")).toBe("message");
    expect(affordanceFamily("bili.read")).toBe("read");
    expect(affordanceFamily("web.search")).toBe("read");
    expect(affordanceFamily("memory.recall")).toBe("read");
    expect(affordanceFamily("desktop.screen")).toBe("desktop");
    expect(affordanceFamily("local.write")).toBe("write");
    expect(affordanceFamily("something.else")).toBe("other");
    expect(affordanceFamily("")).toBe("other");
  });

  it("全部条件满足时：7 类各至少 1 个，continue_thread 用满每类配额，总数 ≤ 8", () => {
    const candidates = generateCandidates(ctx());
    const kinds = new Set(candidates.map((candidate) => candidate.kind));
    expect(candidates.length).toBe(8);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const kind of ["reach_out", "continue_thread", "explore", "create", "repair", "withdraw", "idle"] as const) {
      expect(kinds.has(kind), `${kind} 没被生成（被分数挤掉了？）`).toBe(true);
    }
    const threads = candidates.filter((candidate) => candidate.kind === "continue_thread");
    expect(threads.length).toBe(MAX_PER_KIND);
    expect(new Set(threads.map((candidate) => candidate.goal))).toEqual(
      new Set(["想把「昨晚的事」接上", "想把「待办的截图」接上"]),
    );
  });

  it("候选按分数降序，且每个候选都有合法影响、有动作种子、分数是有限数", () => {
    const candidates = generateCandidates(ctx());
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      expect(Number.isFinite(candidate.score)).toBe(true);
      expect(validateDriveImpact(candidate.kind, candidate.drive_impact)).toEqual([]);
      expect(candidate.planSeeds.length).toBeGreaterThanOrEqual(1);
      expect(candidate.planSeeds.length).toBeLessThanOrEqual(3);
      expect(candidate.because.length).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(candidates[index - 1]!.score).toBeGreaterThanOrEqual(candidate.score);
    }
  });

  it("条件不满足就不生成，而不是给个 0 分凑数", () => {
    const lowAll: DriveVector = {
      energy: 0.1,
      integrity: 0.1,
      connection: 0.1,
      competence: 0.1,
      novelty: 0.1,
      coherence: 0.1,
    };
    const none = generateCandidates(
      ctx({ drive: lowAll, threads: [], needsRepair: false, frame: frame({ affordances: [] }) }),
    );
    expect(none.map((candidate) => candidate.kind)).toEqual(["idle"]);

    // 有连接缺口但没有发消息的能力 → reach_out 不可行
    const noMessage = generateCandidates(
      ctx({
        frame: frame({
          affordances: [{ tool: "bili.read", risk: 0, requiresLogin: true, rateLimited: false }],
        }),
      }),
    );
    expect(noMessage.map((candidate) => candidate.kind)).not.toContain("reach_out");
    expect(noMessage.map((candidate) => candidate.kind)).not.toContain("continue_thread");
    expect(noMessage.map((candidate) => candidate.kind)).not.toContain("repair");
    expect(noMessage.map((candidate) => candidate.kind)).toContain("explore");

    // 没有未完成的事 → 不生成 continue_thread；没有裂痕 → 不生成 repair
    const noFacts = generateCandidates(ctx({ threads: [], needsRepair: false }));
    expect(noFacts.map((candidate) => candidate.kind)).not.toContain("continue_thread");
    expect(noFacts.map((candidate) => candidate.kind)).not.toContain("repair");
  });

  it("isFeasible 与生成结果一致（idle 永远可行，这是合法结果）", () => {
    const context = ctx();
    for (const kind of ["reach_out", "continue_thread", "explore", "create", "repair", "withdraw", "idle"] as const) {
      const feasible = isFeasible(kind, context);
      const generated = generateCandidates(context).some((candidate) => candidate.kind === kind);
      expect(generated).toBe(feasible);
    }
    expect(isFeasible("idle", ctx({ frame: frame({ affordances: [] }) }))).toBe(true);
  });

  it("planSeeds 三级来源：模板 → 经验 → 工具 schema，最多 3 条；全空才给探测动作", () => {
    const noExperience = composePlanSeeds("reach_out", ALL_AFFORDANCES, [], ["发一条问候"]);
    expect(noExperience.length).toBe(3);
    expect(noExperience[0]).toBe("发一条问候");

    const withExperience = composePlanSeeds(
      "reach_out",
      [],
      ["上次直接问「在吗」她回了"],
      ["发一条问候"],
    );
    expect(withExperience).toEqual(["发一条问候", "上次直接问「在吗」她回了"]);

    expect(composePlanSeeds("idle", [], [], [])).toEqual([PROBE_SEED]);

    const generated = generateCandidates(ctx());
    const reachOut = generated.find((candidate) => candidate.kind === "reach_out");
    expect(reachOut?.planSeeds).toContain("上次直接问「在吗」她回了");
    expect(reachOut?.cost.risk).toBe(1); // 取可用工具里最低风险，qq.send_text = 1
  });

  it("静默时段的 hardBlock 不参与打分（闸在 B2 之后，P0 不拦只会告警）", () => {
    const quietFrame = frame({ localHour: 23 });
    const quiet = generateCandidates(ctx({ frame: quietFrame }));
    const normal = generateCandidates(ctx());
    expect(quietFrame.hardBlocks).toContain("quiet_hours");
    expect(quiet.map((candidate) => [candidate.kind, candidate.score])).toEqual(
      normal.map((candidate) => [candidate.kind, candidate.score]),
    );
  });

  it("同输入同输出：连跑两次逐位相同（golden replay 的前提）", () => {
    const a = generateCandidates(ctx());
    const b = generateCandidates(ctx());
    expect(a).toEqual(b);
  });
});
