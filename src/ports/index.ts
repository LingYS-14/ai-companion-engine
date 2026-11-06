/**
 * 层间端口（Port）：工具层能看见的大脑层「合同」。
 *
 * ## 为什么要有这一层
 *
 * 三层重构的核心不是搬目录，而是**把依赖方向拧正向**：现在 `qq/*` 直接
 * `import type { SoulRuntime } from "../plugin/runtime.js"`——工具层反手指着装配点，
 * 装配点又要 import 全部层，于是任何一次拆分都会牵动一大片（ARCH-MAP 实测：改一句话
 * 要动 2–4 个文件，加一个工具要动 5–8 个）。
 *
 * 端口是一小组**只有方法签名、没有实现**的接口：工具层只依赖端口，装配点
 * （`plugin/runtime.ts` / 未来的 `assembly.ts`）负责把真实现接进来。
 * 好处很具体：
 * - 工具层不再 import 装配点 → 循环依赖断掉，`edges` 门禁才有得判；
 * - 测试可以拿一个假端口跑，不用起整个 SoulRuntime（现在测试要造大对象）；
 * - 换实现（比如把记忆换成别的存储）只改装配点一处。
 *
 * ## 边界纪律
 *
 * 这个文件**只允许 import type**，不许 import 任何运行时值——
 * 否则端口本身就变成了依赖。它属于大脑层的公共面（brainPublicPrefixes）。
 */

import type { Visitor } from "./visitor.js";
import type { Persona } from "../dialogue/persona.js";
import type { TurnText } from "../dialogue/turn-result.js";
import type { Wonder } from "../psychology/wonder.js";
import type { TurnRequest } from "../orchestrator/turn.js";
import type { KnowledgeRecord } from "../memory/knowledge.js";
import type { AppraisalRaw } from "../engine/appraisal.js";
import type { ContextTag } from "../learning/strategy.js";
import type { LanguageFeatures, LanguagePort } from "./dialogue.js";

/** 一轮对话的调用选项（与 `SoulRuntime.turn` 的第二参数同形） */
export interface TurnOptions {
  readonly source?: string;
  readonly eventType?: string;
  readonly audiencePresent?: number;
  /** 本轮实际采用的话术标签；不传就用 UCB 的建议 */
  readonly strategy?: string;
  /** 玩家对这一轮的反应；传了才学习 */
  readonly reaction?: string;
  /** 不把这一轮写进情景记忆（自检/通道测试用） */
  readonly skipMemory?: boolean;
}

/** 召回出来的一行（结构同 `runtime.RecallRow`，见 dialogue/turn-result.ts） */
export interface RecalledMemory {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  /**
   * 记忆标签（可选）。§5.2 working self 闸门在**调用侧**需要它来判断
   * 「这条记忆与此刻的目标/价值是否相关」；不提供就 fail-open（不拦）。
   * 只有 `SoulRuntime.recall` 这个真实实现会填，测试里的假端口可以不给。
   */
  readonly tags?: readonly string[];
  /**
   * 记忆来源（task-169 A）。可选：旧假端口/旧快照没有这个字段；
   * 主动开口路径要用它排除自述来源，回信路径不读它。
   */
  readonly source?: string;
}

/**
 * 脊髓层推动时间时看到的结果摘要（结构同 `SoulRuntime.advance` 的返回值）。
 *
 * 为什么在端口里另写一份、而不是 import runtime 的类型：端口是大脑层公共面，
 * 绝不能反过来 import 装配点（那正是这次重构要断掉的环）。结构相同即可，
 * `SoulRuntime implements BrainPort` 会在编译期保证它真的对得上。
 */
export interface AdvanceSummary {
  readonly steps: number;
  readonly pressure: number;
  readonly energy: number;
  readonly mask: number;
  readonly sleep: {
    readonly count: number;
    readonly hour: number;
    readonly ran: boolean;
    readonly clusters: number;
    readonly written: number;
    readonly accepted: readonly string[];
    readonly archived: number;
  } | null;
  readonly faded: number;
  readonly forgotten: number;
  readonly taintCleared: number;
}

/** 一次睡眠巩固的结果摘要（结构同 `SoulRuntime.consolidate` 的返回值） */
export interface ConsolidateSummary {
  readonly clusters: number;
  readonly written: number;
  readonly accepted: readonly string[];
  readonly rejected: readonly { readonly tag: string; readonly verdict: string; readonly reason: string }[];
  readonly selftalk?: number;
  readonly refreshed?: number;
  readonly drift?: {
    readonly ocean: { readonly A: number; readonly N: number; readonly E: number };
    readonly note: string;
    readonly guarded?: string;
  };
}

