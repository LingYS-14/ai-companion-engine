/**
 * P4 求助编排：该不该开口 → 说什么 → 发给谁（纯逻辑；不写文件、不读时钟、不发消息）
 *
 * `capability.ts` 只回答「该不该问」（§11.6.2 的触发条件 + 频率闸），`guardian.ts` 只回答
 * 「问完之后没人回怎么办」（超时/降频/额度）。中间那段一直缺：**由谁、在什么时候、把哪个缺口、
 * 变成一条什么形状的求助，并且同一天不要重复问**。本文件就是这一段，而且刻意只做纯函数：
 * 它不落盘也不发 QQ，所以"她会不会因为一个缺口连问三次"是可以用测试钉死的，不用等线上出事。
 *
 * 三条纪律（来自用户 m04764 难点 1 与 m04801）：
 *   1. 没有尝试过就不算求助（`tried` 必填）——撒娇和求助要分开；
 *   2. 同一缺口 24 小时内只问一次、全局 24 小时内最多两次（与 `capability.ts` 同一套阈值，不另起一套）；
 *   3. 问谁由"用户最近有没有活动"决定：活跃 → 发他；不在 → 交给 Lead 当监护人（`chooseGuardianTarget`）。
 */

import { shouldAskHelp, type CapabilityGap } from "./capability.js";
import {
  buildGuardianRequest,
  chooseGuardianTarget,
  MAX_ASK_CHARS,
  MAX_WHAT_CHARS,
  type GuardianRequest,
  type GuardianTarget,
} from "./guardian.js";
import { formatUtc } from "./episode.js";
import type { HelpNeed, HelpRequest } from "./types.js";

/** 同缺口/全局的"一天"按滚动 24 小时算（比自然日更保守：半夜问过，早上不会再问一次）。 */
export const ASK_WINDOW_MS = 24 * 60 * 60_000;
/** 一次求助最多列 5 条尝试：再多就变成日志，监护人读不动。 */
export const MAX_TRIED = 5;

export interface AskHistoryEntry {
  /** 确定性请求 id（同意图同分钟只会有一次） */
  readonly requestId: string;
  readonly intentionId: string;
  readonly askedAtMs: number;
}

export interface PlanAskHelpInput {
  readonly gap: Pick<CapabilityGap, "missing" | "kind">;
  readonly intentionId: string;
  /** 她卡在哪（用她自己的话） */
  readonly what: string;
  /** 希望监护人做什么 */
  readonly ask: string;
  /** 已经试过什么（至少 1 条） */
  readonly tried: readonly string[];
  readonly attempts: number;
  readonly selfEfficacyEff: number;
  readonly empowermentGain: number;
  /** 进展是否停滞（`progressStalled` 的结果；停滞才允许"我低效但值得做"这条通道） */
  readonly stalled: boolean;
  /** 最近的求助记录（调用方按 24h 窗口传，也可以多传，本文件自己裁） */
  readonly history: readonly AskHistoryEntry[];
  readonly nowMs: number;
  /** 用户最后一次真实活动的毫秒时间；null = 从未互动 */
  readonly ownerLastActiveMs: number | null;
}

export interface AskHelpPlan {
  readonly shouldAsk: boolean;
  /** 一句人话（要进日志/台账，所以不写"没事"这种空话） */
  readonly reason: string;
  readonly request: HelpRequest | null;
  readonly guardian: GuardianRequest | null;
  /** 该问谁（shouldAsk=false 时给 null） */
  readonly target: GuardianTarget | null;
  /** 真问出去之后要追加进历史的一条 */
  readonly historyAdd: AskHistoryEntry | null;
}

/** 缺口类型 → 求助类型（`HelpNeed` 只有五种，映射不超过这五种）。 */
export function needForGap(kind: CapabilityGap["kind"]): HelpNeed {
  switch (kind) {
    case "knowledge":
      return "knowledge";
    case "permission":
      return "permission";
    case "api":
      return "plugin";
    case "skill":
      return "unknown";
    case "physical":
      return "unknown";
  }
}

function validate(input: PlanAskHelpInput): void {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError(`planAskHelp: nowMs 非法：${String(input.nowMs)}`);
  }
  if (!Number.isFinite(input.attempts) || input.attempts < 0) {
    throw new RangeError(`planAskHelp: attempts 非法：${String(input.attempts)}`);
  }
  if (input.intentionId.trim() === "") throw new RangeError("planAskHelp: intentionId 不能为空");
  if (input.what.trim() === "") throw new RangeError("planAskHelp: what 不能为空");
  if (input.what.length > MAX_WHAT_CHARS) throw new RangeError(`planAskHelp: what 超过 ${String(MAX_WHAT_CHARS)} 字`);
  if (input.ask.trim() === "") throw new RangeError("planAskHelp: ask 不能为空");
  if (input.ask.length > MAX_ASK_CHARS) throw new RangeError(`planAskHelp: ask 超过 ${String(MAX_ASK_CHARS)} 字`);
  if (input.tried.length > MAX_TRIED) throw new RangeError(`planAskHelp: tried 最多 ${String(MAX_TRIED)} 条`);
  for (const item of input.tried) {
    if (item.trim() === "") throw new RangeError("planAskHelp: tried 里不能有空条目");
  }
  for (const entry of input.history) {
    if (entry.requestId.trim() === "") throw new RangeError("planAskHelp: history 里有空 requestId");
    if (!Number.isFinite(entry.askedAtMs) || entry.askedAtMs < 0) {
      throw new RangeError(`planAskHelp: history 时间非法：${String(entry.askedAtMs)}`);
    }
  }
}

