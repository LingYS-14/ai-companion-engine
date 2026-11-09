/**
 * SoulRuntime —— 插件侧的“角色实例”：把 engine 的纯函数串成一次可持久化的对话轮。
 *
 * 分工（与 spec 的九模块一一对应）：
 *   orchestrator.runTurn  = appraisal → crisis → tick → resolveMode → 关系通道
 *   bonds                 = 关系进度（本文件负责“每轮推进”这一层接线）
 *   dialogue.composePrompt= 把状态折成给 LLM 的结构化提示（不生成台词）
 *   memory                = 一条消息一条记忆，写路径**必须**过 firewall（INV-1）
 *
 * 本文件是唯一做 IO 的地方：json 状态 + NDJSON 记忆，都落在 dataDir。
 * 为什么不用数据库：§2 定的存储决策是 NDJSON WAL + 纯 JS 向量库，
 * 先跑通“记忆能存能召回”，向量库留到有真实语料再加。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { RecallRow, TurnText } from "../dialogue/turn-result.js";
import { buildRecallCue, rankByCue, type CueRankedRow } from "../orchestrator/intent/cue-recall.js";
import { join } from "node:path";

import { SystemClock, type Clock } from "../engine/clock.js";
import { loadConfig, tickHours, type EngineConfig } from "../engine/config.js";
import { clamp01, energyCostFor, initialSState, tick, type SState } from "../engine/state.js";
import {
  nextSleepState,
  sleepThresholdsFromConfig,
  type SleepPhase,
  type SleepReason,
  type SleepState,
} from "../engine/sleep.js";
import { EventQueue } from "../orchestrator/queue.js";
import { runTurn, type TurnContext, type TurnRequest } from "../orchestrator/turn.js";
import { buildEpisodeWrite, channelForSource } from "../orchestrator/intent/episode-write.js";
import { composePrompt } from "../dialogue/render.js";
import { wonderOf, type Wonder } from "../psychology/wonder.js";
import type { BrainPort, Persona } from "../ports/index.js";
import { expressionLine, styleFor, type Attachment, type ExpressionHint } from "../dialogue/expression.js";
import { eventStyleFor, type EventRegister } from "../dialogue/event-style.js";
import {
  STAGES,
  bondDriveZero,
  deriveBondCurve,
  pacingRates,
  rateForNextStage,
  stageBands,
  stageOf,
  updateBondProgress,
  valenceAnchor,
  type Stage,
} from "../engine/bonds.js";
import { resolveMode, thresholdsFrom, type Mode } from "../engine/modes.js";
import { crossedSleeps, nextSleepInHours, sleepHourFor } from "../engine/cycles.js";
import { MemoryStore, type Firewall } from "../memory/store.js";
import { makeMemory, type MemoryRecord } from "../memory/types.js";
import { retrieve, type QueryContext } from "../memory/retrieve.js";
import { visibleTo, type Visitor } from "../memory/visibility.js";
import { OWNER_VISITOR } from "../ports/visitor.js";
import { semanticScores } from "../memory/semantic.js";
import { ALL_CHANNELS, prefilter } from "../memory/prefilter.js";
import { reconcileSuppression } from "../memory/suppression.js";
import { ArchiveStore, type ArchivedEntry } from "../memory/archive.js";
import { HubStore } from "../memory/hubs.js";
import { computeFreshness, shouldColdArchive } from "../memory/lifecycle.js";
import { applySocialDelta, classifySocialReaction } from "../learning/knowledge-feedback.js";
import { resolveConflict, type ConflictResolution } from "../memory/conflict.js";
import { obsessionTrigger, pickIntrusion, type ObsessionCheck } from "../memory/obsession.js";
import {
  hasRetrievalTaint,
  shouldClearTaint,
  taintForUntrustedTurn,
  taintWindowMs,
  type RetrievalVarSnapshot,
} from "../memory/taint.js";
import {
  computeRepairDelta,
  ExpectationModel,
  learnDelta,
  type ActionRecord,
  type DriftVerdict,
} from "../learning/learn.js";
import {
  baselineFrom,
  settleDrift,
  TRAIT_SAMPLE_CAP,
  type DriftOcean,
  type DriftState,
  type TraitSample,
} from "../learning/drift.js";
import { KnowledgeStore, type KnowledgeType } from "../memory/knowledge.js";
import {
  createKnowledgeWritePort,
  parseKnowledgeGuardMode,
  KNOWLEDGE_GUARD_ENV,
  type GuardedKnowledgePort,
  type KnowledgeGuardStats,
} from "../memory/knowledge-write.js";
import {
  decideStateWrite,
  describeStateSaveOutcome,
  readStateUpdatedAt,
  type StateWriteDecision,
  type StateWriterRole,
} from "../memory/state-guard.js";
import {
  consolidate,
  clusterEpisodic,
  isValidBeliefUpdate,
  knowledgeIdFor,
  makeKnowledge,
} from "../memory/consolidate.js";
import { emptyBandit, recordOutcome, selectStrategy, type BanditState, type StrategyChoice } from "../learning/bandit.js";
import { defaultStrategyFor } from "../learning/strategy.js";
import {
  coverageGap,
  curiosityTargets,
  taintForCuriosity,
  type Contact,
  type CuriosityResult,
} from "../learning/curiosity.js";
import { vetOceanDelta, vetWrite } from "../firewall/guard.js";
import { deriveInsightProvenance } from "../firewall/insight.js";
import { decayUnresolved, shouldForgetNow, tickVividness, updateUnresolved } from "../memory/lifecycle.js";
import { isSelfAuthored } from "../memory/echo-sources.js";
import { knobNumber } from "../engine/config.js";
import { consumedPathFor, journalSeeds, saveConsumedAt } from "../maintenance/selftalk-consumer.js";
import { readTrace, TraceLog } from "../trace/trace.js";
import {
  interpretationsFilePathInDataDir,
  interpretationsFromRaw,
  withInterpretation,
  type InterpretationMap,
} from "../orchestrator/intent/version-recall.js";

/**
 * F355：原子写 rename 重试。
 *
 * Windows 上高频 `writeFileSync + renameSync` 时偶发 EPERM「operation not permitted」——
 * 不是权限/磁盘问题（单次 rename 正常），而是外部句柄（文件监视器 / 杀毒实时扫描）
 * 短暂占着临时文件或目标文件；实测同目录连续 505 次 rename 约 200 次后开始出现，
 * 加 10ms 间隔就不复现，属速率相关的抢占。状态文件是「活下来」优先级最高的东西，
 * 一次 EPERM 就丢一次落盘（heartbeat/finally 都会看到异常），因此这里退避重试几次；
 * 只对占用类错误重试，仍然失败照旧抛，不吃掉真正的权限错误。
 *
 * 与 `src/execution/queue.ts` / `src/memory/wal.ts` / `src/maintenance/selftalk-journal.ts`
 * 的同款实现重复（层归属不同，见 ARCH-EVOLUTION D10：后续抽公共 helper）。
 */
export function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  rename: (a: string, b: string) => void = renameSync,
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt >= attempts) throw err;
      // 同步落盘路径不能用 async 等待：Atomics.wait 阻塞当前线程 5/10/15/20ms，不引依赖。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5);
    }
  }
}


/** 上一轮用过的策略——下一轮拿到玩家反应时才知道该给谁记分 */
export interface PrevStrategy {
  readonly contextTag: string;
  readonly actionTag: string;
}

/**
 * P3-2b：睡眠状态机的最小落盘面（§3.1 方案 S）。
 *
 * 为什么落盘而不再每次现算：相位是**跨进程**的事实——daemon 每拍算、插件重启后必须
 * 接着上一拍（否则重启一次就"醒"一次，夜间硬跳全部失效）。只存 4 个数，复用它自己的
 * 状态文件，不新增 data 文件、不进 S 层（S 层是情绪状态机，睡眠是调度层）。
 *
 * `lastSleepMs` 是**入睡时刻**（喂给 nextSleepState 算 sleptHours），与顶层
 * `lastSleepAt`（上次跨睡点巩固的时刻，用于 20h 去重）不是同一个东西，不要合并。
 */
export interface PersistedSleep {
  readonly phase: SleepPhase;
  /** 进入 waking 的时刻；没醒过为 null */
  readonly wokeAtMs: number | null;
  /** 进入 asleep 的时刻；没睡过为 null */
  readonly asleepSince: number | null;
  /** 最近一次入睡的时刻；没睡过为 null */
  readonly lastSleepMs: number | null;
  /**
   * F340（task-179）：上一次做过夜间功课的睡眠段（episode = `asleepSince` 毫秒值）。
   *
   * 为什么落盘：daemon 每拍判相位，同一段睡眠会经过几十拍；episode 是跨拍/跨重启的
   * 去重键——同一段最多做一次 fade/compact/consolidate/sleepWork。老存档没有 → null，
   * 视为「本段还没做」，部署后第一次入睡会补做一次（预期）。
   */
  readonly lastSleepWorkEpisode?: number | null;
  /**
   * P4-1：夜间功课额度账本（{nightKey,used}）。
   *
   * 为什么落盘：daemon 跨睡点重启后，P4 的夜间消费者（dream/habit/SelfModel）不能
   * 把同一夜重新记一遍账；落这里复用自己的状态文件与原子写，不新增 data 文件、不进 S 层。
   * 老存档没有 → 缺省 null；load 时由装配层用 `normalizeNightBudget` 跨夜重置后写回。
   */
  readonly nightBudget?: PersistedNightBudget | null;
}

/** P4-1：夜间额度账本（与自主层 `NightBudget` 同形；本层不 import spine，故独立声明） */
export interface PersistedNightBudget {
  readonly nightKey: string;
  readonly used: number;
}

/** P4-1：一次夜间 fade 的结果（装配层打 `[fade]` 观测用） */
export interface SleepFadeResult {
  /** 这次 fade 覆盖的天数（clamp 0–7）；首跑锚点写入时为 0 */
  readonly days: number;
  readonly faded: number;
  readonly forgotten: number;
  /** true = 老存档首次跑：只写锚点、不补扣 */
  readonly firstAnchor: boolean;
  /** firstAnchor=true 时实际用的回退锚点（lastSleepAt ?? processStartedAt） */
  readonly anchor: number | null;
  readonly error: string | null;
}

/** P4-1：一次睡眠期 WAL compact 的结果（7 天观察看 linesBefore→linesAfter） */
export interface SleepCompactResult {
  readonly ran: boolean;
  readonly linesBefore: number;
  readonly linesAfter: number;
  readonly error: string | null;
}

/** P4-1：一次睡点的确定性工作（fade/archive/compact/候选报告） */
export interface SleepWorkResult {
  readonly fade: SleepFadeResult;
  readonly archived: number;
  readonly compact: SleepCompactResult;
  /** hardDelete 候选数：只报告，不自动删 */
  readonly purgeable: number;
  /**
   * P4-1（task-74 B3）：hardDelete 候选 id 的前 {@link PURGEABLE_ID_LIMIT} 条。
   *
   * 规格要的是「候选清单」，不是只给个计数；但也不该在日志里刷全量——只报告、不删除，
   * 真正的销毁仍只能由 `purgeCold(true)` 显式触发。取不到（冷档读失败）时为空数组。
   */
  readonly purgeableIds: readonly string[];
  readonly error: string | null;
}

/** P4-1：`sleepAdvance` 的返回值（保留 P3 的四个字段，追加夜间工作结果） */
export interface SleepAdvanceResult {
  readonly consolidated: boolean;
  readonly clusters: number;
  readonly written: number;
  readonly archived: number;
  readonly fade: SleepFadeResult;
  readonly compact: SleepCompactResult;
  readonly purgeable: number;
  readonly purgeableIds: readonly string[];
  readonly error: string | null;
  /** F340（task-179）：本轮结果对应的触发路径；没有触发夜间工作时缺省（旧调用不感知） */
  readonly trigger?: "onset" | "crossing";
}

/** P4-1：启动补巩固（F317）的结果 */
export interface SleepBackfillResult extends SleepAdvanceResult {
  readonly ran: boolean;
  readonly reason: "ran" | "no-anchor" | "recent" | "no-crossing" | "error" | "no-episode" | "already-worked";
  /** 这段时间里跨过的睡点数（补巩固时 >0） */
  readonly missed: number;
}

/** 落盘状态：只存“跨会话必须活下来”的东西，派生量每次现算 */
interface Persisted {
  readonly version: 1;
  readonly characterId: string;
  readonly s: SState;
  readonly bondProgress: number;
  readonly turns: number;
  readonly updatedAt: number;
  /** 策略统计（§7.4）；老存档没有这两项，读到就按空表处理 */
  readonly bandit?: BanditState;
  readonly prevStrategy?: PrevStrategy | null;
  /** 上次跨睡点自动巩固的时刻；用来保证一个睡点只巩固一次 */
  readonly lastSleepAt?: number | null;
  /**
   * P4-1：上次 fade 的锚点（毫秒）。与 `lastSleepAt` 并列、不进 S 层。
   *
   * 为什么要持久化：`advance` 目前隐式用「推进了几小时/24」当天的 fade，但那个量
   * 不跨进程——daemon 重启后无从知道「上次 fade 到哪」。P4 把 fade 接进睡眠后，
   * 需要 `days = clamp((now-lastFadeAt)/DAY_MS, 0, 7)` 的锚点；老存档没有 →
   * 首次睡眠只写锚点、不补扣（避免一次性把历史记忆全标 forgotten）。
   */
  readonly lastFadeAt?: number | null;
  /** P3-2b：睡眠状态机的落盘面（老存档没有 → 按 awake 起步） */
  readonly sleep?: PersistedSleep | null;
  /**
   * §7.2 最近 50 次「对方怎么对我」的强度样本（期望模型的输入）。
   * 不进 S 层：它是调度层的观察历史，不是人格状态；落盘只是别让她每次重启都忘掉这些样本。
   */
  readonly actionHistory?: readonly ActionRecord[];
  /** §7.2 每个事件类型学到的期望偏置，叠加在样本均值上 */
  readonly expectationBias?: Readonly<Record<string, number>>;
  /**
   * §5.4 人格漂移的行为证据：每回合记一条"当时她是什么样"（滚动 200 条）。
   * 不进 S 层——它不是她此刻的情绪，而是给「她本来是什么样」用的慢证据。
   */
  readonly traitSamples?: readonly TraitSample[];
  /** §5.4 结账结果：当前 A/N/E 与每维最近 7 期的偏差（O/C 不漂，见 learning/drift.ts） */
  readonly drift?: DriftState;
}

/** 异常 → 一句人话（降级记录只要一句话，不要堆栈） */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 一次降级的留档（面板/健康检查/日志都要能回答"她最近有没有带病工作"） */
export interface DegradeRecord {
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
}

export interface SoulConfig {
  readonly characterId: string;
  /**
   * 显示名（F326 方案 A）：**只是 UI 标识**，不进入任何提示词。
   * 缺省回落到 `characterId`；头像也按 `characterId` 找包内资源。
   */
  readonly displayName?: string;
  readonly dataDir: string;
  readonly trace: boolean;
  /**
   * 依恋 D 层（§4.1：attachment{anxiety,avoidance}）。
   * 规格把它放在 D 层、却不给任何 archetype 取值（F19/F20），所以这里是**实现侧默认**：
   * 默认 (0.35, 0.30) 落 secure 象限，即"稳"——比默认 preoccupied/fearful 更不容易把角色演成病态。
   * 想换性格就改 cordis.patch.yml 的 config.attachment，不必改代码。
   */
  readonly attachment?: Attachment;
  /**
   * 人格卡（Persona）：把"她是谁"从代码搬到数据文件（见 persona.ts）。
   * 不配置时引擎只按表达层说话——机制完整、但没有具体的人。
   */
  readonly persona?: Persona;
  /**
   * 状态文件写入角色（批次 2a，单写者的第一步）。
   *
   * daemon 是 `primary`（默认）：即使发现别的进程写过，也继续写并记警告——
   * 主写者罢工等于她的心跳停摆。插件传 `secondary`：磁盘上的版本比自己新时**拒绝覆盖**，
   * 只记日志（真正的解法是批次 2c：插件只读快照、写操作投递给 daemon）。
   */
  readonly stateWriter?: StateWriterRole;
  /** 状态写入裁决的日志出口；插件传 appendQQLog，daemon 省略（它自己打 log） */
  readonly stateLog?: (line: string) => void;
}

