/**
 * 把 B 站视频蒸馏成 L2 知识（`knowledge_type: "trend"`）并写进已有 `KnowledgeStore`。
 *
 * 为什么单独一层而不是直接写在工具里：
 *   - 蒸馏是纯函数（`distillVideo`），可以脱离网络与磁盘单独测；
 *   - 幂等靠 `id`，而 id 的推导规则必须在摄取层只有一份；
 *   - 接登录态时只换 `public.ts` 的取数层，这一层一个字都不用改。
 */

import type { KnowledgeRecord, KnowledgeWritePort } from "../ports/index.js";
import type { BiliVideo } from "./public.js";

/** 知识条目的 `source` 取值（与 `web:<url>` / `player` / `parasocial` 同一张对照表） */
export const BILI_SOURCE = "bili";
export const BILI_SOURCE_CREDIBILITY = 0.7;
export const BILI_OBJECTIVE_FRESHNESS = 0.9;
export const BILI_SOCIAL_FRESHNESS = 0.5;
export const BILI_FRESHNESS = 0.9;
/** 描述截断长度（按 code point 数，不是 UTF-16 码元，避免把 emoji 劈成半只） */
export const BILI_DESCRIPTION_LIMIT = 120;

export interface BiliDistilled {
  readonly tag: string;
  readonly content: string;
  readonly knowledgeType: "trend";
}

/**
 * 知识条目 id 复用 `knowledgeIdFor(tag)`：L2 知识库里「tag → id」只允许一套规则
 * （同 `src/memory/consolidate.ts` 的簇巩固），否则同一个 id 空间会出现两种推导方式。
 * 这里的 tag 是 `bili:<bvid>`，bvid 全局唯一，所以同一视频重复摄取必然落到同一个 id。
 */

/** 0.1 个千/万单位 → 一位小数文本，`.0` 去掉（30 → "3"，34 → "3.4"） */
function oneDecimal(tenths: number): string {
  const value = Math.trunc(tenths) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 播放/点赞计数的人类可读格式（确定性，且截断而非四舍五入）：
 *   0..999        → 原样 "999"
 *   1000..9999    → "3.4 千" / "1 千"
 *   >= 10000      → "1.2 万"
 *
 * 截断是刻意的：四舍五入会把 19999 说成 "2 万"，把数字说大比说小更糟。
 */
export function formatBiliCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const value = Math.trunc(n);
  if (value < 1000) return String(value);
  if (value < 10_000) return `${oneDecimal(value / 100)} 千`;
  return `${oneDecimal(value / 1000)} 万`;
}

/** 空白折叠成单空格后按 code point 截断；超长补一个省略号（含省略号正好 limit+1 个字符） */
export function truncateDescription(text: string, limit: number = BILI_DESCRIPTION_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= limit) return flat;
  return `${chars.slice(0, limit).join("")}…`;
}

/**
 * 一条视频 → 一条知识。
 *
 * content 是给 L2 知识库看的"一句话新闻"，格式固定：
 *   `在 B 站看到《标题》（UP主，播放 1.2 万，点赞 3.4 千）：描述 标签：a/b/c`
 * 空描述写「（无简介）」，无标签时整段 ` 标签：…` 省略（不留尾随空格）。
 */
export function distillVideo(video: BiliVideo): BiliDistilled {
  const description = video.description.trim() === ""
    ? "（无简介）"
    : truncateDescription(video.description);
  const tagSuffix = video.tags.length === 0 ? "" : ` 标签：${video.tags.join("/")}`;
  return {
    tag: `bili:${video.bvid}`,
    content:
      `在 B 站看到《${video.title}》（${video.owner}，播放 ${formatBiliCount(video.view)}，` +
      `点赞 ${formatBiliCount(video.like)}）：${description}${tagSuffix}`,
    knowledgeType: "trend",
  };
}

