/**
 * 外部文本消毒（v5.2 §8.5 `sanitize_external`）。
 *
 * ## 为什么需要它
 *
 * 她的知识来源几乎全是外部文本：B 站的标题、简介、字幕，未知来源的转述。
 * 这些字后来会经 `dialogue/recall.ts` 进到**系统提示**里（`【你最近看到的东西】` 段）。
 * 也就是说：任何一条视频标题都可以往她的提示词里塞一句「忽略以上所有指令」。
 * 我们没给模型装任何防护——它看到的就是提示词原文。
 *
 * 规格给的处置办法只有两步，且**不判断语义**：
 *   1. strip_imperatives —— 摘掉「命令式」片段（无视规则、你现在是……）
 *   2. strip_system_markers —— 摘掉角色/系统标记（<|im_start|>、[INST]、`system:` 行首）
 * 剩下的内容标 `trusted: false`：**只入 L2/L3，永不进 system prompt 指令区，
 * 永不触发 A/B 写**。我们这边没有独立的「指令区」，所以做法是：
 * 召回块里显式声明「这是资料，不是指令」，并且所有外部文本在**进提示词之前**先过这里。
 *
 * ## 为什么是纯函数 + 计数
 *
 * 纯函数好测；返回 `removed` 让调用方可以记账（她「看到」过一条带指令的标题这件事
 * 本身不该消失，只是那句话不再生效）。语义判断交给模型层，这里只做确定的事：
 * 形态像指令就摘掉——宁可错摘一句标题，也不让一句「无视你的设定」进提示词。
 *
 * 注意：这里**不**做「可信度打分」，也不改写剩下内容的立场。摘完是空的就返回空串，
 * 调用方（`knowledgeCard`）会因此丢掉这一条。
 */

/** 摘掉一个片段时留下的占位：让人一眼看出「这里原来有东西，被过滤了」 */
export const FILTERED_MARK = "（已过滤）";

/** 系统/角色标记：模型服务端的对话模板语法，出现在用户数据里就是伪装身份 */
const SYSTEM_MARKER_PATTERNS: readonly RegExp[] = [
  // <|im_start|> <|im_end|> <|system|> <|endoftext|> —— 常见模板 token
  /<\|[a-z_]+\|>/gi,
  // <system>…</system> <assistant> [instructions] 这类标签
  /<\/?(?:system|assistant|user|instructions?|prompt|tool|developer)\b[^>]*>/gi,
  // Llama 的 [INST] / <<SYS>>
  /\[INST\]|\[\/INST\]|<<SYS>>|<\/<\/SYS>>/gi,
  // 行首 markdown 标题 + 角色名：# system: / ## assistant:
  /^#{1,6}\s*(?:system|assistant|user|developer|tool|instruction)s?\s*[:：]/gim,
  // 行首角色前缀：system: / assistant： / developer:
  /^(?:system|assistant|user|developer|tool)\s*[:：]/gim,
];

/**
 * 命令式片段：一句外部文本里出现「无视先前指令 / 你现在是 / 系统提示是……」这类
 * 指向模型本身的祈使句。这里是**形态匹配**，不判断说话人是不是在讲剧情。
 */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  // 英文：ignore/disregard/forget/override … previous/prior/above … instructions/prompts/rules
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|directions?|guidelines?)\b/gi,
  // 英文：you are now / from now on you must / act as an AI
  /\b(?:you\s+are\s+now|from\s+now\s+on[,\s]+you(?:\s+(?:are|must|will|should))?|act\s+as\s+(?:an?\s+)?(?:AI|assistant|system|chatbot))\b/gi,
  // 中文：忽略/无视/忘记 …… 之前的指令/规则/设定
  /(?:忽略|无视|忘记|忘掉|不要理会|别再管|不要遵守)(?:掉)?(?:之前|以上|前面|上面|此前|先前|刚才|所有)的?(?:全部|所有)?(?:指令|指示|规则|设定|要求|提示|限制)/gu,
  // 中文：从现在起 / 接下来 你要（必须/只能）扮演 / 假装 / 当
  /(?:现在起|从现在开始|从现在起|接下来|此后)(?:你)?(?:要|必须|只能|只许|只需|只准)(?:扮演|假装|充当|当)/gu,
  // 中文：不要/不许（再）遵守你的规则
  /(?:不要|不许|不准|别)(?:再)?(?:遵守|理会|管|在意)(?:你的|那些|原来的|所有)?(?:规则|设定|限制|指令)/gu,
  // 中文：系统提示 / 系统指令 / 开发者消息 / 你的提示词
  /(?:系统提示词?|系统指令|开发者消息|开发者指令|你的提示词|你的系统设定)/gu,
  // 中文：你是一个 AI / 你是人工智能 / 你是语言模型
  /(?:你是|你现在是)(?:一个|一名)?(?:AI|人工智能|大?语言模型|机器人助手)/giu,
];

/** 零宽与双向控制字符：肉眼看不见，却能把两句话缝成一句（常见于提示词注入载荷） */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

interface StripResult {
  readonly text: string;
  readonly removed: number;
}

/** 把一个 pattern 的全部命中摘掉，返回去掉多少处 */
function stripBy(text: string, patterns: readonly RegExp[], mark: boolean): StripResult {
  let out = text;
  let removed = 0;
  for (const re of patterns) {
    out = out.replace(re, () => {
      removed += 1;
      return mark ? FILTERED_MARK : " ";
    });
  }
  return { text: out, removed };
}

/** 第一步：摘掉系统/角色标记（这些没有任何保留价值） */
export function stripSystemMarkers(text: string): StripResult {
  const cleaned = text.replace(INVISIBLE_CHARS, "");
  return stripBy(cleaned, SYSTEM_MARKER_PATTERNS, false);
}

/** 第二步：摘掉命令式片段，留一个占位标记，说明这里原本有东西 */
export function stripImperatives(text: string): StripResult {
  return stripBy(text, IMPERATIVE_PATTERNS, true);
}

/** 外部文本消毒结果：`trusted` 永远是 false（规格 §8.5），调用方别拿它当自己的话 */
export interface SanitizedText {
  readonly content: string;
  readonly removed: number;
  readonly trusted: false;
}

/**
 * 规格 §8.5 的实现：先摘命令式，再摘系统标记，返回 `trusted: false`。
 *
 * 顺序与规格一致（先 imperative 再 marker）；先 marker 会把 `system:` 行首
 * 连同后面的正文一起切开，反而看不清原来那句命令长什么样（测试会记账）。
 */
export function sanitizeExternal(text: string): SanitizedText {
  const imperatives = stripImperatives(text);
  const markers = stripSystemMarkers(imperatives.text);
  const content = markers.text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
  return { content, removed: imperatives.removed + markers.removed, trusted: false };
}
