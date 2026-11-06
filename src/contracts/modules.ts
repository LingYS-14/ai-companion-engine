/**
 * 模块契约 —— P0 阶段冻结，接口先于实现。
 *
 * 为什么先写契约：
 *   AUDIT P0-1 / P0-5 的根因不是公式错，而是"谁写谁读"从未被声明。
 *   本文件的 `reads` / `writes` 是 CI 的输入，不是注释。
 *
 * 谁在机检它（2026-10-30 之前这里是"声明了但没人读"，现在是真检查）：
 *   - `test/module-contracts.test.ts`（gate 的一部分，跑在每次 `npm run gate`）：
 *       (a) 每个 `s.*` 恰好一个 writer，且只有 state 能写 `s.*` / `d.*` —— 解 P0-1
 *       (b) 每个 `s.*` 必须是 `initialSState()` 真实的键（引用幽灵字段直接红）—— 解 P0-5
 *       (c) 每个模块 id 都要有真实源码文件 —— 契约不再是空头文件
 *   - `tools/lint/writers.mjs`：文本级结构检查（id 唯一、字段名齐全），不依赖 dist。
 *
 * 还没机检的：`(c) Firewall 必须位于 MemoryStore 写路径上`（INV-1 静态可达性）——
 * 它依赖对调用链的分析，目前只在审计文档里人工确认，别把这句当已落地。
 *
 * 纪律：本文件不做任何计算，只描述边界。实现分散在 `src/engine/state.ts`、
 * `src/orchestrator/`、`src/psychology/`、`src/memory/`、`src/learning/`、
 * `src/firewall/`、`src/dialogue/`（见 test 里的 SOURCE_OF 表）。
 */

import type { Clock } from "../engine/clock.js";

/* ------------------------------------------------------------------ *
 * 0. 基础引用类型
 * ------------------------------------------------------------------ */

/** 状态字段引用：`s.<field>` / `d.<field>` / `mark` / `mode`，与 state.schema.json 对齐 */
export type FieldRef = `s.${string}` | `d.${string}` | "mark" | "mode";

/** 记忆字段引用，与 memory.schema.json 对齐 */
export type MemoryFieldRef = `m.${string}`;

export type ModuleId =
  | "orchestrator"
  | "state"
  | "psychology"
  | "memory"
  | "learning"
  | "firewall"
  | "dialogue"
  | "render";

export interface ModuleContract {
  readonly id: ModuleId;
  readonly reads: readonly FieldRef[];
  readonly writes: readonly FieldRef[];
  /** 本模块负责维护的不变量（ID 见 docs/ARCHITECTURE.md 的模块不变量） */
  readonly invariants: readonly string[];
  /** 宿主故障时的行为：degrade = 返回安全默认值并记 trace；throw = 中止本轮 */
  readonly failureMode: "degrade" | "throw";
}

/* ------------------------------------------------------------------ *
 * 1. 输入 / 输出
 * ------------------------------------------------------------------ */

/** 一次用户输入的归一化结果（跨 channel 一致） */
export interface TurnInput {
  readonly traceId: string;
  readonly characterId: string;
  readonly text: string;
  readonly channel: string;
  /** 附件/引用等非文本信号，供 appraisal 使用 */
  readonly signals?: Readonly<Record<string, number | string | boolean>>;
}

/** Appraisal 结果：规格给了 emerge() 的 7 个情绪强度，但没给 state delta */
export interface Appraisal {
  readonly goalCongruence: number;      // [-1, 1]
  readonly goalRelevance: number;       // [0, 1]
  readonly novelty: number;             // [0, 1]
  readonly legitimacy: number;          // [0, 1]
  readonly emotions: Readonly<Record<string, number>>; // emerge() 输出，7 项
  readonly tags: readonly string[];
}

/**
 * 状态增量 —— 规格缺失的一节（AUDIT P0-1）。
 *
 * 设计原则：
 *   1. 唯一 writer：每个字段只在 Delta 里出现一次，且只由 StateMachine 应用；
 *   2. 显式稀疏：未出现的字段表示"本轮不变"，不是"设为 0"；
 *   3. 可审计：trace 记录 delta，使"为什么这个值是 0.42"可回答。
 */
export interface StateDelta {
  readonly s?: Partial<{ [K in StateField]: number }>;
  readonly d?: Partial<{ bondProgress: number; stageDepth: number }>;
  readonly reasons?: Readonly<Record<string, string>>;
}

