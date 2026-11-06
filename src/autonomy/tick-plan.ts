/**
 * tick 规划：只决定「这一轮该做什么」，不执行任何动作。
 *
 * 文件名从 `brain.ts` 改来（F270）：它住在脊髓层（`src/autonomy/`），
 * 而「大脑/脊髓」在这个项目里有明确分工——叫 brain 会让读代码的人以为它是
 * 决策层。名字只影响阅读，不影响行为。
 *
 * 拆成纯函数是为了能测：常驻进程最怕的是「时钟一改行为就变」，而动作（推进状态、
 * 学习、巩固、主动开口）都有副作用，不能靠跑真实进程来验证节奏。
 */

import type { AutonomyConfig } from "./config.js";

export type AutonomyAction = "tick" | "learn" | "consolidate" | "proactive" | "selftalk" | "social";

export interface TickHistory {
  /** 上次推进状态（毫秒时间戳），没跑过为 0 */
  readonly lastStateAt: number;
  /** 上次学习，没跑过为 0 */
  readonly lastLearnAt: number;
  /** 上次主动开口检查，没跑过为 0 */
  readonly lastProactiveAt: number;
  /** 上次内部言语（自言自语），没跑过为 0 */
  readonly lastSelfTalkAt: number;
  /** 上次外部互动（刷 B 站 / 弹幕 / 评论），没跑过为 0 */
  readonly lastSocialAt: number;
  /** 上次睡眠巩固的本地日期（YYYY-MM-DD），没跑过为 "" */
  readonly lastConsolidateDay: string;
}

export const EMPTY_HISTORY: TickHistory = {
  lastStateAt: 0,
  lastLearnAt: 0,
  lastProactiveAt: 0,
  lastSelfTalkAt: 0,
  lastSocialAt: 0,
  lastConsolidateDay: "",
};

export interface TickPlan {
  readonly actions: readonly AutonomyAction[];
  readonly reason: string;
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 *
 * 用纯算术做「历日 → 年月日」换算（Howard Hinnant 的 civil_from_days），不碰 Date：
 * lint:writers 只允许 `src/engine/clock.ts` 读时钟，而这里需要的是「给定毫秒数算日期」，
 * 不是「读现在几点」——纯函数才能被测试和复用。
 */
export function dayKey(now: number, offsetMinutes = 0): string {
  const days = Math.floor((now + offsetMinutes * 60_000) / 86_400_000);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface TickInput {
  readonly now: number;
  /** 本地小时（0–23），用来判断巩固时刻 */
  readonly localHour: number;
  readonly localDay: string;
  readonly history: TickHistory;
  readonly config: AutonomyConfig;
}

export function planTick(input: TickInput): TickPlan {
  const { now, history, config } = input;
  const actions: AutonomyAction[] = [];
  const reasons: string[] = [];

  if (now - history.lastStateAt >= config.stateIntervalMs) {
    actions.push("tick");
    reasons.push("state due");
  }
  if (now - history.lastLearnAt >= config.learnIntervalMs) {
    actions.push("learn");
    reasons.push("learn due");
  }
  if (input.localHour === config.consolidateHour && history.lastConsolidateDay !== input.localDay) {
    actions.push("consolidate");
    reasons.push("sleep consolidate");
  }
  if (config.proactiveEnabled && now - history.lastProactiveAt >= config.proactiveIntervalMs) {
    actions.push("proactive");
    reasons.push("proactive check");
  }
  if (now - history.lastSelfTalkAt >= config.selfTalkIntervalMs) {
    actions.push("selftalk");
    reasons.push("selftalk due");
  }
  if (now - history.lastSocialAt >= config.socialIntervalMs) {
    actions.push("social");
    reasons.push("social due");
  }

  return { actions, reason: reasons.length === 0 ? "nothing due" : reasons.join(", ") };
}

/** 执行完一轮后推进历史；只推进真正跑过的动作 */
export function advanceHistory(
  history: TickHistory,
  ran: readonly AutonomyAction[],
  now: number,
  localDay: string,
): TickHistory {
  return {
    lastStateAt: ran.includes("tick") ? now : history.lastStateAt,
    lastLearnAt: ran.includes("learn") ? now : history.lastLearnAt,
    lastProactiveAt: ran.includes("proactive") ? now : history.lastProactiveAt,
    lastSelfTalkAt: ran.includes("selftalk") ? now : history.lastSelfTalkAt,
    lastSocialAt: ran.includes("social") ? now : history.lastSocialAt,
    lastConsolidateDay: ran.includes("consolidate") ? localDay : history.lastConsolidateDay,
  };
}
