/**
 * 人格卡（persona）：把「她是谁」从代码里搬进一个可替换的文件。
 *
 * ## 为什么要单独一层
 *
 * 现在角色的"人格"分散在三处：`EXPRESSION_TABLE`（依恋 × 阶段的话术基调，规格自带）、
 * `protocol.ts`（怎么用工具）、以及模型自己的理解。前两者是**机制**，第三者是**飘的**：
 * 换一个角色就得改代码，这是导入人格最大的障碍。
 *
 * 这一层只做一件事：把**人格内容**（她叫什么、怎么说话、什么不能碰）做成数据文件，
 * 由装配点读进来（文件 IO 在 `src/plugin/persona.ts`），作为独立的系统提示段落注入。机制层完全不动——
 * 依恋仍由配置的 `attachment` 决定，关系推进仍由 bond 决定。
 *
 * ## 格式
 *
 * JSON（不引 YAML 依赖；一份人格卡手写也就几十行）。字段全部可选，但 `name` 与
 * `description` 缺一不可——没有这两项的人格卡没法注入，直接报错而不是静默降级。
 *
 * ```json
 * {
 *   "name": "苏晚",
 *   "description": "二十四岁，旧书店店员。说话慢，习惯先听再说。",
 *   "speech": "短句为主，少用感叹号；被夸时会先否认一句。",
 *   "taboos": ["不自称 AI", "不主动提自己的年龄"],
 *   "opening": "第一次见面时她正在整理一排旧书，抬头看了你一眼。",
 *   "seedMemories": ["她说过店里的猫叫「三月」。"]
 * }
 * ```
 *
 * ## 与记忆的关系
 *
 * `seedMemories` 不进记忆库（那会让"她记得"变成一次写入事件，还得过防火墙），
 * 只作为**背景设定**注入提示。真正的记忆仍靠 `soul_remember` 与对话累积——
 * 否则一开局就有几十条"记忆"，遗忘与巩固的数值关系会被伪造的记忆量污染。
 */

import type { Stage } from "../engine/bonds.js";
import { parsePersonality, type Personality } from "../engine/personality.js";

export interface Persona {
  /** 名字（必填） */
  readonly name: string;
  /** 一两句身份与气质（必填） */
  readonly description: string;
  /**
   * 面板上显示的一句话（可选）。
   *
   * 为什么单独一个字段：`description` 是给模型读的设定（会写"逐火十三英桀第二位"
   * 这种抬头），直接当界面副标题像百科词条，念出来也不像她说话。
   * 这里放**她自己会说的话**（例：「想我了吗？我一直都在这里哦♪」）。
   */
  readonly tagline?: string;
  /** 说话习惯：句长、语气词、口头禅 */
  readonly speech?: string;
  /** 不能碰的边界（例如"不自称 AI"） */
  readonly taboos?: readonly string[];
  /** 初见场景（只在第一轮有意义） */
  readonly opening?: string;
  /** 背景事实：属于设定，不是记忆 */
  readonly seedMemories?: readonly string[];
  /**
   * 没说出口的矛盾与软肋（用户反馈"人物不够厚重"后加）。
   *
   * 为什么它不是 `description` 的一部分：描述是**自我介绍**，会被人念出来；
   * 这一层是"她不会说、但决定了她的取舍"的东西。提示里明确要求"别直接念"，
   * 它只影响措辞的温度、退让与沉默发生在哪一句。
   */
  readonly inner?: readonly string[];
  /**
   * 具体的小动作与偏好，写成**行为**而不是形容词。
   *
   * "温柔"是形容词，模型只能演成语气软；"说话时会把头发绕在手指上"是可演的动作，
   * 它会让同一个角色在不同轮次里有一致的手感——这是"立体"最便宜的来源。
   */
  readonly habits?: readonly string[];
  /** 会被真的伤到的地方，以及她受伤时的样子（不是发火，也不是客服式道歉） */
  readonly sorePoints?: readonly string[];
  /**
   * 立绘文件名（相对插件包的 `assets/` 目录），面板头像用它。
   *
   * 为什么是文件名而不是路径：面板端点是宿主进程读文件，只认包内 assets，
   * 传绝对路径等于把任意文件读取的口子开在 HTTP 上（路径穿越）。
   */
  readonly avatar?: string;
  /**
   * 关系阶段 → 称呼与距离的**覆盖**。
   *
   * 引擎内置的 `[stage-style]` 是通用梯度（stranger 一律"客气、保持距离、用敬称"），
   * 对日常角色合适，但对"自来熟"的角色是错的：AI助手在第一轮也不该像客服。
   * 这张表让**人设**决定各阶段的语气，而不是让所有角色共用一个梯度——
   * 优先级不变（`[style]` > `[event]` > `[stage-style]` > `[expr]`），只是这一层的文本由人格卡提供。
   */
  readonly stageStyle?: Partial<Record<Stage, string>>;
  /**
   * 六层人格里的 A/B/C/D 四层（v5.2 §3）。
   *
   * 为什么放在人格卡而不是配置旋钮：这四层是**这个角色是谁**，不是引擎调参；
   * 换一个角色就该换一份。S 层（实时状态）仍在引擎里，属于"此刻"而不是"是谁"。
   */
  readonly personality?: Personality;
}

