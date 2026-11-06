/**
 * P4-2 L0 dream-shadow：夜间梦/联想的纯函数层。
 *
 * 依据：.tmp/handover/p4-2-build-brief.md §1.3–§3（用户 m04728 裁决：先开 L0 shadow，
 *   「跑梦、出报告、不落库」；encode_ctx.kind="dream" / derivation_chain / confidence≤0.4，
 *   schema 零变更）。
 *
 * 设计约束：
 *   - 零 IO、零时钟：时间一律由调用方以 nowMs 传入（lint:writers 禁止在纯函数里取当前时间，
 *     这样纯函数层可被单测完整覆盖）；
 *   - 只做「选种 → 提示词 → 解析 → 校验 → 影子记录形状」，不碰 memory、不写任何库；
 *   - 常量是本模块的先验（seed 数量、文本上限、置信上限、保留夜数），不进 overlay：
 *     它们不是可调参数，是 shadow 阶段的验收口径。
 */

export const DREAM_SEED_MIN = 3;
export const DREAM_SEED_MAX = 5;
export const DREAM_TEXT_MAX = 160;
export const DREAM_CONF_MAX = 0.4;
export const DREAM_CONF_HINT = 0.35;
export const DREAM_RETENTION_NIGHTS = 14;
export const DREAM_PROMPT_CONTENT_MAX = 120;

/** 断言式收尾：梦/联想不是学习报告，出现这些说法就判不合格（仍然记录，不落库） */
export const DREAM_ASSERTIVE_PHRASES = ["我学到了", "我发现", "我知道了", "我明白了"] as const;

/** 排序时视为「真实互动」的来源（与 engine 的 RELATION_SOURCES 同口径，由装配层传入覆盖） */
const DEFAULT_REAL_SOURCES = ["player", "qq_contact_verified"] as const;

/** 选种只需要记忆里这几列；不与 MemoryRecord 绑定，避免把纯函数层绑死在存储类型上 */
export interface DreamSeedRecord {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly created_at: number;
  readonly vividness?: number;
  readonly access_count?: number;
  readonly forgotten?: boolean;
  readonly suppressed_by_stronger?: boolean;
  readonly encode_ctx?: Readonly<Record<string, unknown>>;
}

/** 交给提示词的一条种子（不含 id——提示词里不出现内部标识） */
export interface DreamSeed {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly place?: string;
  readonly created_at: number;
}

export interface SelectDreamSeedsInput {
  readonly nowMs: number;
  readonly records: readonly DreamSeedRecord[];
  /** 3–5，默认 4 */
  readonly limit?: number;
  /** 真实互动来源；缺省 player / qq_contact_verified */
  readonly realSources?: readonly string[];
}

export type DreamSeedReason = "ok" | "low-data" | "no-material";

export interface DreamSeedSelection {
  readonly seeds: readonly DreamSeed[];
  /** 真实互动不足 2 条（本轮只在低料时补 1 条非真实互动） */
  readonly lowData: boolean;
  /** 实际补位的非真实互动条数（≤1） */
  readonly fillerCount: number;
  readonly reason: DreamSeedReason;
}

function realRankOf(source: string, realSources: readonly string[]): number {
  return realSources.includes(source) ? 0 : 1;
}

