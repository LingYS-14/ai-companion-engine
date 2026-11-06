/**
 * DSH 方向一（在场信号）的 OS 侧数据源：Windows 的"最后一次键鼠输入"。
 *
 * 为什么需要它：A5 的处境里，她能知道的只有"他上一次说话是 N 小时前"——这和
 * "他是不是坐在电脑前"是两件事。用户 m09313 要的是"让她意识到我可能有事"，
 * 而不是让她以为"不说话 = 不在"。
 *
 * 这份数据不是她的推测：`GetLastInputInfo` 是操作系统事实（有键鼠输入就会刷新）。
 * 本模块只做**纯映射**：秒数 → "他在"/"他刚走"/"不知道"三态，不读时钟、不调系统调用
 * （探测由装配层 `scripts/autonomy/main.mjs` 通过 `tools/presence/activity.ps1` 完成）。
 */

/** 空闲秒数在这个范围内 = 他刚刚还在动键鼠（客户端在） */
export const PRESENCE_ACTIVE_MAX_IDLE_MS = 2 * 60_000;

/** 空闲超过这个时长 = 他离开电脑了（不是"在忙"，是"不在"） */
export const PRESENCE_AWAY_MIN_IDLE_MS = 10 * 60_000;

/** 信号新鲜度：超过这个时间没测过就不采信（防进程停摆后拿旧值骗她） */
export const PRESENCE_MAX_AGE_MS = 5 * 60_000;

/** 她会被告诉"他在电脑前/刚离开"的有效期（比探针周期长一点，避免两句之间失效） */
export const PRESENCE_TTL_MS = 6 * 60_000;

export interface InputActivity {
  /** 最后一次键鼠输入距今多少秒 */
  readonly idleSeconds: number;
  /** 这次测量的时间（毫秒时间戳） */
  readonly atMs: number;
}

/** 与 `situation-note.ts` 的 `SituationPresence` 形状一致（结构类型，不跨层 import）。 */
export interface PresenceSignal {
  readonly atMs: number;
  readonly active: boolean;
  readonly ttlMs: number;
}

/**
 * 解析 `activity.ps1` 的输出。形状不对返回 null（不抛——探测失败就当没有信号，
 * 不能因为 Windows API 小毛病让她"看见"一个假事实）。
 */
export function parseInputActivity(raw: unknown): InputActivity | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as { idleSeconds?: unknown; atMs?: unknown };
  const idleSeconds = obj.idleSeconds;
  const atMs = obj.atMs;
  if (typeof idleSeconds !== "number" || !Number.isFinite(idleSeconds) || idleSeconds < 0) return null;
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs <= 0) return null;
  return { idleSeconds: Math.floor(idleSeconds), atMs };
}

/**
 * 把"最后一次输入距今多久"映射成她能用的在场信号。
 *
 * 规则：
 * - 信号太旧（> `PRESENCE_MAX_AGE_MS`）→ null（不拿旧事实当现在）；
 * - 空闲 ≤2 分钟 → `active: true`（他刚动过电脑）；
 * - 空闲 >10 分钟 → `active: false`（他离开了）；
 * - 2–10 分钟之间 → null（"可能在看/可能在忙"，说不准就不说）。
 */
export function presenceFromActivity(activity: InputActivity, nowMs: number): PresenceSignal | null {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs 必须是有限数");
  const rawAge = nowMs - activity.atMs;
  // 探针在装配层是"稍后"才跑的，测得的 atMs 可能比这一拍的 nowMs 晚几百毫秒。
  // 把这点时钟先后当成"刚刚"（age=0），否则每次都会因为负年龄被判成"不知道"——
  // 线上真实吃过这个亏：idle 明明 <1 分钟，日志却写"不知道（不猜）"。
  if (activity.atMs - nowMs > PRESENCE_MAX_AGE_MS) return null; // 来自未来的时间戳：不可信
  const age = Math.max(0, rawAge);
  if (!Number.isFinite(age) || age > PRESENCE_MAX_AGE_MS) return null;
  const idleMs = activity.idleSeconds * 1000;
  if (idleMs <= PRESENCE_ACTIVE_MAX_IDLE_MS) {
    return { atMs: activity.atMs, active: true, ttlMs: PRESENCE_TTL_MS };
  }
  if (idleMs >= PRESENCE_AWAY_MIN_IDLE_MS) {
    return { atMs: activity.atMs, active: false, ttlMs: PRESENCE_TTL_MS };
  }
  return null;
}

/** 一行日志用（只在装配层观测时用，不进提示词）。 */
export function describeInputActivity(activity: InputActivity | null): string {
  if (activity === null) return "键鼠活动：没有测得（这拍按不知道处理）";
  const minutes = Math.floor(activity.idleSeconds / 60);
  return minutes === 0 ? "键鼠活动：1 分钟内有输入" : `键鼠活动：${String(minutes)} 分钟无输入`;
}
