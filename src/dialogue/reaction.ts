/**
 * 隐式反应推断 —— 让 §7.4 的 bandit 真的开始记分。
 *
 * ## 为什么需要它
 *
 * `learning/bandit.ts` 的 `recordOutcome` 从 v5.3 起就写好了，但**只有显式传 `reaction` 才记分**
 * （`soul_turn` 工具的参数、`runtime.turn` 的 opts）。QQ 这条主路径从来不传——于是 40 轮之后
 * `bandit.table` 还是空的，`prevStrategy` 有值却永远没被打分（V52-GAP M7-07）。
 *
 * 真要做「玩家反应」分类，最准的是让模型读下一句话再判；但那要额外一次 LLM 调用，
 * 而 bandit 只是想学「哪种说法更容易让对话升温」，不值得为它多花一次钱。
 * 所以这里用**可观测的廉价信号**做一半：
 *
 *   1. 对方明确说了好话（谢谢/喜欢/开心…）→ 升温或安抚
 *   2. 对方明确说了坏话（生气/烦/失望…）→ 冷战
 *   3. 隔了很久才回来（≥ 6h）              → 离开
 *   4. 秒回、而且说了不少（≤ 30min 且 ≥ 8 字）→ 升温
 *
 * ## 读不出来就不打分
 *
 * 返回 `null` 而不是「无视」：`无视` 在 `OUTCOME_REWARD` 里是负分，猜错会把一个好策略打下去。
 * 宁可让 bandit 学的样本少一点，也不要教它学错——这条纪律和 `classifyReaction` 的兜底不同，
 * 那里是**已经有明确反应文本**在分类，这里是从沉默里猜。
 */

/** 隐式推断能给出的结局（与 `bandit.OUTCOMES` 的子集一致；`无视` 故意不可推断） */
export type ImplicitReaction = "升温" | "安抚" | "冷战" | "离开";

/** 推断需要的三个信号：现在几点、上一句什么时候回的、对方这次说了什么 */
export interface ReactionSignals {
  readonly now: number;
  /** 她上一次真正发出去的时间；没有就是 null（首轮，没什么可打分） */
  readonly lastReplyAt: number | null;
  readonly text: string;
}

/** 明确的好话：出现就当作"这轮说得不错" */
const WARM_WORDS = ["谢谢", "喜欢你", "爱你", "抱抱", "想你", "记得", "温柔", "好开心", "开心", "好可爱"];

/** 明确的坏话：出现就当作"这轮没说好" */
const COLD_WORDS = ["生气", "烦", "讨厌", "失望", "不想理", "别说了", "难过", "伤心", "滚"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 反应推断的阈值：写得这么少是有意的——阈值多了就变成在猜，不是在用信号。 */
export const REACTION_THRESHOLDS = {
  /** 秒回的上限：半分钟内算"他一直在" */
  quickReplyMs: 30 * MINUTE,
  /** 秒回还得说了点内容，一个"嗯"不算 */
  quickReplyMinChars: 8,
  /** 好话在这么久之内算升温，更久就只能算安抚（他冷静了一会儿才回好话） */
  warmWindowMs: 2 * HOUR,
  /** 隔这么久才回来：上一句大概率没留住他 */
  goneMs: 6 * HOUR,
} as const;

/**
 * 从下一句消息推上一轮话术的反应。
 *
 * 顺序有讲究：坏话优先于好话（"谢谢你但我很失望"该记冷战），
 * 长时间离开优先于"秒回"（两者不会同时成立，但规则顺序写清楚更好读）。
 */
export function inferReaction(signals: ReactionSignals): ImplicitReaction | null {
  if (signals.lastReplyAt === null) return null;
  const text = signals.text.trim();
  if (text === "") return null;
  const gap = signals.now - signals.lastReplyAt;
  if (gap < 0) return null; // 时钟回拨/测试夹具不一致：不猜
  if (COLD_WORDS.some((w) => text.includes(w))) return "冷战";
  if (WARM_WORDS.some((w) => text.includes(w))) {
    return gap <= REACTION_THRESHOLDS.warmWindowMs ? "升温" : "安抚";
  }
  if (gap >= REACTION_THRESHOLDS.goneMs) return "离开";
  if (gap <= REACTION_THRESHOLDS.quickReplyMs && text.length >= REACTION_THRESHOLDS.quickReplyMinChars) {
    return "升温";
  }
  return null;
}
