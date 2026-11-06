/**
 * §8.2 污点清洗 —— 块 3 的两层拆分。
 *
 * 层 A（per-var）：`S.taint_map[var]` 可清 —— 本文件判定的就是它。
 * 层 B（per-memory）：`retrieved_under_taint` 永不清，只参与检索排序。
 *
 * 判定顺序必须是 2a → 2b → 2c → 2d（任何一条成立就不清），因为四条理由里
 * 最宽松的那条（2d）一旦先行，其余三条就永远轮不到。
 *
 * 死锁教训（A11 原版）：把「被判定 tainted 且未消费」的候选当成阻断条件，
 * 而 tainted 候选本身永远无法通过有效候选判定 ⇒ 永不清污。修法是让 reject 就地置
 * consumed（见 `rejectCandidates`），并把 2b 的判断限定在**未被污染的**候选上。
 */

import { knobStrings, supplementalNumber, type EngineConfig } from "../engine/config.js";

/**
 * §8.2 `RETRIEVAL_AFFECTING_VARS`（M8-04）：**哪些状态量的污点会影响检索**。
 *
 * 规格原意不是"状态脏了就都算"：只有这四个（嫉妒/愉悦度/唤醒度/熵）参与
 * appraisal→检索这条链；像 curiosity 这种"我想弄清什么"的污点只影响洞见血统
 * （`deriveInsightProvenance` 的第三条路径），不该让"回忆"整体变色。
 *
 * 这条配置以前在 engine.json 里被规格抽取截成两段（`kind:"text"`、value 只剩
 * `["jealousy",`），全 src 零引用 —— M8-04 说的"声明式检查"就是让它有人读。
 */
export function retrievalAffectingVars(cfg: EngineConfig): readonly string[] {
  return knobStrings(cfg, "RETRIEVAL_AFFECTING_VARS");
}

/** 当前**仍在污染中**、且真的会影响检索的状态量（排序后返回，便于断言与日志） */
export function dirtyRetrievalVars(
  taintMap: Readonly<Record<string, { readonly state: Provenance }>>,
  cfg: EngineConfig,
): readonly string[] {
  const affecting = new Set(retrievalAffectingVars(cfg));
  return Object.entries(taintMap)
    .filter(([name, entry]) => affecting.has(name) && entry.state === "tainted")
    .map(([name]) => name)
    .sort();
}

/** 影响检索的四个状态量的快照（§6.6 `RETRIEVAL_AFFECTING_VARS`） */
export interface RetrievalVarSnapshot {
  readonly jealousy: number;
  readonly valence: number;
  readonly arousal: number;
  readonly entropy: number;
}

/** "被推动了"的判定阈值：小于它就是没动（不把 tick 的末位抖动当成污点） */
const TAINT_MOVE_EPS = 1e-6;

/**
 * §8.2 **新污染标记**（M8-04 的数据侧）：本轮驱动源里含不可信来源时，
 * 被它真正推动的"影响检索"状态量标脏。
 *
 * 规格原文是 `for var in driven_vars(appraisals): taint_map[var] = "tainted"`。
 * 仓库里 appraisal 没有"我推动了哪些变量"的声明，所以这里用可观测的定义代替：
 * **这一轮该量确实变了**才算被它驱动（`|after - before| > 1e-6`）。
 * 这是近似，但不是发明——它只会漏标（保守），不会把没动过的量标脏。
 *
 * 另外两条规格里的污点源还没接，原因记录在台账 F158：
 *   - `taint_map["retrieval"]`（检索查询本身由不可信内容构成）：仓库没有 query composition 来源；
 *   - `driven_vars(appraisals)` 的完整版：等 appraisal 输出"我动了谁"再说。
 */
