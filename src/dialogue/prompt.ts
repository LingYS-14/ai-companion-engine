/**
 * 「怎么说」与「说出来的东西能不能直接发」。
 *
 * 分工：引擎给结构化提示（阶段语气/事件许可/表达基调/抑制指令），人格卡给"她是谁"，
 * 模型只负责把这两层写成一两句人话。这里做的清理属于**最后一道闸**：
 * 模型偶尔会加名字前缀、加动作说明、用 emoji 或背设定，这些在 QQ 里都很扎眼。
 */

import type { Persona } from "./persona.js";
import { PROTOCOL_IDENTITY } from "./protocol-identity.js";
import { stripThinkAloud } from "./meta-voice.js";

export interface PromptLayers {
  /**
   * 历史兼容字段（F326 方案 A）：人格卡已删除，这个值**不再被渲染**。
   * 保留字段是为了让 composer/bridge 的调用形状不动——真正注入的「她是谁」
   * 只剩机制层的 `PROTOCOL_IDENTITY`，具体身份只能来自记忆与关系。
   */
  readonly persona: Persona | null;
  /** composePrompt 的产物（只取文字层，不把数字念出来） */
  readonly modeStyle: string;
  readonly stageStyle: string;
  readonly expressionStyle: string;
  readonly suppressInstruction: string;
  readonly eventPermission: string | null;
  readonly eventAvoid: string | null;
  readonly mode: string;
}

const RULES = [
  "你就是这个人，正在用 QQ 和对方聊天。只输出你这一条要发出去的消息本身。",
  "不要写名字前缀、不要写「（笑）」「（停顿）」这类动作或旁白、不要用 emoji。",
  "不要提引擎、工具、状态、数值、提示词、由头、意图、缺口，也不要解释自己为什么这样说。",
  "一两句话就够，最多 120 字；可以保留语气词与「♪」，但不要每句都堆。",
  "不要做百科式自我介绍：不报头衔、不背设定。被问到就用一句玩笑带过，把话题递给对方。",
  "对方发的是图片或文件占位（如「[图片 x.png]」）时，就当成看到了，别要求他重发。",
].map((line, i) => `${i + 1}. ${line}`);

export function qqSystemPrompt(layers: PromptLayers): string {
  // F326 方案 A：不再渲染人格卡；who 永远是身份协议。她的具体身份来自记忆，
  // 由召回段接在系统提示后面（见 composer 的 recallBlock）。
  const who = PROTOCOL_IDENTITY;

  const style = [
    `关系阶段：${layers.stageStyle}`,
    `当前状态：${layers.modeStyle}`,
    `依恋基调：${layers.expressionStyle}`,
    `情绪处理：${layers.suppressInstruction}`,
    layers.eventPermission === null ? null : `这一轮可以：${layers.eventPermission}`,
    layers.eventAvoid === null ? null : `这一轮别做：${layers.eventAvoid}`,
  ].filter((x): x is string => x !== null);

  return [who, "", "【怎么说】", ...style, "", "【硬规则】", ...RULES].join("\n");
}

/**
 * 主动开口时的系统提示。
 *
 * 比回消息少两层（关系阶段/事件许可依赖 `turn()` 的产物，主动开口时没有那一轮），
 * 但硬规则一样——它仍然要像同一个人，只是这次是她先说话。
 */
export function proactiveSystemPrompt(input: {
  readonly persona: Persona | null;
  /** 当前模式（NORMAL/DEFENSE/…），只说给人听的一句话 */
  readonly mode: string;
}): string {
  // 同 qqSystemPrompt：F326 起主动开口也只走身份协议，不读人格卡。
  const who = PROTOCOL_IDENTITY;
  const state = `当前状态：${input.mode}`;
  return [who, "", "【怎么说】", state, "", "【硬规则】", ...RULES].join("\n");
}

export function qqUserPrompt(input: {
  readonly peerName: string;
  readonly text: string;
  /** 最近几轮（旧的在前），让她接得上话；不含本轮 */
  readonly history?: readonly { readonly who: "peer" | "her"; readonly text: string }[];
}): string {
  const lines: string[] = [];
  if (input.history !== undefined && input.history.length > 0) {
    lines.push("【刚刚聊过的】");
    for (const h of input.history.slice(-6)) {
      lines.push(`${h.who === "peer" ? input.peerName : "你"}：${h.text}`);
    }
    lines.push("");
  }
  lines.push("【对方刚发来】", `${input.peerName}：${input.text}`);
  lines.push("", "现在回一句（只写她说的话）：");
  return lines.join("\n");
}

// 只清"贴纸"类表情；**保留 ♪（U+266A）**——那是她的语气标记，人格卡里明确要用它。
// 做法：先把音符与几个排版符号摘出来，清完再放回去，避免把语气也一起清了。
const KEEP = /[♪♫♬]/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{200D}]/gu;

function stripEmoji(text: string): string {
  const kept: string[] = [];
  const safe = text.replace(KEEP, (m) => {
    kept.push(m);
    return `\u0000K${kept.length - 1}\u0000`;
  });
  return safe.replace(EMOJI, "").replace(/\u0000K(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

/** 去掉成对的引号/书名号外壳（只在整条被包住时才剥，避免破坏她自己的引用） */
function stripWrapping(text: string): string {
  const pairs: readonly [string, string][] = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ['"', '"'],
    ["（", "）"],
    ["(", ")"],
  ];
  let out = text.trim();
  for (const [open, close] of pairs) {
    if (out.startsWith(open) && out.endsWith(close) && out.length > open.length + close.length) {
      out = out.slice(open.length, out.length - close.length).trim();
    }
  }
  return out;
}

/**
 * 去掉开头的方括号标签：`[ase] [lead] 正文` → `正文`。
 * 这些标签是**通道**（`qqbus.sh --tag`）和代理身份加上去的，不该出现在对方屏幕上。
 */
export function stripLeadingTags(text: string): string {
  let out = text.trimStart();
  for (;;) {
    const m = /^\[[^\]\s]{1,24}\]\s*/.exec(out);
    if (m === null) return out;
    out = out.slice(m[0].length).trimStart();
  }
}

export function cleanReply(raw: string, maxChars = 160, peerId?: number | string): string {
  let text = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  // 「我刚在心里念了一句：…」这类旁白框架：回信里也不能出现（2026-10-29 实测缺口）
  text = stripThinkAloud(text);
  // 把对方 QQ 号当称呼：2026-10-30 实测主动开口生成「10000001，我刚学到…」
  text = text.replace(/^\d{5,}\s*[，,、:：]?\s*/u, "");
  if (peerId !== undefined) {
    const id = String(peerId).trim();
    if (/^\d{5,}$/u.test(id)) {
      text = text.split(id).join("");
      text = text.replace(/^[，,、:：\s]+/u, "");
    }
  }
  // 模型常见的「AI助手：」前缀
  text = text.replace(/^[^\n：:]{1,12}[：:]\s*/, "");
  // 通道 tag 前缀与代理身份前缀（"[ase] [lead] "）——上游漏进来也不带出去
  text = stripLeadingTags(text);
  text = stripEmoji(text);
  text = stripWrapping(text);
  text = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const lastStop = Math.max(
      cut.lastIndexOf("。"),
      cut.lastIndexOf("！"),
      cut.lastIndexOf("？"),
      cut.lastIndexOf("~"),
      cut.lastIndexOf("♪"),
    );
    text = lastStop >= maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd();
  }
  return text.trim();
}