/** 未配置时的依恋默认值（落 secure 象限；见 SoulConfig.attachment 的说明） */
export const DEFAULT_ATTACHMENT: Attachment = { anxiety: 0.35, avoidance: 0.3 };



const DAY_MS = 86_400_000;

/**
 * P4-1（task-74 B3）：hardDelete 候选清单的条数上限。
 *
 * 规格要的是「候选报告」而不是全量转储：7 天观察只需要确认「冷档里确实有该删的」，
 * 前 20 个 id 足够对账；计数仍走 `cold.stats().purgeable`（全量），清单只是示例。
 */
const PURGEABLE_ID_LIMIT = 20;


/**
 * 知识使用反馈的结算窗口（v5.2 §10.4）。
 *
 * 她讲完一句、对方下一句的反应进来，中间通常隔几分钟到几十分钟；
 * 超过一小时还没反应，那次「讲出去」就算没有回音，不再等（免得一周后
 * 某句无关的"冷战"去改一条早就过期的知识）。
 */
const KNOWLEDGE_FEEDBACK_WINDOW_MS = 60 * 60_000;

/** 同时挂着的「刚讲出去、等反应」的知识条数上限（多讲几句也不会无界增长） */
const KNOWLEDGE_PENDING_MAX = 5;

/** 自动闯入的冷却（见 lastIntrusionAt 注释）。 */
const INTRUSION_COOLDOWN_MS = 30 * 60_000;
/**
 * 从没学过东西时，`hoursSinceLearn` 给 30 天。
 * 给 Infinity 会让算术出现 non-finite，给 0 又会伪装成"刚学过"——30 天足够触发"久未学习"那一档。
 */
const NO_LEARN_HOURS = 24 * 30;

/**
 * 破裂判据：一次交互里 trust 掉这么多，就算「刚吵过」（§7.1 修复期的入口）。
 *
 * 规格 B8/B9 只写了「修复期」却没写怎么进修复期——没有入口，里程碑捷径就是死代码。
 * 0.1 的依据：trust 的语义增量本身就在 ±0.5 量级（VALENCE_TABLE 非对称），
 * 一次掉 0.1 已经是一次真实的失信，而不是情绪抖动。
 */
const RUPTURE_TRUST_DROP = 0.1;
/** 修复期窗口：破裂后 24 小时内做的补偿动作才算「修」；过时不补，避免一年后的礼物还算修复 */
const REPAIR_WINDOW_MS = 24 * 3_600_000;
/**
 * 期望偏置的硬边界（§7.2）。
 * 偏置是「样本均值之外她额外学到的倾向」；不设边界的话一次极端事件就能把预期推满，
 * 下一次正常互动又被判成落差——那就把她"变成"一个疑神疑鬼的人。
 */
const EXPECTATION_BIAS_MAX = 0.3;
/** 期望模型只看最近 50 条（ENGINE 旋钮 EXPECTATION_WINDOW＝50），内存里也只留这么多 */
const EXPECTATION_HISTORY_MAX = 50;

export class SoulRuntime implements BrainPort {
  private s: SState;
  private bondProgress: number;
  private turns: number;
  private bandit: BanditState;
  private prevStrategy: PrevStrategy | null;

  /**
   * 上一次自动闯入的时刻（进程内）。
   *
   * 为什么要有冷却：一条消息扫一遍全库、挑最该闯进来的那条，如果每个 inbound 都允许
   * 闯入，pressure 会被同一条记忆反复推高（12 条消息 = 12 次 gain），她的状态就变成
   * "被记忆拖着走"。冷却让闯入是事件，不是背景噪音。
   */
  private lastIntrusionAt = 0;
  /**
   * 最近一次「破裂」的时刻（§7.1 修复期）。
   *
   * 为什么记在进程内而不是落盘：rupture 是**这一段对话**里的语义（她刚被伤了），
   * 重启后她不再是"刚吵完"的状态；落盘会让一次争吵永久放进修复期。
   */
  private ruptureAt: number | null = null;
  /** 本次修复期里已经用过的里程碑类型（规格：同一 type 只用一次） */
  private milestoneUsedFor: Record<string, boolean> = {};
  /** §1.2 INV-2 trace 管线；`trace:false` 的实例保持 null（测试与只读面都靠它省 I/O） */
  private traceLog: TraceLog | null = null;
  /** trace id 的自增序号（同一毫秒内多轮也不会撞号） */
  private traceSeq = 0;
  /** §7.2 期望模型：预测「你这次会怎么对我」，与真实值的差距就是落差 */
  private readonly expectationModel: ExpectationModel;
  private actionHistory: ActionRecord[] = [];
  private expectationBias: Record<string, number> = {};
  /** §5.4 行为证据滚动窗口（cap 200）；只有配了人格卡才记账，不然没有 baseline 可比 */
  private traitSamples: TraitSample[] = [];
  /**
   * 「这一句把她学到的哪条讲出去了，等着看反应」——id → 讲出时刻。
   * §10.4 的两次读：桥在发送成功后 `noteKnowledgeUsed`，下一轮拿到反应时结算。
   */
  private pendingKnowledge = new Map<string, number>();
  /** 最近一次降级（§2 A26）：进程内留档，不落盘——降级是"这一刻带病工作"，不是状态 */
  private lastDegrade: DegradeRecord | null = null;
  /** §5.4 上次结账的 A/N/E 与偏差历史；null = 还没结过账 */
  private drift: DriftState | null = null;
  private lastSleepAt: number | null;
  /** P3-2b：睡眠状态机的内存视图（落盘见 PersistedSleep） */
  private sleep: PersistedSleep;
  /**
   * P4-1：上次 fade 的锚点（毫秒）；null = 老存档/从未跑过 P4 fade。
   * 回退链见 `sleepWork`：lastFadeAt → lastSleepAt → processStartedAt。
   */
  private lastFadeAt: number | null;
  /**
   * P4-1：fade 回退链最后一级（本进程启动时刻，不落盘）。
   * 只用于「既没 fade 锚点也没睡点锚点」的首夜——宁可少算，不拿 0 编一个天文数字。
   */
  private readonly processStartedAt: number;
  /**
   * P3 观测（task-51）：本次唤醒是怎么醒的（peer-message / min-window / max-window）。
   *
   * `nextSleepState` 只在**迁移那一步**给出唤醒原因，之后停在 waking 时一律报 "hold"；
   * 每拍日志如果只读当步 reason，夜间醒来的原因就永久丢了。所以这里记住迁移瞬间的
   * reason，只在 phase=waking 的日志里用它；醒来（awake）后不再复用。
   */
  private lastWakeReason: SleepReason | null = null;
  /**
   * 对方最近一条消息的时刻（进程内，不落盘）。
   *
   * 规格里「对方消息可以把她从 asleep 叫醒（覆盖最短窗）」需要一个"消息刚来过"的事实；
   * 它只影响这一次睡眠判定，重启后为 null 不会把状态机卡住（asleep 仍有最长窗兜底）。
   */
  private peerMessagedAt: number | null = null;
  /** 批次 2a：状态文件写入角色与"上次看到的 updatedAt"（单写者仲裁用，见 src/memory/state-guard.ts） */
  private readonly stateWriter: StateWriterRole;
  private lastSeenStateUpdatedAt: number;
  private stateSaveRejections = 0;
  private lastStateSaveDecision: StateWriteDecision = "write";
  /**
   * 同一毫秒内连续写入时的去重序号。
   *
   * 起因是一次真实的丢记忆 bug：id 原先是 `m<now36><2 位随机>`，随机空间只有 1296，
   * 而测试用的是冻结的 FakeClock——5 条记忆落在同一毫秒时，约 0.8% 的概率撞 id，
   * 后写的那条会覆盖先写的（WAL 按 id 索引），于是"5 条同 tag 记忆"只剩 4 条，
   * 巩固永远凑不够门槛。表现是测试偶发失败，实际是**用户的记忆被静默覆盖**。
   */
  private idSeq = 0;
  /**
   * §4.1 n_t：事件类型累计计数（只在本进程内维护，**不进 S 层、不落盘**）。
   * 进程重启后归零 → γ 从 1 重新开始；这是 D7 的取舍：宁可重启后短时"回甜"，
   * 也不把执行层状态写进人格状态机（INV-4）。
   */
  private eventTypeCounts: Record<string, number> = {};
  /**
   * §4.9 / D5：当前有没有还没处理完的入站事件。proactive 定时器靠它避免"她正在读消息时抢话"。
   * 只做繁忙信号，不缓存文本（缓存要选重复/乱序/丢失策略，另有坑）。
   */
  private readonly eventQueue = new EventQueue();

  private constructor(
    private readonly cfg: EngineConfig,
    private readonly conf: SoulConfig,
    private readonly clock: Clock,
    private readonly store: MemoryStore,
    private readonly knowledge: KnowledgeStore,
    private readonly knowledgePort: GuardedKnowledgePort,
    private readonly cold: ArchiveStore,
    private readonly hubs: HubStore,
    private readonly statePath: string,
    persisted: Persisted,
  ) {
    this.s = persisted.s;
    this.bondProgress = persisted.bondProgress;
    this.turns = persisted.turns;
    this.bandit = persisted.bandit ?? emptyBandit();
    this.prevStrategy = persisted.prevStrategy ?? null;
    this.processStartedAt = this.clock.now();
    this.lastSleepAt = persisted.lastSleepAt ?? null;
    this.sleep = persisted.sleep ?? initialPersistedSleep(persisted.lastSleepAt ?? null, this.clock.now());
    this.lastFadeAt = persisted.lastFadeAt ?? null;
    this.expectationModel = new ExpectationModel(cfg);
    if (conf.trace) {
      this.traceLog = new TraceLog({
        path: join(conf.dataDir, `trace-${conf.characterId}.ndjson`),
        capacity: knobNumber(cfg, "TRACE_BUFFER_SIZE"),
        flushIntervalMs: knobNumber(cfg, "TRACE_FLUSH_INTERVAL_SEC") * 1000,
      });
      this.traceLog.start();
    }
    this.actionHistory = [...(persisted.actionHistory ?? [])];
    this.expectationBias = { ...(persisted.expectationBias ?? {}) };
    this.traitSamples = [...(persisted.traitSamples ?? [])];
    this.drift = persisted.drift ?? null;
    this.stateWriter = conf.stateWriter ?? "primary";
    this.lastSeenStateUpdatedAt = persisted.updatedAt;
  }

  static async open(conf: SoulConfig, clock: Clock = new SystemClock()): Promise<SoulRuntime> {
    const cfg = await loadConfig();
    mkdirSync(conf.dataDir, { recursive: true });
    const statePath = join(conf.dataDir, `state-${conf.characterId}.json`);
    const walPath = join(conf.dataDir, `memory-${conf.characterId}.ndjson`);
    const knowledgePath = join(conf.dataDir, `knowledge-${conf.characterId}.ndjson`);

    const firewall: Firewall = (rec, engineCfg) => {
      const channel = typeof rec.encode_ctx["channel"] === "string" ? rec.encode_ctx["channel"] : "local";
      const v = vetWrite(
        { content: rec.content, claimedConfidence: rec.confidence },
        { source: rec.source, channel, observedAt: rec.created_at },
        engineCfg,
      );
      const keep = v.verdict !== "rejected";
      return v.markTainted ? { keep, reason: v.reason, markTainted: true } : { keep, reason: v.reason };
    };
    const store = MemoryStore.open(walPath, firewall, cfg);
    // D2 迁移：v5.3.1 落盘的记忆没有 base_activation，先按「访问次数 + 年龄」补一个初值
    store.migrateActivation(clock.now());
    const knowledge = new KnowledgeStore(knowledgePath).open();
    // F257：知识写入过防火墙。开关默认 enforce；观察期用 `ACE_KNOWLEDGE_WRITE_GUARD=observe`
    // 只记 would-* 不改行为（见 src/memory/knowledge-write.ts 文件头）。
    const knowledgePort = createKnowledgeWritePort({
      store: knowledge,
      cfg,
      now: () => clock.now(),
      mode: parseKnowledgeGuardMode(process.env[KNOWLEDGE_GUARD_ENV]) ?? "enforce",
      taintPath: join(conf.dataDir, `knowledge-taint-${conf.characterId}.ndjson`),
      journalPath: join(conf.dataDir, `knowledge-guard-${conf.characterId}.ndjson`),
    });
    const cold = new ArchiveStore(join(conf.dataDir, `cold-${conf.characterId}.ndjson`)).open();
    const hubs = HubStore.open(join(conf.dataDir, "consolidation-hubs.json"));
    const persisted = readPersisted(statePath, conf.characterId, clock.now());
    return new SoulRuntime(cfg, conf, clock, store, knowledge, knowledgePort, cold, hubs, statePath, persisted);
  }

  /**
   * §4.4：sleep_consolidation 只读 hub 权重（Orchestrator 用）；写入口只有 consolidate 内部。
   */
  consolidationHubs(): ReadonlyMap<string, number> {
    return this.hubs.entries(this.clock.now(), this.cfg);
  }

  get config(): EngineConfig {
    return this.cfg;
  }

  get state(): SState {
    return this.s;
  }

  get progress(): number {
    return this.bondProgress;
  }

  /** 关系阶段（由 progress 派生，不单独存） */
  stage(): Stage {
    return stageOf(this.bondProgress, stageBands(this.cfg));
  }

  /** 面板要画四段关系轨道：给出每档的上下界（含最后一档右端 = 1.0） */
  stageBounds(): readonly { stage: Stage; from: number; to: number }[] {
    const bands = stageBands(this.cfg);
    return STAGES.map((stage) => ({ stage, from: bands[stage][0], to: bands[stage][1] }));
  }

  /** 依恋象限的输入（D 层）；未配置时给默认值，面板据此显示"基调" */
  attachment(): Attachment {
    return this.conf.attachment ?? DEFAULT_ATTACHMENT;
  }

  /** 关系的一行摘要（带类型，面板与测试都用它，不要从 snapshot 的 unknown 里抠） */
  bondInfo(): {
    stage: Stage;
    stageLabel: Stage;
    progress: number;
    quadrant: "secure" | "preoccupied" | "dismissive" | "fearful";
    attachment: Attachment;
  } {
    const att = this.attachment();
    const stage = this.stage();
    return {
      stage,
      stageLabel: stage,
      progress: round4(this.bondProgress),
      quadrant: deriveBondCurve(att.anxiety, att.avoidance),
      attachment: { ...att },
    };
  }

  /** 最近的记忆（面板用；按 last_accessed/created_at 倒序，只读） */
  recentMemories(limit = 3): readonly {
    id: string;
    content: string;
    tags: readonly string[];
    vividness: number;
    created_at: number;
  }[] {
    return [...this.store.active()]
      .sort((a, b) => (b.last_accessed ?? b.created_at) - (a.last_accessed ?? a.created_at))
      .slice(0, Math.max(0, limit))
      .map((m) => ({
        id: m.id,
        content: m.content,
        tags: m.tags,
        vividness: m.vividness,
        created_at: m.created_at,
      }));
  }

  /** 最近沉淀的知识（面板用） */
  recentKnowledge(limit = 2): readonly { id: string; content: string; knowledge_type: string }[] {
    return this.knowledge
      .all()
      .slice(-Math.max(0, limit))
      .reverse()
      .map((k) => ({ id: k.id, content: k.content, knowledge_type: k.knowledge_type }));
  }

  /**
   * 当前时间（毫秒）。插件层写自检报告时要用；系统时钟只允许在
   * clock.ts 里读（CI 的 writers 闸会拦），所以统一从这里取。
   */
  /**
   * §6.7 冲突判定：这条记忆面对当前 trust 时，是坚持（INSIST）还是认错（DOUBT）。
   * 规格缺 INSIST_WEIGHTS 与 taboo_hit，替代方式见 memory/conflict.ts 顶部注释。
   */
  /**
   * §6.8 执念闯入：这条记忆在「用户这句话」的线索下会不会闯进来。
   * INTRUDE 时按规格 §4.6 的 immediate 白名单把 gain 立刻作用到状态（pressure / rumination）。
   */
  /** 影响检索的四个状态量的当前快照（§6.6） */
  private retrievalVarSnapshot(): RetrievalVarSnapshot {
    return {
      jealousy: this.s.jealousy,
      valence: this.s.valence,
      arousal: this.s.arousal,
      entropy: this.s.entropy,
    };
  }

