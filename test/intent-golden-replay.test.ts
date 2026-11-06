/**
 * P0 验收（§8.3）：**golden replay——同输入同输出 100% 可重放**。
 *
 * 这里把 P0 的纯函数端到端串起来：情境帧 → 稳态投影 → 候选生成 → 打分/排序 → 累积器 → 浮现 →
 * 意图记录（激活/尝试/被拦）→ 归因。三个场景覆盖"深夜想说话 / 白天想探索 / 静默+冲突+没额度"。
 *
 * 更新方式（只在**有意**改变行为时才用；改完必须 stepDiff 解释为什么）：
 *   INTENT_GOLDEN_UPDATE=1 node tools/run-vitest.mjs test/intent-golden-replay.test.ts
 * 平时跑：同输入两次必须得到逐字节相同的 JSON，且必须与 `spec/config/intent-golden.json` 完全一致。
 * 任何一处不确定性（Date、随机、Map 顺序）都会让这条测试炸——这正是它存在的意义。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialSState } from "../src/engine/state.js";
import type { Stage } from "../src/engine/bonds.js";
import { buildSituation } from "../src/orchestrator/intent/situation.js";
import { projectDrive } from "../src/orchestrator/intent/drive.js";
import { generateCandidates } from "../src/orchestrator/intent/candidates.js";
import { rankCandidates } from "../src/orchestrator/intent/scoring.js";
import {
  EMIT_THETA,
  activate,
  addAttempt,
  driftFromWidening,
  emittedKinds,
  gapWidening,
  initialAccumulator,
  markBlocked,
  newIntention,
  stepAccumulator,
} from "../src/orchestrator/intent/bus.js";
import { attributeOutcome } from "../src/orchestrator/intent/attribution.js";
import type { Affordance, DriveVector, SituationFrame } from "../src/orchestrator/intent/types.js";

const GOLDEN_PATH = join(process.cwd(), "spec/config/intent-golden.json");

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundDrive(drive: DriveVector): Record<string, number> {
  return Object.fromEntries(Object.entries(drive).map(([key, value]) => [key, round(value as number)]));
}

interface Scenario {
  name: string;
  state: { energy: number; suppressionLoad: number };
  stage: Stage;
  sinceLastContactMin: number;
  recentFailureRate: number;
  openIntentCount: number;
  maxOpenIntents: number;
  coverageGap: number;
  valueDeviation: number;
  localHour: number;
  channel: SituationFrame["channel"];
  affordances: Affordance[];
  rph: number;
  singleWriterConflict: boolean;
  threads: Array<{ id: string; title: string; staleMin: number }>;
  needsRepair: boolean;
  /** 累积器三次 tick 的固定噪声（golden 必须钉死随机源） */
  noise: [number, number, number];
  outcome: { predError: number; binding: number; hasIntentTrace: boolean };
}

