/**
 * 意向引擎 P0 —— VISION-AUTONOMOUS-INTENT v0.3 §4.2 的数据类型（纯类型 + 常量，零 IO、零模型调用）。
 *
 * 命名裁决（D1，2026-10-31 用户拍板）：心理层用 `Intention*`，**不与执行层 `execution.Intent`（工具调用请求）
 * 共用名字**——见 VISION §4.2.1。`IntentionRecord.planSeeds` 展开之后才生成 `execution.Intent`。
 *
 * P0 边界：本文件只有结构，没有行为；行为在 drive.ts / candidates.ts / scoring.ts / bus.ts / attribution.ts。
 */

// ── B0：稳态投影（§4.2 / §11.3） ─────────────────────────────────────────
/** 六个分量全部是 [0,1] 的「未满足度」，越大越缺。只读投影，不引入新旋钮。 */
export interface DriveVector {
  /** 1 − state.energy（疲惫程度） */
  energy: number;
  /** state.suppressionLoad（面具压强 / 自我完整性缺口） */
  integrity: number;
  /** 关系阶段 + 距上次真实互动的衰减 → 连接需求未满足 */
  connection: number;
  /** 近期失败率 + 未完成意图数 / 上限 */
  competence: number;
  /** 知识覆盖缺口（复用 curiosity 的 gap，非新算） */
  novelty: number;
  /** 近期行为与 B 层价值排序的偏离（自传一致性缺口） */
  coherence: number;
}

export const DRIVE_KEYS = [
  "energy",
  "integrity",
  "connection",
  "competence",
  "novelty",
  "coherence",
] as const satisfies readonly (keyof DriveVector)[];

/** 自述层用的人类可读名（P0 只用于 narrative 拼装与调试输出，不参与打分）。 */
export const DRIVE_LABELS: Readonly<Record<keyof DriveVector, string>> = {
  energy: "累了",
  integrity: "绷着",
  connection: "想说话",
  competence: "使不上劲",
  novelty: "想看新东西",
  coherence: "对不上自己",
};

// ── B1：候选生成 ─────────────────────────────────────────────────────────
export type IntentKind =
  | "reach_out" // 连接：想找用户说话
  | "continue_thread" // 未完：上次没聊完/没做完的事
  | "explore" // 新奇：想看/想学/想知道
  | "create" // 表达：想留下点什么
  | "repair" // 修复：关系受损/承诺未兑现
  | "withdraw" // 回避：面具压强过高/被冒犯后需要退开
  | "idle"; // 什么都不想做（合法结果，见 §8.4 风险 1）

export const INTENT_KINDS = [
  "reach_out",
  "continue_thread",
  "explore",
  "create",
  "repair",
  "withdraw",
  "idle",
] as const satisfies readonly IntentKind[];

/** P0 候选上限（§4.2：≤8 个候选；超出说明生成逻辑失控，不是"越多越好"）。 */
export const MAX_CANDIDATES = 8;

/**
 * A4（审计 §2 P0-1）：**只有这三类该走"主动开口"**。
 *
 * 以前 `wouldSpeak = gate.allowed && top !== null`，任何类别——包括 `withdraw`（想安静）和
 * `idle`（什么都不想做）——都能被算成"这一拍要主动说话"，出口自然与意图脱钩。
 * 语义划分：
 * - `reach_out` / `continue_thread` / `repair`：社会性出口，说话就是它的动作；
 * - `explore` / `create`：要的是做事（找资料、做东西），先说一句只是副作用 → journal，等执行器；
 * - `withdraw` / `idle`：状态而不是行为，连日记都不必写。
 */
export const SPEAK_INTENT_KINDS = ["reach_out", "continue_thread", "repair"] as const satisfies readonly IntentKind[];

export function isSpeakKind(kind: IntentKind): boolean {
  return (SPEAK_INTENT_KINDS as readonly string[]).includes(kind);
}

/** `idle` 是合法且必须存在的兜底候选（见 §8.4「意图抖振」对策）。 */
export const IDLE_KIND: IntentKind = "idle";

export const RISK_LEVELS = [0, 1, 2, 3] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface Affordance {
  /** 'qq.send_text' | 'bili.read' | 'desktop.screen' | ... */
  tool: string;
  /** 复用 src/execution 已有的风险四级 */
  risk: RiskLevel;
  requiresLogin: boolean;
  rateLimited: boolean;
}

