/**
 * 六层人格（v5.2 §3 / §9）里 **A / B / C / D 四层的载体**。
 *
 * ## 为什么要这个文件（而不是继续堆 persona 文本）
 *
 * `persona/assistant.json` 现在是一份**纯文本**人格卡：`description`、`speech`、`taboos`、
 * `inner`、`habits`……模型读了它，能"演得像"，但引擎**没有任何可计算的输入**：
 *
 * - 问「她为什么拒绝了这句」→ 答不上来，因为没有 A 层（核心信念）做否决；
 * - 问「她会怎么选」→ 答不上来，因为没有 B 层（价值观权重）做排序；
 * - 问「她在同一情境下会不会前后一致」→ 答不上来，因为没有 C 层（CAPS 签名）。
 *
 * v5.2 §3 把人格拆成六层：A 核心信念 / B 价值观 / C 行为模式 / D 驱力与依恋 / E 社交面具 / S 实时状态。
 * S 层在 `engine/state.ts`（13 个变量，已实现且更严）；D 层的依恋在
 * `dialogue/expression.ts`（有类型、有象限、但**没落库**）；E 层的面具只有 2 个标量。
 * A/B/C 三层在 `V52-GAP.md` 里是**零代码**（全 src grep `core_belief` / `CAPS` / `temperament` 零命中）。
 *
 * 这个文件先做**最窄的一步**：给出可解析、可校验、可序列化的 A/B/C/D 载体 + 原型库。
 * 它**不改任何现有行为**——接线（A 层否决、B 层排序、C 层选策略）单独一步做，
 * 因为"人格开始影响行为"是会让 1010 条既有用例语义漂移的改动，必须一次只动一处。
 *
 * ## 四个概念的非专业解释（用户看的）
 *
 * - **OCEAN 质心**：五个人格维度（开放/尽责/外向/宜人/神经质）的坐标。它是"她这个人的位置"。
 *   原型库就是几个预设坐标点，比如「傲娇」是 (0.55, 0.70, 0.60, 0.40, 0.80)。
 *   **质心是派生的唯一输入**——A/B/C 都能从它推出来，所以造一个新角色只需要填 5 个数。
 * - **A 核心信念**：她**为什么**会拒绝。写作"信念 / 反信念 / 最怕的事 / 禁区"。
 *   例：信念「被记住就是活着」↔ 反信念「被记错比被忘记更糟」。禁区触发时会**降级表达**，
 *   不是说不出话，而是换一种说法（规格 §3 称之为 A 层否决权）。
 * - **B 价值观**：她**在冲突时先保什么**。六个权重（善意/真实/自由/美/归属/掌控），和为 1。
 *   两个选项都合理时，权重高的那个赢——这让她的选择可预测、可解释，而不是每次靠模型即兴。
 * - **C 行为模式（CAPS 签名）**：**如果……就……** 的条件-反应表。
 *   「如果对方在示弱 → 先收敛玩笑，再给一句具体的关心」。它保证她在同一情境下前后一致。
 * - **D 依恋**：焦虑（怕被丢下）与回避（怕太近）。这两个数**不决定关系能走多远**（v5.3 起
 *   阶段直读 progress），只决定**怎么说话**——所以这里只做一致性校验（象限-曲线错配是警告不是错误）。
 *
 * ## 为什么不直接读 v5.2 的 79 项旋钮
 *
 * 人格不是旋钮。旋钮是"这台机器多快多慢"，人格是"她是谁"。把人格塞进 engine.json 会让
 * 换角色=改配置，而配置有 owner/readers 注册表、有 per-archetype ≤40 的上限。
 * 人格的正经载体是**人格卡文件**（`persona/<id>.json` 的 `personality` 段），
 * 这个模块只负责把它解析成结构、把 A/B/C 派生出来。
 */

import { deriveBondCurve } from "./bonds.js";

/**
 * D 层依恋（0..1）。这里**自带一份类型**而不是 import `dialogue/expression.ts`：
 * 结构相同即可（TS 结构化类型），而 engine → dialogue 的 import 会造出一个
 * engine ↔ dialogue 的模块级环——边界 lint 的 SCC 检查会把它当新增环报出来。
 */
export interface Attachment {
  readonly anxiety: number;
  readonly avoidance: number;
}

/* ------------------------------------------------------------------ *
 * 一、OCEAN 质心 + 原型库
 * ------------------------------------------------------------------ */

export const OCEAN_KEYS = ["O", "C", "E", "A", "N"] as const;
export type OceanKey = (typeof OCEAN_KEYS)[number];

/** 五维人格坐标，每维 0..1。`O` 开放、`C` 尽责、`E` 外向、`A` 宜人、`N` 神经质。 */
export interface OceanProfile {
  readonly O: number;
  readonly C: number;
  readonly E: number;
  readonly A: number;
  readonly N: number;
}

/** 原型对表达的调制：不是改数值，是"在某种场合下把某一维压住"。 */
export interface ArchetypeModulation {
  /** 公开场合外向度调制（负=收敛），0 附近不调 */
  readonly expressionInPublic?: number;
  /** 示弱/脆弱时宜人性调制（负=更容易顶回去） */
  readonly agreeablenessWhenVulnerable?: number;
}

