/**
 * 生成侧回声自检（task-169 C）：纯函数，零 IO。
 *
 * 为什么与 `selftalk-journal.ts` 的判重分开写：journal 的写口只比对 journal 自己，
 * 而回声室是「她这句话与最近所有自身输出（journal / proactive / chat_reply）像」。
 * 算法刻意与 journal 的 `bigrams`/`isRepeatText` 对齐（字符 bigram Dice），
 * 两处口径不同会让阈值失去意义。
 *
 * 只做判定，不做重生成/沉默——那是调用侧（selftalk-runner / onebot-bridge）的事。
 */

/** 与 journal 的短文本门槛一致：归一化后不足 8 个字符不判重（「在吗」这种没法比）。 */
const MIN_ECHO_CHARS = 8;

/** 主动开口写记忆时的前缀（`我主动开口说：「…」`）。比对前要剥掉。 */
const SELF_PREFIX = /^(?:我主动开口说|我说)\s*[：:]\s*[「『]?/u;
const SELF_SUFFIX = /[」』]\s*$/u;

/** 归一化：只留字母/数字（含中日文），大小写不敏感。与 journal.normalizeVoice 同口径。 */
export function normalizeEchoText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 剥掉「我主动开口说：「…」」/「我说：「…」」的外壳；没有前缀时原样（去首尾空白）。 */
export function stripSelfPrefix(text: string): string {
  return text.replace(SELF_PREFIX, "").replace(SELF_SUFFIX, "").trim();
}

/** 字符 bigram 集合（按码点切，保证中文/emoji 不会拆坏）。 */
function bigramsOf(normalized: string): Set<string> {
  const chars = Array.from(normalized);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.add(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

/**
 * 两段文本的字符 bigram Dice 系数（0..1）。
 *
 * 与 `selftalk-journal.ts` 的 `bigrams` + 写口算法一致：2·|A∩B| / (|A|+|B|)。
 * 空/单字符返回 0（没有 bigram 就没有可比的东西）。
 */
export function diceBigrams(a: string, b: string): number {
  const left = bigramsOf(normalizeEchoText(stripSelfPrefix(a)));
  const right = bigramsOf(normalizeEchoText(stripSelfPrefix(b)));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const gram of left) {
    if (right.has(gram)) hit += 1;
  }
  return (2 * hit) / (left.size + right.size);
}

/**
 * 这句候选答案与参照文本集的最大相似度（0..1）。
 *
 * 候选归一化后不足 8 个字符 → 0（短句判重只会误伤）；参照逐条算 Dice 取最大。
 */
export function echoScore(text: string, refs: readonly string[]): number {
  const candidate = stripSelfPrefix(text);
  if (Array.from(normalizeEchoText(candidate)).length < MIN_ECHO_CHARS) return 0;
  let max = 0;
  for (const ref of refs) {
    const score = diceBigrams(candidate, ref);
    if (score > max) max = score;
  }
  return max;
}

/** 是否命中回声阈值（纯比较，便于调用侧决定重生成还是沉默）。 */
export function isEcho(text: string, refs: readonly string[], threshold: number): boolean {
  return echoScore(text, refs) >= threshold;
}

/** 带时间戳的参照文本（chat log / memory / journal 统一成这个形状）。 */
export interface EchoRefEntry {
  readonly text: string;
  readonly atMs: number;
}

/**
 * 截取 `[nowMs - windowMs, nowMs]` 窗口内的参照文本。
 *
 * 时间戳不可用（NaN/未来）的条目直接丢弃；顺序保持调用方给的先后（通常是旧→新）。
 */
export function recentRefs(
  entries: readonly EchoRefEntry[],
  nowMs: number,
  windowMs: number,
): readonly string[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) return [];
  const floor = nowMs - windowMs;
  const out: string[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.atMs)) continue;
    if (entry.atMs < floor || entry.atMs > nowMs) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (text === "") continue;
    out.push(text);
  }
  return out;
}

/**
 * 取时间上最新的 `lookback` 条参照文本（task-170 B1）。
 *
 * 参照集来自不同步的来源（chat log / memory / journal），拼接顺序不代表时间顺序；
 * 直接按位置 `slice(-lookback)` 会在总量超过上限时把「最新一条」截掉（闸门漏检最近
 * 自身输出）。这里先按 `atMs` 升序排，再取末尾；时间戳不可用的条目直接丢弃。
 */
export function takeLatestRefs(
  entries: readonly EchoRefEntry[],
  lookback: number,
): readonly string[] {
  if (!Number.isFinite(lookback) || lookback <= 0) return [];
  const usable: EchoRefEntry[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.atMs)) continue;
    if (typeof entry.text !== "string" || entry.text.trim() === "") continue;
    usable.push({ text: entry.text.trim(), atMs: entry.atMs });
  }
  usable.sort((a, b) => a.atMs - b.atMs);
  return usable.slice(-Math.floor(lookback)).map((entry) => entry.text);
}
