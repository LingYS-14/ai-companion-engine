/**
 * 内部言语的「说出来」这一半（§自言自语与记忆 · 表达路径）。
 *
 * 自言自语原本只写进日记（`src/maintenance/selftalk-runner.ts`），是纯内向的。
 * 这个模块做三件事，全部是纯函数，便于单测：
 *   1. `selftalkMood()`：把状态读成一个词（平静/雀跃/好奇/黏人/低落）——决定「她此刻是什么调子」；
 *   2. `humanize()`：把内心独白改成能直接发给人的一句：去掉元叙述（检索/记忆/条目/材料），
 *      收敛到一条消息的长度，补上句末标点；改不动就返回 null（宁可不发，也不发怪话）；
 *   3. `shouldSpeak()`：该不该真的开口——静默时段、精力、当天配额、与上一次的间隔，缺一不可。
 *
 * 边界：本模块不读盘、不写状态、不取时钟（时间由调用方传入），
 * 也不判断「她说了什么」——话来自 `runSelfTalk()` 的产出，这里只做「能不能说/怎么说」。
 */

import { inQuietHours } from "../engine/timewindow.js";
import { stripThinkAloud } from "../dialogue/meta-voice.js";

export type SelftalkMood = "平静" | "雀跃" | "好奇" | "黏人" | "低落";

export interface MoodSignals {
  readonly valence: number;
  readonly arousal: number;
  readonly pressure: number;
  readonly rumination: number;
  readonly affection: number;
  readonly energy: number;
}

/** 她此刻的调子：先看压着的（低落），再看想贴近的（黏人），最后才轮到普通情绪色彩 */
export function selftalkMood(s: MoodSignals): SelftalkMood {
  if (s.pressure >= 0.6 || s.rumination >= 0.5) return "低落";
  if (s.affection >= 0.5 && s.arousal >= 0.45) return "黏人";
  if (s.valence >= 0.65 && s.arousal >= 0.5) return "雀跃";
  if (s.arousal >= 0.55) return "好奇";
  return "平静";
}

/** 不超过一条私聊消息的舒适长度（字符数） */
export const SELFTALK_SPOKEN_MAX = 90;
/** 同一天最多主动说几句（再多就成了刷屏，不是「像活人」） */
export const SELFTALK_SPEAK_DAILY_CAP = 2;
/** 两次主动开口的最小间隔：一小时半，避免连着两拍都说 */
export const SELFTALK_SPEAK_MIN_GAP_MS = 90 * 60_000;
/** 精力低于这个值就不逼她开口（累的时候人是不想说话的） */
export const SELFTALK_SPEAK_MIN_ENERGY = 0.35;

/** 元叙述词：这些词出现在发给人的话里，会立刻露馅「这是系统在说话」 */
const META_WORDS = [
  "记忆库", "检索", "条目", "材料", "日记", "向量", "语义", "标签", "召回", "知识库",
  // A10：这些词会从自述/由头漏进提示词，一旦复述就露馅。
  "由头", "意图", "引擎", "缺口", "机制",
];

/**
 * 她只能发文字（发图/发文件要宿主窗口通道，常驻进程没有）。
 * 说「这张图给你」「稍后发你照片」就是许下做不到的事——宁可这一句不说，也不能让承诺落空。
 * 与 tools/audit/check-voice.mjs 的 PROMISE 保持同一口径（那边是审计，这边是运行时拦截）。
 */
export const UNSUPPORTED_PROMISE =
  /(?:这|那|一)张(?:图|照片|图片)(?:给|发|传)你|(?:给|发|传)你(?:一张|几张|张)(?:图|照片|图片|文件)|(?:等会|稍等|稍后|马上)[^。！？]{0,6}(?:给|发|传)你[^。！？]{0,4}(?:图|照片|文件)/u;

/** 开头的自我叙述前缀：去掉后更像直接说给人听的话 */
const PREFIX =
  /^(?:我)?(?:刚刚|刚才|这会儿|现在)?(?:又)?(?:在)?(?:心里)?(?:想着|想到|想起|琢磨着|琢磨|觉得|发现)[，,：:]?\s*/u;

function clampText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= SELFTALK_SPOKEN_MAX) return text;
  const cut = chars.slice(0, SELFTALK_SPOKEN_MAX).join("");
  // 尽量在标点处收尾，别把一句话拦腰截断
  const at = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("，"), cut.lastIndexOf("？"), cut.lastIndexOf("！"));
  return at >= 20 ? cut.slice(0, at + 1) : `${cut}…`;
}