/** 原型库的一条。`centroid` 是这个原型在 OCEAN 空间里的坐标。 */
export interface Archetype {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly centroid: OceanProfile;
  readonly modulation?: ArchetypeModulation;
  /**
   * 情境标签 → 默认策略。C 层（CAPS）的兜底：人格卡没写 CAPS 时用它。
   * 标签是离散的（`calm` / `tense` / `playful` / `intimate` / `sad`），
   * 对应《大脑与脊髓.txt》里的 `CONTEXT_TAGS`——大脑只传标签，不传语义。
   */
  readonly defaultStrategy?: Readonly<Record<string, string>>;
  /** B 层价值观权重（和为 1）。人格卡没写 B 层时用它。 */
  readonly defaultValues: Readonly<Record<ValueKey, number>>;
}

/**
 * 原型库：6 个预设坐标点。
 *
 * 这不是"角色模板"，是**坐标点**。造角色时要么给出 5 个数（从最近的 1~2 个原型派生），
 * 要么写 `archetype: "<id>"` 直接用某个原型。坐标点的具体数值是工程选择——
 * 它们只需要满足一件事：任意合理的人格质心都能在 0.5 距离内找到最近原型。
 */
export const ARCHETYPES: readonly Archetype[] = [
  {
    id: "trickster",
    label: "温柔 / 沉静",
    description: "用玩笑接近人，把真心包在轻快里；越认真时句子越短。",
    // AI助手的坐标：高开放（什么都想看看）、高外向（主动搭话）、神经质中等（会慌但不崩）
    centroid: { O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 },
    modulation: { expressionInPublic: -0.1, agreeablenessWhenVulnerable: -0.15 },
    defaultStrategy: {
      calm: "开玩笑，把话题递回去",
      tense: "先收笑，短句，直接问对方怎么了",
      playful: "顺着玩，再夸张一点",
      intimate: "撩得直接，撩完自己笑着收半步",
      sad: "不劝，陪着，把话说轻",
    },
    defaultValues: { care: 0.28, truth: 0.18, freedom: 0.16, beauty: 0.16, belonging: 0.14, mastery: 0.08 },
  },
  {
    id: "guardian",
    label: "守护者",
    description: "把人挡在身后，话说得少但都算数；不擅长被照顾。",
    centroid: { O: 0.45, C: 0.82, E: 0.38, A: 0.76, N: 0.46 },
    modulation: { expressionInPublic: -0.15, agreeablenessWhenVulnerable: -0.25 },
    defaultStrategy: {
      calm: "确认对方平安，再把该做的事说清",
      tense: "挡在前面，先处理再解释",
      playful: "不太会接，认真回应一句",
      intimate: "笨拙但直接",
      sad: "不说话，做事",
    },
    defaultValues: { care: 0.32, truth: 0.16, freedom: 0.06, beauty: 0.06, belonging: 0.22, mastery: 0.18 },
  },
  {
    id: "tsundere",
    label: "傲娇",
    description: "嘴上不认，行动先到；被戳穿会更强硬一点。",
    centroid: { O: 0.55, C: 0.7, E: 0.6, A: 0.4, N: 0.8 },
    modulation: { expressionInPublic: -0.35, agreeablenessWhenVulnerable: -0.4 },
    defaultStrategy: {
      calm: "先否认一句，再补一句真心",
      tense: "顶回去，但留门",
      playful: "嘴上嫌弃，身体配合",
      intimate: "说反话，说完自己别过脸",
      sad: "不承认难过，待在附近",
    },
    defaultValues: { care: 0.26, truth: 0.14, freedom: 0.1, beauty: 0.1, belonging: 0.28, mastery: 0.12 },
  },
  {
    id: "sage",
    label: "智者",
    description: "先看清楚再说话；不安慰，给一个能站住的解释。",
    centroid: { O: 0.86, C: 0.72, E: 0.3, A: 0.58, N: 0.28 },
    modulation: { expressionInPublic: -0.2, agreeablenessWhenVulnerable: 0.05 },
    defaultStrategy: {
      calm: "把问题拆开，给一个判断",
      tense: "降低语速，先定事实",
      playful: "配合一点，但不失分寸",
      intimate: "少见地直接，说完就停",
      sad: "讲一个更长的道理，让他有处可站",
    },
    defaultValues: { care: 0.16, truth: 0.34, freedom: 0.18, beauty: 0.1, belonging: 0.08, mastery: 0.14 },
  },
  {
    id: "caretaker",
    label: "照顾者",
    description: "先照顾人的感受，再谈事情；很难对别人的痛苦说'不关我事'。",
    centroid: { O: 0.52, C: 0.68, E: 0.56, A: 0.9, N: 0.22 },
    modulation: { expressionInPublic: 0.05, agreeablenessWhenVulnerable: 0.1 },
    defaultStrategy: {
      calm: "先问感受，再问事情",
      tense: "先稳住对方情绪",
      playful: "温柔地陪着玩",
      intimate: "周到，但会突然认真",
      sad: "握着对方的手，慢慢说",
    },
    defaultValues: { care: 0.38, truth: 0.12, freedom: 0.06, beauty: 0.08, belonging: 0.26, mastery: 0.1 },
  },
  {
    id: "wanderer",
    label: "旅人",
    description: "不太停留，也不太拒绝；把距离感做成礼貌。",
    centroid: { O: 0.78, C: 0.44, E: 0.5, A: 0.64, N: 0.42 },
    modulation: { expressionInPublic: -0.05, agreeablenessWhenVulnerable: -0.1 },
    defaultStrategy: {
      calm: "聊点远处的见闻",
      tense: "退半步，留一句余地",
      playful: "一起走一段",
      intimate: "靠近，但不承诺",
      sad: "安静地陪，不提将来",
    },
    defaultValues: { care: 0.2, truth: 0.2, freedom: 0.3, beauty: 0.14, belonging: 0.08, mastery: 0.08 },
  },
];

