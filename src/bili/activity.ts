/**
 * 社交互动决策：这次刷 B 站时到底做什么？
 *
 * 这是一个**纯函数**：不读时钟、不发请求、不写文件。输入全部由调用方（常驻进程的
 * socialImpl）从账本与运行时状态里取，输出一个动作 + 一句可写日志的原因。
 * 这样预算/冷却/优先级都能在单测里穷举，不需要 mock 网络。
 *
 * 优先级（由重到轻）：
 *   1. 先看/读视频（socialImpl 一定会先取详情，这一步不计入“动作”）；
 *   2. 弹幕（轻互动，额度内优先）；
 *   3. 评论（更重、更像“留下痕迹”，额度更少）；
 *   4. 点赞（最轻，只在没点过赞的视频上做，每视频一次）；
 *   5. 都不满足 → watch（只看不写），或 skip（不该出门）。
 *
 * 为什么 dailyMax 把点赞也算进去：点赞是“对外可见的动作”，全都不该无限刷。
 * 调用方通常把 danmaku 额度留出至少一个位置给点赞/评论——见 main.mjs 的推导。
 */

export type SocialAction = "watch" | "like" | "danmaku" | "comment" | "skip";

export interface SocialActivityConfig {
  /** 两次有内容互动之间的最小间隔（毫秒） */
  readonly intervalMs: number;
  /** 每天最多几个“对外动作”（弹幕 + 评论 + 点赞都算） */
  readonly dailyMax: number;
  readonly danmakuDailyMax: number;
  readonly commentDailyMax: number;
  /** 关掉点赞（照常发弹幕/评论） */
  readonly likeEnabled: boolean;
  /** 低于这个能量就只看不写；缺省 0.2 */
  readonly energyFloor?: number;
}

export interface SocialVideoState {
  readonly bvid: string;
  readonly durationSec: number;
  /** 这条视频是否已经点过赞（账本里查，跨天也有效） */
  readonly liked: boolean;
  /** 今天是否已经在这条视频下发过弹幕/评论（避免同一条反复刷） */
  readonly actedToday: boolean;
}

export interface SocialActivityInput {
  /** 当前毫秒时间戳；由调用方传入，纯函数不读时钟 */
  readonly now: number;
  /** 上一次成功互动的时间；没有则为 null */
  readonly lastActionAt: number | null;
  /** 今天已经成功的对外动作数（弹幕 + 评论 + 点赞） */
  readonly todayActions: number;
  readonly todayDanmaku: number;
  readonly todayComments: number;
  readonly video: SocialVideoState;
  /** 当前能量（0..1 量纲），低于下限就休息 */
  readonly energy: number;
  readonly asleep: boolean;
  /** 是否有可用登录态（sessdata + bili_jct）；没有就只能匿名浏览 */
  readonly hasSession: boolean;
  readonly config: SocialActivityConfig;
}

export interface SocialActivityPlan {
  readonly action: SocialAction;
  readonly reason: string;
  /** 仅 danmaku 有：弹幕出现位置（毫秒） */
  readonly progressMs?: number;
}

/** 缺省能量下限：低于它时“刷视频”本身都是浪费，先休息。 */
export const DEFAULT_SOCIAL_ENERGY_FLOOR = 0.2;

function count(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 弹幕放在视频约 30% 处，避免全挤在 0:00；极短视频退回开头。 */
function danmakuProgressMs(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const totalMs = Math.floor(durationSec * 1_000);
  const at = Math.floor(totalMs * 0.3);
  const latest = totalMs - 1_000;
  return Math.max(0, latest > 0 ? Math.min(at, latest) : 0);
}

export function planActivity(input: SocialActivityInput): SocialActivityPlan {
  const cfg = input.config;
  const energyFloor = cfg.energyFloor ?? DEFAULT_SOCIAL_ENERGY_FLOOR;
  const dailyMax = count(cfg.dailyMax, 0);
  const danmakuMax = count(cfg.danmakuDailyMax, 0);
  const commentMax = count(cfg.commentDailyMax, 0);
  const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : 0;

  if (input.asleep) {
    return { action: "skip", reason: "睡眠中：不刷 B 站" };
  }
  if (!Number.isFinite(input.energy) || input.energy < energyFloor) {
    return {
      action: "skip",
      reason: `能量 ${input.energy.toFixed(2)} 低于下限 ${energyFloor.toFixed(2)}：先休息`,
    };
  }
  // dailyMax=0 是“关掉对外互动”的显式配置；此时连匿名浏览也不必做。
  if (dailyMax === 0) {
    return { action: "skip", reason: "每日互动上限为 0：社交已关闭" };
  }
  const todayActions = count(input.todayActions, 0);
  if (!input.hasSession) {
    return { action: "watch", reason: "没有登录态：只浏览，不点赞/弹幕/评论" };
  }
  if (input.lastActionAt !== null && intervalMs > 0 && input.now - input.lastActionAt < intervalMs) {
    const waitMin = Math.ceil((intervalMs - (input.now - input.lastActionAt)) / 60_000);
    return { action: "skip", reason: `距离上次互动还差约 ${String(waitMin)} 分钟` };
  }
  if (input.video.actedToday) {
    return { action: "skip", reason: "今天已经在这条视频下互动过：换一条" };
  }

  // 额度满了不等于必须回屋：刷/读是主动性的主体，只是不再留下可见痕迹。
  if (todayActions >= dailyMax) {
    return { action: "watch", reason: `今日互动额度已满（${String(todayActions)}/${String(dailyMax)}）：只看不写` };
  }
  const todayDanmaku = count(input.todayDanmaku, 0);
  if (todayDanmaku < danmakuMax) {
    return {
      action: "danmaku",
      reason: `弹幕额度未满（${String(todayDanmaku)}/${String(danmakuMax)}）`,
      progressMs: danmakuProgressMs(input.video.durationSec),
    };
  }
  const todayComments = count(input.todayComments, 0);
  if (todayComments < commentMax) {
    return {
      action: "comment",
      reason: `评论额度未满（${String(todayComments)}/${String(commentMax)}）`,
    };
  }
  if (cfg.likeEnabled && !input.video.liked) {
    return { action: "like", reason: "弹幕/评论额度已用完：留一个赞" };
  }
  return { action: "watch", reason: "今天可做的互动都做完了：只看不写" };
}
