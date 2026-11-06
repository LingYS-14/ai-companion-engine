/**
 * 从一句话里估出 §4.3 的 appraisal 五维（F297：从 tools 层搬进大脑层——这是判断，不是传输）（goal_congruence / goal_relevance /
 * coping_potential / novelty / legitimacy）。
 *
 * 为什么是启发式而不是再调一次模型：
 * - 一轮回帖只允许一次生成调用（延迟与成本都要控）；appraisal 需要确定性、可测；
 * - 一旦让模型同时输出 appraisal + 台词，JSON 解析失败会让整轮卡住；
 * - 反过来，appraisal 的数值**不需要很准**：它只决定这一轮压力/情绪往哪边走，
 *   真正影响观感的是台词，而台词由人格卡 + composePrompt 决定。
 *
 * 为什么不用 `normalizeContext` 的分类：那张表认的是**事件标签**（"争吵"/"夸奖"），
 * 不是 QQ 里的原话——"你到底有没有在听我说话"按它是 neutral。所以这里另有一套
 * 面向原话的口语线索表，判完再把标签映射回事件类型给 `eventStyleFor` 用。
 */

import type { AppraisalRaw, ContextTag, LanguageFeatures, LanguagePort, QqAppraisal } from "../ports/index.js";

export type { QqAppraisal };
export type QQAppraisal = QqAppraisal;

const BASE: Readonly<Record<ContextTag, AppraisalRaw>> = {
  conflict: { goal_congruence: -0.6, goal_relevance: 0.8, coping_potential: 0.5, novelty: 0.3, legitimacy: 0.35 },
  praise: { goal_congruence: 0.7, goal_relevance: 0.8, coping_potential: 0.75, novelty: 0.3, legitimacy: 0.9 },
  distance: { goal_congruence: -0.3, goal_relevance: 0.7, coping_potential: 0.6, novelty: 0.25, legitimacy: 0.6 },
  intimacy: { goal_congruence: 0.8, goal_relevance: 0.85, coping_potential: 0.8, novelty: 0.35, legitimacy: 0.85 },
  neutral: { goal_congruence: 0.15, goal_relevance: 0.55, coping_potential: 0.65, novelty: 0.25, legitimacy: 0.75 },
};

const EVENT_TYPE: Readonly<Record<ContextTag, string>> = {
  conflict: "争吵",
  praise: "夸奖",
  distance: "冷淡",
  intimacy: "亲密",
  neutral: "聊天",
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * 原话线索表。顺序即优先级：先看"有没有在吵"，再看"是不是在冷"，最后才是甜话。
 * 这些词是从真实聊天里挑的，不追求覆盖率——判错的代价只是这一轮 appraisal 偏一点。
 */
const CUES: readonly (readonly [ContextTag, RegExp])[] = [
  ["conflict", /生气|吵架|指责|批评|讨厌|烦死|好烦|闭嘴|滚开|敷衍|不理我|不理你|每次都|有没有在听|凭什么|过分|气死|失望|受够/],
  ["distance", /算了|不聊了|先这样|随便吧|走了|再说吧|没事了|不想说|懒得说/],
  ["intimacy", /想你|抱抱|亲亲|爱你|想见你|撒娇|陪我|晚安|一起睡/],
  ["praise", /可爱|好看|漂亮|厉害|谢谢|感谢|真棒|好喜欢|喜欢你/],
];

function classifyText(text: string): ContextTag {
  for (const [tag, re] of CUES) if (re.test(text)) return tag;
  return "neutral";
}

/** 情绪强度修饰：感叹号多、问号多、长度长，都会让这一轮"更用力" */
function intensity(text: string): { exclaim: number; question: number; length: number } {
  const exclaim = Math.min(3, (text.match(/[!！]/g) ?? []).length);
  const question = Math.min(2, (text.match(/[?？]/g) ?? []).length);
  return { exclaim, question, length: text.trim().length };
}

/**
 * 从一句话估出五维。`language` 是装配点注入的语言特征端口
 * （实现见 `dialogue/port-adapter.ts`）——工具层不 import `dialogue/embodiment.js`。
 */
export function appraiseFromText(text: string, language: LanguagePort): QqAppraisal {
  const features = language.features(text);
  const contextTag = classifyText(text);
  const base = BASE[contextTag];
  const { exclaim, question, length } = intensity(text);

  const appraisal: AppraisalRaw = {
    goal_congruence: clamp01(base.goal_congruence),
    // 被问到就说明这事跟我有关：问号抬 relevance
    goal_relevance: clamp01(base.goal_relevance + 0.05 * question),
    // 长句 + 感叹号通常意味着对方说得很重，可应付度略降
    coping_potential: clamp01(base.coping_potential - 0.05 * Math.min(2, Math.floor(length / 60))),
    novelty: clamp01(base.novelty + 0.1 * exclaim),
    legitimacy: base.legitimacy,
  };

  // goal_congruence 是有符号的，clamp01 会把负值抹平——这里重新夹到 [-1,1]
  const signed = Math.max(-1, Math.min(1, base.goal_congruence));
  return {
    appraisal: { ...appraisal, goal_congruence: signed },
    contextTag,
    eventType: EVENT_TYPE[contextTag],
    features,
  };
}