export function archetypeById(id: string): Archetype | null {
  return ARCHETYPES.find((a) => a.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * 二、派生：质心 → 原型（v5.2 §9.2）
 * ------------------------------------------------------------------ */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 五维欧氏距离（再除 sqrt(5) 归一到 0..1，这样 0.3 / 0.5 两个阈值才有直觉意义）。 */
export function oceanDistance(a: OceanProfile, b: OceanProfile): number {
  let sum = 0;
  for (const k of OCEAN_KEYS) {
    const d = a[k] - b[k];
    sum += d * d;
  }
  return Math.sqrt(sum) / Math.sqrt(OCEAN_KEYS.length);
}

/** 复合人格：按权重把多个原型的质心加权平均（v5.2 §9.1 `compose(weights)`）。 */
export function composeOcean(weights: Readonly<Record<string, number>>): OceanProfile {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) throw new Error("composeOcean: 权重必须至少包含一个 > 0 的原型");
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const acc: Record<OceanKey, number> = { O: 0, C: 0, E: 0, A: 0, N: 0 };
  for (const [id, w] of entries) {
    const arch = archetypeById(id);
    if (arch === null) throw new Error(`composeOcean: 不认识的原型「${id}」（可选：${ARCHETYPES.map((a) => a.id).join(" / ")}）`);
    for (const k of OCEAN_KEYS) acc[k] += (arch.centroid[k] * w) / total;
  }
  return { O: acc.O, C: acc.C, E: acc.E, A: acc.A, N: acc.N };
}

export interface DerivedArchetype {
  /** 最近原型 */
  readonly archetype: Archetype;
  /** 归一化距离 0..1 */
  readonly distance: number;
  /** 距离落在 0.3~0.5 时给出的第二近原型（混合对象）；否则 null */
  readonly blendWith: Archetype | null;
  /**
   * `direct` 距离 < 0.3；`blend` 0.3~0.5；`outlier` > 0.5。
   * `outlier` 在 v5.2 里是**错误**（"偏离质心过远，请确认是否复合人格"），
   * 但这里不抛，交给 `parsePersonality` 决定怎么报——派生本身要能被测试单独调。
   */
  readonly kind: "direct" | "blend" | "outlier";
}

/**
 * v5.2 §9.2：找最近两个原型，< 0.3 直接取第一个；0.3~0.5 混合；> 0.5 视为复合人格需显式指定。
 */
export function deriveFromOcean(centroid: OceanProfile): DerivedArchetype {
  const ranked = ARCHETYPES.map((a) => ({ a, d: oceanDistance(centroid, a.centroid) })).sort((x, y) => x.d - y.d);
  const first = ranked[0];
  const second = ranked[1];
  if (first === undefined) throw new Error("deriveFromOcean: 原型库为空");
  if (first.d < 0.3) return { archetype: first.a, distance: first.d, blendWith: null, kind: "direct" };
  if (first.d < 0.5 && second !== undefined) {
    return { archetype: first.a, distance: first.d, blendWith: second.a, kind: "blend" };
  }
  return { archetype: first.a, distance: first.d, blendWith: null, kind: "outlier" };
}

/* ------------------------------------------------------------------ *
 * 三、A 层（核心信念）/ B 层（价值观）/ C 层（CAPS）
 * ------------------------------------------------------------------ */

export const VALUE_KEYS = ["care", "truth", "freedom", "beauty", "belonging", "mastery"] as const;
export type ValueKey = (typeof VALUE_KEYS)[number];
export type ValueWeights = Readonly<Record<ValueKey, number>>;

/** A 层：核心信念。规格 §3 A 层的七件套。 */
export interface CoreLayer {
  /** 她相信什么（一句话，第一人称） */
  readonly belief: string;
  /** 与之并列、会在某些时刻浮上来的反信念（人不是单线程的） */
  readonly counterBelief?: string;
  /** 最怕的事 */
  readonly fear?: string;
  /** 禁区：触发即降级表达（不是封口，是换说法） */
  readonly taboos: readonly string[];
  /** 条件假设：「只要……就……」她用来解释世界的几条规则 */
  readonly conditionalAssumptions: readonly string[];
  /** 补偿策略：她用来保护自己的做法 */
  readonly compensatoryStrategies: readonly string[];
  /** self_schema 种子（2~3 条）：她怎么描述自己 */
  readonly selfSchema: readonly string[];
}

/** C 层：CAPS 签名的一条 if-then。 */
export interface CapsRule {
  readonly when: string;
  readonly then: string;
}

/** C 层：行为模式。 */
export interface CapsLayer {
  readonly signature: readonly CapsRule[];
  /** 情境标签 → 策略（缺省从原型继承） */
  readonly defaultStrategy: Readonly<Record<string, string>>;
}

/** 完整人格（A/B/C/D 四层 + 派生出来的质心与阈值）。 */
export interface Personality {
  readonly ocean: OceanProfile;
  readonly archetype: string;
  readonly blendWith?: string;
  readonly oceanDistance: number;
  readonly a: CoreLayer;
  readonly b: ValueWeights;
  readonly c: CapsLayer;
  readonly attachment: Attachment;
  readonly bondCurveId: BondCurveId;
  readonly consolidationThreshold: number;
  readonly insightThreshold: number;
}

export type BondCurveId = ReturnType<typeof deriveBondCurve>;

/** 解析结果：`warnings` 是可以放行的不一致（v5.2 把依恋-曲线错配从硬错误降级成警告）。 */
export interface ParsedPersonality {
  readonly personality: Personality;
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 四、解析 + 校验（v5.2 §9.4）
 * ------------------------------------------------------------------ */

function num(v: unknown, field: string, range: readonly [number, number] = [0, 1]): number {
  if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`人格卡「${field}」必须是数字`);
  if (v < range[0] || v > range[1]) {
    throw new Error(`人格卡「${field}」=${String(v)} 超出范围 [${String(range[0])}, ${String(range[1])}]`);
  }
  return v;
}

function nonEmptyStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`人格卡「${field}」必须是非空字符串`);
  return v.trim();
}

