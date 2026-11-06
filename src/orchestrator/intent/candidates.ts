/**
 * 意向引擎 P0 —— B1 候选生成（VISION §4.2/§4.5）。
 *
 * 纪律：
 *   - **纯函数**：同输入同输出（P0 golden replay 的前提）；
 *   - **零模型调用**：`planSeeds` 全部来自模板 / 经验 / 工具 schema 三级来源（§4.5 #2），不生成自然语言；
 *   - **按类别覆盖，不按分数取前 N**（§4.5 #1）：可行的类别至少 1 个，每类最多 2 个，总数 ≤ `MAX_CANDIDATES`，
 *     第一轮每类各取最好的一个，第二轮才用剩余名额补第二个——`explore`/`idle` 不会被 `reach_out` 挤掉；
 *   - **不接线**：P0 没有调用方，不读文件、不发消息、不写 S 层。
 *
 * 需求缺口（`DriveVector`）来自 B0，情境（`SituationFrame`）来自 B1 的上游，`planSeeds` 的可行性由
 * `Affordance`（已按登录/额度过滤的工具能力）决定。候选**只描述"想做什么"**，具体 `execution.Intent`
 * 由 P1 的 B3 展开。
 */

import { clamp01 } from "../../engine/state.js";
import { scoreCandidate } from "./scoring.js";
import {
  DRIVE_KEYS,
  INTENT_KINDS,
  MAX_CANDIDATES,
  type Affordance,
  type Candidate,
  type CandidateCause,
  type DriveVector,
  type IntentKind,
  type RiskLevel,
  type SituationFrame,
} from "./types.js";

// ── 可行性阈值（工程先验，D2：P1 有真实轨迹后再标定） ─────────────────────
/** 某个类别要"浮现"，对应缺口的未满足度至少要到这里。数值是手算的先验，不是运行期旋钮。 */
export const KIND_GAP_THRESHOLDS: Readonly<Partial<Record<IntentKind, number>>> = {
  reach_out: 0.45,
  explore: 0.4,
  create: 0.35,
  withdraw: 0.5,
};

/** 每类最多几个候选（§4.5 #1 的配额） */
export const MAX_PER_KIND = 2;

/** 工具名 → 能力族。只认已知前缀，未知工具一律归 other（不猜）。 */
export type AffordanceFamily = "message" | "read" | "write" | "desktop" | "other";

export function affordanceFamily(tool: string): AffordanceFamily {
  if (tool.startsWith("qq.") || tool.startsWith("wechat.")) return "message";
  if (tool.startsWith("bili.") || tool.startsWith("web.") || tool.startsWith("knowledge.") || tool.startsWith("memory.")) {
    return "read";
  }
  if (tool.startsWith("desktop.")) return "desktop";
  if (tool.startsWith("local.") || tool.startsWith("file.")) return "write";
  return "other";
}

/** 类别 → 需要的工具能力族（空 = 不需要工具，比如"退开休息"）。 */
const KIND_FAMILIES: Readonly<Record<IntentKind, readonly AffordanceFamily[]>> = {
  reach_out: ["message"],
  continue_thread: ["message"],
  explore: ["read"],
  create: ["write", "desktop"],
  repair: ["message"],
  withdraw: [],
  idle: [],
};

/** 类别 → 一条意图自述（为什么是这一类）。 */
const KIND_GOALS: Readonly<Record<IntentKind, string>> = {
  reach_out: "想找用户说句话",
  continue_thread: "想把没聊完的那件事接上",
  explore: "想看看新东西",
  create: "想留下点什么",
  repair: "想把刚才的别扭解释清楚",
  withdraw: "想先退开一会儿，缓一缓",
  idle: "什么都不想做，待着",
};

/** 类别 → 动作模板（§4.5 #2 第①级来源）。模板里的 {title} 由情境替换。 */
const KIND_SEED_TEMPLATES: Readonly<Record<IntentKind, readonly string[]>> = {
  reach_out: ["发一条问候", "问一句你在忙什么"],
  continue_thread: ["翻到上次的话题接着聊", "把待办那条接着做完"],
  explore: ["看一条新视频", "查一个最近想到的问题"],
  create: ["写一段想法记下来", "把刚才想到的记成一条笔记"],
  repair: ["先道个歉", "解释清楚刚才那句话的意思"],
  withdraw: ["先不说话，安静一会儿", "关掉通知，休息一会儿"],
  idle: ["什么都不做", "看一眼窗外"],
};

/** 没有动作可用时的兜底（§4.5 #2：三者皆空 → 插入一个 risk 0 的探测动作）。 */
export const PROBE_SEED = "先做一次 risk 0 的探测：看看现在能做什么";