/**
 * 注入系统提示的字数上限。
 *
 * 900 是"短人格"的预算，装得下苏晚这类日常角色；AI助手这类有身份、有世界观、
 * 有口癖设定的角色需要更多。补上 `inner` / `habits` / `sorePoints` 三层之后提到 **2400**，
 * 再补官方 wiki 的关系与语音素材后提到 **3200**
 * ——它仍小于协议段（2000）+ 表达层，不会把用法说明挤掉；而且人格段在系统提示里排在协议之后，
 * 真被截断时先丢的是 lore，不是工具约束。超预算时 renderPersona 截断并补「…」。
 */
export const PERSONA_BUDGET = 3200;

const VALUE_ZH: Record<string, string> = {
  care: "在意人",
  truth: "说真话",
  freedom: "自由",
  beauty: "美感",
  belonging: "归属",
  mastery: "胜任",
};

function fmt(v: number): string {
  return v.toFixed(2).replace(/0$/, "");
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`人格卡字段「${field}」必须是非空字符串`);
  }
  return v.trim();
}

function strList(v: unknown, field: string): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
    throw new Error(`人格卡字段「${field}」必须是字符串数组`);
  }
  return v.map((x) => (x as string).trim());
}

/**
 * 解析人格卡。
 *
 * 严格解析：多余字段忽略（允许作者加注释性字段），但**必填缺失就报错**——
 * 一份没有名字与描述的人格卡注入了也只是噪声。
 */
export function parsePersona(raw: unknown): Persona {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("人格卡必须是 JSON 对象");
  }
  const o = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof Persona]: Persona[K] } = {
    name: str(o["name"], "name"),
    description: str(o["description"], "description"),
  };
  const tagline = o["tagline"];
  if (tagline !== undefined) out.tagline = str(tagline, "tagline");
  const speech = o["speech"];
  if (speech !== undefined) out.speech = str(speech, "speech");
  const opening = o["opening"];
  if (opening !== undefined) out.opening = str(opening, "opening");
  const taboos = strList(o["taboos"], "taboos");
  if (taboos !== undefined) out.taboos = taboos;
  const seeds = strList(o["seedMemories"], "seedMemories");
  if (seeds !== undefined) out.seedMemories = seeds;
  const inner = strList(o["inner"], "inner");
  if (inner !== undefined) out.inner = inner;
  const habits = strList(o["habits"], "habits");
  if (habits !== undefined) out.habits = habits;
  const sore = strList(o["sorePoints"], "sorePoints");
  if (sore !== undefined) out.sorePoints = sore;
  const avatar = o["avatar"];
  if (avatar !== undefined) out.avatar = str(avatar, "avatar");
  const stageStyle = o["stageStyle"];
  if (stageStyle !== undefined) out.stageStyle = parseStageStyle(stageStyle);
  const personality = o["personality"];
  if (personality !== undefined) out.personality = parsePersonality(personality).personality;
  return out;
}

const STAGE_KEYS: readonly Stage[] = ["stranger", "familiar", "close", "beloved"];

function parseStageStyle(raw: unknown): Partial<Record<Stage, string>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("人格卡字段「stageStyle」必须是对象（阶段名 → 一句语气描述）");
  }
  const out: Partial<Record<Stage, string>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!(STAGE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`人格卡「stageStyle」里的阶段名「${key}」不认识，只能是 ${STAGE_KEYS.join(" / ")}`);
    }
    out[key as Stage] = str(val, `stageStyle.${key}`);
  }
  return out;
}