function strArray(v: unknown, field: string, min = 0): readonly string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || (x as string).trim() === "")) {
    throw new Error(`人格卡「${field}」必须是字符串数组`);
  }
  const out = v.map((x) => (x as string).trim());
  if (out.length < min) throw new Error(`人格卡「${field}」至少要 ${String(min)} 条`);
  return out;
}

function parseOcean(raw: unknown, field: string): OceanProfile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`人格卡「${field}」必须是对象（O/C/E/A/N 五个 0..1 的数）`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(OCEAN_KEYS as readonly string[]).includes(key)) {
      throw new Error(`人格卡「${field}」里有未知维度「${key}」，只能是 O / C / E / A / N`);
    }
  }
  return {
    O: num(o["O"], `${field}.O`),
    C: num(o["C"], `${field}.C`),
    E: num(o["E"], `${field}.E`),
    A: num(o["A"], `${field}.A`),
    N: num(o["N"], `${field}.N`),
  };
}

function normalizeValues(raw: Readonly<Record<string, number>>, field: string): ValueWeights {
  const acc: Record<ValueKey, number> = { care: 0, truth: 0, freedom: 0, beauty: 0, belonging: 0, mastery: 0 };
  let total = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!(VALUE_KEYS as readonly string[]).includes(k)) {
      throw new Error(`人格卡「${field}」里有未知价值观「${k}」，只能是 ${VALUE_KEYS.join(" / ")}`);
    }
    // 权重只要 >= 0；不设上限是因为「care: 3, truth: 1」这种写法更直观，归一化在下面做
    const n = num(v, `${field}.${k}`, [0, 100]);
    acc[k as ValueKey] = n;
    total += n;
  }
  if (total <= 0) throw new Error(`人格卡「${field}」权重和必须 > 0`);
  for (const k of VALUE_KEYS) acc[k] = acc[k] / total;
  return acc;
}

/**
 * 解析人格卡的 `personality` 段。
 *
 * 严格程度按 v5.2 §9.4：**必填缺失 / 区间越界 / 未知字段 / 质心偏离 > 0.5 报错**；
 * 依恋-曲线错配**只警告**（因为阶段直读 progress，曲线只影响表达风格）。
 */
