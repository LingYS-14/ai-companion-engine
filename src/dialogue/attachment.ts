/**
 * 「她是不是在说『我想给你看张图』」——纯文本判断，不调模型。
 *
 * 为什么需要它：F102 记过一笔真实事故——她在日记里写「你看我今天拍的花…这张图给你」，
 * 但这个项目在 OneBot 通道上**没有发图能力**，那句话说完就成了一句空头承诺。
 * 有了这条判断，装配点就能在她真的说「给你看图」时，把手上真有的画面一起发出去；
 * 手上没有图时**不假装有**（voice 门禁会把它记成"做不到的承诺"）。
 *
 * 判断尺度刻意收窄：只要命中一个明确的"递图"说法就算。宁可漏（少发一次图），
 * 不要误判——误判的代价是她每句话都拖一张 B 站截图过去。
 */

/** 明确的递图说法。`这张图给你`、`发你一张`、`给你看看这个`、`拍给你` 都算。 */
const IMAGE_INTENT_PATTERNS: readonly RegExp[] = [
  // 递图的动词必须出现——只出现「这张图 / 那张图」不算：
  // 「那张图的出处」「这张图没有 P 过」都不是在给你看图。
  /图给你/,
  /给你看(?:看)?(?:这|那)?(?:一)?张/,
  /发你(?:一|这|那)?张/,
  /发(?:一|这|那)?张图/,
  /拍给你/,
  /发图给你/,
  /这张照片/,
  /这张图(?:给|发|送)/,
];

/** 她这句话是不是在说「我给你看张图」。只做模式匹配，不理解语义。 */
export function detectImageIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return IMAGE_INTENT_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * 「说了要给你看图，但手上其实没有图」——把这句空头承诺摘掉。
 *
 * 为什么不能只靠 F142 的 `detectImageIntent` + 有图才发：她真的会说「这张图给你」。
 * 如果装配点这时候没有 24h 内的画面（比如今天没学过新视频、或者取帧失败），
 * 那句话就会原样发出去——收信人等了半天没有图，这就是 F102 记下的那种"承诺落空"。
 * 所以加第二道：**没图就把承诺句摘掉，剩下的照发**；全篇只有这一句承诺时（比如主动
 * 开口第一句就是"这张图给你"），换一句诚实的兜底，绝不发空串（空串在桥上等于没回）。
 *
 * 摘句而不是整段重写：跟 A 层否决同一个思路——她整段话里可能只有半句在承诺，
 * 其余是真话；整段换掉会把好内容一起丢掉。
 */

/** 比递图判断更宽：所有"提到图/照片"的句子都算，因为没图时它们都是空话。 */
const IMAGE_MENTION_PATTERNS: readonly RegExp[] = [
  /图/,
  /照片/,
  /画面/,
  /截图/,
  /拍给/,
  /拍的花/,
];

/** 摘句失败时的兜底：诚实、短、不像模板。 */
const NO_IMAGE_FALLBACK = "……我这边一时翻不出能给你看的图，先欠着。";

/** 按句末标点切句，保留标点（中文句子边界足够干净，不做复杂 NLP）。 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (ch === "。" || ch === "！" || ch === "？" || ch === "!" || ch === "?" || ch === "\n" || ch === "…") {
      out.push(buf);
      buf = "";
    }
  }
  if (buf !== "") out.push(buf);
  return out;
}

/**
 * 摘掉提到图的句子。`removed` 是被摘掉的原句（给日志用，不外发）。
 * 返回值永不为空串：全摘光时用 `NO_IMAGE_FALLBACK`。
 */
export function stripImagePromise(text: string): { text: string; removed: string[] } {
  const trimmed = text.trim();
  if (trimmed === "") return { text: "", removed: [] };
  const removed: string[] = [];
  const kept: string[] = [];
  for (const sentence of splitSentences(trimmed)) {
    if (IMAGE_MENTION_PATTERNS.some((re) => re.test(sentence))) removed.push(sentence.trim());
    else kept.push(sentence);
  }
  if (removed.length === 0) return { text: trimmed, removed: [] };
  const rest = kept.join("").trim();
  return { text: rest === "" ? NO_IMAGE_FALLBACK : rest, removed };
}
