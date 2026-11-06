/**
 * 意向引擎 P1 —— 一个 tick 的完整纯计算（VISION §4.3 / §4.5 #3）。
 *
 * 为什么要把「一个 tick」收成一个函数：P0 的九个模块各自是纯的，但调用顺序（帧 → 投影 → 候选 → 打分 →
 * 累积器 → 浮现 → 硬闸 → 自述）只在测试里手写过。P1 接线时若让 `proactive.ts` / `loop.ts` 各自拼一遍，
 * 两处迟早漂移——这正是 VISION 要修的「角色卡旧病」的同构版本。所以顺序只在这里写一次，
 * 插件、常驻进程、离线观测台都调它。
 *
 * 边界（P1 纪律）：
 *   - 本文件零 IO、零模型调用、不读时钟（`at` / `localHour` 由调用方给）；
 *   - **不发送任何东西**，只回答"这一拍她想做什么、硬闸放不放行"；
 *   - 硬闸只对"主动开口"用；回消息路径不经过本函数的 gate（F54 旧坑）。
 */

import type { Stage } from "../../engine/bonds.js";
import type { SState } from "../../engine/state.js";
import { driftFromWidening, emittedKinds, gapWidening, initialAccumulator, stepAccumulator, type Accumulator } from "./bus.js";
import { generateCandidates, type OpenThread } from "./candidates.js";
import { projectDrive, type DriveInput } from "./drive.js";
import { intentHardGate, type GateDecision } from "./gate.js";
import { narrateCandidate, type Narrative } from "./narrative.js";
import { rankCandidates } from "./scoring.js";
import { buildSituation, type SituationInput } from "./situation.js";
import { isSpeakKind, type Candidate, type DriveVector, type IntentKind, type SituationFrame } from "./types.js";

/** 一个 tick 的输入：情景事实 + 她此刻的状态 + 上一 tick 的累积器 */
export interface IntentTickInput {
  /** 情境事实（`at` / `localHour` 由调用方从 Clock 取好） */
  readonly situation: SituationInput;
  /** 只读 S 层快照（B0 投影用） */
  readonly state: SState;
  /** 关系阶段（`stageOf(bondProgress, stageBands(cfg))` 的结果） */
  readonly stage: Stage;
  /** 近期动作失败率 [0,1] */
  readonly recentFailureRate: number;
  /** 未闭合意图数 / 上限（maxOpenIntents=0 表示此刻不允许挂起） */
  readonly openIntentCount: number;
  readonly maxOpenIntents: number;
  /** 行为与 B 层价值排序的偏离度 [0,1] */
  readonly valueDeviation: number;
  /** 知识覆盖缺口；undefined = 没有知识记录（投影取中性 0.5） */
  readonly coverageGap?: number;
  /** 上次真实来往之后她主动开口但没被回应的条数（只衰减 connection；缺省 = 不衰减） */
  readonly unansweredOwnCount?: number;
  /** 关系信任（S 层 trust）与主动开口下限 */
  readonly trust: number;
  readonly trustFloor: number;
  /** 上一 tick 的累积器；缺省 = 全 0（进程刚起来） */
  readonly accumulator?: Readonly<Accumulator>;
  /** 上一 tick 的驱动向量；缺省 = 用本 tick（即 drift 全 0，第一拍不凭空憋出意图） */
  readonly previousDrive?: DriveVector;
  /** 距上一拍的时间（毫秒）；缺省 = 基准 5 分钟拍。λ 按时间折算，晚到的拍不会被少算。 */
  readonly dtMs?: number;
  /** 已有活跃意图（同类不再浮现） */
  readonly activeKinds?: readonly IntentKind[];
  /**
   * F312 同类重复刹车：窗口内已经说够次数的类别。候选与浮现都过滤掉这些类别——
   * 只是"这一拍别再重复这一类"，不动累积器、不改她已有的意图表。
   */
  readonly suppressedKinds?: readonly IntentKind[];
  /** 未完成的事（continue_thread 的唯一来源） */
  readonly threads?: readonly OpenThread[];
  readonly needsRepair?: boolean;
  readonly identityFit?: Readonly<Partial<Record<IntentKind, number>>>;
  /** 确定性噪声（P1 仍不引入 RNG；调用方可给固定序列便于回放） */
  readonly noise?: Readonly<Partial<Record<IntentKind, number>>>;
}

