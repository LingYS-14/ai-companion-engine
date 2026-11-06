/**
 * P2 跨重启一致性探针（纯函数；不读时钟、不写文件、不调模型）
 *
 * 规格验收（docs/DESIGN.md）：**跨重启一致性探针通过**。
 * 探针要回答的问题是：把一拍之后的状态落盘、进程重启、读回、再跑一拍——
 * 结果和"没重启过"是否逐字段相同。不同的话，说明有状态没进落盘形状（或读回时被默认值吞了），
 * 而这正是角色卡旧病（每次重启像换了个人）的工程根因。
 *
 * 做法：
 *   1. 用状态里的 accumulator/previousDrive 跑第一拍，得到结果 A；
 *   2. 把第一拍结束后的状态序列化 → 解析（模拟落盘/重启），断言往返相等；
 *   3. 用解析回来的状态再跑一拍，得到结果 B；
 *   4. 深比较 A、B 的摘要：任何一个数字不同都列出来，不吞。
 *
 * 注意：本探针只能证明"同一份落盘状态 + 同一份输入 → 同一份输出"；
 * 它不能证明"重启后读到的确实是上次的状态"——后者是装配点的责任（读文件失败要报错，
 * 不能静默用初始状态顶替，否则探针会绿着而行为已经漂了）。
 */

import type { IntentTickInput, IntentTickResult } from "./tick.js";
import { runIntentTick } from "./tick.js";
import {
  parseIntentState,
  serializeIntentState,
  stateEquals,
  type IntentRuntimeState,
} from "./state-file.js";
import type { Candidate, DriveVector, IntentKind, SituationFrame } from "./types.js";
import { DRIVE_KEYS, INTENT_KINDS } from "./types.js";
import type { Accumulator } from "./bus.js";

/** 一拍结果里"影响后续行为"的字段摘要（帧的时间戳等不影响决策的字段不进来）。 */
export interface TickDigest {
  readonly accumulator: Readonly<Record<IntentKind, number>>;
  readonly drive: Readonly<Record<string, number>>;
  readonly emitted: readonly IntentKind[];
  readonly candidates: readonly {
    readonly kind: IntentKind;
    readonly goal: string;
    readonly risk: number;
    readonly planSeeds: readonly string[];
  }[];
  readonly topKind: IntentKind | null;
  readonly gate: { readonly allowed: boolean; readonly verdict: string };
  readonly wouldSpeak: boolean;
  readonly narrative: readonly (string | null)[];
  readonly frame: { readonly at: string; readonly hardBlocks: readonly string[] };
}

function digestDrive(drive: DriveVector): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of DRIVE_KEYS) out[key] = drive[key];
  return out;
}

function digestAccumulator(acc: Accumulator): Record<IntentKind, number> {
  const out = {} as Record<IntentKind, number>;
  for (const kind of INTENT_KINDS) out[kind] = acc[kind];
  return out;
}

function digestCandidate(candidate: Candidate): TickDigest["candidates"][number] {
  return {
    kind: candidate.kind,
    goal: candidate.goal,
    risk: candidate.cost.risk,
    planSeeds: candidate.planSeeds,
  };
}

function digestFrame(frame: SituationFrame): TickDigest["frame"] {
  return { at: frame.at, hardBlocks: frame.hardBlocks };
}

/** 把一拍结果压成可比较的摘要（不含时间戳，避免"同一拍"被时间污染）。 */
export function digestTick(result: IntentTickResult): TickDigest {
  return {
    accumulator: digestAccumulator(result.accumulator),
    drive: digestDrive(result.drive),
    emitted: result.emitted,
    candidates: result.candidates.map(digestCandidate),
    topKind: result.top === null ? null : result.top.kind,
    gate: { allowed: result.gate.allowed, verdict: result.gate.verdict },
    wouldSpeak: result.wouldSpeak,
    narrative:
      result.narrative === null ? [null, null] : [result.narrative.line, result.narrative.whyLine ?? null],
    frame: digestFrame(result.frame),
  };
}