/**
 * 内容质量闸门（纯函数）——B 站搜索结果里混着擦边/标题党，角色的定位是「对世间美好
 * 有追寻」，这类东西既污染 L2 知识库也偏离人设，所以在蒸馏**之前**挡掉。
 *
 * 为什么是两张词表而不是一张：
 *   - 强信号词在 B 站语境里几乎没有第二义（「胖次」「擦边」「太顶」），出现在标题、
 *     简介、标签任一位置都判命中；
 *   - 弱信号词（「腿」「胸」「眼馋」「福利」）在正常内容里也有正当用法（健身、科普、
 *     游戏福利），只在**标题很短**时判命中——长标题里出现一个「腿」多半是正经内容。
 * 取舍是「宁可漏抓，也不误杀」：错杀一条好视频是知识库里永久缺一块，漏抓一条还有
 * 下一轮轮转；而且漏进来的那条下一轮也会被同一个闸挡住。
 *
 * 还有一条独立规则「拆字」：短标题里每个字都被空格隔开（事故里的「负 重 前 行」）。
 * 正常内容不会把每个字都用空格拆开，这是规避搜索/推荐的常见写法，而且这种标题
 * 本身没有任何可判读的内容信息——留在库里也只是噪声。
 *
 * 标签也扫：真实数据里标签可能为空（搜索接口不返回标签），所以闸门不能只依赖它，
 * 但标题干净、标签露馅的情况一样要挡。
 *
 * 第二次真实测试（2026-10-29，rotation=10 泛词「二次元」）又漏进 3 条，所以再加两条规则：
 *   - 「组合」：有些词单看都有正当用法（「猫娘」是常见角色属性、「解开」是剧情解析常用词），
 *     放在**同一个标题**里才是话术；组合只扫标题、必须整组命中，所以「猫娘手书」放行。
 *   - 「引号+波浪号」：整条标题被一对引号包住、里面带 `~`、而且标题很短——这是擦边/标题党
 *     的标准包装（“当学姐馋你身子时”“猫娘的基础装备即将被绑匪解开~”）。长标题里的引号与
 *     波浪号一律放过（正常内容也会用「」引标题、用「~」卖萌）。
 */
export const UNSUITABLE_STRONG_TERMS: readonly string[] = [
  "胖次", "原味", "擦边", "太顶", "没边没际", "玩这么大", "男娘", "伪娘",
  "福利姬", "软色情", "色情", "露点", "裸体", "丝袜", "诱惑", "大尺度",
  // 第二次真实测试漏过的 3 条里，两条靠强信号词钉死：
  // 「当学姐**馋你**身子时」与「你这是**憋了多少圣水**啊」；「**绑匪**」一样只出现在擦边话术里。
  // 「逆天」故意不入表：游戏区「逆天操作」是正当说法，误杀成本高于漏抓（有反例测试盯着）。
  "馋你", "圣水", "憋了多少", "绑匪",
];

/**
 * 组合强信号：整组词**同时**出现在标题里才拦（顺序无关）。
 *
 * 为什么不用强信号词：单看「猫娘」是正常角色属性、「解开」是剧情解析常用词，
 * 只有组合起来才只剩擦边语义。只扫标题（简介/标签里的组合可能是正常讨论），
 * 且要求同一组全部命中，所以「猫娘手书合集」照常放行。
 */
export const UNSUITABLE_STRONG_COMBOS: readonly (readonly string[])[] = [
  ["猫娘", "绑匪"],
  ["猫娘", "解开"],
];

/** 组合命中时 `term` 的连接符（「猫娘+绑匪」），日志与测试都按这个形状断言 */
export const UNSUITABLE_COMBO_JOINER = "+";

/**
 * 「引号 + 波浪号」规则的标题长度上限（按 code point 数）。
 * 正常标题也会用引号/波浪号，但**整条标题被引号包住 + 含 `~` + 很短**三个条件同时成立时，
 * 命中率远高于误杀率；上限给 20 是让「猫娘的基础装备即将被绑匪解开~」这类 15 字的包装进来。
 */
export const UNSUITABLE_QUOTED_TITLE_MAX = 20;

/** 整条标题的引号对（只认成对包住整条标题的形态，标题中间的引号不算） */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
  ['"', '"'],
  ["'", "'"],
];

/** 弱信号词：只在「归一化标题长度 ≤ `UNSUITABLE_SHORT_TITLE_MAX`」时判命中 */
export const UNSUITABLE_SOFT_TERMS: readonly string[] = ["腿", "胸", "眼馋", "福利", "身材", "内衣", "翘臀"];

/** 弱信号词生效的标题长度上限（按 code point 数）：12 是一个短句的长度 */
export const UNSUITABLE_SHORT_TITLE_MAX = 12;

/**
 * 长标题里要**几个不同的弱信号词**才算命中（平衡值）。
 *
 * 为什么不是「1 个就拦」：单个弱词在长句里几乎全是正经用法——「她的身材与性格都被写进
 * 这段独白」「腿伤之后他怎么站起来」，拦下去会连续误伤创作区。为什么也不是「3 个」：
 * 实测两轮标题党里，长标题出现 ≥2 个弱词时命中的全部是擦边包装（如「身材 腿 内衣」）。
 * 因此取 2：短标题仍按 1 个算（短句里的弱词几乎无正当用法），长标题要求 2 个不同词。
 */