export type StateField =
  | "valence" | "arousal" | "pressure" | "energy" | "dissonance"
  | "entropy" | "affection" | "trust" | "jealousy"
  | "maskIntegrity" | "suppressionLoad" | "rumination";

/* ------------------------------------------------------------------ *
 * 2. 八个模块
 * ------------------------------------------------------------------ */

/** Orchestrator：单轮编排。不持有状态，只持有流程。 */
export interface IOrchestrator extends ModuleContract {
  readonly id: "orchestrator";
  /** 一轮对话的完整流水线；任一步抛错由 failureMode 决定降级或中止 */
  turn(input: TurnInput): Promise<TurnResult>;
  /** 离线维护：睡眠窗洞见、遗忘、快照 */
  maintenance(): Promise<MaintenanceReport>;
}

/** StateMachine：状态唯一所有者。只有它能改 s.* / d.* */
export interface IStateMachine extends ModuleContract {
  readonly id: "state";
  /** 由 appraisal 计算 delta（规格缺此函数，P0 补） */
  delta(appraisal: Appraisal, ctx: TurnContext): StateDelta;
  /** 应用 delta 并 clamp；返回实际生效的增量（可审计） */
  apply(delta: StateDelta): AppliedStateDelta;
  /** 6 模式判定；输入不足时返回 NORMAL 并记 trace 警告 */
  resolveMode(state: ReadonlyState): Mode;
}

export interface AppliedStateDelta {
  readonly changed: StateDelta;
  /** 被 clamp 掉的量，用于发现"调参无效"类问题 */
  readonly clamped: Readonly<Record<string, number>>;
}

/** Psychology：情绪动力学、面具、依恋、阶段 */
export interface IPsychology extends ModuleContract {
  readonly id: "psychology";
  /** emerge(app, ctx) → 7 个情绪强度（规格 §4.2） */
  emerge(app: Appraisal, ctx: TurnContext): Readonly<Record<string, number>>;
  /** 面具/压抑更新；解 P1-8 的双时钟问题（统一走 Clock） */
  updateMask(state: ReadonlyState, si: number, clock: Clock): { maskIntegrity: number; suppressionLoad: number; energyCost: number };
  /** 由 (anxiety, avoidance) 推导 bond_curve_id —— 规格只有数据表没有函数（P0-5） */
  deriveBondCurve(anxiety: number, avoidance: number): BondCurveId;
  /** 表达层：非单调曲线，允许回退（驱动台词/距离/称呼） */
  expression(curveId: BondCurveId, progress: number): number;
  /** 等级层：单调棘轮，只在 rupture 时回退一档（驱动内容门禁）—— 解 P0-3 */
  stageOf(stageDepth: number, curveId: BondCurveId): Stage;
}

/** MemoryStore：唯一可写记忆的地方；所有写必须过 Firewall */
export interface IMemoryStore extends ModuleContract {
  readonly id: "memory";
  /** 写入前必须调用 Firewall.vetWrite；返回值含裁决 */
  write(record: NewMemory, verdict: FirewallVerdict): WriteResult;
  /** 检索：候选集 + rerank + 目标预算 */
  retrieve(query: RetrieveQuery, ctx: TurnContext): readonly RankedMemory[];
  forget(criterion: ForgetCriterion): number;
  /** 离线整合：簇聚类 → 洞见候选 */
  consolidate(windowMs: number): readonly MemoryId[];
}

/** Learning：OCEAN 漂移、alpha、期望、milestone、bandit */
export interface ILearning extends ModuleContract {
  readonly id: "learning";
  /** 学习率：依赖证据量与 bond（规格 §6.8） */
  alpha(evidence: number, bondProgress: number): number;
  /** OCEAN 增量：必须受 deltaClamp 与 driftGuard 双重约束 */
  oceanDelta(evidence: OceanEvidence, current: Ocean): OceanDelta;
  /** milestone：规格里 cap 永不 bind、trust 一步到 1.0（P1-7），实现前需重定义 */
  milestone(event: MilestoneEvent, state: ReadonlyState): MilestoneResult;
  /** 预测误差：期望值台账（§7.2） */
  predictionError(predicted: number, actual: number): number;
}

/** Firewall：不可绕过。INV-1 要求与 MemoryStore 同进程且在其写路径上 */
export interface IFirewall extends ModuleContract {
  readonly id: "firewall";
  /** 写入裁决：拒绝时返回拒绝原因，不抛错 */
  vetWrite(candidate: NewMemory, provenance: Provenance): FirewallVerdict;
  /** 检索守卫：污染源进入召回集时打标（P0-4 的三元组事件） */
  guardRetrieve(query: RetrieveQuery, hits: readonly RankedMemory[]): readonly TaintMark[];
  /** 洗白判定：ACCEPT 路径必须存在正向夹具（P0-4） */
  canClearTaint(varName: string, now: number, ledger: TaintLedger): boolean;
}