  /**
   * §8.2：把"这一轮被不可信来源推动过的、影响检索的状态量"标脏。
   *
   * 单一写入点：只有这里和 `curiosity()` 会写 taintMap（清洗在 `clearTaintIfDue`）。
   * 返回标脏的变量名，供 trace 与日志使用；没标脏（常态）时返回空数组、不写状态。
   */
  private applyUntrustedTaint(before: RetrievalVarSnapshot, source: string): readonly string[] {
    const res = taintForUntrustedTurn({
      taintMap: this.s.taintMap,
      before,
      after: this.retrievalVarSnapshot(),
      source,
      cfg: this.cfg,
      now: this.clock.now(),
    });
    if (res.tainted.length === 0) return res.tainted;
    this.s = { ...this.s, taintMap: { ...res.taintMap } };
    return res.tainted;
  }

  /**
   * §6.8 自动闯入：一条消息进来时，按线索看哪条记忆会闯进来。
   *
   * 与 `soul_obsess` 工具的区别：那个是"点一条看它会不会闯"（观察/调试），
   * 这个是真对话路径上的自动判定——每 30 分钟最多一次，命中就当场结算
   * pressure + rumination（immediate 白名单里的 obsession_intrusion）。
   */
  autoIntrude(query: string, now: number): { memoryId: string; prob: number } | null {
    const text = query.trim();
    if (text === "") return null;
    if (now - this.lastIntrusionAt < INTRUSION_COOLDOWN_MS) return null;
    const tags = text
      .split(/[\s,，。、！？!?]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .slice(0, 8);
    if (tags.length === 0) return null;
    const pick = pickIntrusion(
      this.store.active(),
      { tags, now },
      { valence: this.s.valence, rumination: this.s.rumination },
      this.cfg,
    );
    if (pick === null || pick.check.gain === null) return null;
    tick(
      this.s,
      {
        dtHours: 0,
        // P3-2b：dt=0 的即时结算不参与 A/B 通道；显式关掉，免得以后改默认值把出入侵变成耗电
        wakeDrain: false,
        energyRecovery: false,
        pressureGain: pick.check.gain.amount,
        ruminationAdd: pick.check.gain.ruminationAdd,
      },
      this.cfg,
    );
    this.lastIntrusionAt = now;
    return { memoryId: pick.memory.id, prob: pick.check.prob };
  }

  /**
   * §7.1 里程碑：破裂之后的补偿动作可以把关系「修回来一点」，且走捷径。
   *
   * 规格写了两条修补（B8 cap 永不 bind、B9 trust 一步到 1.0），`learning/learn.ts` 里
   * 早就按修好的公式实现了 `computeRepairDelta`——但它**一个调用者都没有**（V52-GAP M7-02）。
   * 结果：她的 bond 只会跟着 valence 慢慢爬（40 轮 0.0218），"吵完架被好好安慰一下"
   * 这件事在数值上一次都没发生过。
   *
   * 强度从哪来：规格的事件强度本应来自 appraisal，但那条通道在实现里被删了
   * （V52-GAP M5-04）。所以这里要求调用方**显式给强度**；不给就当作普通事件，
   * 不假装它是一次高强度修复。诚实地说：QQ 主路径目前不给强度，这条捷径在
   * 线上仍是「备着但很少触发」——等期望模型（Phase 3 后半）能评事件强度再接上。
   */
  private tryMilestone(
    eventType: string,
    intensity: number | undefined,
    now: number,
  ): { type: string; path: "milestone" | "queue_insight" | "no_op"; deltaBond: number; deltaTrust: number } | null {
    if (intensity === undefined) return null;
    if (this.ruptureAt === null || now - this.ruptureAt > REPAIR_WINDOW_MS) return null;
    const res = computeRepairDelta(
      { type: eventType, intensity },
      { progress: this.bondProgress, trust: this.s.trust, recentRupture: true },
      this.milestoneUsedFor,
      this.cfg,
    );
    if (res.path !== "milestone") return null;
    this.bondProgress = Math.min(1, Math.max(0, this.bondProgress + res.deltaBond));
    this.s = { ...this.s, trust: Math.min(1, Math.max(0, this.s.trust + res.deltaTrust)) };
    if (res.markUsedFor !== null) this.milestoneUsedFor[res.markUsedFor] = true;
    return { type: eventType, path: res.path, deltaBond: res.deltaBond, deltaTrust: res.deltaTrust };
  }

  /**
   * §8.2 污点清洗：`shouldClearTaint` 也是「实现了、判据四条、零调用者」（V52-GAP M8-02）。
   *
   * 判定顺序 2a→2b→2c→2d 由 memory/taint.ts 负责；这里只负责把现场信息喂进去：
   * - 2a「仍由不可信来源驱动」：破裂后若又写进来一条带污点的记忆，就还算被驱动着；
   * - 2b「有未消费的可信候选」：洞察管线还没接（derive_insight 未实现），所以没有候选
   *   ——污点候选本身不阻断（A11 死锁教训就写在那份文件的文件头里）；
   * - 2c 观察窗由 TAINT_WINDOW（86400 秒）管。
   *
   * 返回清掉了几项，供 advance/health 观察——清污不该是无声的。
   */
  clearTaintIfDue(now = this.clock.now()): number {
    const vars = Object.keys(this.s.taintMap);
    if (vars.length === 0) return 0;
    const windowMs = taintWindowMs(this.cfg);
    const tainted = this.store.active().filter((m) => m.retrieved_under_taint === true);
    let cleared = 0;
    const next: SState["taintMap"] = { ...this.s.taintMap };
    for (const name of vars) {
      const entry = next[name];
      if (entry === undefined || entry.state !== "tainted") continue;
      const decision = shouldClearTaint(name, {
        now,
        // 边界用 >=：标脏那一毫秒写进来的污点记忆也算"又被驱动"（严格 > 会让它漏网）
        drivenByUntrusted: tainted.some((m) => (m.created_at ?? 0) >= entry.since),
        candidates: [],
        varState: { state: entry.state, since: entry.since, sources: entry.sources },
        windowMs,
      });
      if (!decision.clear) continue;
      delete next[name];
      cleared += 1;
    }
    if (cleared > 0) this.s = { ...this.s, taintMap: next };
    return cleared;
  }

  obsess(memoryId: string, query: string): ObsessionCheck & { applied: boolean } {
    const m = this.store.get(memoryId);
    if (!m) throw new Error(`没有 id 为「${memoryId}」的记忆`);
    const tags = query
      .split(/[\s,，。]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 8);
    const res = obsessionTrigger(
      m,
      { tags, now: this.clock.now() },
      { valence: this.s.valence, rumination: this.s.rumination },
      this.cfg,
    );
    if (res.gain) {
      // immediate：当场结算，不等到下一个 tick（§4.6 immediate 白名单）。
      // tick() 就地改 s 并返回 trace，所以不重新赋值 this.s。
      tick(
        this.s,
        {
          dtHours: 0,
          wakeDrain: false,
          energyRecovery: false,
          pressureGain: res.gain.amount,
          ruminationAdd: res.gain.ruminationAdd,
        },
        this.cfg,
      );
      this.save();
    }
    return { ...res, applied: res.gain !== null };
  }

  /**
   * §6.3 知识新鲜度重算（睡眠时调用；也可被工具/测试直接调）。
   *
   * `computeFreshness` 是 v5.3 就写好的纯函数，但**从来没有调用者**（V52-GAP M6-05）：
   * 知识写入时 freshness 被拍成常量 1，此后不衰减 —— 半年前的视频和十分钟前的一样"新鲜"。
   * 这里把 EngineConfig 与 store 接起来：store 不知道配置，runtime 不知道半衰期表。
   */
  /**
   * 桥在「这句真的发出去了」之后调用：记下她刚讲出去的那条知识（v5.2 §10.4 入口）。
   *
   * 只认库里真有的 id——别处传进来一个拼错的 id 不该在 pending 里占位。
   */
  noteKnowledgeUsed(id: string): void {
    if (!this.knowledge.has(id)) return;
    this.pendingKnowledge.delete(id);
    this.pendingKnowledge.set(id, this.clock.now());
    while (this.pendingKnowledge.size > KNOWLEDGE_PENDING_MAX) {
      const oldest = this.pendingKnowledge.keys().next();
      if (oldest.done === true) break;
      this.pendingKnowledge.delete(oldest.value);
    }
  }

  /**
   * 拿这一轮读到的反应，给「上一轮讲出去」的知识结一次账（v5.2 §10.4）。
   *
   * - 看得懂的反应才结算；看不懂（null）就保持 pending，等下一次更明确的信号。
   * - 每条知识：`social_freshness` 增减（+0.2 / −0.1）后重算 `freshness`，
   *   检索打分与好奇缺口都会立刻看到这个变化。
   * - 超过一小时的 pending 直接丢掉，不追认。
   */
  private settleKnowledgeFeedback(reaction: string, now: number): void {
    const kind = classifySocialReaction(reaction);
    if (kind === null) return;
    for (const [id, at] of [...this.pendingKnowledge]) {
      if (now - at > KNOWLEDGE_FEEDBACK_WINDOW_MS) {
        this.pendingKnowledge.delete(id);
        continue;
      }
      const rec = this.knowledge.get(id);
      if (rec === undefined) {
        this.pendingKnowledge.delete(id);
        continue;
      }
      const social = applySocialDelta(typeof rec.social_freshness === "number" ? rec.social_freshness : 1, kind);
      let freshness = rec.freshness;
      try {
        freshness = computeFreshness(
          {
            knowledge_type: rec.knowledge_type,
            ingested_at: typeof rec.ingested_at === "number" ? rec.ingested_at : now,
            access_count: rec.access_count ?? 0,
            social_freshness: social,
          },
          now,
          this.cfg,
        );
      } catch {
        // 半衰期表缺这类：social_freshness 照样记，freshness 留原值
      }
      this.knowledgePort.put({ ...rec, social_freshness: social, freshness });
      this.pendingKnowledge.delete(id);
    }
  }

  refreshKnowledgeFreshness(now = this.clock.now()): number {
    return this.knowledge.recomputeFreshness((rec) => {
      try {
        return computeFreshness(
          {
            knowledge_type: rec.knowledge_type,
            ingested_at: typeof rec.ingested_at === "number" ? rec.ingested_at : now,
            access_count: rec.access_count ?? 0,
            social_freshness: rec.social_freshness ?? 1,
          },
          now,
          this.cfg,
        );
      } catch {
        // 半衰期表没有这一类（历史数据/自定义类型）：保留原值，不让一条坏类型废掉整轮
        return null;
      }
    });
  }

  /** 按 id 读一条记忆（只读快照，调用方不该拿到可变引用） */
  memoryById(id: string): MemoryRecord | undefined {
    return this.store.get(id);
  }

  conflict(id: string): ConflictResolution {
    const m = this.store.get(id);
    if (!m) throw new Error(`没有 id 为「${id}」的记忆`);
    return resolveConflict(m, { trust: this.s.trust });
  }

  now(): number {
    return this.clock.now();
  }

  /** 数据目录（只读门用它判断写锁归属；开发面只读，不暴露可写句柄） */
  dataDirectory(): string {
    return this.conf.dataDir;
  }

  /** 角色 id（心跳文件按它命名；同样只读用途） */
  characterId(): string {
    return this.conf.characterId;
  }

  /**
   * §10.2 好奇心目标 + §8.2 curiosity 污点。
   *
   * v5.4-P1 D13：`boredom` 已废弃，改由 `curiosityGap`（=1−coverage_freshness）驱动
   * 倒 U 动机；不传就跳过并写进 skipped，不在 S 层伪造第 14 个字段。
   */
  curiosity(opts: { curiosityGap?: number; coping?: number; contacts?: readonly Contact[] } = {}): CuriosityResult & {
    readonly tainted: boolean;
  } {
    // gap 没传就从知识库现算：覆盖越新、缺口越小；空库返回 undefined（跳过判据，不伪造数字）
    const gap = opts.curiosityGap ?? coverageGap(this.knowledge.all());
    const res = curiosityTargets({
      state: this.s,
      attachment: this.conf.attachment ?? DEFAULT_ATTACHMENT,
      ...(opts.contacts === undefined ? {} : { contacts: opts.contacts }),
      ...(gap === undefined ? {} : { curiosityGap: gap }),
      ...(opts.coping === undefined ? {} : { coping: opts.coping }),
    }, this.cfg);
    const t = taintForCuriosity(this.s.taintMap, res.targets, this.cfg, this.clock.now());
    if (t.tainted) {
      // 整对象替换保持"单一写入点"可审计：这里不逐字段赋值
      this.s = { ...this.s, taintMap: t.taintMap };
      this.save();
    }
    return { ...res, tainted: t.tainted };
  }

  /**
   * v5.4-P1 §4.9 阶段 0 的状态门阈值（qq 层不直接读配置，由这里给）。
   * 纯读取，不推进状态。
   */
  /** §4.9：队列是否为空（有入站事件正在处理时不主动开口） */
  queueEmpty(): boolean {
    return this.eventQueue.isEmpty;
  }

  proactiveGates(): { energyFloor: number; trustFloor: number; trustSafeMin: number; queueEmpty: boolean } {
    return {
      queueEmpty: this.eventQueue.isEmpty,
      energyFloor: knobNumber(this.cfg, "PROACTIVE_ENERGY_THRESHOLD"),
      trustFloor: knobNumber(this.cfg, "PROACTIVE_TRUST_FLOOR"),
      trustSafeMin: knobNumber(this.cfg, "TRUST_SAFE_MIN"),
    };
  }

  snapshot(): Record<string, unknown> {
    const th = thresholdsFrom(this.cfg);
    return {
      characterId: this.conf.characterId,
      turns: this.turns,
      mode: resolveMode(this.s, th),
      modeThresholds: th,
      state: { ...this.s },
      bond: {
        progress: round4(this.bondProgress),
        stage: this.stage(),
        quadrant: deriveBondCurve(
          (this.conf.attachment ?? DEFAULT_ATTACHMENT).anxiety,
          (this.conf.attachment ?? DEFAULT_ATTACHMENT).avoidance,
        ),
        attachment: { ...(this.conf.attachment ?? DEFAULT_ATTACHMENT) },
      },
      memory: { path: join(this.conf.dataDir, `memory-${this.conf.characterId}.ndjson`) },
      // §5.4 漂移也是「她的现状」的一部分：不给读出口，面板与 soul_state 就只能看到
      // 出生时那一组 OCEAN，等于「她慢慢变了却没人看得见」（F148 遗留）。
      ...(this.drift === null
        ? {}
        : { drift: { ocean: this.drift.ocean, history: this.drift.history, samples: this.traitSamples.length } }),
      clock: { now: this.clock.now(), localHour: this.clock.localHour() },
      // §2 A26：她最近一次带病工作（存储降级）——面板/健康检查要能看见"不是她不想说，是盘出问题"
      ...(this.lastDegrade === null ? {} : { lastDegrade: { ...this.lastDegrade } }),
    };
  }

  /**
   * 一轮对话：推状态 + 推进关系 + 写一条“用户说了什么”的记忆。
   *
   * 注意：这里**不生成台词**。composePrompt 只产出“怎么说”的提示，
   * 台词由调用方（DSH 里的 agent）写——这样插件不绑定任何 LLM 供应商。
   */
  turn(
    req: TurnRequest,
    opts: {
      source?: string;
      eventType?: string;
      audiencePresent?: number;
      /** 本轮实际采用的话术标签；不传就用 UCB 的建议 */
      strategy?: string;
      /** 玩家对这一轮的反应（五个结局名之一，或自然语言）；传了才学习 */
      reaction?: string;
      /**
       * 不把这一轮写进情景记忆。只给"端到端自检/通道测试"这类不是真对话的输入用：
       * 状态与关系照常推进（那才是要验的链路），但她的记忆里不该留下"我们拿她做测试"。
       */
      skipMemory?: boolean;
      /** 事件强度 0..1：只有给了强度，修复期的里程碑才可能触发（见 turnInner） */
      eventIntensity?: number;
    } = {},
  ): TurnText {
    this.eventQueue.push();
    try {
      return this.turnInner(req, opts);
    } finally {
      // 异常路径也要 pop，否则"忙"会永远为真、主动开口永久静默
      this.eventQueue.pop();
    }
  }

  /**
   * §7.2 预测：下一次同类型事件，她预期有多强。
   *
   * 样本均值来自最近 50 条同类动作，再叠加学到的偏置。预测必须在「这一轮记进去之前」算——
   * 用这一轮的真实强度去预测它自己，那是事后诸葛，落差永远为 0。
   */
  private predictIntensity(eventType: string): number {
    // 用精确预测（扫最近 50 条）而不是增量缓存：缓存为了省一次窗口扫描，代价是
    // "同类新样本不足 5 条时预测不更新"，而落差恰恰要靠新样本。50 条的代价可以忽略。
    const mean = this.expectationModel.predictIntensity(eventType, this.actionHistory);
    return clamp01(mean + (this.expectationBias[eventType] ?? 0));
  }

  /**
   * §7.2 记录一次真实发生的动作，并学这次的落差。
   *
   * 学到的落点是**期望偏置**，不是价值观权重：规格的 `learn(field, ...)` 里 field 指 value_shifts，
   * 那需要洞察管线（LLM 抽候选）才有语义，而现在洞察管线还没实现（V52-GAP M8-06）。
   * 公式用同一个 alpha × 预测误差；她先学会「你下次会怎么对我」，才谈得上改性格。
   */
  private recordAction(
    eventType: string,
    intensity: number,
    predicted: number,
  ): NonNullable<TurnText["expectation"]> {
    const sameType = this.actionHistory.filter((a) => a.type === eventType).length;
    const learned = learnDelta(intensity, predicted, sameType, this.bondProgress, this.cfg);
    const bias = this.expectationBias[eventType] ?? 0;
    this.expectationBias[eventType] = Math.max(
      -EXPECTATION_BIAS_MAX,
      Math.min(EXPECTATION_BIAS_MAX, bias + learned),
    );
    this.actionHistory.push({ type: eventType, intensity });
    if (this.actionHistory.length > EXPECTATION_HISTORY_MAX) this.actionHistory.shift();
    return { type: eventType, predicted, actual: intensity, error: intensity - predicted, learned };
  }

  private turnInner(
    req: TurnRequest,
    opts: {
      readonly source?: string;
      readonly eventType?: string;
      readonly audiencePresent?: number;
      readonly strategy?: string;
      readonly reaction?: string;
      readonly skipMemory?: boolean;
      /**
       * 事件强度 0..1（§7.1 里程碑的入口）。规格本应来自 appraisal，但那条通道在实现里被删了
       * （V52-GAP M5-04）；不给就当作普通事件，不假装它是一次高强度修复。
       */
      readonly eventIntensity?: number;
    } = {},
  ): TurnText {
    // P3-2b：对方的消息就是「叫醒」信号——睡眠状态机允许它覆盖最短睡眠窗。
    // 先推进一次相位（如果她在睡，这里会走到 waking），再照常跑这一轮。
    this.peerMessagedAt = this.clock.now();
    this.sleepState();
    // §7.4：反应永远记在**上一轮**的策略头上——这一轮还没发生，谈不上奖励
    const reaction = opts.reaction;
    let scored = false;
    if (reaction !== undefined && reaction.trim() !== "" && this.prevStrategy !== null) {
      const rec = recordOutcome(
        this.bandit,
        { contextTag: this.prevStrategy.contextTag, actionTag: this.prevStrategy.actionTag, reaction },
        this.cfg,
      );
      this.bandit = rec.state;
      scored = true;
    }

    // §10.4：这条 reaction 也决定「上一轮讲出去的知识」还算不算新鲜。
    // 放在这里（bandit 之后、runTurn 之前）：社交反馈与策略记分看的是同一份信号。
    if (reaction !== undefined) this.settleKnowledgeFeedback(reaction, this.clock.now());

    const ctx: TurnContext = {
      clock: this.clock,
      characterId: this.conf.characterId,
      channel: "gui",
      source: opts.source ?? "player",
      eventType: opts.eventType ?? "conversation",
      eventTypeCount: this.eventTypeCounts[opts.eventType ?? "conversation"] ?? 0,
      ...(opts.audiencePresent === undefined ? {} : { audiencePresent: opts.audiencePresent }),
      bondProgress: this.bondProgress,
      attachmentAnxiety: (this.conf.attachment ?? DEFAULT_ATTACHMENT).anxiety,
    };

    // §6.8 自动闯入：先让那条记忆绊她一下（改 pressure/rumination），再走这一轮。
    // 放在 runTurn 之前是必须的——闯入要影响"这一轮她是什么状态"，而不是下一轮。
    const intrusion = opts.skipMemory === true ? null : this.autoIntrude(req.text, this.clock.now());

    // §7.2 先预测，再走这一轮（顺序反了就成了「用结果预测结果」）。
    // 强度来源：soul_turn 显式给就用给的；否则取 appraisal.goal_relevance——
    // 规格的事件强度通道在实现里被删了（V52-GAP M5-04），goal_relevance 是「这件事对你有多重」
    // 最接近的代理，且是 0..1 同一量纲。
    const eventType = opts.eventType ?? "conversation";
    const intensity = clamp01(opts.eventIntensity ?? req.appraisal.goal_relevance);
    const predicted = this.predictIntensity(eventType);

    const before = this.bondProgress;
    const trustBefore = this.s.trust;
    // §8.2（F158）：记下"影响检索"的那几个量，这一轮结束后看谁真的被推动了
    const taintBefore = this.retrievalVarSnapshot();
    const result = runTurn(req, this.s, ctx, this.cfg);
    // P3-2b：B 通道——这一轮真的发生了，按 ENERGY_COST_TURN 扣一次电。
    // 必须放在 runTurn 之后：runTurn 自己的 tick 已经显式关掉 A/B（见 turn.ts），
    // 否则每轮会重复扣掉那 5 分钟的时间耗散。
    this.spendEnergy(energyCostFor(this.cfg, "turn"));
    // §4.1 计数在「本轮生效之后」+1，保证首轮 γ=1
    const et = ctx.eventType;
    this.eventTypeCounts[et] = (this.eventTypeCounts[et] ?? 0) + 1;

    // §7.1 破裂 → 修复期：trust 这一轮掉够多，就进入 24 小时修复窗（新破裂重置已用里程碑）
    const trustDrop = this.s.trust - trustBefore;
    if (trustDrop <= -RUPTURE_TRUST_DROP) {
      this.ruptureAt = this.clock.now();
      this.milestoneUsedFor = {};
    }
    const repair = this.tryMilestone(et, intensity, this.clock.now());
    const expectation = this.recordAction(et, intensity, predicted);

    // 关系推进：档位速率按“当前阶段的下一档”取（PACING_RATE 是分段速率，不是累计平均）
    // A2 归一化零点分离（2026-11-01 规格评审）：锚点=情绪基线（VALENCE_ANCHOR），零点=推进门槛（BOND_DRIVE_ZERO）。
    const stage = stageOf(this.bondProgress, stageBands(this.cfg));
    const rate = rateForNextStage(stage, pacingRates(this.cfg));
    this.bondProgress = updateBondProgress(
      this.bondProgress,
      this.s.valence,
      rate,
      valenceAnchor(this.cfg),
      bondDriveZero(this.cfg),
    );
    this.turns += 1;
    // §5.4 人格漂移的行为证据：记在这一轮**生效之后**，否则记的是上一轮。
    this.recordTraitSample();

    // §8.2 新污染标记（F158 / M8-04 数据侧）：这一轮的来源不可信、且真的推动了某个
    // "影响检索"的状态量（愉悦/唤醒/熵/嫉妒），就把它标脏——脏着的时候想起来的记忆会被
    // 永久打 retrieved_under_taint（F154），下游洞见也会被拒（F154 的三条路径）。
    const taintAdded = this.applyUntrustedTaint(taintBefore, ctx.source);

    // 策略：候选为空/首轮都回退到固定话术，绝不返回空串
    // 没有历史时用情境默认动作（G5-②）：规格引用 archetype.default_strategy 但无 archetype 表，
    // 这里是最小可执行替身，且回退值必须是 ACTION_TYPES 里的合法动作。
    const choice = selectStrategy(this.bandit, ctx.eventType ?? "conversation", defaultStrategyFor(ctx.eventType ?? "conversation", this.cfg));
    const actionTag = opts.strategy ?? choice.actionTag;
    this.prevStrategy = { contextTag: ctx.eventType ?? "conversation", actionTag };

    // 记忆打上情境标签，睡眠巩固时才能在同一个 tag 下聚成簇
    // skipMemory：自检消息照常推状态/关系，但不入库（见 memory-hygiene.ts 顶部说明）
    // §2 A26 降级：存储出错不许把这一轮打断。
    // 两条路都可能抛：记忆写不进（磁盘满/WAL 坏）与状态存不下（同样的盘问题）。
    // 丢一条记忆可以接受；让对方看到"她不说话了"不可接受。
    let memory: { wrote: number; rejected: number } = { wrote: 0, rejected: 0 };
    let degraded: string | undefined;
    if (opts.skipMemory !== true) {
      try {
        memory = this.appendMemory(req.text, opts.source ?? "player", result.mode, [ctx.eventType ?? "conversation"]);
      } catch (err) {
        degraded = `memory: ${messageOf(err)}`;
        this.noteDegrade("memory", err, this.clock.now());
      }
    }
    try {
      this.save();
    } catch (err) {
      degraded = degraded === undefined ? `save: ${messageOf(err)}` : `${degraded}; save: ${messageOf(err)}`;
      this.noteDegrade("save", err, this.clock.now());
    }

    // §1.2 INV-2：把这一轮的"为什么"记进 trace（攒批落盘，不在对话路径上）。
    // 放在 appendMemory 之后：记忆真的写了没有，也是要反查的事实之一。
    const tracedAt = this.clock.now();
    let traceId: string | undefined;
    if (this.traceLog !== null) {
      this.traceSeq += 1;
      traceId = `tr-${tracedAt.toString(36)}-${this.traceSeq.toString(36)}`;
      this.traceLog.record({
        at: tracedAt,
        traceId,
        kind: "turn",
        eventType: et,
        source: ctx.source,
        intensity,
        predicted,
        error: expectation.error,
        learned: expectation.learned,
        mode: result.mode,
        strategy: this.prevStrategy?.actionTag ?? null,
        intrusion: intrusion?.memoryId ?? null,
        repair: repair?.type ?? null,
        tainted: taintAdded,
        memoryWrote: memory.wrote,
        degraded: degraded ?? null,
        pressureGain: result.pressureGain,
        affectionDelta: result.affection.delta,
        valence: this.s.valence,
        pressure: this.s.pressure,
        maskIntegrity: this.s.maskIntegrity,
      });
    }

    const expression = styleFor(
      this.conf.attachment ?? DEFAULT_ATTACHMENT,
      this.bondProgress,
      stageBands(this.cfg),
    );
    const eventStyle = eventStyleFor(ctx.eventType, result.mode);
    const stageStyle = this.conf.persona?.stageStyle;
    // 动机层：状态是刚 tick 过的（runTurn 之后），所以"现在想说什么"按此刻算
    const wonder = this.wonder();
    const style = composePrompt({
      ...result.hints,
      expression,
      wonder,
      ...(stageStyle === undefined ? {} : { stageStyleOverride: stageStyle }),
    });
    const bondMoved = Math.abs(this.bondProgress - before) > 1e-12;
    if (this.conf.trace && bondMoved) {
      // 关系变动不写记忆，只有显式日志意义；保留分支便于排查“为什么阶段没动”
    }

    return {
      mode: result.mode,
      stage: result.hints.stage,
      bondProgress: this.bondProgress,
      state: this.s,
      style,
      expression,
      eventStyle,
      memory,
      bandit: { ...choice, actionTag, scored },
      wonder,
      ...(intrusion === null
        ? {}
        : { intrusion: { memoryId: intrusion.memoryId, prob: intrusion.prob } }),
      ...(repair === null
        ? {}
        : { repair: { type: repair.type, deltaBond: repair.deltaBond, deltaTrust: repair.deltaTrust } }),
      expectation,
      ...(traceId === undefined ? {} : { traceId }),
      ...(degraded === undefined ? {} : { degraded }),
    };
  }

  /** 最近一次降级记录（没有就是 null）；面板/健康检查用 */
  lastDegradeRecord(): DegradeRecord | null {
    return this.lastDegrade;
  }

  /** 记下这次降级：只留档 + 让调用方拿到字符串，不抛、不重试（重试留给下一轮） */
  private noteDegrade(kind: string, err: unknown, at: number): void {
    this.lastDegrade = { at, kind, detail: messageOf(err) };
  }

  /** 当前人格卡（未配置时为 null）；工具面用它回报"她现在是谁" */
  persona(): Persona | null {
    return this.conf.persona ?? null;
  }

  /** §6.6 预筛诊断：让「被截掉多少条」变成可观察的事实，而不是暗中发生的性能优化 */
  prefilterInfo(query: string): { poolSize: number; dropped: number; obsessionAdded: number; candidates: number } {
    const pre = prefilter(this.store.active(), query, this.cfg, ALL_CHANNELS);
    return { poolSize: pre.poolSize, dropped: pre.dropped, obsessionAdded: pre.obsessionAdded, candidates: pre.candidates.length };
  }

  /**
   * 检索：把用户这句话当查询，命中记忆按 §6.6 权重打分。
   *
   * 第三参数是 §8.3 隐私隔离（F156）：**先按访客身份裁掉看不见的记录**，再打分。
   * 不是「打完分再隐藏」——看不见的记录连预筛都不进，否则它仍会影响 poolSize/排名。
   */
  /**
   * §5.4 再巩固的读取端：把版本链里最新的那句解释带上，供 recall 追加在原文后面。
   * 文件不存在/坏掉就返回空表——宁可不带后记，也不拿半份链乱拼（错误静默，但不会污染记忆本体）。
   */
  private interpretations(): InterpretationMap {
    const path = interpretationsFilePathInDataDir(this.conf.dataDir, this.conf.characterId);
    try {
      const raw = readFileSync(path, "utf8");
      return interpretationsFromRaw(raw).interpretations;
    } catch {
      return new Map();
    }
  }

  recall(
    query: string,
    limit?: number,
    visitor: Visitor = OWNER_VISITOR,
    channel?: string,
  ): readonly RecallRow[] {
    const tags = query
      .split(/[\s,，。]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 8);
    // §8.3：访客只能看到愿意分享的 / 他自己的对话；主人看到全部。
    const active = visibleTo(this.store.active(), visitor);
    // §6.6 第一行：top-k 语义预筛（G6-⑥），上万条时把 rerank 成本钉在常数上。
    // F199：这里**不按渠道分区**。原实现用「调用方渠道 ?? gui」过滤，一旦写入侧开始
    // 写真实渠道（qq/web/…），QQ 回合就只查 qq 分区（看不见插件里写的记忆）、工具面又
    // 只查 gui 分区（看不见 QQ 记忆）——同一个人格被一个输入端口切成两半。
    // 分区本身是索引优化；本机只有一个人格、一个 store，连续性比省那点扫描更重要。
    // 渠道仍会传给下面的线索重排（buildRecallCue），只影响「按写时指纹加权」，不影响可见性。
    const pre = prefilter(active, query, this.cfg, ALL_CHANNELS);
    const pool = pre.candidates;
    const qctx: QueryContext = {
      tags,
      // §6.6 semantic 分量：每次召回现算（emb 不在 §6.2 的 27 字段里，见 semantic.ts 的说明）
      semantic: semanticScores(query, pool),
      state: { valence: this.s.valence, arousal: this.s.arousal, entropy: this.s.entropy },
      now: this.clock.now(),
    };
    const scored = retrieve(pool, qctx, this.cfg);
    // §8.2 路径 2 的另一半（F154）：规格说的是"这条记忆**在污染下**被检索过"，
    // 不只是"它自己来源脏"。这一轮想起来的记忆会被永久打标（retrieved_under_taint 只读、永不清），
    // 这样她"带着脏状态想到的事"不能反过来晋升成信念。
    // F157（M8-04）：但"脏"不是所有状态量都算——只有 RETRIEVAL_AFFECTING_VARS 里那几个
    // （嫉妒/愉悦度/唤醒度/熵）的污点才影响检索；好奇心污点只影响洞见血统，见 memory/taint.ts。
    const stateTainted = hasRetrievalTaint(this.s.taintMap, this.cfg);
    const byId = new Map(pool.map((m) => [m.id, m] as const));
    // §5.6 线索重合：只在调用方告诉了我们「此刻在哪、眼前是谁」时才做二次排序；
    // 没传 channel（DSH 工具面、测试、脚本）走原始顺序，行为与以前逐位一致。
    // 这里只重排、只改呈现的 score，`retrieve.ts` 的冻结打分一行没动。
    const cue = channel === undefined ? undefined : buildRecallCue({
      channel,
      participants: visitor.owner ? ["用户"] : [],
      valence: this.s.valence,
    });
    const cueRanked: readonly CueRankedRow[] | undefined =
      cue === undefined ? undefined : rankByCue(scored, byId, cue);
    const rows: RecallRow[] = [];
    // F207：读一次再巩固版本链，循环里只查 map（不是每条记忆读一次文件）
    const interpretations = this.interpretations();
    const now = this.clock.now();
    const boost = knobNumber(this.cfg, "RETRIEVAL_VIVIDNESS_BOOST");
    const ranked: readonly { readonly id: string; readonly score: number }[] =
      cueRanked ?? scored.map((item) => ({ id: item.id, score: item.score }));
    for (const sc of ranked) {
      const rec = byId.get(sc.id);
      if (rec === undefined) continue;
      // §6.5 on_retrieve：想起来的次数越多，细节越清晰（上限 1）；
      // 同时按蔡格尼克效应更新 unresolved_score：情绪同向的回忆会"记着没完"。
      const encodedValence = rec.encode_state["valence"];
      const aligned =
        typeof encodedValence === "number" &&
        Number.isFinite(encodedValence) &&
        Math.sign(encodedValence - 0.5) === Math.sign(this.s.valence - 0.5);
      // §4.2 on_retrieve：必须走 store.touch()，它同时抬升 base_activation——
      // 只在这里手写 access_count/last_accessed 会让 ACT-R 激活永远停在 0，记忆迟早全冷掉。
      this.store.touch(rec.id, now);
      // 她说出去的话不该被"回忆"成心事：proactive/selftalk/chat_reply 是已经说出口的产物，
      // 再对这些记忆累加 unresolved_score 会把自己的回音变成"没聊完的事"，与 replay 端同一处边界。
      const selfAuthored = isSelfAuthored(rec.source);
      this.store.mutate(rec.id, {
        vividness: Math.min(1, rec.vividness + boost),
        // 参数名是 resolvedNow：同向回忆是"又想起一次、还没想完"，所以传 !aligned
        unresolved_score: selfAuthored
          ? (rec.unresolved_score ?? 0)
          : updateUnresolved(rec, !aligned, 0, this.cfg),
      });
      let underTaint = rec.retrieved_under_taint;
      if (stateTainted && underTaint !== true) {
        this.store.markRetrievedUnderTaint(rec.id);
        underTaint = true;
      }
      rows.push({
        id: rec.id,
        score: round4(sc.score),
        semantic: round4(qctx.semantic[rec.id] ?? 0),
        content: withInterpretation(rec.content, interpretations.get(rec.id)),
        tags: rec.tags,
        underTaint,
        // task-169 A：素材过滤在调用侧做，这里只把来源如实透传（检索内核不动）。
        source: rec.source,
      });
      if (limit !== undefined && rows.length >= limit) break;
    }
    return rows;
  }

  /** 记忆 id：时间 + 进程内序号 + 4 位随机（随机空间 1.68M，且序号保证同毫秒内不撞） */
  private memoryId(now: number): string {
    const seq = (this.idSeq += 1).toString(36);
    const salt = Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, "0");
    return `m${now.toString(36)}${seq}${salt}`;
  }