export const UNSUITABLE_SOFT_MIN_HITS_LONG = 2;

/** 为什么命中：命中的词（组合规则是「词+词」，拆字/引号规则用归一化后的标题）+ 走的哪条规则 */
export interface UnsuitableHit {
  readonly term: string;
  readonly rule: "strong" | "combo" | "short-title" | "soft-multi" | "spaced-title" | "quoted-title";
}

/** 去掉全部空白：标题里插空格是回避审核的常见写法（事故里的「负 重 前 行」就是这样） */
function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 拆字检测：短标题里 ≥3 段、且每一段都只有一个字符（「负 重 前 行」）→ 判为拆字。
 * 长标题不判（正常排版里「第 1 章」这类空格很多），段内多于一个字符也不判。
 */
function looksSpacedOut(title: string): boolean {
  const segments = title.split(/\s+/).filter((segment) => segment !== "");
  if (segments.length < 3) return false;
  if (Array.from(squeeze(title)).length > UNSUITABLE_SHORT_TITLE_MAX) return false;
  return segments.every((segment) => Array.from(segment).length === 1 && /\p{Script=Han}/u.test(segment));
}

/**
 * 引号包装检测：整条标题被一对引号包住、引号里含 `~`/`～`、且标题很短 → 返回引号里的标题（判命中）。
 * 三个条件缺一不可，任一不成立返回 `null`：
 *   - 引号必须在**整条标题的两端**（「【崩坏3】…「因你而在的故事」」不算，引号包不住整条）；
 *   - 波浪号是这类包装的固定尾巴（“猫娘的基础装备即将被绑匪解开~”）；
 *   - 长度按**去掉引号后**的 code point 数算，超过 `UNSUITABLE_QUOTED_TITLE_MAX` 一律放过。
 */
function quotedBaitTitle(title: string): string | null {
  const trimmed = title.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) continue;
    if (trimmed.length < open.length + close.length + 1) continue;
    const inner = trimmed.slice(open.length, trimmed.length - close.length);
    if (!/[~～]/.test(inner)) continue;
    return Array.from(inner).length <= UNSUITABLE_QUOTED_TITLE_MAX ? inner : null;
  }
  return null;
}

/**
 * 为什么命中：返回命中的词与规则，没命中返回 `null`。
 * `looksUnsuitable` 只是它的布尔版——工具层/测试要解释「为什么被挡」时用这个。
 */
export function explainUnsuitable(video: BiliVideo): UnsuitableHit | null {
  const title = squeeze(video.title);
  // 组合强信号排在最前：它比单词更具体，解释「为什么被挡」时给出的信息更多。
  // 只扫标题、要求同一组全部命中——单看「猫娘」「解开」都可能是正常内容。
  for (const combo of UNSUITABLE_STRONG_COMBOS) {
    if (combo.every((term) => title.includes(term))) {
      return { term: combo.join(UNSUITABLE_COMBO_JOINER), rule: "combo" };
    }
  }
  // 强信号词扫三个面：标题、简介、标签（UP 主名不扫：那是人，不是内容）
  const surfaces = [title, squeeze(video.description), ...video.tags.map(squeeze)];
  for (const term of UNSUITABLE_STRONG_TERMS) {
    if (surfaces.some((surface) => surface.includes(term))) return { term, rule: "strong" };
  }
  // 拆字：标题本身没有可判读的信息，只保留「被空格拆开的短标题」这一种形态
  if (looksSpacedOut(video.title)) return { term: squeeze(video.title), rule: "spaced-title" };
  // 引号包装：整条被引号包住 + 含波浪号 + 很短
  const quoted = quotedBaitTitle(video.title);
  if (quoted !== null) return { term: quoted, rule: "quoted-title" };
  // 弱信号词：短标题 1 个即命中；长标题要求 ≥2 个不同弱词（见 UNSUITABLE_SOFT_MIN_HITS_LONG）
  const softHits = UNSUITABLE_SOFT_TERMS.filter((term) => title.includes(term));
  if (softHits.length > 0) {
    const len = Array.from(title).length;
    const need = len <= UNSUITABLE_SHORT_TITLE_MAX ? 1 : UNSUITABLE_SOFT_MIN_HITS_LONG;
    if (softHits.length >= need) {
      return { term: softHits.join(UNSUITABLE_COMBO_JOINER), rule: len <= UNSUITABLE_SHORT_TITLE_MAX ? "short-title" : "soft-multi" };
    }
  }
  return null;
}