/**
 * 渲染成系统提示段落。
 *
 * 只输出"她是谁"，不输出数值与机制说明——那些已经在协议里，重复会让模型抓错重点。
 */
export function renderPersona(p: Persona): string {
  const lines = [`【角色设定】${p.name}`, p.description];
  if (p.speech !== undefined) lines.push(`说话方式：${p.speech}`);
  if (p.habits !== undefined && p.habits.length > 0) {
    lines.push(`小动作与偏好（可以有，但不要每轮都演一遍、更不要解说出来）：${p.habits.join("；")}`);
  }
  if (p.inner !== undefined && p.inner.length > 0) {
    lines.push(`心里其实（她不会主动说，别直接念出来；让它影响措辞、退让与沉默的位置）：${p.inner.join("；")}`);
  }
  if (p.sorePoints !== undefined && p.sorePoints.length > 0) {
    lines.push(`会被真的伤到的地方（触及时的反应是收紧、转移或短句，不是发火，也不是客服式道歉）：${p.sorePoints.join("；")}`);
  }
  if (p.taboos !== undefined && p.taboos.length > 0) lines.push(`不碰的边界：${p.taboos.join("；")}`);
  if (p.opening !== undefined) lines.push(`初见：${p.opening}`);
  const ps = p.personality;
  if (ps !== undefined) {
    lines.push(`性格底色（OCEAN 质心，最近原型 ${ps.archetype}${ps.blendWith === undefined || ps.blendWith === null ? "" : `，混合 ${ps.blendWith}`}）：O ${fmt(ps.ocean.O)} / C ${fmt(ps.ocean.C)} / E ${fmt(ps.ocean.E)} / A ${fmt(ps.ocean.A)} / N ${fmt(ps.ocean.N)}`);
    lines.push(`坚信：${ps.a.belief}${ps.a.counterBelief === undefined ? "" : `；反面（她自己也怕是真的）：${ps.a.counterBelief}`}`);
    if (ps.a.fear !== undefined) lines.push(`最怕：${ps.a.fear}`);
    if (ps.a.conditionalAssumptions.length > 0) lines.push(`她默认的前提：${ps.a.conditionalAssumptions.join("；")}`);
    if (ps.a.compensatoryStrategies.length > 0) lines.push(`用来保全自己的做法（会不自觉地用）：${ps.a.compensatoryStrategies.join("；")}`);
    const top = Object.entries(ps.b).sort((a, b) => b[1] - a[1]).slice(0, 3);
    lines.push(`价值排序（前 3）：${top.map(([k, v]) => `${VALUE_ZH[k] ?? k} ${fmt(v)}`).join(" / ")}`);
    if (ps.c.signature.length > 0) lines.push(`行为模式：${ps.c.signature.map((r) => `当${r.when} → ${r.then}`).join("；")}`);
    lines.push(`依恋：焦虑 ${fmt(ps.attachment.anxiety)} / 回避 ${fmt(ps.attachment.avoidance)}（对应关系曲线 ${ps.bondCurveId}）`);
  }
  if (p.seedMemories !== undefined && p.seedMemories.length > 0) {
    // 逐条成行而不是用「；」串起来：官方设定条目自带句号（"……。"），串起来会出现「。；」，
    // 而且一长段对模型来说不如短条目好抓——这些是"背景知识"，不是要念的台词。
    lines.push("背景（是设定，不是刚发生的事，别当成记忆引用）：");
    for (const seed of p.seedMemories) lines.push(`- ${seed}`);
  }
  const text = lines.join("\n");
  if (text.length <= PERSONA_BUDGET) return text;
  // 超预算时截断而不是报错：宁可少一句设定，也不要让整份人格卡进不去
  return `${text.slice(0, PERSONA_BUDGET - 1)}…`;
}

/** 工具输出用的一行摘要 */
export function personaLine(p: Persona | null): string {
  if (p === null) return "[persona] none（未配置人格卡，使用引擎默认表达层）";
  return `[persona] name=${p.name} tagline=${p.tagline ?? "(未配置)"} speech=${p.speech ?? "(未配置)"} taboos=${(p.taboos ?? []).length} seeds=${(p.seedMemories ?? []).length} inner=${(p.inner ?? []).length} habits=${(p.habits ?? []).length} sore=${(p.sorePoints ?? []).length}`;
}