  /** 显式写入一条记忆；来源不可信时会被防火墙打污点（不拒绝） */
  remember(input: {
    content: string;
    source?: string;
    tags?: string[];
    vividness?: number;
    selfRelevance?: number;
    /** §8.3 shared_self：只有主人能打这个标；打了才允许出现在访客的检索里 */
    allowShare?: boolean;
    /**
     * P2a：这句话的方向（谁说的）。soul_remember 的调用方通常不知道，不传 = 缺键 = unknown；
     * 主动开口的记忆由 close-loop 的 spokenMemorySeed 带 outbound。
     */
    direction?: "inbound" | "outbound";
    /**
     * P2a：装配层知道"这一拍她想做什么"时按需传入；插件/宿主路径拿不到就缺键 = unknown。
     */
    goalAtTime?: string;
    goalId?: string;
  }): { stored: boolean; reason: string; id: string } {
    const now = this.clock.now();
    const source = input.source ?? "player";
    // F197：显式记忆（soul_remember）也写情境指纹——它的来源通常是用户本人，
    // 只知道渠道 gui、不知道意图，所以 goal_at_time 同样诚实地标 unknown。
    // 以前这条路径只写 {channel:"gui"}，导致这些记忆在 F196 的线索重排里永远拿不到乘数。
    const tags = input.tags === undefined ? [] : [...input.tags];
    const channel = channelForSource(source);
    const episode = buildEpisodeWrite({
      text: input.content,
      source,
      channel,
      mode: "NORMAL",
      tags,
      valence: this.s.valence,
      arousal: this.s.arousal,
      createdAtMs: now,
      // P2a：本地小时用于 cue_fingerprint.timeOfDay（brain 不读时钟，由装配层给）
      localHour: this.clock.localHour(),
      // P2a：显式记忆不知道方向时就不写这个键（缺键 = unknown），不伪造
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      // P2a：意图上下文同理——装配层知道才传，否则 buildEpisodeWrite 自己标 unknown
      ...(input.goalAtTime === undefined ? {} : { goalAtTime: input.goalAtTime }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    });
    const rec = makeMemory({
      id: this.memoryId(now),
      content: input.content,
      source,
      created_at: now,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.vividness === undefined ? {} : { vividness: input.vividness }),
      ...(input.selfRelevance === undefined ? {} : { self_relevance: input.selfRelevance }),
      ...(input.allowShare === true ? { allow_share: true } : {}),
      participants: [...episode.participants],
      encode_ctx: { channel, mode: "NORMAL", ...episode.encodeCtx },
      encode_state: { valence: this.s.valence, arousal: this.s.arousal },
      source_chain: [source],
    });
    const res = this.store.write(rec, now);
    if (res.stored) this.applySuppression(rec.id);
    this.save();
    return { stored: res.stored, reason: res.reason, id: rec.id };
  }