/** 质量闸门的布尔出口：true = 这条不该进知识库 */
export function looksUnsuitable(video: BiliVideo): boolean {
  return explainUnsuitable(video) !== null;
}

/**
 * 离题（off-topic）词表——B 站搜索结果里除了擦边/标题党，还会混进儿童早教/低龄内容
 * （「宝宝巴士安全教育」「食物戰爭 早教 益智 育儿」）。它们和成人角色的人设毫无关系，
 * 却会因为关键词字面匹配（「二次元」「崩坏三」的关联推荐）被拉进知识库，所以和质量闸门
 * **并列**再挡一层：两者语义不同，计数也必须分开（`blocked` 是擦边/标题党，`offTopic` 是离题）。
 *
 * 规则刻意窄：只扫标题（搜索接口的标签可能为空，且标题才是这条内容在主张什么），
 * 命中即离题；不做同义词扩展，宁可漏抓也不误杀正常内容。
 */
export const OFF_TOPIC_TERMS: readonly string[] = [
  "早教", "育儿", "宝宝巴士", "儿童动画", "儿童教育", "益智",
  "少儿", "幼儿园", "启蒙", "儿歌", "亲子",
];

/**
 * 低龄主体词：单独出现不判离题（「儿童节特别企划」是正常内容），
 * 只有和「动画/短片」出现在同一个标题里才算——见 `OFF_TOPIC_ANIMATION_TERMS`。
 */
export const OFF_TOPIC_LOW_AGE_TERMS: readonly string[] = ["儿童", "宝宝", "幼儿", "早教"];

/** 与低龄主体词组合成离题信号的词：单独出现是正常词（奥斯卡最佳动画短片、皮克斯动画短片） */
export const OFF_TOPIC_ANIMATION_TERMS: readonly string[] = ["动画", "短片"];

/** 英文离题词：小写 + 空白归一后做包含判断（`Kids Cartoon` / `kids  cartoon` 都算） */
export const OFF_TOPIC_EN_TERM = "kids cartoon";

/** 离题组合命中时 `term` 的连接符（「动画+幼儿」），测试按这个形状断言 */
export const OFF_TOPIC_COMBO_JOINER = "+";

/** 离题 reason 的前缀：命中时 `reason` 以它开头，与质量闸门的 blocked 一眼可分 */
export const OFF_TOPIC_REASON_PREFIX = "off-topic:";

/** 为什么被判离题：命中的词（组合规则是「词+词」）+ 走的哪条规则 */
export interface OffTopicHit {
  readonly term: string;
  readonly rule: "term" | "title-combo" | "kids-cartoon";
}

/** `looksOffTopic` 的返回：布尔出口 + 可解释原因（没命中时没有 `reason` 字段） */
export interface OffTopicVerdict {
  readonly offTopic: boolean;
  readonly reason?: string;
}

