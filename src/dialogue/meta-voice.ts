/**
 * 「内心叙述」清理：把「我刚在心里念了一句：…」这类**描述自己内心活动过程**的框架去掉。
 *
 * 为什么会需要它：
 * - 内部言语的提示词让模型「写心里话」，模型很容易把**叙述框架**也写出来
 *   （「我刚在心里念了一句：窗台那枝花精神多了」）。这类句子作为独白没问题，
 *   一旦真的发给用户，就像有人把旁白一起念了出来。
 * - 回信路径偶尔也会漏出同样的框架（模型把自己当成「在回想」的第三人称）。
 *
 * 边界：只清**开头**的框架，且必须同时出现「内心容器词」（心里/脑子里/脑海中…）
 * 或「念了/嘀咕了 + 一句」这种明确的转述结构。像「心里还是有点在意」这种正常中文用法
 * 不处理——它不是旁白，是人话。
 */

/** 内心容器词：只有和「想/念/琢磨」一起出现、且在句首时才算旁白框架 */
const CONTAINER = "(?:心里|心里头|心里面|心底|心坎里|脑子里|脑袋里|脑海当中?|脑内)";
const MANNER = "(?:默默地?|暗暗地?|悄悄地?|忍不住|不由得)";
const VERB =
  "(?:想|想着|想了想|想过|想到|想起|念|念了|念叨|念着|嘀咕|嘀咕了|琢磨|琢磨着|琢磨了|盘算|盘算着|寻思|寻思着|冒出|浮现|闪过)";
const TAIL = "(?:了)?(?:一句|一句话|一个念头|念头|想法|个念头|半句)?";

/** 句首框架：可选语气词 + 可选「我」+ 可选时间 + 容器 + 方式 + 动词 + 尾缀 + 标点 */
const FRAME_WITH_CONTAINER = new RegExp(
  `^(?:嗯|呃|唉)?[，,、。…\\s]*` +
    `(?:我)?(?:刚刚|刚才|刚|方才|这会儿|现在)?(?:又)?(?:在)?` +
    `${CONTAINER}(?:里)?${MANNER}?${VERB}${TAIL}` +
    `(?:[，,：:。…\\-—]\\s*|\\s+)`,
  "u",
);

/** 没有容器词、但明确是「念了一句」的转述结构 */
const FRAME_WITHOUT_CONTAINER = new RegExp(
  `^(?:嗯|呃|唉)?[，,、。…\\s]*(?:我)?(?:刚刚|刚才|刚|方才|这会儿|现在)?(?:又)?${MANNER}?` +
    `(?:念了|念|嘀咕了|嘀咕|念叨了|念叨)${TAIL}` +
    `(?:[，,：:。…\\-—]\\s*|\\s+)`,
  "u",
);

function stripOnce(text: string): string {
  let out = text;
  for (const re of [FRAME_WITH_CONTAINER, FRAME_WITHOUT_CONTAINER]) {
    if (re.test(out)) {
      out = out.replace(re, "");
      // 去掉框架后可能留下开头标点/省略号
      out = out.replace(/^[，,。、：:…\\-—\\s]+/u, "");
    }
  }
  return out;
}

/**
 * 去掉句首的「内心叙述」框架，保留真正要说的话。
 * 清到只剩空气时返回空串（调用方据此判定「这句不能说」）。
 */
export function stripThinkAloud(raw: string): string {
  let text = raw.trim();
  if (text === "") return "";
  // 可能叠了两层框架（「我刚刚在心里想着，嗯……我刚在心里念了一句：…」），最多清三次
  for (let i = 0; i < 3; i += 1) {
    const next = stripOnce(text);
    if (next === text) break;
    text = next;
  }
  return text.replace(/^[「“"']+|[」”"']+$/gu, "").trim();
}

/** 整句都是「我在心里过了很久」这种纯过程描述、没有实际内容的判定（用于拒发） */
export function isPureInnerProcess(raw: string): boolean {
  const text = raw.trim();
  if (text === "") return true;
  const stripped = stripThinkAloud(text).replace(/[。？！…～~，,\s]/gu, "");
  return Array.from(stripped).length < 4;
}