  /**
   * 离线推进：按 tickHours 分步跑 tick，避免“一次跳 24h”把松弛算成一步。
   * 上限 7 天——再多说明调用方在拿它当时间机器，应当走迁移脚本。
   *
   * P3-2b（task-57 B2，责任反转）：这里只做**能量 tick + 醒着分支（awake/drowsy/waking）
   * 的跨睡点巩固**——不做相位转移、不自己判断 asleep。相位由装配层的 `sleepState()`
   * 每拍推进；真的睡着时装配层会改走 `sleepAdvance()`，不会再调本方法。
   * `wakeDrain` 由调用方按相位决定（只有 awake 才扣 A），缺省 true 保持工具/脚本的旧行为。
   */
  advance(hours: number, opts: { readonly wakeDrain?: boolean } = {}): {
    steps: number;
    pressure: number;
    energy: number;
    mask: number;
    sleep: {
      count: number;
      hour: number;
      ran: boolean;
      clusters: number;
      written: number;
      accepted: readonly string[];
      archived: number;
    } | null;
    faded: number;
    forgotten: number;
    /** 这一拍清掉了几个污点变量（§8.2）；0 是常态，非 0 说明洗白窗口真的到了 */
    taintCleared: number;
  } {
    if (!Number.isFinite(hours) || hours <= 0) throw new RangeError("hours 必须是正的有限数");
    const dt = tickHours(this.cfg);
    const steps = Math.min(Math.round(hours / dt), Math.round((7 * 24) / dt));
    // 区间起点 = 推进前的小时数；模拟时钟随后被推进，生产时钟交给真实时间
    const t0 = this.clock.now();
    const startHour = this.clock.localHour() + (t0 % 3_600_000) / 3_600_000;
    // P3-2b（task-57 B2）：这里不再逐算睡眠相位——醒着分支不判 asleep，A 通道是否扣
    // 由调用方按当前相位传 wakeDrain（只有 truly awake 才扣）。睡眠步进走 sleepAdvance。
    for (let i = 0; i < steps; i += 1) {
      tick(this.s, { dtHours: dt, wakeDrain: opts.wakeDrain ?? true, energyRecovery: true }, this.cfg);
    }

    // 记忆褪色按"推进了几天"一次结算（§6.5），不随每 5 分钟 tick 写盘；
    // 放在时钟推进前，保证顺序是「先褪色、再按褪色后的结果归档」（F29 的归档判据吃 vividness）
    const fade = this.fade(hours / 24);

    // §8.2 污点清洗：用推进前的时刻判窗口（保守），清污不写记忆、只改 S 层
    const taintCleared = this.clearTaintIfDue();

    // 模拟时钟随后被推进；生产时钟交给真实时间
    if (this.clock.simulated === true) this.clock.advance(hours * 3_600_000);
    const now = this.clock.now();
    // P4-1（task-74 B1）：醒着分支只 fade 了本次 `hours`，所以锚点也只能前移 `hours`，
    // 不能设成 now——否则「不跨睡点的睡眠」和「<20h 重启 downtime」这段没 fade 过的
    // 时间会被锚点跳过、永久丢失（supervisor task-70 B1）。锚点语义 = 已 fade 覆盖到的
    // 时间点；未覆盖的间隙留给下一次 sleepFade 的 (now-lastFadeAt) 自然补上。
    // 首拍回退链（task-57）：锚点 null 时不动，留给第一次睡眠走「只写锚点、不补扣」，不造 NaN。
    if (this.lastFadeAt !== null) this.lastFadeAt += hours * 3_600_000;
    const sleepHour = sleepHourFor(this.conf.characterId, this.cfg);
    const crossing = crossedSleeps(startHour, hours, sleepHour);

    let sleep: {
      count: number;
      hour: number;
      ran: boolean;
      clusters: number;
      written: number;
      accepted: readonly string[];
      archived: number;
    } | null = null;
    if (crossing.count > 0) {
      // 一个睡点只巩固一次：距上次巩固不足 20 小时说明这段时间内已经整理过了
      const already = this.lastSleepAt !== null && now - this.lastSleepAt < 20 * 3_600_000;
      if (already) {
        sleep = { count: crossing.count, hour: sleepHour, ran: false, clusters: 0, written: 0, accepted: [], archived: 0 };
      } else {
        const res = this.consolidate();
        this.lastSleepAt = now;
        // 巩固之后顺手做冷归档：睡着的时候整理，醒了不丢东西（只搬不删，F29）
        const cold = this.archiveCold();
        sleep = {
          count: crossing.count,
          hour: sleepHour,
          ran: true,
          clusters: res.clusters,
          written: res.written,
          accepted: res.accepted,
          archived: cold.archived,
        };
      }
    }
    this.save();
    return {
      steps,
      pressure: round4(this.s.pressure),
      energy: round4(this.s.energy),
      mask: round4(this.s.maskIntegrity),
      sleep,
      faded: fade.faded,
      forgotten: fade.forgotten,
      taintCleared,
    };
  }

  /**
   * P3-2b（task-57 B2/B4）：睡着分支的时间推进——只做能量恢复 tick，不扣 A 通道。
   *
   * 为什么单独一条：装配层每拍先 `sleepState()` 判相位，asleep 时不能再调 `advance`
   * （那会用 wakeDrain 扣电，且会重复做跨睡点巩固）。这里只「恢复 + 睡着分支的跨睡点
   * 巩固」，醒来/入睡的相位转移仍由 sleepState() 负责。
   *
   * 夜间巩固：旧路径靠 `advance` 在跨睡点后 consolidate；改走本方法后若不做这件事，
   * 「睡着时跨过每日睡点」就永远不巩固了。去重口径与 advance 一致（距上次巩固 < 20h
   * 视为本睡点已整理过）；`lastSleepAt` 只做这个 20h 去重，**不写回** `sleep.lastSleepMs/
   * wokeAtMs`（那是入睡/醒来的时刻，见 task-57 C）。
   *
   * P4-1（task-69）：跨睡点巩固之后接确定性 SWS 三件（每睡点一次、不耗模型额度）——
   * fade（按 `lastFadeAt` 锚点补夜间衰减）→ archiveCold（只搬不删）→（按阈）WAL compact
   * → hardDelete 候选报告（只报 purgeable、不自动删）。任何一件失败只写进返回值里的
   * error，**不阻断能量恢复**，也不重试本夜。
   *
   * 已知边界（supervisor B，不改行为）：daemon 在跨睡点期间重启会漏一次；F317 的启动
   * 补巩固由 `backfillSleepWork()` 兜（只补 deterministic，不补模型功课）。
   *
   * F340（task-179）：她的真实睡眠段未必跨 03:00（由能量驱动，常在 10:35 后入睡），
   * 此时 crossing.count=0、旧路径永不触发。因此装配层传入 `opts.episodeMs`（=asleepSince）：
   * 入睡后首拍直接走 `runEpisodeWork`，一次/睡眠段；episode key 持久化，跨重启去重。
   */
  sleepAdvance(dtHours: number, opts?: { readonly episodeMs?: number }): SleepAdvanceResult {
    if (!Number.isFinite(dtHours) || dtHours <= 0) throw new RangeError("dtHours 必须是正的有限数");
    const now = this.clock.now();
    const startHour = this.clock.localHour() + (now % 3_600_000) / 3_600_000;
    // 睡眠只恢复：A 通道（wake drain）停，B 通道由调用方在认知事件发生时另扣。
    tick(this.s, { dtHours, wakeDrain: false, energyRecovery: true }, this.cfg);
    // 恢复后的能量可能已经满足「最短窗 + wakeEnergy」——让相位跟上（迁移时自己落盘）。
    this.sleepState();
    const sleepHour = sleepHourFor(this.conf.characterId, this.cfg);
    const crossing = crossedSleeps(startHour, dtHours, sleepHour);
    let result: SleepAdvanceResult = emptySleepAdvance();
    const episodeMs = opts?.episodeMs;
    if (
      typeof episodeMs === "number" &&
      Number.isFinite(episodeMs) &&
      episodeMs > 0 &&
      this.sleep.lastSleepWorkEpisode !== episodeMs
    ) {
      // F340（task-179）：真实入睡后的首拍——不看 03:00 跨点、也不受 20h lastSleepAt 影响；
      // 去重靠 episode key（= 本段 asleepSince），同一段睡眠最多做一次。
      result = this.runEpisodeWork(episodeMs, now, "onset");
    } else if (crossing.count > 0) {
      const already = this.lastSleepAt !== null && now - this.lastSleepAt < 20 * 3_600_000;
      const episode = this.sleep.asleepSince;
      // F340：crossing 旧路径复用同一 helper（先写 key 再工作）；若本段已被 onset 做过
      // （key 相等），crossing 不能再跑一次。
      const episodeDone = episode !== null && this.sleep.lastSleepWorkEpisode === episode;
      if (!already && !episodeDone) {
        result = this.runEpisodeWork(episode, now, "crossing");
      }
    }
    this.save();
    return result;
  }

