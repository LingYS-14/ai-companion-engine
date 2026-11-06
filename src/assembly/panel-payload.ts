/**
 * 面板数据：把运行时折成**一份给界面用的、扁平且带语义的 JSON**。
 *
 * 为什么单独一个文件：面板端点是插件里唯一被浏览器直接读取的东西，
 * 它的形状一旦散落在 index.ts 的闭包里，就没法在测试里断言——
 * 而"面板显示错了"正是用户唯一能直接看到的问题。
 *
 * 设计口径（2026-10-28 用户反馈后改）：
 *   1. **不要专业术语、也不要 emoji**。`valence/arousal/entropy` 是给引擎看的，
 *      界面给的是「心情 / 精力 / 压力 / 面具」这种人话；心情用一个色点 + 两个字，
 *      不用表情符号——表情字体在深色界面里像贴纸，破坏整体观感
 *      （2026-10-28 用户明确反馈）。
 *   2. **能画图就不写字**。关系四段轨道给 `stageTrack`，条状指标给 0..1 的
 *      `vitals`，界面只负责把它们画出来。
 *   3. **给最近的记忆**。一个人"是不是记得刚发生的事"，只能从 recent 看出来。
 */

import type { SoulConfig, SoulRuntime } from "../plugin/runtime.js";
import { round4 } from "../plugin/runtime.js";
import type { PanelIntentFacts, PanelStateView, Stage } from "../ports/index.js";

export interface PanelPayload {
  readonly name: string;
  readonly tagline: string | null;
  readonly mode: string;
  readonly turns: number;
  readonly bond: {
    readonly stage: Stage;
    readonly stageLabel: string;
    readonly progress: number;
    readonly quadrant: string | null;
  };
  readonly stageTrack: readonly { stage: Stage; label: string; from: number; to: number }[];
  /** 心情：只有文字与色相，没有 emoji（emoji 在这块深色面板里像贴纸） */
  readonly mood: {
    readonly label: string;
    /** 语义色相键，供界面映射颜色：warm / calm / cool / tense / flat / low */
    readonly tone: "warm" | "calm" | "cool" | "tense" | "flat" | "low";
    readonly color: string;
  };
  readonly vitals: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: number;
    readonly word: string;
    readonly color: string;
  }[];
  readonly memory: Record<string, number | null>;
  readonly recent: readonly { id: string; content: string; tags: readonly string[]; vividness: number }[];
  readonly knowledge: readonly { id: string; content: string; type: string }[];
  /**
   * 睡眠相位（P2 网页聊天用来预禁用输入框）。
   *
   * 只暴露「她是不是睡着」这一个事实：真正的拒绝在 daemon（`runtime.sleepInfo().phase`），
   * 这里多一个字段是为了 UI 不用等一次失败才变灰。
   */
  readonly sleep: { readonly hour: number; readonly nextInHours: number; readonly phase: string };
  /** 头像地址：走插件自己的静态路由（读包内 assets），没有立绘时为 null */
  readonly avatarUrl: string | null;
  /**
   * 意图面（F269，只读）：她在等什么、想做什么、卡在哪。
   * 只显示，不代替她推进；回答问询仍是人这一侧 CLI 的事。
   */
  readonly intent: PanelIntentFacts | null;
  readonly updatedAt: number;
}

export const AVATAR_PATH = "/plugins/ai-companion-engine/avatar";

const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  stranger: "陌生",
  familiar: "熟悉",
  close: "亲近",
  beloved: "挚爱",
};

/** 心情标签：valence 决定好不好，arousal 决定"静/闹"。阈值刻意粗，界面不该出现小数。 */
export interface Mood {
  readonly label: string;
  readonly tone: "warm" | "calm" | "cool" | "tense" | "flat" | "low";
  readonly color: string;
}

const MOOD_COLOR: Readonly<Record<Mood["tone"], string>> = {
  warm: "#ff9ed6", // 粉：好且热闹
  calm: "#67e8f9", // 青：好但安静
  cool: "#a78bfa", // 紫：还行
  tense: "#fb7185", // 玫红：心跳快
  flat: "#9ca3af", // 灰：平静
  low: "#7c8aa5", // 冷灰：低
};

/** 心情标签：valence 决定好不好，arousal 决定"静/闹"。阈值刻意粗，界面不该出现小数。 */
export function moodOf(valence: number, arousal: number): Mood {
  const v = Number.isFinite(valence) ? valence : 0.5;
  const a = Number.isFinite(arousal) ? arousal : 0.3;
  if (v >= 0.62 && a >= 0.62) return { label: "雀跃", tone: "warm", color: MOOD_COLOR.warm };
  if (v >= 0.62 && a < 0.45) return { label: "安稳", tone: "calm", color: MOOD_COLOR.calm };
  if (v >= 0.58) return { label: "心情不错", tone: "cool", color: MOOD_COLOR.cool };
  if (v >= 0.42 && a >= 0.62) return { label: "心跳有点快", tone: "tense", color: MOOD_COLOR.tense };
  if (v >= 0.42) return { label: "平静", tone: "flat", color: MOOD_COLOR.flat };
  if (v < 0.35 && a >= 0.55) return { label: "烦躁", tone: "tense", color: MOOD_COLOR.tense };
  if (v < 0.35) return { label: "低落", tone: "low", color: MOOD_COLOR.low };
  return { label: "有点拧", tone: "tense", color: MOOD_COLOR.tense };
}