/** 显式写一条记忆的入参（结构同 `SoulRuntime.remember` 的入参） */
export interface RememberInput {
  readonly content: string;
  readonly source?: string;
  readonly tags?: readonly string[];
  readonly vividness?: number;
  readonly selfRelevance?: number;
  /** §8.3 shared_self：只有主人能打这个标 */
  readonly allowShare?: boolean;
  /**
   * P2a：这句话是谁说的——入站（inbound）还是她主动说出（outbound）。
   * 缺省 = unknown：不写进 encode_ctx，也不参与节律统计。
   */
  readonly direction?: "inbound" | "outbound";
  /**
   * P2a：写入这一刻她正在追的意图目标（人类可读）与意图 id。
   * 装配层知道意图上下文时按需传入；插件/宿主路径拿不到就不传——缺省 = unknown。
   */
  readonly goalAtTime?: string;
  readonly goalId?: string;
}

/** 主动开口的状态门限（结构同 `SoulRuntime.proactiveGates`；阈值在配置里，端口只传形状） */
export interface ProactiveGates {
  readonly energyFloor: number;
  readonly trustFloor: number;
  readonly trustSafeMin: number;
  readonly queueEmpty: boolean;
}

/** 显式写一条记忆的结果 */
export interface RememberSummary {
  readonly stored: boolean;
  readonly reason: string;
  readonly id: string;
}

/**
 * 大脑端口：工具层与脊髓层「推动她往前走」的入口。
 *
 * 只收真正跨层用到的方法。**不要图省事把 SoulRuntime 的四十个方法全抄进来**——
 * 端口越大，工具层能碰到的大脑内部就越多，这次重构就白做了。
 *
 * P0-3（审计 2026-10-31）：脊髓层原来用 `Pick<SoulRuntime, "advance" | "consolidate" | …>`
 * 直连装配点，等于端口只挡了工具层、没挡脊髓层。现在把 advance / consolidate / remember
 * 收进这里，脊髓与工具层看的是同一份合同，`SoulRuntime` 用 `implements` 保证实现不漂。
 */
export interface BrainPort {
  /** 推进一轮：状态、关系、记忆、提示风格都在里面算完 */
  turn(req: TurnRequest, opts?: TurnOptions): TurnText;
  /** 人格卡（未配置时 null） */
  persona(): Persona | null;
  /** 面板/自检用的快照（只读，字段由装配点定义） */
  snapshot(): Record<string, unknown>;
  /** 她此刻"想说什么"的方向（动机层，只影响提示） */
  wonder(): Wonder;
  /** 主动开口的状态门限（脊髓用它构造对话端口；阈值本身在配置里） */
  proactiveGates(): ProactiveGates;
  /** 按这句话召回记忆（策略与遗忘曲线都在大脑里） */
  /**
   * §8.3 隐私隔离：第三参数是「眼前这个人是谁」。缺省=主人（看得见全部）。
   * 访客只能拿到 allow_share 的记忆或他自己的对话记录。
   */
  /**
   * 第四参数「哪个渠道」：给了它，调用侧会按记忆写时的情境指纹做一次线索重合重排
   * （VISION §5.6）。不给=原始顺序，与旧行为逐位一致；打分逻辑仍在 retrieve.ts，不受影响。
   */
  recall(query: string, limit?: number, visitor?: Visitor, channel?: string): readonly RecalledMemory[];
  /**
   * 推进时间（脊髓按拍调用）：状态松弛、记忆衰减、可能的睡眠都在里面。
   *
   * 返回值只给摘要——脊髓要的是"这一拍发生了什么"，不是让她替大脑做判断。
   */
  advance(hours: number): AdvanceSummary;
  /**
   * 睡眠巩固（脑内整理）：把够数的情节簇蒸馏成知识、清洗污点、推进人格漂移。
   * 输入只有最小簇大小；其余阈值都在配置里，调用方不该知道。
   */
  consolidate(opts?: { minSize?: number }): ConsolidateSummary;
  /**
   * 显式写一条记忆（soul_remember / 外部导入路径）。
   * 写路径必须过防火墙与污点标记——这由实现负责，端口只声明契约。
   */
  remember(input: RememberInput): RememberSummary;
  /**
   * 记下「这一句真的把她学到的某条知识讲出去了」（v5.2 §10.4 的入口）。
   *
   * 桥在发送成功之后调用；真正的结算在下一轮对话读到她/对方的反应时做
   * （见 `plugin/runtime.ts` 的 `settleKnowledgeFeedback`）。可选：老实现不实现也不报错。
   */
  noteKnowledgeUsed?(id: string): void;
}

