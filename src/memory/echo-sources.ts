/**
 * 「她自己说出去的话」的来源标签（task-169 A/B/C 回声室修复）。
 *
 * 为什么集中成一份常量：这三类来源会在三条路径上被反复判断——
 *   ① 主动开口的召回应排除它们（A：素材过滤）；
 *   ② 自言自语选材应排除它们（B：选材过滤）；
 *   ③ 生成侧回声自检用它们当参照文本（C：Dice 闸门）。
 * 字符串散落在 close-loop / selftalk / bridge 里迟早漂移，所以放一处。
 *
 * 边界：这里只放**语义常量**，不注册 overlay（它是来源清单，不是可调数值）。
 */

/** 主动开口说出去的话（close-loop.ts 的 spokenMemorySeed 写入）。 */
export const PROACTIVE_SOURCE = "proactive" as const;

/** 自言自语写进日记、再被睡眠消费成记忆的来源。 */
export const SELFTALK_SOURCE = "selftalk" as const;

/** 网页聊天里她回复的话（close-loop.ts 的 chatReplyMemorySeed 写入）。 */
export const CHAT_REPLY_SOURCE = "chat_reply" as const;

/**
 * 自述来源全集：这些记忆的内容都是「她自己说过的话」。
 *
 * 注意：**只影响素材端**（主动 recall 的 T2 补位、selftalk 选材、回声自检），
 * 不改变记忆本体，也不影响回信/网页回复路径的召回——那两条路径仍然该记得自己说过什么。
 */
export const SELF_AUTHORED_SOURCES = [
  PROACTIVE_SOURCE,
  SELFTALK_SOURCE,
  CHAT_REPLY_SOURCE,
] as const;

export type SelfAuthoredSource = (typeof SELF_AUTHORED_SOURCES)[number];

const SELF_AUTHORED_SET: ReadonlySet<string> = new Set(SELF_AUTHORED_SOURCES);

/** 这个 source 是不是「她自己说出去的话」。缺省/未知来源一律返回 false（fail-open）。 */
export function isSelfAuthored(source: string | undefined | null): boolean {
  return source !== undefined && source !== null && SELF_AUTHORED_SET.has(source);
}