/** 类别 → 该类别的基础影响（§4.3 impact；极性受 scoring 里的 7×6 基表约束）。 */
export const KIND_IMPACT: Readonly<
  Record<IntentKind, Readonly<Partial<Record<keyof DriveVector, number>>>>
> = {
  // 主动说话能缓解"想说话"，但也把自己暴露出来（面具压强 +）
  reach_out: { connection: 0.3, novelty: 0.05, integrity: -0.1 },
  continue_thread: { connection: 0.2, coherence: 0.25, competence: 0.15 },
  explore: { novelty: 0.4, competence: 0.1, energy: -0.05 },
  create: { coherence: 0.35, competence: 0.2, novelty: 0.1, energy: -0.1 },
  repair: { connection: 0.25, coherence: 0.3, competence: 0.2, integrity: -0.15 },
  withdraw: { integrity: 0.3, energy: 0.25, novelty: -0.05, connection: -0.1 },
  idle: {},
};

/** 类别 → 社会风险（被看见的代价，§4.3 单列一项） */
const KIND_SOCIAL_RISK: Readonly<Record<IntentKind, number>> = {
  reach_out: 0.2,
  continue_thread: 0.15,
  explore: 0.05,
  create: 0.25,
  repair: 0.45,
  withdraw: 0.0,
  idle: 0.0,
};

/** 类别 → 粗略 token 成本（§4.3 的 budget_penalty 用；P0 是常量估计，P1 换真实计数） */
const KIND_TOKENS: Readonly<Record<IntentKind, number>> = {
  reach_out: 120,
  continue_thread: 160,
  explore: 200,
  create: 240,
  repair: 140,
  withdraw: 0,
  idle: 0,
};

/** 未完成的事（`continue_thread` 的输入；不猜，由调用方从记忆/待办里取） */
export interface OpenThread {
  id: string;
  title: string;
  /** 距上次触碰的分钟数（越久越值得接上） */
  staleMin: number;
}

export interface CandidateContext {
  frame: SituationFrame;
  drive: DriveVector;
  /** 未完成的事；空 = 这类候选不生成 */
  threads?: readonly OpenThread[];
  /** 关系/承诺有裂痕、需要修复；false/缺省 = 不生成 repair */
  needsRepair?: boolean;
  /** 来自 §4.3 `identityFit`（两段式检索 top3 的 tanh）；缺省 0.5 中性 */
  identityFit?: Readonly<Partial<Record<IntentKind, number>>>;
  /** §4.5 #2 第②级来源：从 `IntentWAL.attempts` 里同类别 outcome:'ok' 的动作序列 */
  experienceSeeds?: Readonly<Partial<Record<IntentKind, readonly string[]>>>;
}

/** `planSeeds` 三级来源拼装（①模板 ②经验 ③工具 schema），三者皆空才给探测动作。 */
export function composePlanSeeds(
  kind: IntentKind,
  affordances: readonly Affordance[],
  experienceSeeds: readonly string[] = [],
  templates: readonly string[] = [],
): string[] {
  const seeds: string[] = [];
  for (const seed of templates) seeds.push(seed);
  for (const seed of experienceSeeds) seeds.push(seed);
  for (const affordance of affordances) {
    // ③ 用工具 schema 拼最小合法调用；P0 只拼形状，不含参数推断
    seeds.push(`${affordance.tool}(…)：risk ${affordance.risk}`);
  }
  const seen: string[] = [];
  const unique = seeds.filter((seed) => (seen.includes(seed) ? false : (seen.push(seed), true)));
  return unique.length > 0 ? unique.slice(0, 3) : [PROBE_SEED];
}

/** 该类别需要哪些能力族。P4 能力缺口判定复用（`capability-signal.ts`），勿在别处再抄一份。 */
export function familiesFor(kind: IntentKind): readonly AffordanceFamily[] {
  return KIND_FAMILIES[kind];
}

function matchingAffordances(kind: IntentKind, frame: SituationFrame): Affordance[] {
  const families = familiesFor(kind);
  if (families.length === 0) return [];
  return frame.affordances.filter((affordance) => families.includes(affordanceFamily(affordance.tool)));
}

/** 该类在**此刻**是否可行（缺口门槛 + 工具能力 + 输入事实）。 */
export function isFeasible(kind: IntentKind, ctx: CandidateContext): boolean {
  const { drive, frame } = ctx;
  if (kind === "idle") return true;

  const threshold = KIND_GAP_THRESHOLDS[kind];
  const families = familiesFor(kind);
  if (families.length > 0 && matchingAffordances(kind, frame).length === 0) return false;

  switch (kind) {
    case "reach_out":
      return drive.connection >= (threshold ?? 0);
    case "continue_thread":
      return (ctx.threads?.length ?? 0) > 0;
    case "explore":
      return drive.novelty >= (threshold ?? 0);
    case "create":
      return drive.coherence >= (threshold ?? 0);
    case "repair":
      return ctx.needsRepair === true;
    case "withdraw":
      return drive.integrity >= (threshold ?? 0);
    default:
      return false;
  }
}

