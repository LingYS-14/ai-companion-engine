/**
 * 意向引擎 P1 前置 —— 主动性硬闸（VISION §4.5 #3 / §8.1 对 `shouldInitiate` 的降级）。
 *
 * 为什么要拆出这一层：现在的 `src/orchestrator/initiative.ts` 一眼看是"决定要不要开口"，其实混了三件事——
 *   ① 机械门（静默/冷却/日上限/开关）  ② 状态门（energy/trust）  ③ 话题挑选（ddProactive 的 pickTopic）。
 * VISION P1 要求把 `shouldInitiate` **降级成硬闸**：只保留四个否决（额度 / 静默 / 单写者 / 关系信任），
 * 决定"说什么"交给意图引擎的候选打分。这样"想不想说"和"能不能说"才分开——否则她又会回到
 * "状态好就发一条、状态不好就不发"的角色卡式行为。
 *
 * P0/P1 边界：本文件是**纯函数**，没有接进任何调用路径（没改 `initiative.ts`、没改 `proactive.ts`、没改 loop）。
 * 接线要等用户看过 `docs/DESIGN.md 的风险清单` 里的风险清单点头（会碰她说话的路径）。
 *
 * 否决的语义（顺序固定，便于审计与 golden 对拍）：
 *   1. `quota`          —— 本小时模型调用额度没了（`frame.budget.rph ≤ 0`）
 *   2. `single_writer`  —— 另一个进程持有写锁（`frame.hardBlocks` 含 `single_writer_conflict`）
 *   3. `distrust`       —— 关系信任未到下限（**只拦主动开口**；回消息不受它约束，见 F54 旧坑）
 *
 * **A6（2026-10-31 用户裁决 D1）**：静默时段不再是否决，降级成"情境"——
 * 她能看到"现在是凌晨 2 点"，由她在出口里判断"要不要说 / 先不说（HOLD）"。
 * 用死程序替她决定"深夜不许说话"，正是用户明确否掉的那件事。
 * `quiet` 仍留在 `GateVerdict` 里只是为了让旧日志/旧测试能读，不再由本函数产生。
 */

import type { IntentionRecord, SituationFrame } from "./types.js";
import { markBlocked } from "./bus.js";
import type { HardBlock } from "./situation.js";

/** 硬闸否决码。`speak` = 放行（不是"一定会说"，后面还有候选打分）。 */
export type GateVerdict = "speak" | "quota" | "quiet" | "single_writer" | "distrust";

export interface IntentHardGateInput {
  /** 情境帧（含额度、静默、单写者告警） */
  frame: SituationFrame;
  /** 关系信任（S 层 trust，0..1） */
  trust: number;
  /** 主动开口的关系信任下限（来自现有 StateGateThresholds.trustFloor，不新增旋钮） */
  trustFloor: number;
}

export interface GateDecision {
  readonly allowed: boolean;
  readonly verdict: GateVerdict;
  readonly note: string;
}

function blockedBy(block: HardBlock): GateVerdict | null {
  switch (block) {
    case "quiet_hours":
      // A6：静默只是事实（她看得到"现在几点"），不是否决。
      return null;
    case "single_writer_conflict":
      return "single_writer";
    case "rate_limited":
      return "quota";
    default:
      return null; // no_affordance 不拦"想"，只说明此刻做不了（§4.5 #3 的闸在动作层）
  }
}

/**
 * 四否决硬闸。纯函数、不读时钟、不写状态。
 * 额度与静默从 `frame.hardBlocks` 读，保证与 `buildSituation` 的判定是同一份事实（不重复实现）。
 */
export function intentHardGate(input: IntentHardGateInput): GateDecision {
  if (!Number.isFinite(input.trust)) {
    throw new RangeError(`intentHardGate: trust 必须是有限数字，收到 ${String(input.trust)}`);
  }
  if (input.frame.budget.rph <= 0) {
    return { allowed: false, verdict: "quota", note: "本小时模型调用额度用完了" };
  }
  for (const block of input.frame.hardBlocks) {
    const verdict = blockedBy(block as HardBlock);
    if (verdict === "single_writer") {
      return { allowed: false, verdict: "single_writer", note: "另一个进程正在写，先不抢" };
    }
    if (verdict === "quota") return { allowed: false, verdict: "quota", note: "本小时额度用完了" };
  }
  if (input.trust <= input.trustFloor) {
    return {
      allowed: false,
      verdict: "distrust",
      note: `trust ${input.trust.toFixed(3)} ≤ 下限 ${input.trustFloor}，不主动开口（回消息不受此限）`,
    };
  }
  return { allowed: true, verdict: "speak", note: "硬闸放行（静默只作情境），交给候选打分决定说什么" };
}

/**
 * 被硬闸拦下时，把原因写进意图记录（§4.5 #3 要求可审计）。
 * 放行时原样返回——**不**擅自改状态。
 */
export function applyHardGate(record: IntentionRecord, decision: GateDecision): IntentionRecord {
  if (decision.allowed) return record;
  return markBlocked(record, decision.verdict);
}
