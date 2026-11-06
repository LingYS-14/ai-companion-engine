/**
 * 意向引擎 P0 —— B0 稳态投影（VISION-AUTONOMOUS-INTENT v0.3 §4.2）。
 *
 * 纪律（§4.0 / §8.1）：
 *   - **只读**：不写 S 层、不写记忆、不调模型、不碰检索权重；
 *   - **纯函数**：同一输入永远同一输出（P0 的 golden replay 靠这一条）；
 *   - **不新增运行期旋钮**：这里所有系数是**离线标定的工程先验值**（D2 裁决：P0 值可手算、可审计，
 *     真实轨迹出现后（P1）再标定），不是新的 `engine.json` 参数。
 *
 * 六个分量的来源严格按照 §4.2 的注释，不自己发明语义：
 *   energy     = 1 − state.energy
 *   integrity  = state.suppressionLoad
 *   connection = 关系阶段基线 + 距上次真实互动的线性爬升 − 主动了没人回的衰减
 *   competence = 近期失败率 + 未完成意图负载
 *   novelty    = 知识覆盖缺口（curiosity.coverageGap 的原值；没有知识时取中性 0.5）
 *   coherence  = 行为与 B 层价值排序的偏离度
 */

import { clamp01, type SState } from "../../engine/state.js";
import type { Stage } from "../../engine/bonds.js";
import type { DriveVector } from "./types.js";

/** 距上次真实互动到这个分钟数，connection 的「联系衰减」项爬满。3 小时 = 一次正常作息间隔。 */
export const CONTACT_FULL_GAP_MIN = 180;

/** 联系衰减在 connection 里占的权重（关系本身占剩余部分）。 */
export const CONTACT_WEIGHT = 0.35;

/**
 * 「主动了没人回」的衰减（D2 离线标定的工程先验值，不是运行期旋钮）。
 *
 * 连说 n 句没被回应：connection 在「想说话的顶格」上按 `1 − 0.45 × clamp01(n / 3)` 递减，
 * 即 1.0 → 0.85 → 0.70 → 0.55（n ≥ 3 封顶，越说越冷但不会凉透）。
 * 为什么是 3 句：连续三次没回应已经是「自说自话」的典型形态，再往上衰减的信息量很小。
 * 为什么是 0.45：它是对「已经顶格」的降温，不是断念——但 0.45 只在 stranger 顶格时
 * 落到 0.55；档位越高基线越低，最低点会下探到 familiar 0.50 / close 0.30 / beloved 0.15。
 * 也就是说：关系越近，连说几句没人回的后果越重（这是有意的，但要按 stage 看，别只按 stranger 验）。
 * 现阶段用它配合温和刹车，只当"降温"；reach_out 在 close/beloved 下能否仍然越阈，属 P2/P3 的标定问题。
 */
export const UNANSWERED_FULL_COUNT = 3;
export const UNANSWERED_DECAY = 0.45;

/**
 * 关系阶段 → connection 的**基线**未满足度。
 * 越亲近基线越低（常联系的人不需要主动补连接），但**不会归零**（再亲也会有"想说话"的时刻）。
 */
export const CONNECTION_BY_STAGE: Readonly<Record<Stage, number>> = {
  stranger: 0.8,
  familiar: 0.6,
  close: 0.4,
  beloved: 0.25,
};

/** 没有知识记录时 novelty 取中性值：既不假装"什么都不缺"，也不假装"缺口很大"。 */
export const DEFAULT_NOVELTY_GAP = 0.5;

/** competence 里「近期失败率」的权重；剩余给「未完成意图负载」。 */
export const COMPETENCE_FAILURE_WEIGHT = 0.6;

