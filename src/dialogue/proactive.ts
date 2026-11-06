/**
 * 她主动开口。
 *
 * 回消息是「被叫醒」，主动开口是「自己想起你」——两者在引擎里不是一回事：
 * 前者由消息驱动，后者只能由状态与时间驱动。这里只做**决定**与**措辞素材**，
 * 真正的台词仍然交给 LLM（人格卡 + composePrompt 的口径不变）。
 */

import { inQuietHours } from "../engine/timewindow.js";
import { mechanicalGate, shouldInitiate } from "../orchestrator/initiative.js";
import { WONDER_PRIORITY, WONDER_TOPIC_TEXT, wonderTopic, type Wonder } from "../psychology/wonder.js";
import type { IntentNote } from "./composer.js";

/**
 * P1 真出口：意向引擎交给「主动开口」的两样东西（都可缺省 = 旧行为）。
 *
 * 为什么合成一个类型而不是两个参数：它们来自同一个 tick，必须同进同出；
 * 而且 `gate` 与 `note` 只有一起给出时才代表"这一拍她是被意向引擎推着开口的"。
 */
export interface ProactiveIntentContext {
  /** 四否决硬闸的结论（只对主动开口生效；回消息不经过它，见 F54 旧坑） */
  readonly gate?: { readonly allowed: boolean; readonly verdict: string; readonly note: string };
  /** top 候选的自述（交给 composeDialogue，让模型说"她想说的那件事"） */
  readonly note?: IntentNote;
  /**
   * A5 情境自觉：她能看到的事实（现在几点、他多久没出现、她说了几次没回、他是否在电脑前）。
   * 纯素材，不参与决定是否开口——出口协议（HOLD）由 composer 写进系统提示。
   */
  readonly situation?: { readonly lines: readonly string[] };
}

export type ProactiveTopic =
  | "held_back"
  | "unfinished"
  | "tired"
  | "restless"
  | "missing"
  // 动机层的四个方向（见 src/psychology/wonder.ts）：与 Wonder.push 同名，
  // 这样 pickTopic 可以直接把 push 当话题返回，proactiveUserPrompt 也能给出方向性的提示。
  | "beauty"
  | "effort"
  | "newborn"
  | "farewell";

export interface ProactiveOptions {
  readonly enabled: boolean;
  /** 距上次主动开口至少多久（毫秒） */
  readonly minGapMs: number;
  /** 一天最多几句 */
  readonly maxPerDay: number;
  readonly quietFrom: number;
  readonly quietTo: number;
}

export const DEFAULT_PROACTIVE: ProactiveOptions = {
  enabled: true,
  // 温和兜底（用户 2026-11-01 裁决）：最小间隔 30 分钟、每天最多 10 条。
  // 静默时段只保留为事实（供情境与诊断），intent 路径不得据此否决（A6）。
  minGapMs: 30 * 60_000,
  maxPerDay: 10,
  quietFrom: 23,
  quietTo: 7,
};

export type ProactiveVerdict =
  | "disabled"
  | "quiet"
  | "gap"
  | "daily"
  | "energy"
  | "distrust"
  | "queue"
  /** P1：额度用完 / 单写者冲突（来自意向引擎硬闸） */
  | "quota"
  | "single_writer"
  | "calm"
  | "speak";

export interface ProactiveInput {
  readonly now: number;
  readonly localHour: number;
  readonly pressure: number;
  readonly rumination: number;
  readonly energy: number;
  readonly entropy: number;
  readonly lastAt: number | null;
  /** 今天已经主动说了几句 */
  readonly todayCount: number;
  readonly opts: ProactiveOptions;
  /**
   * 动机层（§ 动机自拟，见 src/psychology/wonder.ts）。
   * 分值够高时优先于「压力→没说完→累→心乱」这套状态推力——
   * 否则她永远只会被自己的难受推着开口，说不出在乎的东西。
   */
  readonly wonder?: Wonder;
  /** S 层 trust（v5.4-P1 §4.9 阶段 0 的状态门要用；不传就跳过状态门，兼容旧调用） */
  readonly trust?: number;
  /** 状态门阈值（由调用方从注册表取，proactive 本身不读配置） */
  readonly gates?: {
    readonly energyFloor: number;
    readonly trustFloor: number;
    readonly trustSafeMin: number;
    /** §4.9 / D5：有入站事件正在处理时 queueEmpty=false，不主动开口 */
    readonly queueEmpty?: boolean;
    /**
     * P1：意向引擎的四否决硬闸结论。给了它 = 只认这四条（额度/静默/单写者/信任），
     * 不再看 energy 阈值与队列；不给 = 旧行为。
     */
    readonly intentGate?: {
      readonly allowed: boolean;
      readonly verdict: string;
      readonly note: string;
    };
  };
}

export interface ProactiveDecision {
  readonly act: boolean;
  readonly verdict: ProactiveVerdict;
  readonly topic?: ProactiveTopic;
  readonly note: string;
  /** §4.9：trust 刚够开口但没到安全线时只能安全话术 */
  readonly strategy?: "initiate_meme" | "select";
}

export { inQuietHours };