  /**
   * F340（task-179）：一段睡眠的夜间功课——一次/睡眠段，at-most-once。
   *
   * 顺序是规格 v3 的硬要求：**先写 episode key + lastSleepAt 并 save()，再跑
   * consolidate + sleepWork**。这样「落 key 后崩溃」只会少做一次（不重放 fade）：
   * 失败（work.error 或 consolidate 抛）也保留 key，本段不重试。
   * `consolidated` 收窄为 `work.error === null`——sleepWork 内部 catch 只回 error 不抛，
   * 不能靠「是否抛错」判成功（否则 error 夜仍会调度 dream）。
   */
  private runEpisodeWork(
    episodeMs: number | null,
    nowMs: number,
    trigger: "onset" | "crossing",
  ): SleepAdvanceResult {
    if (episodeMs !== null) this.sleep = { ...this.sleep, lastSleepWorkEpisode: episodeMs };
    this.lastSleepAt = nowMs;
    this.save();
    try {
      const res = this.consolidate();
      const work = this.sleepWork(nowMs);
      // F340/B1：work 后显式落盘（`sleepFade` 在 work 里更新 `lastFadeAt`）。不能依赖
      // `archiveCold()` 的副作用——它只在本次真搬走记忆时才 `save()`（runtime.ts 冷归档），
      // 无冷归档时磁盘仍是旧锚点，重启后下一段会从旧锚点重复 fade、重复扣 vividness。
      this.save();
      return {
        consolidated: work.error === null,
        trigger,
        clusters: res.clusters,
        written: res.written,
        archived: work.archived,
        fade: work.fade,
        compact: work.compact,
        purgeable: work.purgeable,
        purgeableIds: work.purgeableIds,
        error: work.error,
      };
    } catch (err) {
      // 巩固抛错：key/锚点已经落盘，本段不重试；只把 error 带回去给装配层观测。
      // 同样显式 save：若 `sleepFade` 已改过 `lastFadeAt` 再抛错，也要落盘，避免重放。
      this.save();
      return { ...emptySleepAdvance(), trigger, error: messageOf(err) };
    }
  }


  /**
   * P4-1（task-69）：启动补巩固（F317）——deterministic only。
   *
   * 什么时候补：`lastSleepAt` 距 now > 20h，且这段时间里**跨过至少 1 个每日睡点**
   * （daemon 在睡点期间重启会让 `sleepAdvance` 错过那次巩固）。补什么：一次
   * consolidate + archiveCold + fade/compact（即 `sleepWork`），并把 `lastSleepAt=now`；
   * **不补 dream/habit/SelfModel**——它们按 nightKey 记账，错过的一夜就是错过，
   * 补跑只会变成「白天做梦」+ 预算错位。
   *
   * 幂等（F340/task-179）：episode key 与 onset 同口径——当时睡着写 `asleepSince`、
   * 醒着写 `lastSleepMs`；key 已等于该 episode → `already-worked` 跳过。补做顺序也与
   * onset 一样：**先写 key+lastSleepAt+save，再 consolidate+sleepWork**；失败/崩溃保留
   * key、本段不重试（at-most-once），结果 `consolidated = work.error === null`。
   * 无 episode（lastSleepMs/asleepSince 为 null/0）→ `no-episode` 跳过、不写假 key。
   * 异常不抛——由 `runEpisodeWork` 内部 catch 带回 error，装配层只打 degraded 日志，启动照常。
   */
  backfillSleepWork(): SleepBackfillResult {
    const base: SleepBackfillResult = {
      ...emptySleepAdvance(),
      ran: false,
      reason: "no-anchor",
      missed: 0,
    };
    const now = this.clock.now();
    // F340：episode 与 onset 同口径——睡着写 asleepSince、醒着写 lastSleepMs；
    // 两者拿不到（null/非有限/≤0）时标 no-episode，绝不写 0/假值。
    const episode = this.sleep.phase === "asleep" ? this.sleep.asleepSince : this.sleep.lastSleepMs;
    if (episode === null || !Number.isFinite(episode) || episode <= 0) {
      return { ...base, reason: "no-episode" };
    }
    if (this.sleep.lastSleepWorkEpisode === episode) {
      return { ...base, reason: "already-worked" };
    }
    if (this.lastSleepAt === null) return base;
    const elapsedHours = (now - this.lastSleepAt) / 3_600_000;
    if (elapsedHours <= 20) return { ...base, reason: "recent" };
    const sleepHour = sleepHourFor(this.conf.characterId, this.cfg);
    const crossing = crossedSleeps(this.localHourAt(this.lastSleepAt), elapsedHours, sleepHour);
    if (crossing.count === 0) return { ...base, reason: "no-crossing" };
    // 与 onset 同一顺序（先 key+lastSleepAt+save，再工作）：backfill 崩溃/失败也不重放。
    const work = this.runEpisodeWork(episode, now, "crossing");
    return {
      ...work,
      ran: true,
      reason: "ran",
      missed: crossing.count,
    };
  }

  /**
   * P4-1：一次睡点的确定性工作。顺序按规格 §6.2：fade → archiveCold → compact → 候选报告。
   * 四步各自 try/catch：任何一步失败都不让后面的步骤和能量恢复陪葬。
   */
  private sleepWork(nowMs: number): SleepWorkResult {
    const fade = this.sleepFade(nowMs);
    let archived = 0;
    let error: string | null = null;
    // task-74 B2：fade 失败也要进聚合 error——否则 [sleep-work] 会打 error=null，
    // 而 fade.error 只留在嵌套对象里，7 天观察看不到「这一夜 fade 挂了」。
    if (fade.error !== null && error === null) error = fade.error;
    try {
      archived = this.archiveCold().archived;
    } catch (err) {
      error = messageOf(err);
    }
    const compact = this.sleepCompact();
    if (compact.error !== null && error === null) error = compact.error;
    // hardDelete：P4-1 只产候选报告（purgeable 计数 + 前 N 个 id），不自动删——不可逆操作留给显式触发。
    let purgeable = 0;
    let purgeableIds: string[] = [];
    try {
      purgeable = this.cold.stats(nowMs, this.cfg).purgeable;
      if (purgeable > 0) {
        const retention = knobNumber(this.cfg, "HARD_DELETE_RETENTION_DAYS") * DAY_MS;
        purgeableIds = this.cold
          .all()
          .filter((entry) => nowMs - entry.archived_at >= retention)
          .map((entry) => entry.record.id)
          .slice(0, PURGEABLE_ID_LIMIT);
      }
    } catch (err) {
      if (error === null) error = messageOf(err);
    }
    return { fade, archived, compact, purgeable, purgeableIds, error };
  }

  /**
   * P4-1：按「距上次 fade 多少天」补一次夜间衰减（每个睡点一次）。
   *
   * 锚点回退链：`lastFadeAt → lastSleepAt → processStartedAt`；`days` clamp 到 0–7。
   * **升级首跑只写锚点、不补扣**（lastFadeAt === null）：否则一次性把历史记忆按 7 天
   * 衰减、集体标 forgotten。首跑在返回值里给 `firstAnchor=true` + 实际锚点，供日志回放。
   */
  private sleepFade(nowMs: number): SleepFadeResult {
    if (this.lastFadeAt === null) {
      const anchor = this.lastSleepAt ?? this.processStartedAt;
      this.lastFadeAt = nowMs;
      return { days: 0, faded: 0, forgotten: 0, firstAnchor: true, anchor, error: null };
    }
    const days = Math.min(7, Math.max(0, (nowMs - this.lastFadeAt) / DAY_MS));
    this.lastFadeAt = nowMs;
    try {
      const res = this.fade(days);
      return { days, faded: res.faded, forgotten: res.forgotten, firstAnchor: false, anchor: null, error: null };
    } catch (err) {
      return { days, faded: 0, forgotten: 0, firstAnchor: false, anchor: null, error: messageOf(err) };
    }
  }

  /**
   * P4-1：睡眠期 WAL compact——阈 `max(120, records*3)`（首版实验值，上线后按
   * `[sleep-work] compact=lines_before→lines_after` 再调）。失败（Windows rename EPERM
   * 是已知噪声）只留 error，不重试本夜、不影响恢复。
   */
  private sleepCompact(): SleepCompactResult {
    const linesBefore = this.walLineCount();
    const threshold = Math.max(120, this.store.stats().size * 3);
    if (linesBefore <= threshold) {
      return { ran: false, linesBefore, linesAfter: linesBefore, error: null };
    }
    try {
      this.store.compact();
      return { ran: true, linesBefore, linesAfter: this.walLineCount(), error: null };
    } catch (err) {
      return { ran: false, linesBefore, linesAfter: linesBefore, error: messageOf(err) };
    }
  }

  /** P4-1：WAL 磁盘行数（compact 判据）。Wal 没有公开计数；睡点一夜读一次文件足够便宜。 */
  private walLineCount(): number {
    const path = join(this.conf.dataDir, `memory-${this.conf.characterId}.ndjson`);
    if (!existsSync(path)) return 0;
    try {
      return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
    } catch {
      // 读不到就按 0：宁可这一夜不 compact，也不因为观测失败影响睡眠
      return 0;
    }
  }

  /**
   * P4-1：给定时刻的本地小时（背fill 的「期间是否跨睡点」判定用）。
   * tz 固定（与 temporal/main 的 480 同源），所以可以从「当前 localHour + 时间差」反推。
   */
  private localHourAt(ms: number): number {
    const deltaHours = (ms - this.clock.now()) / 3_600_000;
    return (((this.clock.localHour() + deltaHours) % 24) + 24) % 24;
  }


  /**
   * P3-2b：按「此刻」算一次睡眠判定（纯读：不迁移、不落盘）。
   *
   * 输入全部来自本实例：能量取 S 层、睡点取 cycles、阈值取 overlay 的 3 个 SLEEP_*；
   * `peerMessagedAt` 只影响「睡着后被消息叫醒」这一条。
   */
  private sleepAt(nowMs: number, localHour: number): SleepState {
    return nextSleepState({
      nowMs,
      localHour,
      energy: this.s.energy,
      sleepHour: sleepHourFor(this.conf.characterId, this.cfg),
      lastSleepAt: this.sleep.lastSleepMs,
      lastWakeAt: this.sleep.wokeAtMs,
      previousPhase: this.sleep.phase,
      peerMessagedAt: this.peerMessagedAt,
      thresholds: sleepThresholdsFromConfig(this.cfg),
    });
  }

  /**
   * 把相位迁移写进内存。时刻只在**迁移发生的那一刻**落值：
   * 进 asleep 记入睡时刻（喂 sleptHours），进 waking 记缓冲起点。
   */
  private applySleep(state: SleepState, atMs: number): void {
    if (state.phase === this.sleep.phase) return;
    // task-51 观测：迁移瞬间的 reason 是唯一一次能拿到「夜醒原因」的机会（见字段注释）。
    if (state.phase === "waking") this.lastWakeReason = state.reason;
    else if (state.phase === "asleep") this.lastWakeReason = null;
    this.sleep = {
      phase: state.phase,
      wokeAtMs: state.phase === "waking" ? atMs : this.sleep.wokeAtMs,
      asleepSince: state.phase === "asleep" ? atMs : this.sleep.asleepSince,
      lastSleepMs: state.phase === "asleep" ? atMs : this.sleep.lastSleepMs,
      // F340：episode 去重键也必须跟着相位迁移走——否则每醒一次就丢掉，
      // 同一段睡眠在 waking→asleep 的边界上会被当成新 episode 重复做功课。
      lastSleepWorkEpisode: this.sleep.lastSleepWorkEpisode ?? null,
      // P4-1：相位迁移是重建对象，账本要跟着搬过去（否则每醒一次就把当夜已用次数丢了）
      ...(this.sleep.nightBudget === undefined || this.sleep.nightBudget === null
        ? {}
        : { nightBudget: this.sleep.nightBudget }),
    };
  }

  /**
   * P3-2b：推进并返回当前睡眠状态（装配层每 5 分钟拍一次）。
   *
   * 相位变化时立刻落盘——重启后接着睡，而不是重启一次"醒"一次。
   */
  sleepState(): SleepState & { readonly asleepSince: number | null } {
    const nowMs = this.clock.now();
    const localHour = this.clock.localHour() + (nowMs % 3_600_000) / 3_600_000;
    const before = this.sleep.phase;
    const state = this.sleepAt(nowMs, localHour);
    this.applySleep(state, nowMs);
    if (state.phase !== before) this.save();
    // F348（2026-11-04 夜间观测发现）：装配层要用本段睡眠的 episode（=asleepSince）喂
    // `sleepAdvance({ episodeMs })`；`SleepState` 是 engine 纯状态机结果、没有这个字段，
    // 之前只返回 `state` → `sl.asleepSince` 恒为 undefined，F340 的 onset 路径线上从未触发。
    // 这里补读投影（不改进程内状态、不动 engine）。
    return { ...state, asleepSince: this.sleep.asleepSince };
  }

  /**
   * P3-2b：每拍一行睡眠日志（装配层直接 log，格式见 task-50）。
   *
   * P3 观测（task-51 补）：加 `mode/reason/sleptH/turns` —— 7 天窗口要能回放
   * 「mode 分布」与「夜醒原因（peer-message / min-window / max-window）」，
   * 这两项是 v2.2 §9 的回调判据；`turns` 让 B 通道的 turn 项也能从日志估算。
   */
  sleepLogLine(): string {
    const state = this.sleepState();
    const mode = resolveMode(this.s, thresholdsFrom(this.cfg));
    // 停在 waking 时状态机只会报 "hold"；夜醒原因只能用迁移瞬间记下的那个（见 lastWakeReason）。
    const reason = state.phase === "waking" && this.lastWakeReason !== null ? this.lastWakeReason : state.reason;
    return `[sleep] phase=${state.phase} pressure=${state.sleepPressure.toFixed(2)} energy=${this.s.energy.toFixed(3)} window=${state.windowOpen ? "open" : "closed"} mode=${mode} reason=${reason} sleptH=${state.sleptHours.toFixed(2)} turns=${this.turns}`;
  }