export function taintForUntrustedTurn(input: {
  readonly taintMap: Readonly<Record<string, TaintVarState>>;
  readonly before: RetrievalVarSnapshot;
  readonly after: RetrievalVarSnapshot;
  readonly source: string;
  readonly cfg: EngineConfig;
  readonly now: number;
}): { readonly taintMap: Readonly<Record<string, TaintVarState>>; readonly tainted: readonly string[] } {
  const untrusted = knobStrings(input.cfg, "UNTRUSTED_SOURCES");
  if (!untrusted.includes(input.source)) return { taintMap: input.taintMap, tainted: [] };

  const next: Record<string, TaintVarState> = { ...input.taintMap };
  const tainted: string[] = [];
  for (const name of retrievalAffectingVars(input.cfg)) {
    const key = name as keyof RetrievalVarSnapshot;
    if (!(key in input.before) || !(key in input.after)) continue; // 配置里出现未知量：不猜
    if (Math.abs(input.after[key] - input.before[key]) <= TAINT_MOVE_EPS) continue;
    const prev = next[name];
    const sources = [...new Set([...(prev?.sources ?? []), input.source])].sort();
    // 规格在标脏时重置 taint_timestamp（清洗窗口重新计时），这里照做。
    next[name] = { state: "tainted", since: input.now, sources };
    tainted.push(name);
  }
  return { taintMap: next, tainted: tainted.sort() };
}

/** 检索期判据：有没有"影响检索"的污点。只有它为 true 才给记忆打 `retrieved_under_taint`。 */
export function hasRetrievalTaint(
  taintMap: Readonly<Record<string, { readonly state: Provenance }>>,
  cfg: EngineConfig,
): boolean {
  // §6.6：`taint_map["retrieval"]` 是规格里专给"检索这条通道"留的位置，
  // 它不参与 RETRIEVAL_AFFECTING_VARS 的逐个比较，但同样让检索整体不可信。
  if (taintMap["retrieval"]?.state === "tainted") return true;
  return dirtyRetrievalVars(taintMap, cfg).length > 0;
}

/** §8.2 洗白窗口；真源 meta.supplemental.TAINT_WINDOW（秒），这里只换算成毫秒 */
export function taintWindowMs(cfg: EngineConfig): number {
  return supplementalNumber(cfg, "TAINT_WINDOW") * 1000;
}

export type Provenance = "trusted" | "tainted";

export interface TaintVarState {
  // 可变字段：S 层的 taintMap（`Record<string, TaintEntry>`）是可写结构，
  // 这里若声明成 readonly，把算出来的新 map 交回 runtime 时会被类型系统挡住。
  state: Provenance;
  since: number;
  sources: string[];
}

export interface InsightCandidate {
  readonly id: string;
  readonly source_vars: readonly string[];
  readonly state_provenance: Provenance;
  consumed: boolean;
}

export interface TaintContext {
  readonly now: number;
  /** 当前是否仍由不可信来源驱动（2a） */
  readonly drivenByUntrusted: boolean;
  /** 与 var 相关的候选（已按 source_vars 过滤） */
  readonly candidates: readonly InsightCandidate[];
  readonly varState: TaintVarState;
  /** 洗白窗口（毫秒）：调用方传 taintWindowMs(cfg)，不传就没有默认值——避免又一份硬编码副本 */
  readonly windowMs: number;
}

export type TaintDecisionCode = "2a" | "2b" | "2c" | "2d";

export interface TaintDecision {
  readonly clear: boolean;
  readonly code: TaintDecisionCode;
  readonly reason: string;
}

export function shouldClearTaint(varName: string, ctx: TaintContext): TaintDecision {
  const window = ctx.windowMs;

  // 2a 仍在被不可信来源驱动
  if (ctx.drivenByUntrusted) {
    return { clear: false, code: "2a", reason: `${varName} 当前仍由不可信来源驱动` };
  }

  // 2b 还有未消费的**可信**候选（污点候选不算：它们永远无法"有效消费"，见死锁教训）
  const pending = ctx.candidates.find((c) => !c.consumed && c.state_provenance !== "tainted");
  if (pending) {
    return { clear: false, code: "2b", reason: `候选 ${pending.id} 尚未消费` };
  }

  // 2c 观察窗未过
  const elapsed = ctx.now - ctx.varState.since;
  if (elapsed < window) {
    return { clear: false, code: "2c", reason: `观察窗未满（${Math.round(elapsed / 3600_000)}h < 24h）` };
  }

  // 2d 可以清
  return { clear: true, code: "2d", reason: `${varName} 已满足全部清洗条件` };
}

/** 候选被拒绝时立即置 consumed —— 不这样做会复现 A11 的死锁 */
export function rejectCandidates(candidates: InsightCandidate[], id: string): boolean {
  const c = candidates.find((x) => x.id === id);
  if (!c) return false;
  c.consumed = true;
  return true;
}
