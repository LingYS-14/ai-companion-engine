/**
 * 能量决定「这一拍还有多少力气好奇」。
 *
 * P3 把能量接进了行为：醒着持续耗能、说话/学习/内部言语按事件扣费、睡着回血。
 * 于是「累」不再只是一个数字——累的时候她应该做便宜的事（瞄一眼热榜、不深读、少搜索），
 * 有精神的时候才继续翻陌生主题。这一层只做**分档**，不搜索、不写库、不调模型。
 *
 * 边界（为什么函数这么"窄"）：
 *   - 纯函数、零 IO、不读时钟：同一个能量必然得到同一个档位，可复现、可单测。
 *   - 阈值 0.6 / 0.4 / 0.25 是工程先验（同 D2 先例），首版实验值，7 天后按能量曲线与
 *     知识入库速率再决定是否升进 overlay；不改 `planTick` / `learnIntervalMs` / 轮转。
 *   - 低能量不是惩罚：`skip` 只在能量贴地时出现，睡眠回血 1.0/h 会把它带回来。
 *   - 分数边界按「>」判：0.6 → search、0.4 → hot、0.25 → skip（正好卡在阈值上视为已降档）。
 */

/** 这一拍能拿出的学习力气：full=正常 / search=只搜不深读 / hot=只拉热榜 / skip=完全休息 */
export type LearnTier = "full" | "search" | "hot" | "skip";

/** full 档下限（> 0.6） */
export const LEARN_TIER_FULL_MIN_ENERGY = 0.6;
/** search 档下限（> 0.4） */
export const LEARN_TIER_SEARCH_MIN_ENERGY = 0.4;
/** hot 档下限（> 0.25） */
export const LEARN_TIER_HOT_MIN_ENERGY = 0.25;

function assertEnergy(energy: number): void {
  if (!Number.isFinite(energy) || energy < 0) {
    throw new RangeError(`能量必须是 >= 0 的有限数字（收到 ${String(energy)}）`);
  }
}

function assertTier(tier: LearnTier): void {
  if (tier !== "full" && tier !== "search" && tier !== "hot" && tier !== "skip") {
    throw new RangeError(`未知的学习档位：${String(tier)}`);
  }
}

/**
 * 按能量分档。
 *
 * > 0.6 → full；0.4 < e ≤ 0.6 → search；0.25 < e ≤ 0.4 → hot；e ≤ 0.25 → skip。
 */
export function learnTierOf(energy: number): LearnTier {
  assertEnergy(energy);
  if (energy > LEARN_TIER_FULL_MIN_ENERGY) return "full";
  if (energy > LEARN_TIER_SEARCH_MIN_ENERGY) return "search";
  if (energy > LEARN_TIER_HOT_MIN_ENERGY) return "hot";
  return "skip";
}

/**
 * 这一拍最多深读几条视频笔记。
 *
 * 只有 full 档深读；且**不改变既有上限**——`min(enrichPerRound, 1)`。
 * 想把上限提到 2 属于数值/行为政策变更（`LEARN_ENRICH_PER_ROUND` 是既有键），
 * 不是这一层能顺带做的。
 */
export function deepReadLimitOf(tier: LearnTier, enrichPerRound: number): number {
  assertTier(tier);
  if (!Number.isFinite(enrichPerRound) || enrichPerRound < 0) {
    throw new RangeError(`enrichPerRound 必须是 >= 0 的有限数字（收到 ${String(enrichPerRound)}）`);
  }
  if (tier !== "full") return 0;
  return Math.min(enrichPerRound, 1);
}

/** 这一拍要不要搜索（热榜不算搜索）。 */
export function shouldSearchOf(tier: LearnTier): boolean {
  assertTier(tier);
  return tier === "full" || tier === "search";
}

/** 这一拍要不要拉热榜（只有 skip 连热榜都停）。 */
export function shouldFetchHotOf(tier: LearnTier): boolean {
  assertTier(tier);
  return tier !== "skip";
}

/** 给日志看的一行：这一拍为什么是这个档（`[learn] energy=0.72 tier=full` 的前半段）。 */
export function learnTierReasonOf(energy: number, tier: LearnTier): string {
  assertEnergy(energy);
  assertTier(tier);
  return `energy=${energy.toFixed(2)} tier=${tier}`;
}
