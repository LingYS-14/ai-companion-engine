/**
 * P1 出口分流：这一拍的意图该流向哪里（§8.2 P1「selftalk 出口改走意图」）。
 *
 * 背景：旧行为里，如果她"想说"但主动开口的硬闸拦下，这一拍就什么都没有——
 * 想说而说不出的力气被丢掉了。P1 的裁决是：被拦下的意图**不消失**，而是流向内部言语（日记），
 * 由 selftalk 用她自己的语气写下来。这样"想说但被规则挡住"仍然留下痕迹，日后再回看能解释
 * 「那晚我明明想找他说话，只是静默窗不让我发」。
 *
 * 纪律：
 * - 纯函数，不读时钟、不写文件、不调模型（真正的日记生成还在 selftalk，零模型调用属于 P2 的空闲 tick）；
 * - 只做**分流决定**，不替 selftalk 决定措辞（语气归 persona 层）；
 * - 拿不到信息就返回 idle，不猜、不编。
 */

import { isSpeakKind, type IntentKind } from "./types.js";
import type { IntentTickResult } from "./tick.js";

export type IntentOutletTarget = "speak" | "journal" | "idle";

export interface IntentOutlet {
  /** speak = 交给主动开口路径；journal = 写进内部言语；idle = 这一拍什么都不做 */
  readonly target: IntentOutletTarget;
  /** 流向哪一类意图；没有候选时为 null */
  readonly kind: IntentKind | null;
  /** 自述第一句（journal 的种子；null = 没有） */
  readonly line: string | null;
  /** 为什么（给日记的由头；null = 没有） */
  readonly whyLine: string | null;
  readonly note: string;
}

/**
 * 决定这一拍的出口。
 *
 * 顺序：
 * 1. 没有候选 → idle（这一拍确实没什么想做的）；
 * 2. 硬闸放行且确有候选 → speak；
 * 3. 硬闸拦下但确有候选 → journal（被挡住的想说话，不丢）；
 * 4. 有候选但没到「非说不可」的阈值 → journal（还没到要开口，但值得记一笔）。
 */
export function chooseIntentOutlet(result: Pick<IntentTickResult, "top" | "gate" | "wouldSpeak" | "narrative">): IntentOutlet {
  const top = result.top;
  if (top === null) {
    return { target: "idle", kind: null, line: null, whyLine: null, note: "这一拍没有候选" };
  }
  const line = result.narrative === null ? null : result.narrative.line;
  const whyLine = result.narrative === null ? null : result.narrative.whyLine;
  // A4：意图的类别先决定它能不能走"开口"这条路，再看闸放不放行。
  // 以前是"闸放行 + 有候选"就算要说话，于是 withdraw/idle 也被当成想找他聊天。
  if (!isSpeakKind(top.kind)) {
    const writeJournal = top.kind === "explore" || top.kind === "create";
    return {
      target: writeJournal ? "journal" : "idle",
      kind: top.kind,
      line,
      whyLine,
      note: writeJournal
        ? `这类想做的事（${top.kind}）不走主动开口，先记一笔，等有执行器`
        : `只是心里动了一下（${top.kind}），不开口也不写日记`,
    };
  }
  if (result.wouldSpeak) {
    return { target: "speak", kind: top.kind, line, whyLine, note: result.gate.note };
  }
  if (!result.gate.allowed) {
    return {
      target: "journal",
      kind: top.kind,
      line,
      whyLine,
      note: `想开口但被挡下（${result.gate.verdict}）：${result.gate.note}`,
    };
  }
  return {
    target: "journal",
    kind: top.kind,
    line,
    whyLine,
    note: "还没到非说不可的程度，先记一笔",
  };
}

/**
 * 给内部言语用的种子句（直接塞进日记/内省提示，不经过模型也能用于降级模板）。
 * 只做拼接，不改写——措辞留给 selftalk 与 persona。
 */
export function journalSeed(outlet: IntentOutlet): string | null {
  if (outlet.target !== "journal" || outlet.line === null) return null;
  const why = outlet.whyLine === null ? "" : `（${outlet.whyLine}）`;
  return `${outlet.line}${why}——${outlet.note}`;
}