export interface IntentTickResult {
  readonly frame: SituationFrame;
  readonly drive: DriveVector;
  /** 本 tick 更新后的累积器（调用方负责持久化） */
  readonly accumulator: Accumulator;
  /** 按分数降序的候选（≤8） */
  readonly candidates: readonly Candidate[];
  /** 分数最高的候选；候选为空时 null */
  readonly top: Candidate | null;
  /** 本 tick 越阈浮现的类别（顺序固定）；空 = 这一拍什么都不想做 */
  readonly emitted: readonly IntentKind[];
  /** 硬闸判定（只对主动开口；回消息不经过它） */
  readonly gate: GateDecision;
  /** 硬闸放行且确有候选 = 这一拍"主"会主动开口 */
  readonly wouldSpeak: boolean;
  /** top 候选的自述（给 composeDialogue 的输入；null = 没候选） */
  readonly narrative: Narrative | null;
}

/** 把六维驱动 + 关系阶段投影成 tick 需要的 `DriveInput`。纯函数。 */
export function tickDriveInput(input: IntentTickInput): DriveInput {
  return {
    state: input.state,
    stage: input.stage,
    sinceLastContactMin: input.situation.sinceLastContactMin,
    recentFailureRate: input.recentFailureRate,
    openIntentCount: input.openIntentCount,
    maxOpenIntents: input.maxOpenIntents,
    valueDeviation: input.valueDeviation,
    ...(input.coverageGap === undefined ? {} : { coverageGap: input.coverageGap }),
    ...(input.unansweredOwnCount === undefined ? {} : { unansweredOwnCount: input.unansweredOwnCount }),
  };
}

/**
 * 跑一拍完整计算。顺序固定：帧 → 投影 → 候选 → 排序 → drift → 累积器 → 浮现 → 硬闸 → 自述。
 *
 * 第一拍（没有 previousDrive）**不产生 drift**：否则进程每次重启都会因为"状态从默认值跳变"
 * 白憋出一堆意图（P1 空转防抖，§4.5 #4）。
 */
export function runIntentTick(input: IntentTickInput): IntentTickResult {
  const frame = buildSituation(input.situation);
  const drive = projectDrive(tickDriveInput(input));

  // 累积器先算：它只依赖驱动与上一拍，不依赖候选。先算出来，才能让"憋到阈值的类别"
  // 参与"这一拍到底以什么为主"的判定（见下面的 top 选择）。
  const previous = input.accumulator ?? initialAccumulator();
  const widening = input.previousDrive === undefined ? null : gapWidening(input.previousDrive, drive);
  const accumulator = stepAccumulator(previous, {
    ...(widening === null ? {} : { drift: driftFromWidening(widening) }),
    ...(input.noise === undefined ? {} : { noise: input.noise }),
    ...(input.dtMs === undefined ? {} : { dtMs: input.dtMs }),
  });
  const suppressed = new Set<IntentKind>(input.suppressedKinds ?? []);
  const emitted = emittedKinds(accumulator, input.activeKinds ?? []).filter(
    (kind) => !suppressed.has(kind),
  );

  const candidates = rankCandidates(
    generateCandidates({
      frame,
      drive,
      ...(input.threads === undefined ? {} : { threads: input.threads }),
      ...(input.needsRepair === undefined ? {} : { needsRepair: input.needsRepair }),
      ...(input.identityFit === undefined ? {} : { identityFit: input.identityFit }),
    }),
  ).filter((candidate) => !suppressed.has(candidate.kind));
  // A8：候选排序回答"此刻做什么最划算"（idle 常常最划算），而浮现（emitted）回答"她憋不住了"。
  // 若这一拍有类别越阈，它就是这一拍的主导——只在越阈的类别里挑 top；否则才按分数挑。
  // 否则会出现线上看到的那种自相矛盾：emitted=reach_out/continue_thread，top 却是 idle，永远不开口。
  const emittedCandidates = emitted.length === 0 ? [] : candidates.filter((c) => emitted.includes(c.kind));
  const topPool = emittedCandidates.length > 0 ? emittedCandidates : candidates;
  const top = topPool.length === 0 ? null : (topPool[0] ?? null);

  const gate = intentHardGate({ frame, trust: input.trust, trustFloor: input.trustFloor });
  // A4：只有社会性出口（reach_out / continue_thread / repair）才算"要主动开口"。
  // withdraw/idle 是状态，explore/create 是做事——它们被 gate 放行不等于要说话。
  const wouldSpeak = gate.allowed && top !== null && isSpeakKind(top.kind);

  return {
    frame,
    drive,
    accumulator,
    candidates,
    top,
    emitted,
    gate,
    wouldSpeak,
    narrative: top === null ? null : narrateCandidate(top),
  };
}