/** 只读知识端口：工具层要「她最近学了什么」时用它，别直接摸 KnowledgeStore */
export interface KnowledgeReader {
  /** 语义/标签检索知识库 */
  searchKnowledge(query: string, limit?: number): readonly { readonly id: string; readonly content: string }[];
  /** 最近入库的知识（按吸收时间倒序） */
  recentKnowledge(limit?: number): readonly { readonly id: string; readonly content: string; readonly knowledge_type: string }[];
}

/**
 * 网页学习计划（W1，spec v2.3 §5.1）：脊髓层判档之后，告诉装配层「这一拍该不该查网页」。
 *
 * 为什么形状定义在这里而不是 `src/web/types.ts`：它由脊髓（brain 侧的 autonomy 层）产出、
 * 由装配层消费、`src/web`（tools 层）只读不改——两边都允许 import `src/ports/`，
 * 所以放在公共门面才不会逼出一只 tools→brain 的边（R3）。
 *
 * `allowSearch=false` 是常态（只有 full 档 + explore/空结果才可能 true）；
 * 脊髓层不发网络、不碰额度、不判 URL——那些在装配层与 `src/web/search.ts` 里。
 */
export interface LearningWebPlan {
  readonly allowSearch: boolean;
  /** query 的来源（隐私口径：learning-plan / hot-topic 只能来自学习计划或热榜） */
  readonly querySource: "learning-plan" | "hot-topic";
  /** 要查的关键词（learning-plan/hot-topic 时就是这一拍的学习关键词） */
  readonly keyword: string;
}

/**
 * 知识**写入**端口：工具层（B 站学习、外部导入）只通过它落库。
 *
 * 为什么必须有：`bili/ingest.ts` 现在直接拿 `KnowledgeStore` 往里 `put()`，
 * 等于绕过了防火墙（`memory/gurad` 的 vetWrite 走的是 runtime 的写入路径）。
 * 端口化之后，装配点可以在实现里接上 vetWrite / 污点标记，工具层不需要知道。
 * 幂等口径（同 id 不重复写）由实现方保证，端口层只声明 `has`。
 */
export interface KnowledgeWritePort {
  has(id: string): boolean;
  put(rec: KnowledgeRecord): void;
  /**
   * 幂等 id 的推导（`kn_<hash>`）。
   *
   * 工具层只给 tag（`bili:BV…`），**别在工具里自己拼 hash**：规则只有一份，
   * 在 `memory/consolidate.ts`；实现方（`KnowledgeStore.idFor`）已经把结果递出来。
   */
  idFor(tag: string): string;
}

/**
 * 旋钮读取端口：工具层要读「学习深度」这类引擎旋钮时用它（`bili/notes.ts`）。
 *
 * 由装配点把 `EngineConfig` + `knobNumber` 包成一个实现塞进来——工具层于是
 * 不必 `import { knobNumber } from "../engine/config.js"`（那是 R3）。
 * 缺失键的行为由实现决定（现在会抛，调用方自己兜底）。
 */
export interface KnobReader {
  read(name: string): number;
}

// ---------------------------------------------------------------------------
// 类型转出：工具层需要的「形状」都从这里拿，别再 import 大脑内部
// ---------------------------------------------------------------------------
//
// 这些是纯类型（编译后一行不剩），转出它们不会让工具层碰到大脑的实现；
// 不转出的话每个工具文件都得 `import type { … } from "../engine/clock.js"`，
// 于是每一次都算一条 R3 边——2026-11 清理存量违规时成批消掉的就是这类。

export type { ComposedDialogue, DialoguePort, LanguagePort, LanguageFeatures } from "./dialogue.js";
export type { DialogueRecall } from "./dialogue.js";
export type { ProactiveDecision, ProactiveInput, ProactiveIntentContext, ProactiveOptions } from "./dialogue.js";
export type { ReplyComposeInput, ProactiveComposeInput } from "./dialogue.js";
/** 时钟接口：工具层拿它当参数类型，别 import `engine/clock.js` */
export type { Clock } from "../engine/clock.js";
/** 关系阶段（面板要用它当字段类型） */
export type { Stage } from "../engine/bonds.js";
/** §4.3 五维分数与 §4.4 语境标签：工具层的启发式估计器输出它们的形状 */
export type { AppraisalRaw } from "../engine/appraisal.js";
export type { ContextTag } from "../learning/strategy.js";