function becauseFor(kind: IntentKind, ctx: CandidateContext): CandidateCause[] {
  const impact = KIND_IMPACT[kind];
  const causes: CandidateCause[] = [];
  for (const key of DRIVE_KEYS) {
    const value = impact[key];
    if (value === undefined || value <= 0) continue; // 只把"被缓解的缺口"当作原因
    causes.push({ drive: key, gap: clamp01(ctx.drive[key]) });
  }
  return causes;
}

function buildCandidate(
  kind: IntentKind,
  ctx: CandidateContext,
  overrides: { goal?: string; threadId?: string; seeds?: readonly string[]; costRisk?: RiskLevel } = {},
): Candidate {
  const matched = matchingAffordances(kind, ctx.frame);
  const firstMatch = matched[0];
  const risk = overrides.costRisk ?? (firstMatch ? firstMatch.risk : 0);
  const templates = [...KIND_SEED_TEMPLATES[kind]];
  if (overrides.goal) templates.unshift(overrides.goal);
  const seeds = composePlanSeeds(
    kind,
    matched,
    [...(ctx.experienceSeeds?.[kind] ?? [])],
    overrides.seeds ? [...overrides.seeds, ...templates] : templates,
  );
  const because = becauseFor(kind, ctx);
  const firstCause = because[0];
  if (overrides.threadId !== undefined && firstCause !== undefined) {
    because[0] = { ...firstCause, memoryId: overrides.threadId };
  }
  return {
    kind,
    goal: overrides.goal ?? KIND_GOALS[kind],
    because,
    drive_impact: { ...KIND_IMPACT[kind] },
    planSeeds: seeds.slice(0, 3),
    score: 0, // 由 scoreCandidate 填充（B2 在 P1 才独立成层）
    cost: { risk, tokens: KIND_TOKENS[kind], socialRisk: KIND_SOCIAL_RISK[kind] },
    identityFit: ctx.identityFit?.[kind] ?? 0.5,
  };
}

function kindIndex(kind: IntentKind): number {
  return INTENT_KINDS.indexOf(kind);
}

/** 候选去重/排序键：同分时按类别固定顺序，保证"同输入同输出"（golden replay 需要稳定序）。 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const byKind = kindIndex(a.kind) - kindIndex(b.kind);
  if (byKind !== 0) return byKind;
  return a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0;
}

/**
 * B1：生成候选（≤ `MAX_CANDIDATES`）。
 *
 * 裁剪顺序（§4.5 #1）：
 *   1. 每个可行类别先取**本类最高分**的一个 → 类别覆盖优先；
 *   2. 剩余名额按分数从高到低补第二候选（每类 ≤ `MAX_PER_KIND`）；
 *   3. 仍超过 8 说明生成逻辑失控，截断（不会发生在新类别上，因为 7 类 ≤ 8）。
 */
export function generateCandidates(ctx: CandidateContext): Candidate[] {
  const feasible = INTENT_KINDS.filter((kind) => isFeasible(kind, ctx));
  const perKind: Candidate[][] = [];
  for (const kind of feasible) {
    const built: Candidate[] = [];
    if (kind === "continue_thread") {
      for (const thread of ctx.threads ?? []) {
        built.push(
          buildCandidate(kind, ctx, {
            goal: `想把「${thread.title}」接上`,
            threadId: thread.id,
            seeds: [`接着聊：${thread.title}`],
          }),
        );
        if (built.length >= MAX_PER_KIND) break;
      }
    } else {
      built.push(buildCandidate(kind, ctx));
    }
    for (const candidate of built) candidate.score = scoreCandidate(candidate, ctx.drive, ctx.frame);
    perKind.push(built.slice(0, MAX_PER_KIND));
  }

  const selected: Candidate[] = [];
  // 第 1 轮：每类先取一个
  for (const built of perKind) {
    if (built.length > 0) selected.push(built[0]!);
  }
  // 第 2 轮：按分数补第二候选，直到满 8
  const extras: Candidate[] = [];
  for (const built of perKind) {
    for (let index = 1; index < built.length; index += 1) extras.push(built[index]!);
  }
  extras.sort(compareCandidates);
  for (const extra of extras) {
    if (selected.length >= MAX_CANDIDATES) break;
    selected.push(extra);
  }

  selected.sort(compareCandidates);
  return selected.slice(0, MAX_CANDIDATES);
}