/**
 * 去掉尾部悬空/空的引号与括号。
 *
 * 三种情况都得处理，否则副标题会变成半截密码：
 *   1. 结尾是开引号（`…也被叫「`）；
 *   2. 结尾是空的一对（`…「」`，句号被切走后留下的）；
 *   3. 结尾是闭引号但前面没有对应的开引号（配平检查）。
 */
function trimDangling(text: string): string {
  const PAIRS: readonly (readonly [string, string])[] = [
    ["「", "」"],
    ["『", "』"],
    ["（", "）"],
    ["《", "》"],
    ["“", "”"],
  ];
  let out = text.trim();
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    let cut = false;
    for (const [open, close] of PAIRS) {
      const count = (ch: string): number => out.split(ch).length - 1;
      // 空的成对引号：直接去掉一对
      if (out.endsWith(open + close)) {
        out = out.slice(0, -2).trimEnd();
        cut = true;
        break;
      }
      if (last === open || (last === close && count(open) < count(close))) {
        out = out.slice(0, -1).trimEnd();
        cut = true;
        break;
      }
    }
    if (!cut) return out;
  }
}

/**
 * 面板副标题。
 *
 * 优先用人格卡里的 `tagline`（她自己会说的一句话）；没有才退回 `description` 首句。
 * 退回路径必须**按句末标点切**再删掉悬空引号，否则会出现
 * 「一位在旧城区经营书店的年轻人，习惯先听人把话说完」「」
 * 这种一眼出错的行——它同时也是"百科腔"的来源。
 */
export function taglineOf(persona: { tagline?: string; description?: string } | null): string | null {
  if (persona === null) return null;
  if (persona.tagline !== undefined && persona.tagline.trim() !== "") return persona.tagline.trim();
  const description = persona.description;
  if (description === undefined) return null;
  const sentence = description.split(/[。！？♪]/)[0] ?? "";
  const clipped = trimDangling(sentence);
  if (clipped === "") return null;
  return clipped.length > 40 ? `${trimDangling(clipped.slice(0, 39))}…` : clipped;
}

export function wordFor(v: number): string {
  if (v < 0.3) return "低";
  if (v < 0.6) return "中";
  return "高";
}

export function panelPayload(
  runtime: SoulRuntime,
  conf: SoulConfig,
  intent: PanelIntentFacts | null = null,
  fresh: PanelStateView | null = null,
): PanelPayload {
  const snap = runtime.snapshot();
  const s = runtime.state;
  // F274：唯一写者每拍写的状态快照优先；读不到/过期就用本进程的旧值（不猜）。
  const view = {
    valence: fresh?.valence ?? s.valence,
    energy: fresh?.energy ?? s.energy,
    pressure: fresh?.pressure ?? s.pressure,
    maskIntegrity: fresh?.maskIntegrity ?? s.maskIntegrity,
  };
  const stats = runtime.memoryStats();
  const sleep = runtime.sleepInfo();
  // F326 方案 A：人格卡已删除。面板只显示 UI 标识：displayName 缺省回落 characterId。
  const displayName = conf.displayName ?? conf.characterId;
  const mood = moodOf(view.valence, s.arousal);
  const bond = runtime.bondInfo();

  return {
    name: displayName,
    // 副标题不再来自人格卡：没有设定可背，留空由界面决定怎么排版。
    tagline: null,
    mode: fresh?.mode ?? String(snap["mode"]),
    turns: fresh?.turns ?? Number(snap["turns"]),
    bond: {
      stage: bond.stage,
      stageLabel: STAGE_LABEL[bond.stage],
      progress: bond.progress,
      quadrant: bond.quadrant,
    },
    stageTrack: runtime.stageBounds().map((b) => ({
      stage: b.stage,
      label: STAGE_LABEL[b.stage],
      from: b.from,
      to: b.to,
    })),
    mood,
    vitals: [
      { key: "valence", label: "心情", value: round4(view.valence), word: wordFor(view.valence), color: "#e78ab0" },
      { key: "energy", label: "精力", value: round4(view.energy), word: wordFor(view.energy), color: "#5fbf8f" },
      { key: "pressure", label: "压力", value: round4(view.pressure), word: wordFor(view.pressure), color: "#ef7f6b" },
      { key: "mask", label: "面具", value: round4(view.maskIntegrity), word: wordFor(view.maskIntegrity), color: "#7ea9ef" },
    ],
    memory: {
      total: stats.total,
      active: stats.active,
      forgotten: stats.forgotten,
      suppressed: stats.suppressed,
      cold: stats.cold,
      knowledge: stats.knowledge,
      vividness: round4(stats.vividness),
    },
    recent: runtime.recentMemories(3).map((m) => ({
      id: m.id,
      content: m.content.length > 42 ? `${m.content.slice(0, 41)}…` : m.content,
      tags: m.tags.slice(0, 3),
      vividness: round4(m.vividness),
    })),
    knowledge: runtime.recentKnowledge(2).map((k) => ({
      id: k.id,
      content: k.content.length > 46 ? `${k.content.slice(0, 45)}…` : k.content,
      type: k.knowledge_type,
    })),
    // 头像按 characterId 找包内资源（F326：不再由人格卡的 avatar 字段决定）；无资源时端点 404。
    avatarUrl: `${AVATAR_PATH}?f=${encodeURIComponent(conf.characterId)}`,
    sleep: { hour: sleep.hour, nextInHours: round4(sleep.nextInHours), phase: sleep.phase },
    intent,
    updatedAt: runtime.now(),
  };
}