export interface DriveInput {
  /** 只读的 S 层快照（BrainPort.read 的 projection） */
  state: SState;
  /** 关系阶段（bonds.stageOf 的结果） */
  stage: Stage;
  /** 距上次真实互动的分钟数（≥0；无记录时传一个大数，由调用方决定口径） */
  sinceLastContactMin: number;
  /**
   * 上次真实来往之后，她主动开口但对方没回的条数（≥0；缺省 0 = 旧行为，不衰减）。
   * 只影响 connection 的「想说话」缺口，不进 contact 口径（真实来往的定义不变）。
   */
  unansweredOwnCount?: number;
  /** 近期动作失败率 [0,1]（来自意图 attempts / bandit 记录） */
  recentFailureRate: number;
  /** 未闭合意图数 */
  openIntentCount: number;
  /** 未闭合意图上限（0 表示"这一刻不允许挂起意图"，此时负载项记 0） */
  maxOpenIntents: number;
  /** 知识覆盖缺口 [0,1]；undefined = 没有知识记录 → 取中性值 */
  coverageGap?: number;
  /** 行为与 B 层价值排序的偏离度 [0,1] */
  valueDeviation: number;
}

function requireFinite(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`projectDrive: ${name} 必须是有限数字，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 把 S 层 + 情境的可观测量投影成六维缺口。
 *
 * 输入非法（NaN / 负分钟数 / 负意图数）直接抛 RangeError —— P0 宁可当场炸，也不把 NaN 带进打分。
 */
export function projectDrive(input: DriveInput): DriveVector {
  const energy = requireFinite("state.energy", input.state.energy);
  const suppressionLoad = requireFinite("state.suppressionLoad", input.state.suppressionLoad);
  const sinceLastContactMin = requireFinite("sinceLastContactMin", input.sinceLastContactMin);
  if (sinceLastContactMin < 0) {
    throw new RangeError(`projectDrive: sinceLastContactMin 不能为负，收到 ${sinceLastContactMin}`);
  }
  const unansweredOwnCount =
    input.unansweredOwnCount === undefined ? 0 : requireFinite("unansweredOwnCount", input.unansweredOwnCount);
  if (unansweredOwnCount < 0) {
    throw new RangeError(`projectDrive: unansweredOwnCount 不能为负，收到 ${unansweredOwnCount}`);
  }
  const recentFailureRate = requireFinite("recentFailureRate", input.recentFailureRate);
  const openIntentCount = requireFinite("openIntentCount", input.openIntentCount);
  if (openIntentCount < 0) {
    throw new RangeError(`projectDrive: openIntentCount 不能为负，收到 ${openIntentCount}`);
  }
  const maxOpenIntents = requireFinite("maxOpenIntents", input.maxOpenIntents);
  if (maxOpenIntents < 0) {
    throw new RangeError(`projectDrive: maxOpenIntents 不能为负，收到 ${maxOpenIntents}`);
  }
  const valueDeviation = requireFinite("valueDeviation", input.valueDeviation);
  const coverageGap =
    input.coverageGap === undefined ? DEFAULT_NOVELTY_GAP : requireFinite("coverageGap", input.coverageGap);

  const contactRamp = clamp01(sinceLastContactMin / CONTACT_FULL_GAP_MIN);
  const openRatio = maxOpenIntents === 0 ? 0 : clamp01(openIntentCount / maxOpenIntents);
  // 先夹住「关系基线 + 联系爬升」，再减主动了没人回的衰减：衰减是对"已经顶格"的降温，
  // 不是把爬升项也一起按比例缩放。unanswered=0 时 clamp01(clamp01(x)) === clamp01(x)，旧输出逐位不变。
  const connectionBase = clamp01(CONNECTION_BY_STAGE[input.stage] + CONTACT_WEIGHT * contactRamp);
  const unansweredRamp = clamp01(unansweredOwnCount / UNANSWERED_FULL_COUNT);

  return {
    energy: clamp01(1 - energy),
    integrity: clamp01(suppressionLoad),
    connection: clamp01(connectionBase - UNANSWERED_DECAY * unansweredRamp),
    competence: clamp01(
      COMPETENCE_FAILURE_WEIGHT * clamp01(recentFailureRate) +
        (1 - COMPETENCE_FAILURE_WEIGHT) * openRatio,
    ),
    novelty: clamp01(coverageGap),
    coherence: clamp01(valueDeviation),
  };
}