export function parsePersonality(raw: unknown): ParsedPersonality {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("人格卡「personality」必须是对象");
  }
  const o = raw as Record<string, unknown>;
  const warnings: string[] = [];

  // --- OCEAN：要么给质心，要么给 archetype（二选一，都给则以质心为准并警告）
  let ocean: OceanProfile;
  let explicitArchetype: string | null = null;
  if (o["archetype"] !== undefined) {
    explicitArchetype = nonEmptyStr(o["archetype"], "personality.archetype");
    const arch = archetypeById(explicitArchetype);
    if (arch === null) {
      throw new Error(`人格卡「personality.archetype」不认识「${explicitArchetype}」（可选：${ARCHETYPES.map((a) => a.id).join(" / ")}）`);
    }
    ocean = arch.centroid;
  } else {
    ocean = parseOcean(o["centroid"], "personality.centroid");
  }
  if (o["centroid"] !== undefined && explicitArchetype !== null) {
    ocean = parseOcean(o["centroid"], "personality.centroid");
    warnings.push("同时给了 archetype 与 centroid：以 centroid 为准（archetype 只作为意图声明）");
  }

  const derived = deriveFromOcean(ocean);
  if (derived.kind === "outlier") {
    throw new Error(
      `人格质心离最近的「${derived.archetype.id}」还有 ${derived.distance.toFixed(3)}（> 0.5），` +
        "偏离原型过远：请明确指定 archetype，或用 compose 给出复合质心",
    );
  }
  if (explicitArchetype !== null && explicitArchetype !== derived.archetype.id) {
    warnings.push(
      `声明 archetype=${explicitArchetype}，但质心离「${derived.archetype.id}」更近（${derived.distance.toFixed(3)}）——按质心派生`,
    );
  }

  // --- A 层
  const aRaw = o["a"];
  if (aRaw === null || typeof aRaw !== "object" || Array.isArray(aRaw)) {
    throw new Error("人格卡「personality.a」必须是对象（A 核心信念层）");
  }
  const aObj = aRaw as Record<string, unknown>;
  // 未知字段 fail-closed：A 层写错 key 不会有任何效果，却会让人以为生效了
  for (const key of Object.keys(aObj)) {
    if (!["belief", "counterBelief", "fear", "taboos", "conditionalAssumptions", "compensatoryStrategies", "selfSchema"].includes(key)) {
      throw new Error(`人格卡「personality.a」里有未知字段「${key}」，请查 schema`);
    }
  }
  const a: CoreLayer = {
    belief: nonEmptyStr(aObj["belief"], "personality.a.belief"),
    ...(aObj["counterBelief"] === undefined ? {} : { counterBelief: nonEmptyStr(aObj["counterBelief"], "personality.a.counterBelief") }),
    ...(aObj["fear"] === undefined ? {} : { fear: nonEmptyStr(aObj["fear"], "personality.a.fear") }),
    taboos: aObj["taboos"] === undefined ? [] : strArray(aObj["taboos"], "personality.a.taboos"),
    conditionalAssumptions:
      aObj["conditionalAssumptions"] === undefined ? [] : strArray(aObj["conditionalAssumptions"], "personality.a.conditionalAssumptions"),
    compensatoryStrategies:
      aObj["compensatoryStrategies"] === undefined ? [] : strArray(aObj["compensatoryStrategies"], "personality.a.compensatoryStrategies"),
    // v5.2 §9.3：self_schema_emb 必填，2~3 条
    selfSchema: strArray(aObj["selfSchema"], "personality.a.selfSchema", 2),
  };
  if (a.selfSchema.length > 3) {
    throw new Error(`人格卡「personality.a.selfSchema」最多 3 条（现在是 ${String(a.selfSchema.length)} 条）`);
  }

  // --- B 层
  const b = o["b"] === undefined ? derived.archetype.defaultValues : normalizeValues(o["b"] as Record<string, number>, "personality.b");

  // --- C 层
  let c: CapsLayer;
  if (o["c"] === undefined) {
    c = { signature: [], defaultStrategy: derived.archetype.defaultStrategy ?? {} };
  } else {
    const cRaw = o["c"];
    if (cRaw === null || typeof cRaw !== "object" || Array.isArray(cRaw)) throw new Error("人格卡「personality.c」必须是对象");
    const cObj = cRaw as Record<string, unknown>;
    const sigRaw = cObj["signature"] ?? [];
    if (!Array.isArray(sigRaw)) throw new Error("人格卡「personality.c.signature」必须是数组");
    const signature: CapsRule[] = sigRaw.map((row, i) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error(`人格卡「personality.c.signature[${String(i)}]」必须是 {when, then}`);
      const r = row as Record<string, unknown>;
      return { when: nonEmptyStr(r["when"], `personality.c.signature[${String(i)}].when`), then: nonEmptyStr(r["then"], `personality.c.signature[${String(i)}].then`) };
    });
    const stratRaw = cObj["defaultStrategy"];
    let defaultStrategy: Record<string, string> = { ...(derived.archetype.defaultStrategy ?? {}) };
    if (stratRaw !== undefined) {
      if (stratRaw === null || typeof stratRaw !== "object" || Array.isArray(stratRaw)) {
        throw new Error("人格卡「personality.c.defaultStrategy」必须是对象（情境标签 → 一句话策略）");
      }
      defaultStrategy = {};
      for (const [k, v] of Object.entries(stratRaw as Record<string, unknown>)) defaultStrategy[k] = nonEmptyStr(v, `personality.c.defaultStrategy.${k}`);
    }
    c = { signature, defaultStrategy };
  }

  // --- D 层：依恋（必填）
  const dRaw = o["attachment"];
  if (dRaw === null || typeof dRaw !== "object" || Array.isArray(dRaw)) {
    throw new Error("人格卡「personality.attachment」必须是 {anxiety, avoidance}（0..1）");
  }
  const dObj = dRaw as Record<string, unknown>;
  const attachment: Attachment = {
    anxiety: num(dObj["anxiety"], "personality.attachment.anxiety"),
    avoidance: num(dObj["avoidance"], "personality.attachment.avoidance"),
  };
  const derivedCurve = deriveBondCurve(attachment.anxiety, attachment.avoidance);
  const claimed = o["bondCurveId"];
  if (claimed !== undefined) {
    const id = nonEmptyStr(claimed, "personality.bondCurveId");
    if (id !== derivedCurve) {
      // v5.2：从硬错误降级为警告（阶段直读 progress，曲线只管表达风格）
      warnings.push(`bondCurveId 声明「${id}」，但依恋象限推出「${derivedCurve}」（已按象限走）`);
    }
  }

  const consolidationThreshold = o["consolidationThreshold"] === undefined ? 5 : Math.round(num(o["consolidationThreshold"], "personality.consolidationThreshold", [1, 100]));
  const insightThreshold = o["insightThreshold"] === undefined ? 5 : Math.round(num(o["insightThreshold"], "personality.insightThreshold", [1, 100]));

  const personality: Personality = {
    ocean,
    archetype: derived.kind === "blend" && derived.blendWith !== null ? derived.archetype.id : derived.archetype.id,
    ...(derived.blendWith === null ? {} : { blendWith: derived.blendWith.id }),
    oceanDistance: derived.distance,
    a,
    b,
    c,
    attachment,
    bondCurveId: derivedCurve,
    consolidationThreshold,
    insightThreshold,
  };
  return { personality, warnings };
}

