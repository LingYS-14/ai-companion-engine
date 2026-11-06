/**
 * 自主运行的配置。
 *
 * 「她脱离本会话存在」= 一个常驻进程按自己的节奏跑 tick；本文件只描述节奏与边界，
 * 不描述她是谁（人格卡在 persona 里），也不描述她说什么（composer 负责）。
 *
 * 默认 `enabled: false`：骨架先能起、能测，是否真的开由用户拍板（见 docs/OPERATIONS.md 的五个待决项）。
 */

export interface AutonomyConfig {
  readonly enabled: boolean;
  /** 状态推进（S 层松弛、能量恢复、压力）间隔 */
  readonly stateIntervalMs: number;
  /** 学习（刷视频/搜索）间隔 */
  readonly learnIntervalMs: number;
  /** 每天几点做睡眠巩固（0–23，本地时间） */
  readonly consolidateHour: number;
  /**
   * 主动开口的检查间隔（真正的发送还有 minGap/每日上限/安静时段三道门）。
   * 默认 20min：常驻进程每 5min 问一次“要不要说话”本身不花钱，但太密会让
   * 连接需求高的时候很容易撞上额度；把检查粒度放缓，主动性才有空间让给 B 站。
   */
  readonly proactiveIntervalMs: number;
  /** 两次主动开口之间的最小间隔；默认 2h（真正的机械门在 dialogue/proactive.ts） */
  readonly proactiveMinGapMs: number;
  /** 每天最多主动开口几次；默认 3。0 = 关掉主动开口（仍保留回信） */
  readonly proactiveMaxPerDay: number;
  /**
   * 主动开口总开关：来自 `cordis.patch.yml` 的 `qq.proactive.enabled`。
   * 默认 true；关掉后循环不再规划 proactive（但 intentTick 照跑，意图仍会积累）。
   */
  readonly proactiveEnabled: boolean;
  /** 外部互动（刷 B 站 / 弹幕 / 评论 / 点赞）的检查间隔；默认 20min */
  readonly socialIntervalMs: number;
  /** 每天最多几个“对外动作”（弹幕 + 评论 + 点赞都算）；默认 4。0 = 关掉社交 */
  readonly socialDailyMax: number;
  /** 每天最多几条评论（评论比弹幕重）；默认 1 */
  readonly socialCommentDailyMax: number;
  /**
   * 内部言语的**检查粒度**（不是它真正的间隔）：循环每这么久问一次「该想点什么吗」，
   * 真正的间隔 = SELFTALK_INTERVAL_MS（注册表）× 峰谷缩放，由 port 里的定价层判定。
   * 拆成两层是因为节奏（brain）必须可单测，而峰谷折扣只影响经济性，不该污染 tick 规划。
   */
  readonly selfTalkIntervalMs: number;
  /** 单写者锁的过期时间：超过这个时间没心跳，才允许另一个进程接手 */
  readonly lockStaleMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  enabled: false,
  stateIntervalMs: 5 * MINUTE,
  learnIntervalMs: 45 * MINUTE,
  consolidateHour: 3,
  proactiveIntervalMs: 20 * MINUTE,
  proactiveMinGapMs: 2 * 60 * MINUTE,
  proactiveMaxPerDay: 3,
  proactiveEnabled: true,
  socialIntervalMs: 20 * MINUTE,
  socialDailyMax: 4,
  socialCommentDailyMax: 1,
  selfTalkIntervalMs: 5 * MINUTE,
  lockStaleMs: 10 * MINUTE,
};

function clampPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 计数类配置允许 0（0 通常表示“关掉”），所以不能复用 clampPositive。
 * 负数 / NaN / 小数都回落到缺省值或向下取整。
 */
function clampCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function resolveAutonomyConfig(raw?: Partial<AutonomyConfig> | null): AutonomyConfig {
  if (raw === undefined || raw === null) return DEFAULT_AUTONOMY;
  const hour = typeof raw.consolidateHour === "number" && Number.isFinite(raw.consolidateHour) ? Math.floor(raw.consolidateHour) : DEFAULT_AUTONOMY.consolidateHour;
  return {
    enabled: raw.enabled === true,
    stateIntervalMs: clampPositive(raw.stateIntervalMs, DEFAULT_AUTONOMY.stateIntervalMs),
    learnIntervalMs: clampPositive(raw.learnIntervalMs, DEFAULT_AUTONOMY.learnIntervalMs),
    consolidateHour: hour >= 0 && hour <= 23 ? hour : DEFAULT_AUTONOMY.consolidateHour,
    proactiveIntervalMs: clampPositive(raw.proactiveIntervalMs, DEFAULT_AUTONOMY.proactiveIntervalMs),
    proactiveMinGapMs: clampPositive(raw.proactiveMinGapMs, DEFAULT_AUTONOMY.proactiveMinGapMs),
    proactiveMaxPerDay: clampCount(raw.proactiveMaxPerDay, DEFAULT_AUTONOMY.proactiveMaxPerDay),
    proactiveEnabled: raw.proactiveEnabled !== false,
    socialIntervalMs: clampPositive(raw.socialIntervalMs, DEFAULT_AUTONOMY.socialIntervalMs),
    socialDailyMax: clampCount(raw.socialDailyMax, DEFAULT_AUTONOMY.socialDailyMax),
    socialCommentDailyMax: clampCount(raw.socialCommentDailyMax, DEFAULT_AUTONOMY.socialCommentDailyMax),
    selfTalkIntervalMs: clampPositive(raw.selfTalkIntervalMs, DEFAULT_AUTONOMY.selfTalkIntervalMs),
    lockStaleMs: clampPositive(raw.lockStaleMs, DEFAULT_AUTONOMY.lockStaleMs),
  };
}
