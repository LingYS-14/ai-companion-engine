/**
 * 学习产出率 → 好奇缺口（审计 A8）。
 *
 * 为什么需要它：原来 `novelty = 1 − 平均 freshness`，而她每天学习会把 freshness 顶回 0.9，
 * 于是 curiosity 缺口恒等于 0.1，永远低于 explore 阈值 0.4——**越学越不想探索**。
 * 但真正该问的不是"知识新鲜不新鲜"，而是"这一轮有没有学到新东西"：
 * 搜了 5 条、全是已入库的旧视频（ingested=0），说明这块地已经挖空了，应该换主题；
 * 每轮都有新入库，说明还有得挖，不必焦虑。
 *
 * 所以这里把"学习产出率"做成独立信号，与 freshness 缺口按权重合成 novelty。
 *
 * 纯函数：不读盘、不读时钟。
 */

/** 从最近若干轮学习里判断"这块地是不是挖空了"。 */
export const YIELD_WINDOW = 12;

export interface LearningYield {
  /** 样本轮数（最近 window 内实际发生过的学习轮） */
  readonly rounds: number;
  /** 有入库的轮数 */
  readonly productive: number;
  /** 产出率 [0,1]；样本为 0 时返回 null（不伪造 0） */
  readonly rate: number | null;
  /** 好奇缺口贡献 [0,1]：学不到新东西=缺口大；样本不足返回 null */
  readonly gap: number | null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * 由"最近每轮入库数"算产出率与缺口。
 *
 * - 空样本 → `{rounds:0, productive:0, rate:null, gap:null}`（调用方回退到 freshness 缺口）；
 * - 每轮都 0 → gap=1（彻底挖空，值得换地方看）；
 * - 每轮都有 → gap=0（这块还很新鲜，不必当成缺口）。
 */
export function learningYield(recentIngested: readonly number[], window = YIELD_WINDOW): LearningYield {
  if (!Number.isInteger(window) || window < 1) throw new RangeError("window 必须是正整数");
  const tail = recentIngested.slice(-Math.floor(window));
  const rounds = tail.filter((n) => Number.isFinite(n)).length;
  if (rounds === 0) return { rounds: 0, productive: 0, rate: null, gap: null };
  const productive = tail.filter((n) => Number.isFinite(n) && n > 0).length;
  const rate = clamp01(productive / rounds);
  return { rounds, productive, rate, gap: clamp01(1 - rate) };
}

/**
 * 合成 novelty 用的缺口：产出率为主，freshness 为次（审计给出的顺序）。
 *
 * 没有学习样本时退回 freshness；两者都没有时返回 undefined（让投影取中性值，不编）。
 */
export function noveltyGap(input: {
  readonly yieldGap: number | null;
  readonly freshnessGap: number | null;
  readonly yieldWeight?: number;
}): number | undefined {
  const weight = input.yieldWeight ?? 0.7;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("yieldWeight 必须在 [0,1]");
  const y = input.yieldGap === null ? null : clamp01(input.yieldGap);
  const f = input.freshnessGap === null ? null : clamp01(input.freshnessGap);
  if (y === null && f === null) return undefined;
  if (y === null) return f ?? undefined;
  if (f === null) return y;
  return clamp01(weight * y + (1 - weight) * f);
}

/** 给日志看的一句话：为什么这一拍觉得"该去看看新东西"。 */
export function describeLearningYield(yieldInfo: LearningYield): string {
  if (yieldInfo.rounds === 0) return "还没有学习样本（不假装知道该不该换主题）";
  return `最近 ${String(yieldInfo.rounds)} 轮学到新东西 ${String(yieldInfo.productive)} 次（产出率 ${(
    (yieldInfo.rate ?? 0) * 100
  ).toFixed(0)}%）`;
}