/** DialogueGenerator：把"状态 + 记忆 + 意图"变成话（唯一调 LLM 的模块） */
export interface IDialogueGenerator extends ModuleContract {
  readonly id: "dialogue";
  generate(prompt: DialoguePrompt, opts: GenerateOptions): Promise<DialogueOutput>;
}

/** Render：格式化为各 channel 输出（表情、延迟、分段） */
export interface IRender extends ModuleContract {
  readonly id: "render";
  format(output: DialogueOutput, hints: RenderHints, channel: string): RenderedMessage;
}

/* ------------------------------------------------------------------ *
 * 3. 读写集（lint 输入）
 * ------------------------------------------------------------------ */

export const CONTRACTS: readonly ModuleContract[] = [
  {
    id: "orchestrator",
    reads: [],
    writes: [],
    invariants: ["INV-1", "INV-4"],
    failureMode: "throw",
  },
  {
    id: "state",
    // 唯一 writer：所有 s.* / d.bondProgress / d.stageDepth / mode
    reads: ["mark"],
    writes: [
      "s.valence", "s.arousal", "s.pressure", "s.energy", "s.dissonance",
      "s.entropy", "s.affection", "s.trust", "s.jealousy",
      "s.maskIntegrity", "s.suppressionLoad", "s.rumination",
      "d.bondProgress", "d.stageDepth", "mode",
    ],
    invariants: ["INV-5", "INV-6"],
    failureMode: "degrade",
  },
  {
    id: "psychology",
    // 只读状态、只产出建议值；实际写入由 state 执行
    reads: ["s.valence", "s.arousal", "s.energy", "s.entropy", "s.trust", "s.suppressionLoad", "d.attachment", "d.bondProgress"],
    writes: [],
    invariants: ["INV-6"],
    failureMode: "degrade",
  },
  {
    id: "memory",
    reads: ["s.valence", "s.arousal", "s.entropy", "s.trust", "mark"],
    writes: [],
    invariants: ["INV-1", "INV-7"],
    failureMode: "throw",
  },
  {
    id: "learning",
    // INV-3：不得调用 LLM；此处也禁止读 s.* 瞬时量做长期更新
    reads: ["d.bondProgress", "d.stageDepth"],
    writes: [],
    invariants: ["INV-3", "INV-8"],
    failureMode: "degrade",
  },
  {
    id: "firewall",
    reads: ["mark"],
    writes: ["mark"],
    invariants: ["INV-1", "INV-9"],
    failureMode: "throw",
  },
  {
    id: "dialogue",
    reads: ["mode", "s.pressure", "s.energy"],
    writes: [],
    invariants: ["INV-3"],
    failureMode: "throw",
  },
  {
    id: "render",
    reads: ["mode"],
    writes: [],
    invariants: [],
    failureMode: "degrade",
  },
];

/* ------------------------------------------------------------------ *
 * 4. 支撑类型（略去全部实现，仅签名）
 * ------------------------------------------------------------------ */

export type TurnResult = unknown;
export type MaintenanceReport = unknown;
export type TurnContext = unknown;
export type ReadonlyState = unknown;
export type Mode = "NORMAL" | "DEFENSE" | "BREAK" | "OBSESSION" | "OVERDRIVE" | "LAZY";
export type BondCurveId = "secure" | "preoccupied" | "dismissive" | "fearful";
export type Stage = "stranger" | "familiar" | "close" | "beloved";
export type MemoryId = string;
export type NewMemory = unknown;
export type WriteResult = unknown;
export type RetrieveQuery = unknown;
export type RankedMemory = unknown;
export type ForgetCriterion = unknown;
export type Ocean = unknown;
export type OceanEvidence = unknown;
export type OceanDelta = unknown;
export type MilestoneEvent = unknown;
export type MilestoneResult = unknown;
export type Provenance = unknown;
export type FirewallVerdict = { allow: boolean; reason?: string; taint?: readonly string[] };
export type TaintMark = { var: string; startedAt: number; sourceChain: readonly string[]; consumed: boolean };
export type TaintLedger = unknown;
export type DialoguePrompt = unknown;
export type GenerateOptions = { temperature?: number; cot?: boolean; maxTokens?: number };
export type DialogueOutput = unknown;
export type RenderHints = unknown;
export type RenderedMessage = unknown;