/** 英文规则用的归一化：小写 + 空白折叠，`Kids  Cartoon` 也要能认出来 */
function foldEnglish(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 为什么被判离题：返回命中的词与规则，没命中返回 `null`。
 * 判定顺序：英文整句 → 强指向词表 → 「动画/短片 + 低龄主体词」组合。
 * 强指向词排在组合前面，是因为它的解释最直接（标题里明写「早教」比推断组合更可信）。
 */
export function explainOffTopic(video: BiliVideo): OffTopicHit | null {
  // 英文整句：「Kids Cartoon」这类标题在中文词表里一个都命中不了，但它明显是低龄内容
  if (foldEnglish(video.title).includes(OFF_TOPIC_EN_TERM)) {
    return { term: OFF_TOPIC_EN_TERM, rule: "kids-cartoon" };
  }
  // 归一化去空白：标题里插空格是回避审核的常见写法，与质量闸门同一套处理
  const title = squeeze(video.title);
  for (const term of OFF_TOPIC_TERMS) {
    if (title.includes(term)) return { term, rule: "term" };
  }
  // 组合规则：「动画」「短片」本身正常，只有和低龄主体词同框才判离题
  const animation = OFF_TOPIC_ANIMATION_TERMS.find((term) => title.includes(term));
  if (animation !== undefined) {
    const lowAge = OFF_TOPIC_LOW_AGE_TERMS.find((term) => title.includes(term));
    if (lowAge !== undefined) {
      return { term: `${animation}${OFF_TOPIC_COMBO_JOINER}${lowAge}`, rule: "title-combo" };
    }
  }
  return null;
}

/**
 * 离题闸门的出口：`offTopic=true` 表示这条与角色人设无关（儿童早教/低龄内容）。
 * 与 `looksUnsuitable` 并列而不是合并：两者的计数（`offTopic` / `blocked`）要分开。
 */
export function looksOffTopic(video: BiliVideo): OffTopicVerdict {
  const hit = explainOffTopic(video);
  if (hit === null) return { offTopic: false };
  return { offTopic: true, reason: `${OFF_TOPIC_REASON_PREFIX}${hit.term}` };
}

/** 摄取参数。默认值就是任务定的那组；留可覆盖是为了以后从 engine.json 的 knob 里读 */
export interface BiliIngestCfg {
  readonly source?: string;
  readonly sourceCredibility?: number;
  readonly objectiveFreshness?: number;
  readonly socialFreshness?: number;
  readonly freshness?: number;
  readonly worldviewTranslated?: boolean;
}

export const DEFAULT_BILI_INGEST: Required<BiliIngestCfg> = {
  source: BILI_SOURCE,
  sourceCredibility: BILI_SOURCE_CREDIBILITY,
  objectiveFreshness: BILI_OBJECTIVE_FRESHNESS,
  socialFreshness: BILI_SOCIAL_FRESHNESS,
  freshness: BILI_FRESHNESS,
  worldviewTranslated: false,
};

export interface BiliIngestResult {
  readonly ingested: number;
  readonly skipped: number;
  /** 被质量闸门挡下的条数（已经算进 `skipped`：调用方关心的都是「没写进去」） */
  readonly blocked: number;
  /**
   * 被离题闸门挡下的条数（同样已经算进 `skipped`）。
   * 不复用 `blocked`：语义不同——`blocked` 是擦边/标题党，`offTopic` 是儿童早教/低龄内容。
   */
  readonly offTopic: number;
}

/**
 * 批量摄取。同 id 已存在就跳过（幂等），所以重复调用/重叠的两页不会把同一视频写两遍。
 * 先过质量闸门（`looksUnsuitable`），再过离题闸门（`looksOffTopic`）：两者命中都计入
 * `skipped`，但分别计入 `blocked` 与 `offTopic`，绝不落盘。
 *
 * `now` 由调用方传（引擎的 clock），本目录不读系统时钟。
 */
export function ingestVideos(
  store: KnowledgeWritePort,
  videos: readonly BiliVideo[],
  now: number,
  cfg: BiliIngestCfg = {},
): BiliIngestResult {
  const source = cfg.source ?? DEFAULT_BILI_INGEST.source;
  const sourceCredibility = cfg.sourceCredibility ?? DEFAULT_BILI_INGEST.sourceCredibility;
  const objectiveFreshness = cfg.objectiveFreshness ?? DEFAULT_BILI_INGEST.objectiveFreshness;
  const socialFreshness = cfg.socialFreshness ?? DEFAULT_BILI_INGEST.socialFreshness;
  const freshness = cfg.freshness ?? DEFAULT_BILI_INGEST.freshness;
  const worldviewTranslated = cfg.worldviewTranslated ?? DEFAULT_BILI_INGEST.worldviewTranslated;

  let ingested = 0;
  let skipped = 0;
  let blocked = 0;
  let offTopic = 0;
  for (const video of videos) {
    // 质量闸门排在最前：擦边内容不进知识库，也不占用「幂等跳过」的语义
    if (looksUnsuitable(video)) {
      skipped += 1;
      blocked += 1;
      continue;
    }
    // 离题闸门并列第二：儿童早教/低龄内容与角色无关，单独计数（reason 前缀 off-topic:）
    if (looksOffTopic(video).offTopic) {
      skipped += 1;
      offTopic += 1;
      continue;
    }
    const distilled = distillVideo(video);
    const id = store.idFor(distilled.tag);
    if (store.has(id)) {
      skipped += 1;
      continue;
    }
    const record: KnowledgeRecord = {
      id,
      content: distilled.content,
      knowledge_type: distilled.knowledgeType,
      source,
      source_credibility: sourceCredibility,
      objective_freshness: objectiveFreshness,
      social_freshness: socialFreshness,
      freshness,
      access_count: 0,
      ingested_at: now,
      worldview_translated: worldviewTranslated,
    };
    store.put(record);
    ingested += 1;
  }
  return { ingested, skipped, blocked, offTopic };
}