const SCENARIOS: Scenario[] = [
  {
    name: "深夜她想找人说话",
    state: { energy: 0.4, suppressionLoad: 0.5 },
    stage: "close",
    sinceLastContactMin: 240,
    recentFailureRate: 0,
    openIntentCount: 1,
    maxOpenIntents: 5,
    coverageGap: 0.7,
    valueDeviation: 0.2,
    localHour: 23,
    channel: "qq",
    affordances: [
      { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
      { tool: "qq.send_image", risk: 1, requiresLogin: true, rateLimited: false },
    ],
    rph: 8,
    singleWriterConflict: false,
    threads: [{ id: "th-1", title: "昨天那件事", staleMin: 180 }],
    needsRepair: false,
    noise: [0.01, -0.02, 0.03],
    outcome: { predError: 0.35, binding: 0.8, hasIntentTrace: true },
  },
  {
    name: "白天她想去看/做点东西",
    state: { energy: 0.8, suppressionLoad: 0.1 },
    stage: "familiar",
    sinceLastContactMin: 30,
    recentFailureRate: 0.3,
    openIntentCount: 0,
    maxOpenIntents: 3,
    coverageGap: 0.55,
    valueDeviation: 0.1,
    localHour: 14,
    channel: "local",
    affordances: [
      { tool: "bili.read", risk: 0, requiresLogin: true, rateLimited: false },
      { tool: "local.file_write", risk: 1, requiresLogin: false, rateLimited: false },
    ],
    rph: 12,
    singleWriterConflict: false,
    threads: [],
    needsRepair: false,
    noise: [0, 0, 0],
    outcome: { predError: 0.1, binding: 0.2, hasIntentTrace: false },
  },
  {
    name: "静默时段 + 单写者冲突 + 没额度",
    state: { energy: 0.2, suppressionLoad: 0.9 },
    stage: "stranger",
    sinceLastContactMin: 720,
    recentFailureRate: 0.6,
    openIntentCount: 3,
    maxOpenIntents: 3,
    coverageGap: 0.9,
    valueDeviation: 0.5,
    localHour: 2,
    channel: "none",
    affordances: [],
    rph: 0,
    singleWriterConflict: true,
    threads: [],
    needsRepair: true,
    noise: [0.02, 0.02, 0.02],
    outcome: { predError: 0.9, binding: 0.1, hasIntentTrace: false },
  },
];

interface ScenarioResult {
  name: string;
  frame: SituationFrame;
  drive: Record<string, number>;
  candidates: Array<{ kind: string; goal: string; score: number }>;
  accumulator: Record<string, number>;
  emitted: string[];
  intention: { status: string; blocked_by: string | null; attempts: number };
  attribution: { target: string; agency: number; predError: number };
}

function runScenario(scenario: Scenario): ScenarioResult {
  const state = { ...initialSState(), ...scenario.state };
  const frame = buildSituation({
    at: "2026-10-31T03:20:00.000Z",
    localHour: scenario.localHour,
    channel: scenario.channel,
    participants: scenario.channel === "qq" ? ["owner"] : [],
    affordances: scenario.affordances,
    sinceLastContactMin: scenario.sinceLastContactMin,
    activeIntents: [],
    budget: { rph: scenario.rph, peak: false },
    singleWriterConflict: scenario.singleWriterConflict,
  });
  const drive = projectDrive({
    state,
    stage: scenario.stage,
    sinceLastContactMin: scenario.sinceLastContactMin,
    recentFailureRate: scenario.recentFailureRate,
    openIntentCount: scenario.openIntentCount,
    maxOpenIntents: scenario.maxOpenIntents,
    coverageGap: scenario.coverageGap,
    valueDeviation: scenario.valueDeviation,
  });
  const candidates = rankCandidates(
    generateCandidates({
      frame,
      drive,
      threads: scenario.threads,
      needsRepair: scenario.needsRepair,
    }),
  );

  // 三次 tick：drift 来自"缺口在扩大"的差分（同一 drive 连续两次 → 无扩大，只留衰减与噪声）
  let accumulator = initialAccumulator();
  const widening: DriveVector = gapWidening(drive, drive);
  for (const noise of scenario.noise) {
    accumulator = stepAccumulator(accumulator, {
      drift: driftFromWidening(widening),
      noise,
      noiseScale: 0.05,
    });
  }
  const emitted = emittedKinds(accumulator, [], EMIT_THETA);

  let intention = newIntention({
    id: "itn-1",
    at: "2026-10-31T03:20:00.000Z",
    kind: candidates[0]?.kind ?? "idle",
    goal: candidates[0]?.goal ?? "此刻没什么特别想做的",
    why: "golden replay 固定场景",
  });
  intention = activate(intention);
  intention = addAttempt(intention, {
    at: "2026-10-31T03:21:00.000Z",
    act: "试探性执行第一个 planSeed",
    outcome: "fail",
    agency: 0.4,
  });
  if (frame.hardBlocks.length > 0) intention = markBlocked(intention, frame.hardBlocks[0]!);

  const attribution = attributeOutcome({
    intentId: intention.id,
    predicted: "应该会被接住",
    observed: "没有立刻回应",
    predError: scenario.outcome.predError,
    binding: scenario.outcome.binding,
    hasIntentTrace: scenario.outcome.hasIntentTrace,
  });

  return {
    name: scenario.name,
    frame,
    drive: roundDrive(drive),
    candidates: candidates.map((candidate) => ({
      kind: candidate.kind,
      goal: candidate.goal,
      score: round(candidate.score),
    })),
    accumulator: Object.fromEntries(Object.entries(accumulator).map(([key, value]) => [key, round(value as number)])),
    emitted,
    intention: { status: intention.status, blocked_by: intention.blocked_by ?? null, attempts: intention.attempts.length },
    attribution: { target: attribution.attributedTo, agency: round(attribution.agency), predError: round(attribution.predError) },
  };
}

describe("§8.3 P0 验收：golden replay 同输入同输出 100% 可重放", () => {
  it("三个固定场景串完整管线：两次运行逐字节相同", () => {
    const first = JSON.stringify(SCENARIOS.map(runScenario));
    const second = JSON.stringify(SCENARIOS.map(runScenario));
    expect(second).toBe(first);
  });

  it("与 spec/config/intent-golden.json 完全一致（改行为必须显式更新并解释）", () => {
    const actual = SCENARIOS.map(runScenario);
    if (process.env.INTENT_GOLDEN_UPDATE === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify({ version: 1, scenarios: actual }, null, 2)}\n`, "utf8");
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
      version: number;
      scenarios: ScenarioResult[];
    };
    expect(golden.version).toBe(1);
    expect(golden.scenarios.map((scenario) => scenario.name)).toEqual(SCENARIOS.map((scenario) => scenario.name));
    expect(golden.scenarios).toEqual(actual);
  });

  it("场景语义自检：静默场景真被拦、白天场景真能做、深夜场景真有候选", () => {
    const [night, day, quiet] = SCENARIOS.map(runScenario);
    expect(night!.frame.hardBlocks).toContain("quiet_hours");
    expect(night!.candidates.length).toBeGreaterThan(0);
    expect(day!.frame.hardBlocks).toEqual([]);
    expect(day!.candidates.map((candidate) => candidate.kind)).toContain("explore");
    expect(quiet!.frame.hardBlocks).toEqual(["quiet_hours", "single_writer_conflict", "rate_limited", "no_affordance"]);
    expect(quiet!.emitted).toEqual([]); // 硬闸不参与打分，但此刻确实没有可浮现的候选
    expect(quiet!.intention.status).toBe("blocked");
    // 说明：本管线是"帧→候选→累积器→意图记录"的纯函数串，不经 `intentHardGate`；
    // 这里仍按 frame.hardBlocks 记第一项（A6 的"静默不再否决"由 test/intent-gate.test.ts 锁）。
    expect(quiet!.intention.blocked_by).toBe("quiet_hours");
  });
});
