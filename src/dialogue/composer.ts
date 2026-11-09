/**
 * 唯一出口：把「脑子里的东西」组装成一次生成的输入。
 *
 * ## 为什么要有这一层
 *
 * 2026-10-29 用户的判断：聊天出问题是「大脑和嘴连接不够紧密」。当时确实是三条嘴各拼一套：
 * QQ 回信拼人格+状态，`recall.ts` 再自己往系统提示后面贴一段记忆/知识，主动开口又拼另一套。
 * 结果是状态与知识更新了，嘴还按旧习惯说——被问「昨晚学到什么」时，召回到了素材却答成气氛。
 *
 * 现在所有生成入口都必须经过 `composeDialogue()`：
 *   意图（reply / proactive / 库存汇报） → 素材（人格、状态、记忆、知识、历史） → 两段提示词
 * 桥不再自己 join 提示词，也不再各自决定「要不要带记忆」——那是这一层的事。
 *
 * 这一层是纯函数：不读盘、不写状态、不碰时钟。所有副作用仍留在桥与 runtime 里。
 */

import type { Persona } from "../dialogue/persona.js";
import { proactiveSystemPrompt, qqSystemPrompt, qqUserPrompt, type PromptLayers } from "../dialogue/prompt.js";
import { proactiveUserPrompt, type ProactiveTopic } from "../dialogue/proactive.js";
import { recallBlock, type DialogueRecall } from "../dialogue/recall.js";

/** 这一轮说话的动机。库存问题单独一类，因为它的素材义务不同（必须说具体的东西） */
export type DialogueIntent = "reply" | "proactive" | "learn-report";

export interface RecallUsage {
  readonly memories: number;
  readonly knowledge: number;
  readonly mandatory: boolean;
}

export interface ComposedDialogue {
  readonly system: string;
  readonly user: string;
  readonly intent: DialogueIntent;
  readonly recall: RecallUsage;
}

export interface ReplyComposeInput {
  /** 省略时按普通回信处理；库存问题由 recall.mandatory 自动升级为 learn-report */
  readonly intent?: "reply";
  readonly layers: PromptLayers;
  readonly peerName: string;
  readonly text: string;
  /** 未读的图片/文件说明，拼在这句话后面 */
  readonly unread?: string;
  readonly history?: readonly { readonly who: "peer" | "her"; readonly text: string }[];
  readonly recall?: DialogueRecall;
}

/**
 * 「她此刻想做什么」——来自意向引擎的自述（`src/orchestrator/intent/narrative.ts`）。
 *
 * 只作为**想开口的由头**交给模型，语气/称呼/长度仍由 persona 层决定；这里不做任何润色，
 * 也不把它当台词（P1-RISK-LIST R3：自述是中性机制文本，直接塞进回复会像系统提示）。
 */
export interface IntentNote {
  /** 我想做什么（"我想找人说句话"） */
  readonly line: string;
  /** 为什么（逐维回链） */
  readonly whyLine: string;
  /** 此刻的状态句（可选："现在被静默拦住了"） */
  readonly statusLine?: string;
}

export interface ProactiveComposeInput {
  readonly intent: "proactive";
  readonly persona: Persona | null;
  /** 当前模式（NORMAL/DEFENSE/…）说给人听的一句话 */
  readonly mode: string;
  readonly topic: ProactiveTopic;
  readonly peerName: string;
  readonly localHour: number;
  readonly history?: readonly string[];
  /**
   * 2026-11-09（单话题根因）：她自己最近说过的话。
   * 与 history 分开——history 是"他最近说过什么"（可当素材），avoid 是"别再重复"清单。
   */
  readonly avoid?: readonly string[];
  /** 主动开口也可以带一点记得的事；空则只按话题说 */
  readonly recall?: DialogueRecall;
  /**
   * P1：意向引擎给的自述。省略 = 旧行为（只看 topic + 状态），**旧调用一个字都不用改**。
   */
  readonly intentNote?: IntentNote;
  /**
   * A5（审计修复）：情境自觉。她能看到的事实——现在几点、他多久没出现、她主动说了几次
   * 他回没回、他是否在电脑前、此刻的冲动。**不是命令，也不否决**；说与不说由她在出口里定。
   */
  readonly situation?: SituationNoteLike;
}