  /**
   * P3-2b：B 通道——一次认知事件按 `energyCostFor` 扣能量（dt=0，不碰 A 通道）。
   *
   * asleep 时直接返回：睡着不支付（此时调用方本应已经硬跳过那一拍）。
   * 不落盘：调用方随后本来就要 save（turnInner、advance 末尾；自主动作由下一拍 advance 落盘）。
   *
   * 为什么先快照再复原：tick 的 EMA（valence/arousal 朝锚点的拉力）不按 dt 缩放，
   * dt=0 时那一步仍会把情绪往基线拉一点——那是"时间过去了一点"的语义，不是一次
   * 认知事件的语义。B 通道只该改 energy，所以除 energy 外全部保留原值；这样
   * 每轮多扣一次电不会顺手把她的心情也抹平（panel 的心情标签会因此失真）。
   */
  spendEnergy(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) {
      throw new RangeError(`spendEnergy：cost 必须是非负有限数（收到 ${String(cost)}）`);
    }
    if (this.sleep.phase === "asleep") return;
    const before = { ...this.s };
    tick(this.s, { dtHours: 0, energyCost: cost, wakeDrain: false, energyRecovery: false }, this.cfg);
    this.s = { ...before, energy: this.s.energy };
  }

  /**
   * 下一次睡点距今几小时、上次跨睡点巩固是什么时候——给 soul_stats 用。
   * P3-2b 扩展：附带睡眠状态机的相位快照（只读投影，不推进也不落盘）。
   * P4-1 扩展：`lastFadeAt` 与夜间账本（7 天观察要看 fade 锚点与每夜已用额度）。
   */
  sleepInfo(): {
    hour: number;
    nextInHours: number;
    lastSleepAt: number | null;
    /** P4-1：上次 fade 锚点；null = 老存档，首次睡眠只写锚点不补扣 */
    lastFadeAt: number | null;
    phase: SleepPhase;
    asleep: boolean;
    wokeAtMs: number | null;
    asleepSince: number | null;
    lastSleepMs: number | null;
    /** P4-1：落盘的夜间账本（load 时由装配层 normalize 后写回） */
    nightBudget: PersistedNightBudget | null;
  } {
    const now = this.clock.now();
    const startHour = this.clock.localHour() + (now % 3_600_000) / 3_600_000;
    const hour = sleepHourFor(this.conf.characterId, this.cfg);
    const sleep = this.sleepAt(now, startHour);
    return {
      hour,
      nextInHours: round4(nextSleepInHours(startHour, hour)),
      lastSleepAt: this.lastSleepAt,
      lastFadeAt: this.lastFadeAt,
      phase: sleep.phase,
      asleep: sleep.asleep,
      wokeAtMs: this.sleep.wokeAtMs,
      asleepSince: this.sleep.asleepSince,
      lastSleepMs: this.sleep.lastSleepMs,
      nightBudget: this.sleep.nightBudget ?? null,
    };
  }

  /**
   * P4-1：写回夜间账本（装配层 load/跨夜时 normalize 后调用；同值早退不重复落盘）。
   * 账本进 `Persisted.sleep`，复用状态文件的原子写与单写者，不新增 data 文件。
   */
  setNightBudget(budget: PersistedNightBudget): void {
    const prev = this.sleep.nightBudget;
    if (prev !== undefined && prev !== null && prev.nightKey === budget.nightKey && prev.used === budget.used) return;
    this.sleep = { ...this.sleep, nightBudget: { nightKey: budget.nightKey, used: budget.used } };
    this.save();
  }

  reset(confirm: boolean): { reset: boolean } {
    if (!confirm) throw new Error("重置会清空状态与关系（记忆文件保留）——必须传 confirm=true");
    this.s = initialSState();
    this.bondProgress = 0;
    this.turns = 0;
    // P3-2b（task-57 B5）：reset 也要把睡眠状态清回初值，否则 soul_reset 之后
    // 可能还停在 asleep——下一拍装配层会一直走睡眠分支，她「重置完了却叫不醒」。
    this.sleep = initialPersistedSleep(null, this.clock.now());
    // P4-1（task-69 Lead 决定 4）：reset 同时清两个锚点——否则 20h 巩固去重会拿
    // reset 之前的旧睡点挡住「reset 后第一夜」的巩固；fade 锚点同理（否则首夜按旧锚点
    // 一次性补扣）。只清锚点，记忆/知识本体现有语义不变（reset 本来就不清记忆）。
    this.lastSleepAt = null;
    this.lastFadeAt = null;
    this.peerMessagedAt = null;
    this.lastWakeReason = null;
    this.save();
    return { reset: true };
  }

  /**
   * §7.3 睡眠巩固：把够数的 L1 簇蒸馏成 L2 知识并落库。
   *
   * 纯函数 consolidate() 只做判定，落盘由这里负责——这样测试可以只跑判定，
   * 不用建文件。同一 tag 重复巩固不会写第二条（id 由 tag 的 FNV 哈希决定）。
   */
  /**
   * §5.4 行为证据采样：每回合记一条"这一轮之后她是什么样"。
   *
   * 为什么不塞进 S 层：S 层是**此刻的情绪**，每回合被 tick 往 baseline 拉；
   * 漂移要的是**慢证据**——攒很多轮看均值往哪偏。所以它落在状态文件顶层的 `traitSamples`。
   * 没配人格卡（`persona.personality`）时不记：没有 baseline 就谈不上"偏离"，记了也没用。
   */
  private recordTraitSample(): void {
    if (this.persona()?.personality === undefined) return;
    this.traitSamples.push({
      at: this.clock.now(),
      valence: this.s.valence,
      arousal: this.s.arousal,
      pressure: this.s.pressure,
      rumination: this.s.rumination,
    });
    if (this.traitSamples.length > TRAIT_SAMPLE_CAP) {
      this.traitSamples.splice(0, this.traitSamples.length - TRAIT_SAMPLE_CAP);
    }
  }

  /**
   * §5.4 人格漂移结账：睡眠时做一次（跟知识新鲜度同一个节拍），把一天的证据折成慢漂移。
   *
   * 返回 null 是常态而不是失败：①没配人格卡，没有 baseline 可比；②这一晚没动一点点
   * （阻尼把偏离拉回 baseline 时会精确等于当前值），那就不值得写进日志。
   * 真的动了才把一句话交给调用方——她在变，是要留下痕迹的事。
   */
  private settleDriftNow(): {
    ocean: DriftOcean;
    verdicts: Readonly<Record<"A" | "N" | "E", DriftVerdict>>;
    changed: boolean;
    note: string;
    /** §8.4 三重防护拒掉的那些维度（有才出现） */
    guarded?: string;
  } | null {
    const personality = this.persona()?.personality;
    if (personality === undefined) return null;
    const base = baselineFrom(personality.ocean);
    const settled = settleDrift(base, this.drift, this.traitSamples, this.cfg);

    // §8.4 三重防护（M8-10）：睡眠结账是唯一会推动 OCEAN 的机制，它也要过闸——
    // 来源白名单 + 单次幅度 + 累计偏移。被拒的维度保持原值，绝不"先写再报错"。
    const current = this.drift?.ocean ?? base;
    const delta: Record<string, number> = {};
    for (const dim of ["A", "N", "E"] as const) delta[dim] = settled.ocean[dim] - current[dim];
    const guard = vetOceanDelta({ source: "drift_settle", base, current, delta }, this.cfg);
    const ocean = { ...current } as Record<"A" | "N" | "E", number>;
    for (const [dim, d] of Object.entries(guard.applied)) {
      const key = dim as "A" | "N" | "E";
      ocean[key] = current[key] + d;
    }

    // 结账过就记住当前值与偏差历史（下一晚拿它当起点）；样本**不清空**——
    // 它是滚动窗口（cap 200），清掉会让"每天只来 3 句"的人永远攒不够 12 条证据。
    this.drift = { ocean, history: settled.history };
    if (!guard.ok) {
      // 全拒时历史仍然记（否则下一晚还得重新攒窗），但不报"变了"
      return null;
    }
    const moved = (["A", "N", "E"] as const).some((d) => Math.abs(ocean[d] - current[d]) >= 1e-9);
    if (!moved) return null;
    const guarded =
      guard.rejected.length === 0 ? undefined : guard.rejected.map((r) => `${r.dim}(${r.reason})`).join("；");
    return {
      ocean,
      verdicts: settled.verdicts,
      changed: true,
      note: settled.note,
      ...(guarded === undefined ? {} : { guarded }),
    };
  }

  consolidate(opts: { minSize?: number } = {}): {
    clusters: number;
    written: number;
    accepted: readonly string[];
    rejected: readonly { tag: string; verdict: string; reason: string }[];
    /** 这次睡眠消费了多少条内部言语（§4.10：言语进同一套记忆基础设施） */
    selftalk?: number;
    /** 这次重算了多少条知识的新鲜度（§6.3；只计真正变化超过 0.02 的） */
    refreshed?: number;
    /** §5.4 这一晚人格漂移真的动了才会出现（A/N/E 的新值 + 一句话摘要） */
    drift?: { ocean: DriftOcean; note: string; guarded?: string };
  } {
    const now = this.clock.now();
    // 先把她"想过的事"落成低鲜活度记忆，再照常聚类——内部言语不是旁路，必须过同一套闸。
    // 游标防止重复消费；id 用 `st-<entry.id>`，即使游标丢了也是幂等写。
    const journal = journalSeeds(this.conf.dataDir, this.conf.characterId);
    let selftalk = 0;
    for (const seed of journal.seeds) {
      if (this.store.get(seed.id) !== undefined) continue;
      if (this.store.write(makeMemory(seed), now).stored) selftalk += 1;
    }
    if (journal.seeds.length > 0) saveConsumedAt(consumedPathFor(this.conf.dataDir, this.conf.characterId), journal.latestAt);
    const result = consolidate(this.store.active(), this.cfg, now, opts);
    const accepted: string[] = [];
    for (const item of result.accepted) {
      this.knowledgePort.put(item.knowledge);
      accepted.push(item.knowledge.id);
      // §4.4：hub 权重按证据量记一笔，供下次 sleep 的优先级延续（TTL 7 天）
      const weight = Math.min(1, Math.max(0.1, item.cluster.evidenceCount / 5));
      this.hubs.update(item.cluster.tag, weight, now);
    }
    // §6.3 睡眠时重算知识新鲜度：写入时它是常量 1，之后从不衰减，
    // 于是检索打分与好奇心缺口都看不见时间（V52-GAP M6-05）。
    const refreshed = this.refreshKnowledgeFreshness(now);
    // §5.4 同一趟睡眠里结一次人格漂移的账（证据来自这一天的对话样本）
    const drift = this.settleDriftNow();
    // P3-2b：B 通道——巩固也是一次认知事件（睡眠中调用时 spendEnergy 会按 asleep 跳过）。
    this.spendEnergy(energyCostFor(this.cfg, "consolidate"));
    this.save();
    return {
      clusters: result.clusters.length,
      written: accepted.length,
      refreshed,
      ...(drift === null
        ? {}
        : {
            drift: {
              ocean: drift.ocean,
              note: drift.note,
              ...(drift.guarded === undefined ? {} : { guarded: drift.guarded }),
            },
          }),
      accepted,
      rejected: result.rejected.map((r) => ({ tag: r.cluster.tag, verdict: r.check.verdict, reason: r.check.reason })),
      selftalk,
    };
  }

  /**
   * 让**外部模型**（DSH 里的 agent）填写簇的洞见文本。
   *
   * 规格把 `extract_insight(cluster)` 定为整个系统唯一的 LLM 入口（[1017] 附近）；
   * 插件自己不调模型，所以这一句由 agent 传进来，插件只负责校验与落库。
   */
  submitInsight(input: { tag: string; content: string; knowledgeType?: KnowledgeType }): {
    stored: boolean;
    id: string;
    verdict: string;
    reason: string;
  } {
    const text = (input.content ?? "").trim();
    if (text === "") throw new Error("content 不能为空：这一句是模型写的洞见，不是占位符");
    const clusters = clusterEpisodic(this.store.active(), { cfg: this.cfg });
    const cluster = clusters.find((c) => c.tag === input.tag);
    if (cluster === undefined) {
      throw new Error(`没有标签为「${input.tag}」的簇；先用 soul_consolidate 看看簇名与证据数`);
    }
    // §8.2 路径 3（F154）：血统与记忆污点在 clusterEpisodic 里已经判过，但"此刻状态还脏着"
    // 只有 runtime 知道（taintMap 在 S 层）。这里把三条路径合成一次，避免两处口径分叉。
    const provenance = deriveInsightProvenance({ members: cluster.members, taintMap: this.s.taintMap });
    const guarded = { ...cluster, stateProvenance: provenance.stateProvenance, taintReason: provenance.reason };
    const check = isValidBeliefUpdate(
      {
        cluster: guarded,
        memoryLayer: "L1_episodic",
        evidenceCount: guarded.evidenceCount,
        source: guarded.source,
        stateProvenance: guarded.stateProvenance,
      },
      this.cfg,
    );
    if (check.verdict !== "ACCEPTED") {
      return { stored: false, id: knowledgeIdFor(cluster.tag), verdict: check.verdict, reason: check.reason };
    }
    const rec = makeKnowledge(cluster, this.clock.now(), {
      content: text,
      ...(input.knowledgeType === undefined ? {} : { knowledgeType: input.knowledgeType }),
    });
    this.knowledgePort.put(rec);
    this.save();
    return { stored: true, id: rec.id, verdict: "ACCEPTED", reason: check.reason };
  }

  /**
   * 动机层：把「状态 + 最近学没学到东西」折成一个 Wonder（规则见 src/psychology/wonder.ts）。
   *
   * 新知识的两个输入直接数知识库的 `ingested_at`：1 小时内写入几条 = newKnowledge，
   * 最近一次写入距今几小时 = hoursSinceLearn。时间戳读不到就按"没学过"处理——
   * 宁可说她很久没学到东西，也不要拿当前时间伪造一次"刚学到"。
   */
  wonder(): Wonder {
    const now = this.clock.now();
    let latest: number | null = null;
    let newKnowledge = 0;
    for (const k of this.knowledge.all()) {
      const at = k.ingested_at;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (latest === null || at > latest) latest = at;
      const age = now - at;
      if (age >= 0 && age <= 3_600_000) newKnowledge += 1;
    }
    return wonderOf({
      state: {
        valence: this.s.valence,
        arousal: this.s.arousal,
        energy: this.s.energy,
        entropy: this.s.entropy,
        dissonance: this.s.dissonance,
      },
      newKnowledge,
      hoursSinceLearn: latest === null ? NO_LEARN_HOURS : Math.max(0, (now - latest) / 3_600_000),
      localHour: this.clock.localHour(),
    });
  }

  /** 已巩固的知识条目（给工具与调试看） */
  /**
   * 知识库检索（KnowledgeReader 端口用）。
   *
   * 工具层不该直接 import `memory/knowledge.ts` 的 KnowledgeStore——那会把
   * 「知识怎么存」变成工具的依赖；这里只暴露"按一句话找几条"。
   */
  searchKnowledge(query: string, limit = 3): readonly { id: string; content: string }[] {
    return this.knowledge.search(query, limit).map((rec) => ({ id: rec.id, content: rec.content }));
  }

  knowledgeRows(limit = 10): readonly { id: string; type: string; freshness: number; content: string }[] {
    return this.knowledge
      .all()
      .slice(-limit)
      .reverse()
      .map((k) => ({ id: k.id, type: k.knowledge_type, freshness: round4(k.freshness), content: k.content }));
  }

  /**
   * 现有知识库实例（只给「外部摄取」用：B 站视频蒸馏后写进这里）。
   *
   * 为什么必须复用这个实例而不是在摄取方 `new KnowledgeStore(同一路径)`：文件是同一份，
   * 但内存索引是两份，`has()` 的幂等判重会失效——同一个视频每拉一次就会多追加一行。
   */
  /** 自主进程写内部言语时需要它（只给同一个写者用；开发面仍然只读） */
  memoryStore(): MemoryStore {
    return this.store;
  }

  knowledgeStore(): KnowledgeStore {
    return this.knowledge;
  }

  /**
   * 知识写入端口（F257）：**外部摄取（bili/外部导入）必须走它**，不要拿 `knowledgeStore()` 直接 `put`。
   *
   * 实现里已经接上 `vetWrite`：rejected 不落库、quarantined 落库并记污点侧车、
   * clean 照常。装配点只负责把这个端口递给工具层（`ingestVideos`/`ingestVideoNote`）。
   */
  knowledgeWritePort(): GuardedKnowledgePort {
    return this.knowledgePort;
  }

  /** 知识写入闸的计数（只在本进程内；health/日志可读，用来确认闸真的在跑） */
  knowledgeGuardStats(): KnowledgeGuardStats {
    return this.knowledgePort.stats();
  }

  /**
   * §6.5 记忆会褪色（G6-①）：每过一个模拟日，活跃记忆的 vividness 按规格原式衰减一次，
   * unresolved_score 同步衰减，跌破阈值且不是执念就标 forgotten（软删除，可回溯）。
   *
   * 为什么放在 advance 而不是每 5 分钟 tick 里：衰减公式的 dt 单位是**天**，
   * 每 tick 调用需要把 dt 拆成 1/288 天，浮点上等价但会多 288 倍写盘；
   * 这里按"推进了几天"一次性衰减，语义与规格一致。
   */
  fade(dtDays: number): { faded: number; forgotten: number } {
    if (!Number.isFinite(dtDays) || dtDays <= 0) return { faded: 0, forgotten: 0 };
    let faded = 0;
    let forgotten = 0;
    for (const m of this.store.active()) {
      if (m.is_obsession) continue;
      const vividness = tickVividness(m.vividness, this.s.arousal, dtDays, this.cfg);
      const unresolved_score = decayUnresolved(m.unresolved_score, dtDays, this.cfg);
      const died = shouldForgetNow(vividness, m.is_obsession, this.cfg);
      if (Math.abs(vividness - m.vividness) > 1e-9) faded += 1;
      if (died) forgotten += 1;
      this.store.mutate(m.id, {
        vividness,
        unresolved_score,
        ...(died ? { forgotten: true } : {}),
      });
    }
    return { faded, forgotten };
  }

  /**
   * 冷归档（§6.9，规则自拟见 src/memory/archive.ts 文件头，F29）。
   *
   * 只搬不删：把满足 `shouldColdArchive` 的记忆从热档移到冷档，返回被搬走的 id。
   * 自动调用发生在睡点巩固之后；手动调用走 `soul_archive action=run`。
   */
  archiveCold(): { readonly archived: number; readonly ids: readonly string[] } {
    const now = this.clock.now();
    const ids: string[] = [];
    for (const m of this.store.all()) {
      if (!shouldColdArchive(m, now, this.cfg)) continue;
      this.cold.put({ record: { ...m }, archived_at: now, reason: "cold_archive" });
      this.store.remove(m.id);
      ids.push(m.id);
    }
    if (ids.length > 0) this.save();
    return { archived: ids.length, ids };
  }

  /** 冷档列表（诊断用）：把"想不起来"与"已经不在热档"分开 */
  coldRows(limit = 10): readonly ArchivedEntry[] {
    return this.cold.all().slice(0, limit);
  }

  /** 从冷档取回热档：重置 last_accessed 并清掉 forgotten —— 这是显式的"我又想起它了" */
  restoreCold(id: string): MemoryRecord | null {
    const entry = this.cold.take(id);
    if (entry === undefined) return null;
    const now = this.clock.now();
    const restored: MemoryRecord = { ...entry.record, forgotten: false, last_accessed: now };
    this.store.readmit(restored);
    this.save();
    return restored;
  }

  /**
   * 硬删除（不可逆）：**只能显式触发**，且只对已进冷档、过了保留期的条目生效。
   * 自动销毁不值得为"整洁"冒险——这是本插件唯一一处真正的数据销毁。
   */
  purgeCold(confirm: boolean): { readonly purged: number; readonly ids: readonly string[] } {
    if (confirm !== true) throw new Error("硬删除必须显式确认：传 confirm=true");
    const now = this.clock.now();
    const stats = this.cold.stats(now, this.cfg);
    if (stats.purgeable === 0) return { purged: 0, ids: [] };
    const retention = knobNumber(this.cfg, "HARD_DELETE_RETENTION_DAYS") * DAY_MS;
    const ids = this.cold
      .all()
      .filter((entry) => now - entry.archived_at >= retention)
      .map((entry) => entry.record.id);
    const removed = this.cold.purge(ids);
    return { purged: removed.length, ids: removed };
  }

  /** 记忆条数与最近一条的年龄——用来区分“没记住”和“记了但没召回” */
  memoryStats(): {
    total: number;
    active: number;
    rejects: number;
    newest: number | null;
    knowledge: number;
    banditKeys: number;
    forgotten: number;
    suppressed: number;
    cold: number;
    purgeable: number;
    vividness: number;
  } {
    const all = this.store.all();
    const active = this.store.active();
    let newest: number | null = null;
    for (const m of all) if (newest === null || m.created_at > newest) newest = m.created_at;
    const vividness = active.length === 0 ? 0 : active.reduce((sum, m) => sum + m.vividness, 0) / active.length;
    return {
      total: all.length,
      active: active.length,
      rejects: this.store.rejections().length,
      newest,
      knowledge: this.knowledge.size(),
      banditKeys: Object.keys(this.bandit.table).length,
      forgotten: all.filter((m) => m.forgotten).length,
      suppressed: all.filter((m) => m.suppressed_by_stronger && !m.forgotten).length,
      cold: this.cold.stats(this.clock.now(), this.cfg).size,
      purgeable: this.cold.stats(this.clock.now(), this.cfg).purgeable,
      vividness: round4(vividness),
    };
  }

  private appendMemory(text: string, source: string, mode: Mode, tags: readonly string[] = []): { wrote: number; rejected: number } {
    const now = this.clock.now();
    // §5.3/§5.6（P2 写入层）：写下的这一刻就把五元组里知道的写下来、不知道的标 unknown。
    // 插件回合拿不到常驻进程的意向上下文，所以 goal_at_time 通常是 unknown——这是诚实，不是缺陷。
    const channel = channelForSource(source);
    const episode = buildEpisodeWrite({
      text: text ?? "",
      source,
      channel,
      mode,
      tags,
      valence: this.s.valence,
      arousal: this.s.arousal,
      createdAtMs: now,
      // P2a：本地小时用于 cue_fingerprint.timeOfDay（brain 不读时钟，由装配层给）
      localHour: this.clock.localHour(),
      // P2a：turn 只处理收到的消息，所以这条记忆一定是入站方向（不需要调用方再传）
      direction: "inbound",
    });
    const rec = makeMemory({
      id: this.memoryId(now),
      content: (text ?? "").trim(),
      source,
      created_at: now,
      self_relevance: 0.3,
      tags: [...tags],
      participants: [...episode.participants],
      encode_ctx: { channel, mode, ...episode.encodeCtx },
      encode_state: { valence: this.s.valence, arousal: this.s.arousal, pressure: this.s.pressure },
      source_chain: [source],
    });
    const res = this.store.write(rec, now);
    if (res.stored) this.applySuppression(rec.id);
    return res.stored ? { wrote: 1, rejected: 0 } : { wrote: 0, rejected: 1 };
  }

  /**
   * G6-⑤：§6.5 的 `suppressed_by_stronger` 规格只读不写，规则由本插件自拟
   * （见 `src/memory/suppression.ts` 顶部说明）。这里只负责把纯函数算出的补丁落库。
   */
  private applySuppression(id: string): void {
    const rec = this.store.get(id);
    if (rec === undefined) return;
    const patches = reconcileSuppression(rec, this.store.all());
    for (const patch of patches) this.store.suppress(patch.id, patch.suppressed, patch.strength);
  }

  /**
   * 批次 2a：拿到写锁之后、开始这一回合之前，把状态文件重新读一遍。
   *
   * 为什么必须重读：插件与 daemon 共享同一份 `state-<char>.json`。插件启动时读到的是那一刻的
   * 快照；daemon 每拍都在 advance。若插件拿着启动时的旧快照写回，就会把 daemon 这几十分钟的
   * 推进（关系/情绪/回合数）整份覆盖掉——审计 B.1 的"后写者用旧态覆盖"。
   * 重读 + `lastSeenStateUpdatedAt` 对齐之后，这一回合的写入才是"基于最新状态"的。
   *
   * 只在**拿到写锁**后调用（见 plugin/index.ts 的 turnWriteLock）：没拿到锁说明 daemon 正在推进，
   * 这时重读也挡不住竞态，save 会由 state-guard 拒绝（宁可这一回合不落盘，也不覆盖她的状态）。
   */
  reloadState(): void {
    const persisted = readPersisted(this.statePath, this.conf.characterId, this.clock.now());
    this.s = persisted.s;
    this.bondProgress = persisted.bondProgress;
    this.turns = persisted.turns;
    this.bandit = persisted.bandit ?? emptyBandit();
    this.prevStrategy = persisted.prevStrategy ?? null;
    this.lastSleepAt = persisted.lastSleepAt ?? null;
    this.sleep = persisted.sleep ?? initialPersistedSleep(persisted.lastSleepAt ?? null, this.clock.now());
    this.lastFadeAt = persisted.lastFadeAt ?? null;
    this.actionHistory = [...(persisted.actionHistory ?? [])];
    this.expectationBias = { ...(persisted.expectationBias ?? {}) };
    this.traitSamples = [...(persisted.traitSamples ?? [])];
    this.drift = persisted.drift ?? null;
    this.lastSeenStateUpdatedAt = persisted.updatedAt;
  }

  /** 关机保护：把 S 层/关系/策略立刻落盘（自主进程收到 SIGTERM 时调用） */
  flush(): void {
    this.save();
    // trace 也要在关机前落地，否则"最后 5 秒"就白记了（INV-2 的崩溃窗口只应该发生在强杀时）
    this.traceLog?.flush();
  }

  /** 最近 n 条 trace（面板/工具面用；文件仍是唯一事实来源，这里只是顺手的读口） */
  traceLast(n = 5): readonly Record<string, unknown>[] {
    const log = this.traceLog;
    if (log === null) return [];
    return readTrace(log.path, { last: n }) as readonly Record<string, unknown>[];
  }

  /**
   * 批次 2a：写盘前先问 `decideStateWrite`——磁盘上的版本比"上次看到的"更新时：
   *   · primary（daemon）照写但记警告：主写者不能因为别人写过就停心跳；
   *   · secondary（插件）拒绝覆盖，只记日志与计数（`stateWriteStats()` 给 health/测试看）。
   * 这是"检测 + 降级"，不是锁；真正的修复是插件只读快照 + 写请求投递（批次 2c）。
   */
  private save(): void {
    const body: Persisted = {
      version: 1,
      characterId: this.conf.characterId,
      s: this.s,
      bondProgress: this.bondProgress,
      turns: this.turns,
      updatedAt: this.clock.now(),
      bandit: this.bandit,
      prevStrategy: this.prevStrategy,
      lastSleepAt: this.lastSleepAt,
      lastFadeAt: this.lastFadeAt,
      sleep: this.sleep,
      actionHistory: this.actionHistory,
      expectationBias: this.expectationBias,
      traitSamples: this.traitSamples,
      ...(this.drift === null ? {} : { drift: this.drift }),
    };
    const currentUpdatedAt = readStateUpdatedAt(this.statePath);
    const decision = decideStateWrite({
      currentUpdatedAt,
      lastSeenUpdatedAt: this.lastSeenStateUpdatedAt,
      role: this.stateWriter,
    });
    this.lastStateSaveDecision = decision;
    if (decision === "reject-stale") {
      this.stateSaveRejections += 1;
      this.conf.stateLog?.(
        `[state] ${describeStateSaveOutcome({ decision, written: false, currentUpdatedAt }, this.stateWriter)}（current=${String(currentUpdatedAt)}，本进程上次看到=${String(this.lastSeenStateUpdatedAt)}）`,
      );
      return;
    }
    if (decision === "write-with-warning") {
      this.conf.stateLog?.(
        `[state] overwrite-warning：磁盘上的版本被别的进程改过（current=${String(currentUpdatedAt)}，本进程上次看到=${String(this.lastSeenStateUpdatedAt)}），主写者继续落盘`,
      );
    }
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameWithRetry(tmp, this.statePath);
    this.lastSeenStateUpdatedAt = body.updatedAt;
  }

  /** 批次 2a：状态写入裁决的最近结果（health/测试读；不落盘，进程内事实） */
  stateWriteStats(): {
    role: StateWriterRole;
    lastDecision: StateWriteDecision;
    rejections: number;
    lastSeenUpdatedAt: number;
  } {
    return {
      role: this.stateWriter,
      lastDecision: this.lastStateSaveDecision,
      rejections: this.stateSaveRejections,
      lastSeenUpdatedAt: this.lastSeenStateUpdatedAt,
    };
  }
}