/**
 * §4.3 一句 QQ 原话 → 五维 appraisal + 语言特征 + 事件类型（F297）。
 *
 * 形状放 ports 的原因：判定本身在大脑层（`src/psychology/appraisal-qq.ts`），
 * 但工具层的两个 QQ 桥要声明"我需要这个判定"，按 R3 它们只能看到 ports。
 */
export interface QqAppraisal {
  readonly appraisal: AppraisalRaw;
  /** §4.10 语言特征（纯函数产出，随这一轮一起交给引擎/渲染层） */
  readonly features: LanguageFeatures;
  readonly contextTag: ContextTag;
  /** 交给引擎 §4.4/事件层的事件类型（中文，`eventStyleFor` 认这些词） */
  readonly eventType: string;
}

export type QqAppraiseFn = (text: string, language: LanguagePort) => QqAppraisal;
/** L2 知识条目（工具层写入知识库时的记录形状） */
export type { KnowledgeRecord } from "../memory/knowledge.js";
/** 一轮的产物（OneBot 桥要拿 `mode/stage` 记流水账） */
export type { TurnText } from "../dialogue/turn-result.js";
/** 一轮的输入（F272：QQ 桥可把回合投给唯一写者，需要声明请求形状） */
export type { TurnRequest } from "../orchestrator/turn.js";
/** 人格卡形状：工具层的 shim 只负责读盘，解析由装配点注入的大脑实现做 */
export type { Persona } from "../dialogue/persona.js";

/**
 * 为什么这个文件在 `src/ports/` 而不是 `src/contracts/`
 *
 * `spec/config/layers.json` 的 `brainPublicPrefixes` 把「公共面」定义为 `src/ports/`：
 * 工具层（qq/bili/plugin）只允许 import 这里的类型，不允许 import 大脑内部实现。
 * 放在 contracts/ 下会被边界 lint 判成 R3（tools → brain 内部）。
 * 这个目录**只放类型**（`import type`），不放实现——放实现就等于给工具层开了后门。
 */

/**
 * 面板「意图面」（F269）：形状放这里，是因为面板数据层（F295 起在 `src/assembly/panel-payload.ts`）
 * 只能 import 本目录的类型；真正的读取（读文件、汇总）由装配点 `src/plugin/index.ts`
 * 调用大脑实现 `orchestrator/intent/panel-facts.ts` 后当参数递进来。
 *
 * 为什么不让面板自己读：面板读的是**别的进程**写的文件，读错了就是替她编一个安静；
 * 让它只是「画」，「读」与「判断」留在大脑侧，也方便单独测。
 */
export interface PanelIntentionItem {
  readonly id: string;
  readonly kind: string;
  readonly goal: string;
  readonly why: string;
  readonly blockedBy: string | null;
  readonly attempts: number;
  readonly status: string;
}

export interface PanelDshItem {
  readonly id: string;
  readonly kind: string;
  readonly at: number;
  readonly text: string;
  readonly expired: boolean;
}

export interface PanelGuardianItem {
  readonly requestId: string;
  readonly what: string;
  readonly ask: string;
  readonly at: number;
  readonly timedOut: boolean;
  readonly answered: boolean;
}

export interface PanelGapItem {
  readonly key: string;
  readonly kind: string;
  readonly missingFamily: string;
  readonly attempts: number;
}

export interface PanelIntentFacts {
  readonly intentions: { readonly open: number; readonly total: number; readonly items: readonly PanelIntentionItem[] };
  readonly dsh: { readonly waiting: number; readonly items: readonly PanelDshItem[] };
  readonly guardian: { readonly waiting: number; readonly items: readonly PanelGuardianItem[] };
  readonly gaps: readonly PanelGapItem[];
  readonly notes: readonly string[];
}

/**
 * 面板「状态快照」（F274）：唯一写者每拍写、插件只读。
 *
 * 只带四个会随拍变化的数字 + turns/mode，字段少是为了不出现两套解析。
 * 工具层面板拿到它时，用它覆盖本进程 runtime 里那部分旧值；读不到/过期就退回旧值。
 */
export interface PanelStateView {
  readonly atMs: number;
  readonly turns: number;
  readonly mode: string;
  readonly valence: number;
  readonly energy: number;
  readonly pressure: number;
  readonly maskIntegrity: number;
}