export interface SituationFrame {
  /** ISO 时间 */
  at: string;
  channel: "qq" | "wechat" | "bili" | "local" | "none";
  /** 在场者 */
  participants: string[];
  /** 此刻真正可执行的（已按登录/额度过滤） */
  affordances: Affordance[];
  sinceLastContactMin: number;
  /** 未闭合意图 id */
  activeIntents: string[];
  budget: { rph: number; peak: boolean; quietHours: boolean };
  /** 静默时段 / 单写者冲突 / 额度超限 → 只读告警，不参与打分 */
  hardBlocks: string[];
}

export interface CandidateCause {
  drive: keyof DriveVector;
  gap: number;
  memoryId?: string;
}

export interface Candidate {
  kind: IntentKind;
  /** 一句话："想问她昨天那件事怎么样了" */
  goal: string;
  /** 逐维影响，可为负。"硬着头皮去社交" = connection +0.3 但 integrity −0.2 */
  because: CandidateCause[];
  drive_impact: Partial<Record<keyof DriveVector, number>>;
  /** 2–3 个动作候选（给 B3 展开，不给模型自由发挥） */
  planSeeds: string[];
  score: number;
  cost: { risk: RiskLevel; tokens: number; socialRisk: number };
  identityFit: number;
}

// ── B2/B3：意图记录与自述 ────────────────────────────────────────────────
export interface IntentionTrigger {
  type: "time" | "event" | "cue";
  spec: string;
}

export interface IntentionAttempt {
  at: string;
  act: string;
  outcome: "ok" | "fail" | "noop";
  agency: number;
}

export type IntentionStatus = "pending" | "active" | "blocked" | "held" | "done" | "dropped";

export interface IntentionRecord {
  id: string;
  created_at: string;
  kind: IntentKind;
  goal: string;
  /** 自述层一句话，可回溯到 because */
  why: string;
  /** 前瞻意图（Gollwitzer 1999） */
  trigger: IntentionTrigger | null;
  deadline: string | null;
  status: IntentionStatus;
  /** §4.5 #3：被硬闸拦下时写明是谁拦的（`shouldInitiate` 的哪个否决），可审计 */
  blocked_by?: string | null;
  attempts: IntentionAttempt[];
  superseded_by: string | null;
  /** 跨 tick 被推进次数 → 「意图存活率」指标原料 */
  survival: number;
  /** 派生自哪些记忆/事件（可追溯） */
  source_ids: string[];
}

export const INTENTION_STATUSES = [
  "pending",
  "active",
  "blocked",
  "held",
  "done",
  "dropped",
] as const satisfies readonly IntentionStatus[];

// ── B4：归因与学习 ───────────────────────────────────────────────────────
export type AttributionTarget = "self" | "other" | "world" | "unclear";

export interface Attribution {
  intent_id: string;
  /** 预期结果 */
  predicted: string;
  /** 实际结果 */
  observed: string;
  /** 0..1 */
  predError: number;
  /** 0..1 */
  agency: number;
  attributedTo: AttributionTarget;
  /** 回写：这次行动到底缓解了哪个缺口（只写变化的维度） */
  driveDelta: Partial<DriveVector>;
}

// ── P4：求助与能力账本（P0 先落结构，不实现行为；见 §11.6.2 / §11.7） ──
export type HelpNeed = "knowledge" | "permission" | "plugin" | "review" | "unknown";

export interface HelpRequest {
  blockedIntentionId: string;
  /** 我卡在哪（用她自己的话，不是堆栈） */
  what: string;
  /** 我已经试过什么（引用 intent.attempts） */
  tried: string[];
  need: HelpNeed;
  /** 希望对方做什么 */
  ask: string;
}

export const HELP_NEEDS = [
  "knowledge",
  "permission",
  "plugin",
  "review",
  "unknown",
] as const satisfies readonly HelpNeed[];

export type CapabilityKind = "tool" | "script" | "integration" | "knowledge";
export type CapabilityStatus = "quarantined" | "active" | "retired";

export interface CapabilityRecord {
  capId: string;
  kind: CapabilityKind;
  tool: string | null;
  /** 它是为了哪个意图而生的 */
  sourceIntentionId: string;
  effectivityBefore: number;
  effectivityAfter: number;
  tests: Array<{ name: string; passed: boolean }>;
  riskCeiling: RiskLevel;
  status: CapabilityStatus;
  createdAt: string;
}

// ── 运行时守卫（P0 唯一的行为：防止把 JSON 里读出来的字符串当 IntentKind 用） ──
export function isIntentKind(value: unknown): value is IntentKind {
  return typeof value === "string" && (INTENT_KINDS as readonly string[]).includes(value);
}

export function isDriveKey(value: unknown): value is keyof DriveVector {
  return typeof value === "string" && (DRIVE_KEYS as readonly string[]).includes(value);
}
