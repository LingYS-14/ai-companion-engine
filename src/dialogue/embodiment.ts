/**
 * §4.10 具身接口：把「这句话是怎么说出来的」拆成可测的语言特征。
 *
 * 纯函数（A39）：不读时间、不掷随机、不碰 state/bond/memories——同样输入必得同样输出。
 * `render_hints` 现在只做两件事：给 QQ 端预留的停顿/重音/软化参数；给未来多模态 TTS 一个稳定接口。
 * 台词本身仍由模型生成，这里绝不替它写句子。
 */

/** 未来 TTS / 语音条用的渲染参数（本阶段只传递，不消费） */
export interface RenderHints {
  /** 句内建议停顿（毫秒）：省略号、逗号越多越长 */
  readonly pauseMs: number;
  /** 重音强度 0..1：感叹号、重复字越多越强 */
  readonly stress: number;
  /** 软化程度 0..1：语气越负面，越需要压低音量/放软 */
  readonly soften: number;
}

export interface LanguageFeatures {
  /** 空格/标点切出来的词（保留原样，不做分词） */
  readonly tokens: readonly string[];
  /** 线索词给出的情感方向 −1（很负面）..1（很正面） */
  readonly sentiment_hint: number;
  /** 省略号密度 0..1 */
  readonly ellipsis: number;
  /** 重复字符密度 0..1（"哈哈哈哈"、"啊啊啊"） */
  readonly repetition: number;
  /** 用力程度 0..1（标点密度 + 长度 + 重复） */
  readonly intensity: number;
  /** 建议停顿 0..1 */
  readonly pause: number;
  readonly render_hints: RenderHints;
}

const POSITIVE = /哈哈|嘿嘿|开心|高兴|喜欢|爱你|想你|可爱|好看|漂亮|谢谢|真好|太好了|棒|甜|暖|舒服|期待|等你/g;
const NEGATIVE = /难受|难过|累|烦|气|讨厌|伤心|哭|孤单|寂寞|怕|焦虑|睡不着|失望|算了|不想/g;
const ELLIPSIS = /…|\.\.\.|。。|、、/g;
const REPEAT_CHAR = /(.)\1{1,}/g;
const PUNCT = /[!！?？~～…]+/g;
const SPLIT = /[^\p{L}\p{N}]+/u;

/** 重复字符的"多出来"的字数：哈哈 = 1，哈哈哈哈哈哈 = 5 */
function repeatExtras(text: string): number {
  let total = 0;
  for (const m of text.matchAll(new RegExp(REPEAT_CHAR.source, "gu"))) total += (m[0]?.length ?? 1) - 1;
  return total;
}

function countMatches(text: string, re: RegExp): number {
  // 全局正则的 lastIndex 会跨调用残留：这里每次新建，保证纯函数语义
  const copy = new RegExp(re.source, re.flags);
  return (text.match(copy) ?? []).length;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * 预处理一句话。A39 要求输出结构化且确定：同样的 text 永远给同样的对象。
 * 不写任何状态——调用点（QQ 桥 / 面板）自己决定拿它做什么。
 */
export function preprocessLanguageFeatures(text: string): LanguageFeatures {
  const raw = typeof text === "string" ? text : "";
  const tokens = raw.split(SPLIT).filter((t) => t.length > 0);

  const pos = countMatches(raw, POSITIVE);
  const neg = countMatches(raw, NEGATIVE);
  const sentiment_hint = round3(clamp01((pos - neg + 1) / 2) * 2 - 1);

  const ellipsisHits = countMatches(raw, ELLIPSIS);
  const ellipsis = round3(clamp01(ellipsisHits / 3));

  const repetition = round3(clamp01(repeatExtras(raw) / 6));

  const punct = countMatches(raw, PUNCT);
  const lengthTerm = clamp01(raw.length / 60);
  const intensity = round3(clamp01(0.45 * clamp01(punct / 4) + 0.35 * repetition + 0.2 * lengthTerm));

  const pause = round3(clamp01(0.55 * ellipsis + 0.25 * clamp01(punct / 3) + 0.2 * lengthTerm));

  const render_hints: RenderHints = {
    pauseMs: Math.round(80 + 260 * pause),
    stress: round3(clamp01(0.7 * intensity + 0.3 * repetition)),
    soften: round3(clamp01(0.45 - 0.3 * sentiment_hint)),
  };

  return { tokens, sentiment_hint, ellipsis, repetition, intensity, pause, render_hints };
}