/** 深比较两份摘要；返回差异描述（空数组 = 完全相同）。 */
export function diffDigests(a: TickDigest, b: TickDigest, epsilon = 1e-9): string[] {
  const diffs: string[] = [];
  for (const kind of INTENT_KINDS) {
    if (Math.abs(a.accumulator[kind] - b.accumulator[kind]) > epsilon) {
      diffs.push(`accumulator.${kind}: ${String(a.accumulator[kind])} → ${String(b.accumulator[kind])}`);
    }
  }
  for (const key of DRIVE_KEYS) {
    const av = a.drive[key] ?? 0;
    const bv = b.drive[key] ?? 0;
    if (Math.abs(av - bv) > epsilon) diffs.push(`drive.${key}: ${String(av)} → ${String(bv)}`);
  }
  if (a.emitted.join(",") !== b.emitted.join(",")) diffs.push(`emitted: [${a.emitted.join(",")}] → [${b.emitted.join(",")}]`);
  if (a.candidates.length !== b.candidates.length) {
    diffs.push(`候选数: ${String(a.candidates.length)} → ${String(b.candidates.length)}`);
  } else {
    a.candidates.forEach((cand, index) => {
      const other = b.candidates[index];
      if (other === undefined) return;
      if (cand.kind !== other.kind) diffs.push(`候选[${String(index)}].kind: ${cand.kind} → ${other.kind}`);
      if (cand.goal !== other.goal) diffs.push(`候选[${String(index)}].goal 不同`);
      if (Math.abs(cand.risk - other.risk) > epsilon) diffs.push(`候选[${String(index)}].risk 不同`);
      if (cand.planSeeds.join("|") !== other.planSeeds.join("|")) diffs.push(`候选[${String(index)}].planSeeds 不同`);
    });
  }
  if (a.topKind !== b.topKind) diffs.push(`top: ${String(a.topKind)} → ${String(b.topKind)}`);
  if (a.gate.allowed !== b.gate.allowed) diffs.push(`gate.allowed: ${String(a.gate.allowed)} → ${String(b.gate.allowed)}`);
  if (a.gate.verdict !== b.gate.verdict) diffs.push(`gate.verdict: ${a.gate.verdict} → ${b.gate.verdict}`);
  if (a.wouldSpeak !== b.wouldSpeak) diffs.push(`wouldSpeak: ${String(a.wouldSpeak)} → ${String(b.wouldSpeak)}`);
  if (a.narrative[0] !== b.narrative[0]) diffs.push("narrative.line 不同");
  if (a.narrative[1] !== b.narrative[1]) diffs.push("narrative.whyLine 不同");
  if (a.frame.at !== b.frame.at) diffs.push("frame.at 不同");
  if (a.frame.hardBlocks.join(",") !== b.frame.hardBlocks.join(",")) diffs.push("frame.hardBlocks 不同");
  return diffs;
}

/** 用一份落盘状态跑一拍：把状态里的累积器/上一拍驱动塞进 tick 输入。 */
export function tickWithState(input: IntentTickInput, state: IntentRuntimeState): IntentTickResult {
  return runIntentTick({
    ...input,
    accumulator: state.accumulator,
    ...(state.previousDrive === null ? {} : { previousDrive: state.previousDrive }),
  });
}

export interface ConsistencyReport {
  readonly first: TickDigest;
  readonly second: TickDigest;
  /** 序列化 → 解析的往返是否逐字段相等。 */
  readonly stateRoundTrip: boolean;
  /** 两次运行的摘要是否完全一致。 */
  readonly consistent: boolean;
  readonly diffs: readonly string[];
  /** 一行结论，直接进日志/台账。 */
  readonly verdict: string;
}

/**
 * 跑一次跨重启探针：第一拍 → 落盘往返 → 第二拍，比较两拍。
 * 第二拍用的输入与第一拍完全相同（同一份情景/状态），只有累积器来自"读回来的状态"。
 */
export function runConsistencyProbe(input: IntentTickInput, state: IntentRuntimeState): ConsistencyReport {
  const firstResult = tickWithState(input, state);
  const first = digestTick(firstResult);

  const serialized = serializeIntentState({
    ...state,
    accumulator: firstResult.accumulator,
    previousDrive: firstResult.drive,
    lastTickAtMs: state.lastTickAtMs,
  });
  const roundTripped = requireState(serialized);
  const stateRoundTrip = stateEquals(roundTripped, {
    ...state,
    accumulator: firstResult.accumulator,
    previousDrive: firstResult.drive,
    lastTickAtMs: state.lastTickAtMs,
  });

  const secondResult = tickWithState(input, roundTripped);
  const second = digestTick(secondResult);
  const diffs = diffDigests(first, second);

  return {
    first,
    second,
    stateRoundTrip,
    consistent: stateRoundTrip && diffs.length === 0,
    diffs,
    verdict:
      stateRoundTrip && diffs.length === 0
        ? "跨重启一致：落盘往返相等，两次运行逐字段相同"
        : `跨重启不一致：${stateRoundTrip ? "" : "状态往返不等；"}${diffs.join("；")}`,
  };
}

/** 内部：解析失败直接抛（探针自己写出来的状态解析不了，是探针的 bug，不是调用方的）。 */
function requireState(serialized: string): IntentRuntimeState {
  const result = parseIntentState(serialized);
  if (result.state === null) {
    throw new Error(`一致性探针：自己序列化的状态解析失败：${result.errors.join("；")}`);
  }
  return result.state;
}
