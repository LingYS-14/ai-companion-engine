/**
 * 好奇心决定「今天学什么」。
 *
 * 原来的学习是纯轮转：`LEARNING_PLAN` 一条条往下走，跟她此刻的状态毫无关系——
 * 她很想念用户的时候在学「国创」，精力充沛的时候还在学「圣地巡礼」。
 * 这一层把 §10.2 的好奇心目标接到学习计划上：**先由状态决定想弄清什么，再决定搜什么**。
 *
 * 边界（为什么函数这么"窄"）：
 *   - 只做**选择**，不搜、不写库：搜索与入库仍在脊髓（`scripts/autonomy/main.mjs`）与工具层。
 *   - 不 import 工具层的 `bili/topics.js`（那条边是 R1 违规）。计划表以**结构类型**传进来，
 *     调用方给什么就用什么；匹配不到就返回 `null`，由调用方退回固定轮转——不发明关键词。
 *   - 纯函数：同样的状态 + 同样的 rotation 必然给出同样的关键词（可复现，才可测、可回放）。
 */

import type { EngineConfig } from "../engine/config.js";
import type { SState } from "../engine/state.js";
import type { Attachment } from "../dialogue/expression.js";
import { curiosityTargets, type Contact, type CuriosityKind } from "./curiosity.js";

/** 学习计划的一组方向（结构上与 `bili/topics.ts` 的 `LearningTopic` 相同，故意不 import） */
export interface PlanGroup {
  readonly topic: string;
  readonly keywords: readonly string[];
}

/** 好奇心目标 → 优先去学的关键词。只收「词典里真有」的词，匹配不到就跳过。 */
const KEYWORDS_BY_TARGET: Readonly<Record<CuriosityKind, readonly string[]>> = {
  // 想确认关系时去看她自己的设定与剧情：这不是"搜自己"，是回到世界线里找安全感
  relationship_confirmation: ["AI助手", "逐火十三英桀", "往世乐土"],
  // 找乐子：轻松、有画面的东西
  funny_memes: ["动画短片", "手书"],
  // 有没聊完的话题：回到角色相关内容继续找谈资
  common_topic: ["AI助手"],
  // 想随便看看：没有偏好词，交给轮转（这里显式留空，避免"随机探索"变成固定几个词）
  random_exploration: [],
};

export interface ChooseLearningKeywordInput {
  readonly plan: readonly PlanGroup[];
  readonly state: SState;
  /** D 层依恋；不传就跳过 anxiety 判据 */
  readonly attachment?: Attachment;
  readonly contacts?: readonly Contact[];
  /** 好奇缺口 = 1 − 知识平均新鲜度；不传就跳过 random_exploration */
  readonly curiosityGap?: number;
  /** 轮转下标：同一偏好下有多个候选词时用它轮着换，避免连续十几轮搜同一个词 */
  readonly rotation: number;
}

export interface KeywordChoice {
  readonly topic: string;
  readonly keyword: string;
  /** 给日志看的一句话：为什么是这个词 */
  readonly reason: string;
  /** 触发这次选择的好奇目标（label 形式，便于和 soul_curious 对账） */
  readonly targets: readonly string[];
}

interface FlatKeyword {
  readonly topic: string;
  readonly keyword: string;
}

function flatten(plan: readonly PlanGroup[]): FlatKeyword[] {
  const out: FlatKeyword[] = [];
  for (const group of plan) {
    const topic = group.topic.trim();
    for (const raw of group.keywords) {
      const keyword = raw.trim();
      if (keyword !== "") out.push({ topic, keyword });
    }
  }
  return out;
}

function nonNegativeInt(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const n = Math.trunc(x);
  return n < 0 ? ((-n) % Number.MAX_SAFE_INTEGER) * -1 : n;
}

/**
 * 按状态挑下一个要学的关键词。
 *
 * 返回 `null` 表示「状态没给出偏好」（没有好奇目标，或目标对应的词不在计划里）——
 * 这时候调用方应该退回固定轮转。**不要在这里用轮转兜底**：那样调用方就分不清
 * "状态决定"和"计划决定"，日志里也看不出她今晚为什么学这个。
 */
export function chooseLearningKeyword(input: ChooseLearningKeywordInput, cfg: EngineConfig): KeywordChoice | null {
  const flat = flatten(input.plan);
  if (flat.length === 0) return null;

  const result = curiosityTargets(
    {
      state: input.state,
      ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
      ...(input.contacts === undefined ? {} : { contacts: input.contacts }),
      ...(input.curiosityGap === undefined ? {} : { curiosityGap: input.curiosityGap }),
    },
    cfg,
  );
  const targets = result.targets;
  if (targets.length === 0) return null;

  // 按目标的优先级顺序找第一个「计划里真有」的偏好词；随机探索不提供偏好词，跳过
  const rotation = nonNegativeInt(input.rotation);
  for (const target of targets) {
    const preferred = KEYWORDS_BY_TARGET[target.kind];
    if (preferred.length === 0) continue;
    const matches = flat.filter((k) => preferred.includes(k.keyword));
    if (matches.length === 0) continue;
    const chosen = matches[rotation % matches.length] ?? matches[0];
    if (chosen === undefined) continue;
    return {
      topic: chosen.topic,
      keyword: chosen.keyword,
      reason: `好奇心 ${target.kind}（${target.reason}）→ 计划里的偏好词 ${matches.map((m) => m.keyword).join("/")}，轮转取第 ${String(rotation % matches.length)} 个`,
      targets: targets.map((t) => t.label),
    };
  }
  return null;
}