/**
 * 把内心独白改成一句可以说出口的话。
 * 返回 null 表示「这句不适合发」：太短、全是元叙述、或改完不成句。
 */
export function humanize(raw: string): string | null {
  let text = raw.trim().replace(/\s+/gu, " ");
  if (text === "") return null;
  // 引号包住的整句（模型爱加）去掉外层引号
  text = text.replace(/^[「“"']+|[」”"']+$/gu, "").trim();
  // 「我刚在心里念了一句：…」——旁白框架不能跟着话一起发出去
  text = stripThinkAloud(text);
  if (text === "") return null;
  // 做不到的承诺：这一句不说（日记里仍留着，她确实想过）
  if (UNSUPPORTED_PROMISE.test(text)) return null;
  for (const word of META_WORDS) {
    if (text.includes(word)) return null;
  }
  text = text.replace(PREFIX, "").trim();
  if (text === "") return null;
  // 「（想了想）」这类括号动作字：发给人的消息里不要
  text = text.replace(/（[^（）]{0,12}）/gu, "").trim();
  if (Array.from(text).length < 6) return null;
  if (!/[。？！…～~]$/u.test(text)) text = `${text}。`;
  return clampText(text);
}

export interface SpeakGateInput {
  readonly nowMs: number;
  readonly localHour: number;
  readonly quietFrom: number;
  readonly quietTo: number;
  readonly energy: number;
  readonly mood: SelftalkMood;
  /** 当天已经主动说过几句 */
  readonly spokenToday: number;
  /** 上一次主动开口的时刻；0 表示从未 */
  readonly lastSpokeAt: number;
}

export interface SpeakDecision {
  readonly speak: boolean;
  readonly reason: string;
}

/** 静默时段、精力、当天配额、间隔——四条都过才开口 */
export function shouldSpeak(input: SpeakGateInput): SpeakDecision {
  if (inQuietHours(input.localHour, input.quietFrom, input.quietTo)) {
    return { speak: false, reason: `静默时段 ${String(input.quietFrom)}:00–${String(input.quietTo)}:00` };
  }
  if (!Number.isFinite(input.energy) || input.energy < SELFTALK_SPEAK_MIN_ENERGY) {
    return { speak: false, reason: `精力 ${input.energy.toFixed(2)} < ${String(SELFTALK_SPEAK_MIN_ENERGY)}` };
  }
  if (input.spokenToday >= SELFTALK_SPEAK_DAILY_CAP) {
    return { speak: false, reason: `今天已说 ${String(input.spokenToday)} 句（上限 ${String(SELFTALK_SPEAK_DAILY_CAP)}）` };
  }
  if (input.lastSpokeAt !== 0 && input.nowMs - input.lastSpokeAt < SELFTALK_SPEAK_MIN_GAP_MS) {
    return { speak: false, reason: "距上次开口不足 90 分钟" };
  }
  // 低落时她不太会主动找人，除非确实亲近（affection 在 mood 里体现为「黏人」）
  if (input.mood === "低落") {
    return { speak: false, reason: "此刻情绪低落，不主动开口（先自己消化）" };
  }
  return { speak: true, reason: `mood=${input.mood}` };
}


/**
 * 同一个话题的冷却（6 小时）。
 *
 * 只看句子是否重复是不够的：23:37 / 23:52 / 23:57 那三句「刚才那件小事」措辞各不相同，
 * 复读闸（bigram Dice）放行了它们，但人不会在二十分钟里把同一件小事说三遍。
 * 这里按「种子记忆 id」判同话题——她想到的是同一段记忆，就不该再说一遍。
 */
export const SELF_TALK_TOPIC_COOLDOWN_MS = 6 * 3_600_000;

/** 这些种子里有没有最近说出口过的 */
export function topicWasSpokenRecently(
  seeds: readonly string[],
  spoken: readonly { readonly seeds: readonly string[]; readonly at: number }[],
  nowMs: number,
): boolean {
  if (seeds.length === 0) return false;
  const fresh = spoken.filter((e) => nowMs - e.at < SELF_TALK_TOPIC_COOLDOWN_MS);
  return fresh.some((e) => e.seeds.some((id) => seeds.includes(id)));
}