/** P3-2b：没有 sleep 字段时的起点——按 awake，并沿用旧存档的 lastSleepAt 做近似 */
function initialPersistedSleep(lastSleepAt: number | null, nowMs: number): PersistedSleep {
  return {
    phase: "awake",
    wokeAtMs: lastSleepAt ?? nowMs,
    asleepSince: null,
    lastSleepMs: lastSleepAt,
    // F340：老存档没有 episode key → null（视为本段未做，部署后第一次入睡补做一次）
    lastSleepWorkEpisode: null,
  };
}

/**
 * P3-2b：读回睡眠字段时做一次形状校验。
 *
 * 校验失败返回 null（按旧存档处理 → awake 起步），而不是抛错：状态文件是"活下来"的
 * 优先级最高的东西，一个坏字段不该让整个实例起不来。`asleep` 但缺入睡时刻会被拒绝——
 * 否则 sleptHours 永远是 0，最长窗兜底失效，她会永远睡着。
 */
function parsePersistedSleep(raw: unknown): PersistedSleep | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Partial<Record<keyof PersistedSleep, unknown>>;
  const phase = o.phase;
  if (phase !== "awake" && phase !== "drowsy" && phase !== "asleep" && phase !== "waking") return null;
  const numOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const wokeAtMs = numOrNull(o.wokeAtMs);
  const asleepSince = numOrNull(o.asleepSince);
  const lastSleepMs = numOrNull(o.lastSleepMs);
  // F340：坏值/缺失都按 null 读（= 本段未做），不影响状态文件其余字段。
  const lastSleepWorkEpisode = numOrNull(o.lastSleepWorkEpisode);
  if (phase === "asleep" && lastSleepMs === null) return null;
  // P4-1：夜间账本形状校验——坏账本按 null 丢（装配层会 normalize 成 used=0），
  // 不让一个脏字段把整个状态文件判死。used 上限按 SLEEP_NIGHT_BUDGET=8（与自主层常量同步）。
  const rawBudget = o.nightBudget;
  let nightBudget: PersistedNightBudget | null = null;
  if (rawBudget !== null && typeof rawBudget === "object") {
    const b = rawBudget as { readonly nightKey?: unknown; readonly used?: unknown };
    if (
      typeof b.nightKey === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(b.nightKey) &&
      typeof b.used === "number" &&
      Number.isInteger(b.used) &&
      b.used >= 0 &&
      b.used <= 8
    ) {
      nightBudget = { nightKey: b.nightKey, used: b.used };
    }
  }
  return { phase, wokeAtMs, asleepSince, lastSleepMs, lastSleepWorkEpisode, ...(nightBudget === null ? {} : { nightBudget }) };
}

/** P4-1：空结果（没有跨睡点/没有工作时由装配层日志读取，避免 undefined 分支） */
function emptySleepAdvance(): SleepAdvanceResult {
  return {
    consolidated: false,
    clusters: 0,
    written: 0,
    archived: 0,
    fade: emptySleepFade(),
    compact: emptySleepCompact(),
    purgeable: 0,
    purgeableIds: [],
    error: null,
  };
}

function emptySleepFade(): SleepFadeResult {
  return { days: 0, faded: 0, forgotten: 0, firstAnchor: false, anchor: null, error: null };
}

function emptySleepCompact(): SleepCompactResult {
  return { ran: false, linesBefore: 0, linesAfter: 0, error: null };
}

function readPersisted(path: string, characterId: string, now: number): Persisted {
  if (!existsSync(path)) {
    return { version: 1, characterId, s: initialSState(), bondProgress: 0, turns: 0, updatedAt: now };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<Persisted>;
  if (parsed.version !== 1) throw new Error(`状态文件版本不支持：${String(parsed.version)}`);
  const s = parsed.s;
  if (s === undefined) throw new Error("状态文件缺少 s 字段");
  const sleep = parsePersistedSleep(parsed.sleep);
  return {
    version: 1,
    characterId: parsed.characterId ?? characterId,
    s: { ...initialSState(), ...s },
    bondProgress: typeof parsed.bondProgress === "number" ? parsed.bondProgress : 0,
    turns: typeof parsed.turns === "number" ? parsed.turns : 0,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
    // 老存档（G3 之前）没有这两项，读到就按“没有策略历史”处理，不报错
    ...(parsed.bandit === undefined ? {} : { bandit: parsed.bandit }),
    ...(parsed.prevStrategy === undefined || parsed.prevStrategy === null ? {} : { prevStrategy: parsed.prevStrategy }),
    ...(typeof parsed.lastSleepAt === "number" ? { lastSleepAt: parsed.lastSleepAt } : {}),
    // P4-1：fade 锚点（老存档没有 → undefined → 首次睡眠只写锚点不补扣）
    ...(typeof parsed.lastFadeAt === "number" ? { lastFadeAt: parsed.lastFadeAt } : {}),
    // P3-2b：老存档没有 sleep → 保持 undefined，构造时按 awake 起步（不伪造"她昨晚睡过"）
    ...(sleep === null ? {} : { sleep }),
    // §7.2 期望模型的观察历史与偏置：老存档没有这两项，读到就按"她还没有预期"处理
    ...(Array.isArray(parsed.actionHistory) ? { actionHistory: parsed.actionHistory } : {}),
    ...(parsed.expectationBias === undefined || parsed.expectationBias === null
      ? {}
      : { expectationBias: parsed.expectationBias }),
    // §5.4 人格漂移：老存档没有这两项，读到就按"没有行为证据"处理
    ...(Array.isArray(parsed.traitSamples) ? { traitSamples: parsed.traitSamples } : {}),
    ...(parsed.drift === undefined || parsed.drift === null ? {} : { drift: parsed.drift }),
  };
}

export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export { DAY_MS };

/** 记忆→文本：给模型看的紧凑表示，不要塞 JSON */
export function renderRecalls(rows: readonly RecallRow[]): string {
  if (rows.length === 0) return "（没有命中记忆）";
  return rows
    .map((r) => `- [${r.id}] score=${r.score} sem=${r.semantic}${r.underTaint ? " ⚠污点" : ""} ${r.content.slice(0, 120)}`)
    .join("\n");
}

export type { MemoryRecord };

export type { RecallRow, TurnText } from "../dialogue/turn-result.js";