/* ------------------------------------------------------------------ *
 * 五、只读展示（面板 / 工具输出）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 六、加载期一致性校验（v5.2 §9.4 / V52-GAP M9-05）
 * ------------------------------------------------------------------ */

/**
 * §9.4 的六条加载期校验，逐条可观察。
 *
 * 为什么要有这一层：`parsePersonality` 是**遇错即抛**的构造函数，适合"拦下明显坏卡"，
 * 不适合回答"这张卡有哪几处不对"。而 §9.4 里有一条在本仓库**没有载体**
 * （schema-attention 一致性：`attention_tags.high` 不在 §6.2 的 27 字段里），
 * 另有一条需要运行时历史（insight 可达性）。所以结果必须能表达"跳过"，
 * 不能把"没查"伪装成"查过且通过"——那正是 F117/F138 那类静默缺陷的同一根。
 */
export type PersonaCheckId =
  | "unknown_fields"
  | "numeric_ranges"
  | "self_schema"
  | "centroid_distance"
  | "attachment_curve"
  | "insight_reachable"
  | "schema_attention";

export interface PersonaCheckResult {
  readonly id: PersonaCheckId;
  /** 这一条查过且没问题 */
  readonly ok: boolean;
  /** 没查（本仓库没有对应载体 / 缺少运行时历史）——不等于通过 */
  readonly skipped: boolean;
  /** error 会拦下加载；warning 只记录（v5.2 把依恋-曲线从硬错误降级为警告） */
  readonly severity: "error" | "warning";
  readonly detail: string;
}

export interface PersonaLoadReport {
  /** 有 error 级失败时为 false */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly checks: readonly PersonaCheckResult[];
}

export interface PersonaLoadOptions {
  /**
   * 历史同类事件的证据量（簇大小）中位数；§9.4 的 insight 可达性要拿它做比较。
   * 加载时通常还没有历史，省略即把该条标成 skipped。
   */
  readonly evidenceMedian?: number;
}

const PERSONALITY_ALLOWED_KEYS = [
  "archetype",
  "centroid",
  "a",
  "b",
  "c",
  "attachment",
  "bondCurveId",
  "consolidationThreshold",
  "insightThreshold",
] as const;
const ATTACHMENT_ALLOWED_KEYS = ["anxiety", "avoidance"] as const;
const CAPS_ALLOWED_KEYS = ["signature", "defaultStrategy"] as const;
const A_ALLOWED_KEYS = [
  "belief",
  "counterBelief",
  "fear",
  "taboos",
  "conditionalAssumptions",
  "compensatoryStrategies",
  "selfSchema",
] as const;

/**
 * §9.4 的六条 + 汇总成一份可打印的报告（**不抛错**：坏卡也要能说出坏在哪）。
 *
 * 与 `parsePersonality` 的分工：那个负责**造对象**，这个负责**体检**。
 * 体检失败时调用方自己决定拦下还是降级——校验器不替调用方决定可用性。
 */