/**
 * 用状态挑一个「为什么想说话」，不用随机数（可复现，也便于测试）。
 *
 * 顺序：动机层（wonder）→ 压力 → 没说完 → 累 → 心乱 → 都说不出。
 * wonder 放最前面是有意的：她**真正在乎什么**不该排在"自己难受"之后。
 */
export function pickTopic(input: ProactiveInput): ProactiveTopic | null {
  const w = input.wonder;
  if (w !== undefined && w.score >= WONDER_PRIORITY && w.push !== null && wonderTopic(w) !== null) {
    return w.push;
  }
  if (input.pressure >= 0.55) return "held_back";
  if (input.rumination >= 0.4) return "unfinished";
  if (input.energy <= 0.35) return "tired";
  if (input.entropy >= 0.55) return "restless";
  return null;
}

export function decideProactive(input: ProactiveInput): ProactiveDecision {
  // D4：四道门（静默/冷却/日上限 + energy/trust + 队列空）全部交给 shouldInitiate，
  // 免得"proactive 一套、阶段 0 另一套"以后各改各的漂移。
  if (input.gates !== undefined) {
    const g = input.gates;
    const init = shouldInitiate(
      {
        now: input.now,
        localHour: input.localHour,
        energy: input.energy,
        trust: input.trust ?? 0,
        eventQueueEmpty: g.queueEmpty ?? true,
        lastAt: input.lastAt,
        todayCount: input.todayCount,
        opts: input.opts,
      },
      { energyFloor: g.energyFloor, trustFloor: g.trustFloor, trustSafeMin: g.trustSafeMin },
      g.intentGate === undefined ? {} : { intentGate: g.intentGate },
    );
    if (!init.act) return { act: false, verdict: init.verdict, note: init.note };
  } else {
    const blocked = mechanicalGate(input);
    if (blocked !== null) return { act: false, verdict: blocked.verdict, note: blocked.note };
  }
  const topic = pickTopic(input);
  if (topic === null) {
    return { act: false, verdict: "calm", note: "状态平稳，没有非说不可的话" };
  }
  // wonder 的话题用 wonderTopic 的原话当 note：诊断时能直接看出「她为什么此刻想开口」
  const own = input.wonder;
  const note = own !== undefined && own.push === topic ? (wonderTopic(own)?.note ?? TOPIC_NOTE[topic]) : TOPIC_NOTE[topic];
  const strategy =
    input.gates === undefined || input.trust === undefined
      ? undefined
      : input.trust < input.gates.trustSafeMin ? "initiate_meme" : "select";
  return { act: true, verdict: "speak", topic, note, ...(strategy === undefined ? {} : { strategy }) };
}

export const TOPIC_NOTE: Readonly<Record<ProactiveTopic, string>> = {
  held_back: "心里压着事，想试探着提一句，但不逼对方",
  unfinished: "还惦记着上次没说完的话",
  tired: "自己累了，想被问一句，也想被允许不说话",
  restless: "有点乱，想说点无关紧要的",
  missing: "没来由地想念",
  beauty: "看见了好东西，想说给它听",
  effort: "被认真做事的样子打动了，想为别人做点什么",
  newborn: "刚学到新东西，说给你听",
  farewell: "想说告别与传承",
};

export const TOPIC_HINT: Readonly<Record<ProactiveTopic, string>> = {
  held_back: "你心里有点事，想开口又不想把气氛弄重",
  unfinished: "你忽然想起你们上一次没聊完的话题",
  tired: "你有点累，想听对方说句话，但不要求对方安慰你",
  restless: "你有点静不下来，想随便找个话头",
  missing: "你只是忽然想起对方，想打个招呼",
  // 动机层的提示与 wonderTopic 的 note 同源，避免两处措辞漂移
  beauty: `说说${WONDER_TOPIC_TEXT.beauty}`,
  effort: `说说${WONDER_TOPIC_TEXT.effort}`,
  newborn: `说说${WONDER_TOPIC_TEXT.newborn}`,
  farewell: `说说${WONDER_TOPIC_TEXT.farewell}`,
};

/**
 * 主动开口的 user prompt：与回消息的 prompt 分开，避免模型把它写成「回应」。
 *
 * P1 时间观改造（DESIGN v0.2 §2.4）：
 * - 删掉「现在是 N 点」——时间事实由「此刻的处境」行提供（TemporalSnapshot 渲染），
 *   提示词里再写一遍就是第二套账，而且会让她把时钟当话题；
 * - 删掉「称呼对方为「X」」——称呼是人格卡 speech 的一部分，提示词硬性规定只会让她
 *   每条消息都以同一个称呼开头（审计里 86% 的「用户，」就是这么来的）。
 */
export function proactiveUserPrompt(input: {
  readonly topic: ProactiveTopic;
  readonly history: readonly string[];
}): string {
  const hist = input.history.length === 0 ? "（没有之前的对话）" : input.history.join("\n");
  return [
    `${TOPIC_HINT[input.topic]}。`,
    "这次是你**主动**开口，不是回消息：不要回应对方没说出口的话，第一句就是你的话。",
    "一两句就好，不超过 40 字，不用 emoji。",
    "最近的对话（供你避免重复，不必复述）：",
    hist,
    "只输出你要发的那一句。",
  ].join("\n");
}