function compareSeeds(a: DreamSeedRecord, b: DreamSeedRecord, realSources: readonly string[]): number {
  const ra = realRankOf(a.source, realSources);
  const rb = realRankOf(b.source, realSources);
  if (ra !== rb) return ra - rb;
  const va = a.vividness ?? 0;
  const vb = b.vividness ?? 0;
  if (va !== vb) return vb - va;
  const aa = a.access_count ?? 0;
  const ab = b.access_count ?? 0;
  if (aa !== ab) return ab - aa;
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function placeOf(record: DreamSeedRecord): string | undefined {
  const value = record.encode_ctx?.["place"];
  if (typeof value !== "string") return undefined;
  const place = value.trim();
  return place === "" ? undefined : place;
}

function toSeed(record: DreamSeedRecord): DreamSeed {
  const place = placeOf(record);
  return {
    id: record.id.trim(),
    source: record.source,
    content: record.content.trim(),
    created_at: record.created_at,
    ...(place === undefined ? {} : { place }),
  };
}

/**
 * 选出这一夜的种子。
 *
 * 过滤：id/正文为空、已遗忘、已被更强记忆压制、来源是 dream 的都不选；
 * 排序：真实互动优先 → vividness 降 → access_count 降 → created_at 降 → id 升；
 * 低料：真实互动 < 2 时，最多补 1 条非真实互动（lowData=true）；不足 3 条返回 no-material，
 *   由装配层跳过本次梦（不生成模板凑数，也不花模型钱）。
 */
export function selectDreamSeeds(input: SelectDreamSeedsInput): DreamSeedSelection {
  if (!Number.isFinite(input.nowMs)) throw new RangeError("selectDreamSeeds：nowMs 必须是有限数");
  if (!Array.isArray(input.records)) throw new RangeError("selectDreamSeeds：records 必须是数组");
  const limit = input.limit ?? 4;
  if (!Number.isInteger(limit) || limit < DREAM_SEED_MIN || limit > DREAM_SEED_MAX) {
    throw new RangeError(`selectDreamSeeds：limit 必须是 ${DREAM_SEED_MIN}–${DREAM_SEED_MAX} 的整数`);
  }
  const realSources = input.realSources === undefined ? [...DEFAULT_REAL_SOURCES] : [...input.realSources];

  const candidates = input.records
    .filter((record) => {
      if (record.id.trim() === "") return false;
      if (record.content.trim() === "") return false;
      if (record.forgotten === true) return false;
      if (record.suppressed_by_stronger === true) return false;
      if (record.source === "dream") return false;
      return true;
    })
    .sort((a, b) => compareSeeds(a, b, realSources));

  const realCount = candidates.filter((record) => realRankOf(record.source, realSources) === 0).length;
  const capped = candidates.slice(0, limit);

  let picked = capped;
  if (realCount < 2) {
    // 低料时只补 1 条非真实互动：宁可这次梦更短，也不让 selftalk 把梦嚼成复读机
    let fillerUsed = false;
    picked = capped.filter((record) => {
      if (realRankOf(record.source, realSources) === 0) return true;
      if (fillerUsed) return false;
      fillerUsed = true;
      return true;
    });
  }

  const seeds = picked.map(toSeed);
  const lowData = candidates.length > 0 && realCount < 2;
  const fillerCount = picked.filter((record) => realRankOf(record.source, realSources) === 1).length;
  const reason: DreamSeedReason =
    seeds.length < DREAM_SEED_MIN ? "no-material" : lowData ? "low-data" : "ok";
  return { seeds, lowData, fillerCount, reason };
}

export interface DreamPromptMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface BuildDreamPromptInput {
  readonly personaName: string;
  readonly seeds: readonly DreamSeed[];
  readonly nightKey: string;
}

function takeCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join("")}…`;
}

/**
 * 组梦的提示词。
 * 约束（brief §1.4）：只输出正文；不编新事实；不要「我学到了」这类断言式收尾；
 * 种子只以正文片段出现，**不带 id**（避免模型把内部标识写进梦）。
 */
export function buildDreamPrompt(input: BuildDreamPromptInput): readonly DreamPromptMessage[] {
  const nightKey = input.nightKey.trim();
  if (nightKey === "") throw new RangeError("buildDreamPrompt：nightKey 不能为空");
  if (input.seeds.length === 0) throw new RangeError("buildDreamPrompt：没有种子就不该调模型");

  const lines = input.seeds.map((seed) => {
    const body = takeCodePoints(seed.content.trim(), DREAM_PROMPT_CONTENT_MAX);
    const place = seed.place === undefined ? "" : `（场景：${seed.place}）`;
    return `- ${body}${place}`;
  });
  const system = `你是${input.personaName}，正在睡眠中。今晚记忆在重放——不要向任何人报告这件事，只让念头自己流动。`;
  const user = [
    `今晚（${nightKey}）重放的是这几件事：`,
    ...lines,
    "",
    "写一条 80 字以内的梦/联想，第一人称；不要编新事实，不要写「我学到了」「我发现」「我知道了」「我明白了」；不要解释、不要列点，只输出正文。",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
];

/**
 * 清掉模型偶尔包上的引号/前后空白；非字符串一律空串。
 * 只做规范化，不做内容裁断（长度/断言式都留给 validate，保证报告里看得到原文）。
 */
export function parseDreamText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  return text;
}

export interface DreamShadowValidationInput {
  /** 本次候选池（用于判悬空/已遗忘/压制/来源） */
  readonly records: readonly DreamSeedRecord[];
  /** 本轮实际用到的种子 id（顺序即 derivation_chain） */
  readonly seedIds: readonly string[];
  readonly text: string;
  readonly confidenceHint?: number;
  readonly error?: string | null;
}

export interface DreamShadowValidation {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * 校验一条影子的可落库形状（L0 只记录，不落库）。
 * reasons 是稳定码，便于夜里 grep：model-error / seeds-empty / seed-count / seed-id-duplicate /
 * seed-dangling / seed-self / seed-dream / seed-forgotten / seed-suppressed / text-empty /
 * text-too-long / text-assertive / confidence。
 */
export function validateDreamShadow(input: DreamShadowValidationInput): DreamShadowValidation {
  const reasons = new Set<string>();
  if (typeof input.error === "string" && input.error.trim() !== "") reasons.add("model-error");
  if (input.seedIds.length === 0) reasons.add("seeds-empty");
  if (input.seedIds.length < DREAM_SEED_MIN || input.seedIds.length > DREAM_SEED_MAX) {
    reasons.add("seed-count");
  }

  const seen = new Set<string>();
  for (const id of input.seedIds) {
    if (seen.has(id)) reasons.add("seed-id-duplicate");
    seen.add(id);
    if (id.startsWith("dream:") || id.startsWith("dream-shadow:")) reasons.add("seed-self");
    const record = input.records.find((candidate) => candidate.id === id);
    if (record === undefined) {
      reasons.add("seed-dangling");
      continue;
    }
    if (record.source === "dream") reasons.add("seed-dream");
    if (record.forgotten === true) reasons.add("seed-forgotten");
    if (record.suppressed_by_stronger === true) reasons.add("seed-suppressed");
  }

  const text = typeof input.text === "string" ? input.text.trim() : "";
  const chars = Array.from(text).length;
  if (chars === 0) reasons.add("text-empty");
  if (chars > DREAM_TEXT_MAX) reasons.add("text-too-long");
  if (chars > 0 && DREAM_ASSERTIVE_PHRASES.some((phrase) => input.text.includes(phrase))) {
    reasons.add("text-assertive");
  }

  if (input.confidenceHint !== undefined) {
    if (
      !Number.isFinite(input.confidenceHint) ||
      input.confidenceHint < 0 ||
      input.confidenceHint > DREAM_CONF_MAX
    ) {
      reasons.add("confidence");
    }
  }

  const list = [...reasons];
  return { ok: list.length === 0, reasons: list };
}

export interface DreamShadowTokens {
  readonly prompt: number;
  readonly completion: number;
}

export interface DreamShadowBudget {
  readonly used: number;
  readonly left: number;
}

export interface DreamShadowRecord {
  readonly v: 1;
  readonly nightKey: string;
  readonly ranAtMs: number;
  readonly model: string;
  readonly seedIds: readonly string[];
  readonly text: string | null;
  readonly validation: { readonly ok: boolean; readonly reasons: readonly string[] };
  readonly confidenceHint: number;
  readonly landingShape: {
    readonly source: "dream";
    readonly confidence: number;
    readonly encode_ctx: { readonly kind: "dream" };
    readonly derivation_chain: readonly string[];
  };
  readonly tokens: DreamShadowTokens;
  readonly durationMs: number;
  readonly budget: DreamShadowBudget;
  readonly lowData: boolean;
  readonly error: string | null;
}

export interface BuildShadowRecordInput {
  readonly nightKey: string;
  readonly ranAtMs: number;
  readonly model: string;
  readonly seedIds: readonly string[];
  readonly text: string | null;
  readonly validation: DreamShadowValidation;
  readonly lowData: boolean;
  readonly tokens: DreamShadowTokens;
  readonly durationMs: number;
  readonly budget: DreamShadowBudget;
  readonly confidenceHint?: number;
  readonly error?: string | null;
}

function clampConfidence(hint: number | undefined): number {
  const raw = hint ?? DREAM_CONF_HINT;
  const clamped = Number.isFinite(raw) ? Math.min(DREAM_CONF_MAX, Math.max(0, raw)) : DREAM_CONF_HINT;
  return Math.round(clamped * 100) / 100;
}

/**
 * 组装一行影子记录。landingShape 是「若将来落库会长成什么样」的预演：
 * encode_ctx.kind="dream"、derivation_chain=本轮种子、confidence 不超过 0.4（Q2 裁决）。
 */
export function buildShadowRecord(input: BuildShadowRecordInput): DreamShadowRecord {
  const nightKey = input.nightKey.trim();
  if (nightKey === "") throw new RangeError("buildShadowRecord：nightKey 不能为空");
  if (!Number.isFinite(input.ranAtMs)) throw new RangeError("buildShadowRecord：ranAtMs 必须是有限数");
  const confidence = clampConfidence(input.confidenceHint);
  return {
    v: 1,
    nightKey,
    ranAtMs: input.ranAtMs,
    model: input.model,
    seedIds: [...input.seedIds],
    text: input.text,
    validation: { ok: input.validation.ok, reasons: [...input.validation.reasons] },
    confidenceHint: confidence,
    landingShape: {
      source: "dream",
      confidence,
      encode_ctx: { kind: "dream" },
      derivation_chain: [...input.seedIds],
    },
    tokens: { prompt: input.tokens.prompt, completion: input.tokens.completion },
    durationMs: input.durationMs,
    budget: { used: input.budget.used, left: input.budget.left },
    lowData: input.lowData,
    error: typeof input.error === "string" && input.error.trim() !== "" ? input.error : null,
  };
}

/** 影子文件只保留最近 N 夜（调用方负责原子重写；这里只做纯裁剪） */
export function trimShadowLines(
  lines: readonly string[],
  keep: number = DREAM_RETENTION_NIGHTS,
): string[] {
  if (!Number.isInteger(keep) || keep <= 0) throw new RangeError("trimShadowLines：keep 必须是正整数");
  return lines.slice(Math.max(0, lines.length - keep));
}