/** 24 小时窗口内的求助次数（同缺口 / 全局）与"距离上次求助多少小时"。 */
export function askCounts(
  history: readonly AskHistoryEntry[],
  intentionId: string,
  nowMs: number,
): { readonly forGap: number; readonly global: number; readonly hoursSinceLastAsk: number | null } {
  let forGap = 0;
  let global = 0;
  let lastMs: number | null = null;
  for (const entry of history) {
    if (nowMs - entry.askedAtMs > ASK_WINDOW_MS) continue;
    global += 1;
    if (entry.intentionId === intentionId) forGap += 1;
    if (lastMs === null || entry.askedAtMs > lastMs) lastMs = entry.askedAtMs;
  }
  const hoursSinceLastAsk = lastMs === null ? null : (nowMs - lastMs) / 3_600_000;
  return { forGap, global, hoursSinceLastAsk };
}

function refusalReason(input: PlanAskHelpInput, forGap: number, global: number): string {
  if (input.attempts < 2) return `试的次数还不够（${String(input.attempts)} 次）——没试过就先开口叫撒娇，不是求助`;
  if (forGap >= 1) return "这个缺口 24 小时内已经问过一次了";
  if (global >= 2) return "24 小时内求助额度（2 次）已经用完";
  if (!input.stalled && !(input.selfEfficacyEff < 0.3 && input.empowermentGain >= 0.6)) {
    return "进展还在推进，也没有到「我干不了但值得干」——先自己再试一次";
  }
  return "被频率闸挡下（hoursSinceLastAsk 不足 24 小时）";
}

/**
 * 编排一次求助判定。顺序固定：合法性 → 已放弃 → 24h 窗口计数 → `shouldAskHelp` → 造请求 → 选收件人。
 * 任何一步不通过都返回 `shouldAsk=false` + 具体理由；返回 null 的字段表示"没造出来"，不是"空字符串"。
 */
export function planAskHelp(input: PlanAskHelpInput): AskHelpPlan {
  validate(input);
  const { forGap, global, hoursSinceLastAsk } = askCounts(input.history, input.intentionId, input.nowMs);
  const no = (reason: string): AskHelpPlan => ({
    shouldAsk: false,
    reason,
    request: null,
    guardian: null,
    target: null,
    historyAdd: null,
  });

  if (input.attempts >= 5) return no("已按规则放弃（试满 5 次，不再产生候选，也不再来问）");
  if (input.tried.length === 0) return no("还没试过任何一步——没有尝试的求助是撒娇，不是求助");

  const ask = shouldAskHelp(
    {
      attempts: input.attempts,
      selfEfficacyEff: input.selfEfficacyEff,
      empowermentGain: input.empowermentGain,
      hoursSinceLastAsk,
      asksTodayForGap: forGap,
      asksTodayGlobal: global,
    },
    { stalled: input.stalled },
  );
  if (!ask) return no(refusalReason(input, forGap, global));

  const request: HelpRequest = {
    blockedIntentionId: input.intentionId,
    what: input.what.trim(),
    tried: [...input.tried],
    need: needForGap(input.gap.kind),
    ask: input.ask.trim(),
  };
  const atIso = isoFromMs(input.nowMs);
  const guardian = buildGuardianRequest(request, atIso, input.nowMs);
  const target = chooseGuardianTarget({ nowMs: input.nowMs, ownerLastActiveMs: input.ownerLastActiveMs });
  const historyAdd: AskHistoryEntry = {
    requestId: guardian.requestId,
    intentionId: input.intentionId,
    askedAtMs: input.nowMs,
  };
  const who = target === "owner" ? "用户（他刚在）" : "Lead（用户不在，代当监护人）";
  return {
    shouldAsk: true,
    reason: `该开口了：${String(input.attempts)} 次没做成、缺口是「${input.gap.missing}」，问 ${who}`,
    request,
    guardian,
    target,
    historyAdd,
  };
}

/** 毫秒 → ISO（纯算术 UTC，不用本地时区；与 episode.ts 的 formatUtc 同口径）。 */
export function isoFromMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`isoFromMs: 毫秒非法：${String(ms)}`);
  return formatUtc(ms);
}

/** 一行日志（该问 / 不该问都要能一眼看出为什么）。 */
export function describeAskPlan(plan: AskHelpPlan): string {
  return plan.shouldAsk
    ? `求助：开口（${plan.target ?? "?"}）｜${plan.reason}`
    : `求助：这次不问｜${plan.reason}`;
}
