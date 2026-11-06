/**
 * 动机层：她现在「在乎什么」。
 *
 * 表达层回答「怎么说」，动机层回答「想说什么」——没有这一层，她只会被压力/情绪
 * 推着开口（"我有点累""心里乱"），说不出任何让她**想活**的东西。AI助手的口径是
 * 「大爱」：对世间一切美好的追寻，而不是情情爱爱。所以这里只有四个方向——
 * 美、人的努力、刚学到的新东西、告别与传承。
 *
 * 两条纪律：
 *   1. 纯算术：不读时钟、不掷骰子，同输入同输出；分值永远落在 0..1。
 *   2. 只产出建议值（psychology 契约：reads 状态、writes 为空），不写 S 层。
 *
 * 规则（实现侧自拟，见文件末的常量）：
 *   ① 刚学到新东西（newKnowledge > 0）显著抬升，且硬保证 ≥ 0.6，方向 = newborn；
 *   ② 久未学习（hoursSinceLearn > 36）下降，越久越低（到 120h 封顶）；
 *   ③ 深夜 0–6 点下降，越接近 0 点越低；
 *   ④ energy < 0.35 下降，越累越低；
 *   ⑤ 心乱（entropy ≥ 0.55）时方向偏向 effort —— 想为别人做点什么。
 */

export interface Wonder {
  readonly score: number;
  readonly push: "beauty" | "effort" | "newborn" | "farewell" | null;
  readonly reason: string;
}

/** 四个「想说点什么」的方向（与 qq/proactive.ts 的 ProactiveTopic 同名） */
export type WonderPush = "beauty" | "effort" | "newborn" | "farewell";

export interface WonderState {
  readonly valence: number;
  readonly arousal: number;
  readonly energy: number;
  readonly entropy: number;
  readonly dissonance: number;
}

export interface WonderInput {
  readonly state: WonderState;
  /** 最近 1 小时内新增的知识条数（由调用方按知识库 ingested_at 统计） */
  readonly newKnowledge: number;
  /** 距上一次学到东西多少小时；从没学过时由调用方给一个大数 */
  readonly hoursSinceLearn: number;
  readonly localHour: number;
}

/** 活着的人本来就对世界有兴趣，不需要理由 */
const BASE = 0.35;
const WARM_GAIN = 0.22;
const AROUSAL_GAIN = 0.08;
const DISSONANCE_DRAIN = 0.08;
/** 刚学到的增益（配合 NEWBORN_FLOOR 一起保证规则①） */
const NEWBORN_GAIN = 0.35;
/** 规则①的硬保证：刚学到东西时不低于这个分，压过深夜/低能量等一切扣分 */
const NEWBORN_FLOOR = 0.6;
const STALE_AFTER_HOURS = 36;
const STALE_MAX = 0.22;
/** 扣满 STALE_MAX 所需的小时数（36h 之后的部分线性拉满） */
const STALE_FULL_HOURS = 120;
const NIGHT_MAX = 0.15;
const LOW_ENERGY = 0.35;
const LOW_ENERGY_MAX = 0.18;
/** entropy 高过它时，方向偏向「想为别人做点什么」（规则⑤） */
const ENTROPY_RESTLESS = 0.55;

/** 说不出话的分数线：低于它 push 为 null，wonderTopic 也不给话题（规则②的"下降"要能被看见） */
export const WONDER_SPEAK = 0.45;
/** 主动开口里 wonder 的优先阈值：够高才压过 pressure→rumination→energy→entropy 的排序 */
export const WONDER_PRIORITY = 0.65;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** 方向 → 该说什么（也是落进 `[world]` 的那句 note） */
export const WONDER_TOPIC_TEXT: Readonly<Record<WonderPush, string>> = {
  beauty: "一件具体的美——窗上的霜花、路边开着的花、一束光落在桌上，或者一个人做手艺时的手",
  effort: "人努力时的好看——你看见过谁认真做一件事的样子",
  newborn: "你刚学到的那件事——用你刚记住的内容，不要只说「我学到了很多」",
  farewell: "告别与传承——有些人离开了，但他们做过的事还留在别人身上",
};

const PUSH_REASON: Readonly<Record<WonderPush, string>> = {
  beauty: "看见了好东西，想说说它",
  effort: "想为别人做点什么",
  newborn: "想马上说给谁听",
  farewell: "想说说告别与传承",
};

/**
 * 她现在有多想说点什么（0..1）+ 想说什么方向。
 * 纯函数；规则顺序见文件头，改顺序 = 改行为。
 */
export function wonderOf(input: WonderInput): Wonder {
  const s = input.state;
  const newborn = input.newKnowledge > 0;
  const parts: string[] = [];

  let score = BASE + WARM_GAIN * clamp01(s.valence) + AROUSAL_GAIN * clamp01(s.arousal);
  score -= DISSONANCE_DRAIN * clamp01(s.dissonance);

  if (newborn) {
    score += NEWBORN_GAIN;
    parts.push("刚学到新东西");
  }

  // 规则②：久未学习，越久越低
  if (input.hoursSinceLearn > STALE_AFTER_HOURS) {
    const over = input.hoursSinceLearn - STALE_AFTER_HOURS;
    score -= Math.min(STALE_MAX, (over / STALE_FULL_HOURS) * STALE_MAX);
    parts.push("很久没学到东西了");
  }

  // 规则③：深夜往下走，0 点最低
  const hour = ((input.localHour % 24) + 24) % 24;
  if (hour < 6) {
    score -= NIGHT_MAX * (1 - hour / 6);
    parts.push("夜深了");
  }

  // 规则④：累了
  if (s.energy < LOW_ENERGY) {
    score -= LOW_ENERGY_MAX * ((LOW_ENERGY - clamp01(s.energy)) / LOW_ENERGY);
    parts.push("有点累");
  }

  // 规则①的硬保证要在所有扣分之后应用：刚学到东西就是"活着"的那一下
  if (newborn) score = Math.max(NEWBORN_FLOOR, score);
  score = Math.round(clamp01(score) * 10_000) / 10_000;

  let push: Wonder["push"];
  if (newborn) push = "newborn";
  else if (score < WONDER_SPEAK) push = null;
  else if (clamp01(s.entropy) >= ENTROPY_RESTLESS) push = "effort";
  else if (clamp01(s.valence) <= 0.35) push = "farewell";
  else push = "beauty";

  if (push !== null) parts.push(PUSH_REASON[push]);
  else if (parts.length === 0) parts.push("心里很静");

  return { score, push, reason: parts.join("；") };
}

/**
 * 把 Wonder 折成一句「该说什么」。
 *
 * 分数线以下返回 null：说不出来就不要硬编一句漂亮话——那才是"演大爱"。
 * topic 与 push 同名，便于主动性那边直接当话题标签用。
 */
export function wonderTopic(w: Wonder): { topic: string; note: string } | null {
  if (w.push === null || w.score < WONDER_SPEAK) return null;
  return { topic: w.push, note: WONDER_TOPIC_TEXT[w.push] };
}