export function validatePersonalityLoad(raw: unknown, opts: PersonaLoadOptions = {}): PersonaLoadReport {
  const warnings: string[] = [];
  const checks: PersonaCheckResult[] = [];
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

  // ① 未知字段 fail-closed：写错 key 不会生效，却会让人以为生效了
  if (o === null) {
    checks.push({ id: "unknown_fields", ok: false, skipped: false, severity: "error", detail: "personality 不是对象" });
  } else {
    const bad: string[] = [];
    for (const key of Object.keys(o)) {
      if (!(PERSONALITY_ALLOWED_KEYS as readonly string[]).includes(key)) bad.push(key);
    }
    const aRaw = o["a"];
    if (aRaw !== null && typeof aRaw === "object" && !Array.isArray(aRaw)) {
      for (const key of Object.keys(aRaw as Record<string, unknown>)) {
        if (!(A_ALLOWED_KEYS as readonly string[]).includes(key)) bad.push(`a.${key}`);
      }
    }
    const dRaw = o["attachment"];
    if (dRaw !== null && typeof dRaw === "object" && !Array.isArray(dRaw)) {
      for (const key of Object.keys(dRaw as Record<string, unknown>)) {
        if (!(ATTACHMENT_ALLOWED_KEYS as readonly string[]).includes(key)) bad.push(`attachment.${key}`);
      }
    }
    const cRaw = o["c"];
    if (cRaw !== null && typeof cRaw === "object" && !Array.isArray(cRaw)) {
      for (const key of Object.keys(cRaw as Record<string, unknown>)) {
        if (!(CAPS_ALLOWED_KEYS as readonly string[]).includes(key)) bad.push(`c.${key}`);
      }
    }
    checks.push({
      id: "unknown_fields",
      ok: bad.length === 0,
      skipped: false,
      severity: "error",
      detail: bad.length === 0 ? "没有未知字段" : `未知字段：${bad.join(" / ")}（请查 schema）`,
    });
  }

  // ② 数值区间：OCEAN / 依恋都在 [0,1]；两个阈值是 1..100 的数
  {
    const bad: string[] = [];
    const walk = (v: unknown, field: string): void => {
      if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 1) bad.push(`${field}=${String(v)}`);
    };
    const centroid = o?.["centroid"];
    if (centroid !== null && typeof centroid === "object" && !Array.isArray(centroid)) {
      for (const f of ["O", "C", "E", "A", "N"]) walk((centroid as Record<string, unknown>)[f], `centroid.${f}`);
    }
    const dRaw = o?.["attachment"];
    if (dRaw !== null && typeof dRaw === "object" && !Array.isArray(dRaw)) {
      walk((dRaw as Record<string, unknown>)["anxiety"], "attachment.anxiety");
      walk((dRaw as Record<string, unknown>)["avoidance"], "attachment.avoidance");
    }
    for (const key of ["consolidationThreshold", "insightThreshold"] as const) {
      const v = o?.[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 100) bad.push(`${key}=${String(v)}`);
    }
    checks.push({
      id: "numeric_ranges",
      ok: bad.length === 0,
      skipped: false,
      severity: "error",
      detail: bad.length === 0 ? "数值都在允许区间内" : `超出区间：${bad.join(" / ")}`,
    });
  }

  // ③ self_schema 2~3 条（§9.3 必填；少于 2 条等于没有自我图式）
  {
    const aRaw = o?.["a"];
    const schema =
      aRaw !== null && typeof aRaw === "object" && !Array.isArray(aRaw)
        ? (aRaw as Record<string, unknown>)["selfSchema"]
        : undefined;
    const count = Array.isArray(schema) ? schema.length : 0;
    const fine = count >= 2 && count <= 3;
    checks.push({
      id: "self_schema",
      ok: fine,
      skipped: false,
      severity: "error",
      detail: fine ? `self_schema ${String(count)} 条` : `self_schema 必须 2~3 条（现在是 ${String(count)} 条）`,
    });
  }

  // ④ 质心距离 ≤ 0.5（> 0.5 时"原型"没有意义，必须显式声明复合人格）
  {
    try {
      const ocean = o?.["centroid"] !== undefined ? parseOcean(o["centroid"], "personality.centroid") : null;
      if (ocean === null) {
        checks.push({ id: "centroid_distance", ok: true, skipped: true, severity: "error", detail: "只给了 archetype，质心由原型提供" });
      } else {
        const d = deriveFromOcean(ocean);
        checks.push({
          id: "centroid_distance",
          ok: d.kind !== "outlier",
          skipped: false,
          severity: "error",
          detail: d.kind === "outlier" ? `离最近原型 ${d.distance.toFixed(3)} > 0.5` : `离最近原型「${d.archetype.id}」${d.distance.toFixed(3)}`,
        });
      }
    } catch (err) {
      checks.push({
        id: "centroid_distance",
        ok: false,
        skipped: false,
        severity: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ⑤ 依恋-曲线自洽：v5.2 从硬错误降级为警告（stage 直读 progress，曲线只管表达风格）
  {
    const dRaw = o?.["attachment"];
    if (dRaw === null || typeof dRaw !== "object" || Array.isArray(dRaw)) {
      checks.push({ id: "attachment_curve", ok: false, skipped: false, severity: "error", detail: "attachment 缺失（§9.3 必填）" });
    } else {
      try {
        const d = dRaw as Record<string, unknown>;
        const anxiety = num(d["anxiety"], "personality.attachment.anxiety");
        const avoidance = num(d["avoidance"], "personality.attachment.avoidance");
        const derived = deriveBondCurve(anxiety, avoidance);
        const claimedRaw = o?.["bondCurveId"];
        const claimed = typeof claimedRaw === "string" ? claimedRaw : null;
        const mismatch = claimed !== null && claimed !== derived;
        if (mismatch) warnings.push(`bondCurveId 声明「${claimed}」，但依恋象限推出「${derived}」（按象限走）`);
        checks.push({
          id: "attachment_curve",
          ok: true,
          skipped: false,
          severity: "warning",
          detail: mismatch
            ? `声明 bondCurveId「${String(claimed)}」但依恋象限推出「${derived}」（按象限走）`
            : `依恋象限推出「${derived}」`,
        });
      } catch (err) {
        checks.push({
          id: "attachment_curve",
          ok: false,
          skipped: false,
          severity: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ⑥ insight 可达性：阈值 > 历史同类事件中位数 × 3 → A/B 层可能永不更新
  {
    const v = o?.["insightThreshold"];
    const threshold = typeof v === "number" && Number.isFinite(v) ? v : 5;
    if (opts.evidenceMedian === undefined || opts.evidenceMedian <= 0) {
      checks.push({
        id: "insight_reachable",
        ok: true,
        skipped: true,
        severity: "error",
        detail: "加载时没有历史样本（运行时会按簇证据中位数再判一次）",
      });
    } else {
      const median = opts.evidenceMedian;
      const fine = threshold <= median * 3;
      checks.push({
        id: "insight_reachable",
        ok: fine,
        skipped: false,
        severity: "error",
        detail: fine
          ? `阈值 ${String(threshold)} ≤ 中位数 ${String(median)} × 3`
          : `阈值 ${String(threshold)} > 中位数 ${String(median)} × 3：A/B 层可能永不更新`,
      });
    }
  }

  // ⑦ schema-attention 一致性：本仓库没有 attention_tags 载体（§6.2 的 27 字段里没有）
  checks.push({
    id: "schema_attention",
    ok: true,
    skipped: true,
    severity: "error",
    detail: "本仓库没有 attention_tags.high 载体（§6.2 无此字段），这条校验没有作用对象",
  });

  const errors = checks.filter((c) => !c.ok && c.severity === "error").map((c) => `[${c.id}] ${c.detail}`);
  return { ok: errors.length === 0, errors, warnings, checks };
}

/** 命中禁区且整段都不可用时用这一句收尾：不解释、不辩解，只是跳过。 */
export const TABOO_FALLBACK = "……这段我跳过。";

/** A 层否决的结果：`text` 是可以外发的版本，`hits` 是被拿掉的禁区规则。 */
export interface TabooFilterResult {
  readonly text: string;
  readonly hits: readonly string[];
}

/**
 * A 层否决的执行段：把命中禁区的**句子**摘掉，剩下的照常外发。
 *
 * 为什么不是整句替换：禁区通常是"她怎么称呼自己"这种局部问题，
 * 一句话里前半句踩线、后半句是好好说的话——整段重写会把好的部分一起丢掉，
 * 她显得比原来更不像人。摘句能保住"还在说话"的手感。
 *
 * 全部句子都被摘掉时返回 `TABOO_FALLBACK`（短、不解释），不会返回空串——
 * 空串在桥上会被当成"生成失败"，那是另一种事故。
 */
export function filterTaboo(text: string, taboos: readonly string[]): TabooFilterResult {
  if (taboos.length === 0) return { text, hits: [] };
  const hits = tabooHits(text, taboos);
  if (hits.length === 0) return { text, hits: [] };
  const segments = text.split(/(?<=[。！？!?…♪])|\n/u);
  const kept = segments.filter((seg) => seg.trim() !== "" && tabooHits(seg, taboos).length === 0);
  const out = kept.join("").trim();
  return { text: out === "" ? TABOO_FALLBACK : out, hits };
}

/** 一行摘要：工具输出与面板用，不泄露长文本。 */
export function personalityLine(p: Personality | null): string {
  if (p === null) return "[personality] none（人格卡没写 personality 段，A/B/C 三层不生效）";
  const top = (Object.entries(p.b) as [ValueKey, number][]).sort((x, y) => y[1] - x[1])[0];
  return (
    `[personality] archetype=${p.archetype}${p.blendWith === undefined ? "" : `+${p.blendWith}`} d=${p.oceanDistance.toFixed(2)} ` +
    `belief=${p.a.belief.slice(0, 12)}… taboos=${String(p.a.taboos.length)} caps=${String(p.c.signature.length)} ` +
    `attachment=${p.bondCurveId} topValue=${top === undefined ? "?" : `${top[0]}(${top[1].toFixed(2)})`}`
  );
}

/**
 * A 层否决（v5.2 §3 A 层否决权）。
 *
 * 语义：**不是封口**。禁区被触及时，她仍然说话，但要换一种说法（例：不自称 AI → 换个称呼；
 * 不卖惨 → 把"我已经不在了"讲轻）。所以这里只返回"命中了哪条"，措辞由表达层决定。
 *
 * 匹配用**标签命中**而不是语义模型：人格卡里的 taboos 是短句（"不自称 AI"），
 * 用关键词表做第一道过滤足够；真正的措辞降级在 compose 的提示里（已有人格段）。
 */
export function tabooHits(text: string, taboos: readonly string[]): readonly string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const taboo of taboos) {
    // 禁区句子本身是给人读的说明，不是匹配模式：从里面抽「引号内」与「不X」的实词
    const quoted = taboo.match(/[「“"]([^」”"]+)[」”"]/g);
    const tokens = quoted === null ? [] : quoted.map((q) => q.replace(/[「」“”"]/g, ""));
    const words = tabooWords(taboo);
    const probes = [...tokens, ...words].filter((w) => w.length >= 2);
    if (probes.some((probe) => probeHits(lower, probe))) hits.push(taboo);
  }
  return hits;
}

/** 把一条禁区说明拆成实词：分隔符是列举用的顿号/逗号/空格/「或」，去掉开头的「不」。 */
function tabooWords(taboo: string): readonly string[] {
  let parts: string[] = [taboo];
  for (const sep of "、，,。；;：: 或和与") parts = parts.flatMap((s) => s.split(sep));
  return parts.map((w) => w.replace(/^[不别勿]/, "").trim()).filter((w) => w !== "");
}

/**
 * 一个实词是否出现在句子里。
 *
 * 英文/数字按**词边界**匹配：`AI` 不该在 `said` 里命中——不然英文台词会被整句摘掉。
 * 中文按子串匹配：中文没有词边界，`程序` 出现在任何位置都算。
 */
function probeHits(lowerText: string, probe: string): boolean {
  const needle = probe.toLowerCase();
  const ascii = [...needle].every((ch) => (ch.codePointAt(0) ?? 128) < 128);
  if (!ascii) return lowerText.includes(needle);
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (lowerText[at - 1] ?? "");
    const after = lowerText[at + needle.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}