/** 结构形状（不 import `orchestrator/intent/*`：提示词层不需要知道意图引擎的内部类型）。 */
export interface SituationNoteLike {
  readonly lines: readonly string[];
}

export const SITUATION_HEADER = "## 此刻的处境";
/** 出口协议里的"先不说"标记（与 `src/qq/onebot-bridge.ts` 的 PROACTIVE_HOLD_TOKEN 一致，测试锁住）。 */
export const SITUATION_HOLD_TOKEN = "HOLD";
export const SITUATION_HOLD_DIRECTIVE =
  "如果此刻不宜打扰——他大概睡了、在忙、或者你连着说了几句他都没回——就只回 HOLD（四个大写字母，不要加任何别的字）。" +
  "否则写一句你此刻真想说、并且值得此刻打扰他的话。先说事情，不要解释这段说明，也不要提「处境」「意图」「引擎」这些词。";

function usageOf(recall: DialogueRecall | undefined): RecallUsage {
  return {
    memories: recall?.memories.length ?? 0,
    knowledge: recall?.knowledge.length ?? 0,
    mandatory: recall?.mandatory === true,
  };
}

function joinSystem(base: string, recall: DialogueRecall | undefined): string {
  if (recall === undefined) return base;
  const block = recallBlock(recall);
  return block === "" ? base : `${base}

${block}`;
}

/**
 * 把自述拼进系统提示。刻意写成"这是你想开口的由头，不要复述"——
 * 不这么写，模型会把机制句子原样念出来（P1-RISK-LIST R3 说的"像系统提示"）。
 */
function joinIntentNote(system: string, note: IntentNote | undefined): string {
  if (note === undefined) return system;
  const why = note.whyLine === "" ? "" : `（${note.whyLine}）`;
  const status = note.statusLine === undefined || note.statusLine === "" ? "" : `${note.statusLine}。`;
  return `${system}

【此刻的由头】${note.line}${why}。${status}把它化成你自己的语气和称呼说出来，不要复述这一句，也不要解释这段说明。`;
}

/**
 * 把「此刻的处境」拼进系统提示。
 *
 * 三条纪律：①只写事实（几点、多久没出现、说了几次没回、在不在电脑前），不写判断；
 * ②不出现"应该/必须/不许"这类外部指令；③给出口协议（HOLD），决定权在她。
 */
function joinSituationNote(system: string, note: SituationNoteLike | undefined): string {
  if (note === undefined || note.lines.length === 0) return system;
  const body = note.lines.map((line) => `- ${line}`).join("\n");
  return `${system}

${SITUATION_HEADER}
${body}

${SITUATION_HOLD_DIRECTIVE}`;
}

export function composeDialogue(input: ReplyComposeInput): ComposedDialogue;
export function composeDialogue(input: ProactiveComposeInput): ComposedDialogue;
export function composeDialogue(input: ReplyComposeInput | ProactiveComposeInput): ComposedDialogue {
  if (input.intent === "proactive") {
    const system = joinSituationNote(
      joinIntentNote(
        joinSystem(proactiveSystemPrompt({ persona: input.persona, mode: input.mode }), input.recall),
        input.intentNote,
      ),
      input.situation,
    );
    // P1：时间事实改走「此刻的处境」（TemporalSnapshot），user prompt 不再带时钟与称呼指令。
    const user = proactiveUserPrompt({
      topic: input.topic,
      history: input.history ?? [],
      ...(input.avoid === undefined ? {} : { avoid: input.avoid }),
    });
    return { system, user, intent: "proactive", recall: usageOf(input.recall) };
  }

  const intent: DialogueIntent = input.recall?.mandatory === true ? "learn-report" : "reply";
  const system = joinSystem(qqSystemPrompt(input.layers), input.recall);
  const user = qqUserPrompt({
    peerName: input.peerName,
    text: input.text + (input.unread === undefined || input.unread === "" ? "" : `
${input.unread}`),
    ...(input.history === undefined ? {} : { history: input.history }),
  });
  return { system, user, intent, recall: usageOf(input.recall) };
}
