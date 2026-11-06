/**
 * §10.2 好奇心驱动（G5-④）。
 *
 * 规格原文（`tools/audit/fixtures/v531.txt` 段落 [1244]–[1255]）：
 *
 * ```python
 * def curiosity_targets(state, contacts):
 *     targets = []
 *     if state.pressure > 0.5 or state.attachment.anxiety > 0.6:
 *         targets.append("relationship_confirmation")
 *     if state.energy > 0.7: targets.append("funny_memes")
 *     if state.boredom > 0.6: targets.append("random_exploration")   # v5.4 补 boredom 声明
 *     for c in contacts:
 *         if c.pending_topic: targets.append(f"common_topic:{c.id}")
 *     return targets
 * ```
 *
 * 两条必须照规格保留的边界：
 *   1. **`state.boredom` 已按 v5.4-P1 D13 废弃**（原 §15 遗留 #1：规格 §4.1 从未声明这个状态字段）。
 *      现在第三条改成 `curiosity_gap`（= 1 − coverage_freshness）：缺口太大和太小都不够好奇，
 *      倒 U 形状见 `curiosityMotivation()`；峰值 `CURIOSITY_GAP_PEAK`=1/3。调用方没给 gap 就跳过
 *      并在 `skipped` 里写明，不把它偷偷塞进 S 层（那会让状态机多出第 14 字段）。
 *   2. §8.2 的污点规则里有一条专门给好奇心：`for target in curiosity_targets:
 *      if target.source in UNTRUSTED_SOURCES: taint_map["curiosity"] = "tainted"`。
 *      所以每个 target 必须带 `source`，否则这条规则无从执行。
 */

import { knobNumber, knobStrings, type EngineConfig } from "../engine/config.js";
import type { SState } from "../engine/state.js";
import type { Attachment } from "../dialogue/expression.js";

export type CuriosityKind =
  | "relationship_confirmation"
  | "funny_memes"
  | "random_exploration"
  | "common_topic";

export interface Contact {
  readonly id: string;
  /** 与该联系人之间有未聊完的话题（规格 `c.pending_topic`） */
  readonly pendingTopic?: boolean;
}

export interface CuriosityTarget {
  readonly kind: CuriosityKind;
  /** relationship_confirmation / funny_memes / random_exploration / common_topic:<id> */
  readonly label: string;
  /** 为什么想弄清这件事（给模型看的短句，不是日志） */
  readonly reason: string;
  /** 内容来源；决定是否触发 §8.2 的 curiosity 污点 */
  readonly source: string;
}

/** 知识覆盖新鲜度 → 好奇缺口（1 − 平均 freshness）。没有知识时返回 undefined：判据跳过，不伪造 0。 */
export function coverageGap(records: readonly { readonly freshness: number }[]): number | undefined {
  if (records.length === 0) return undefined;
  let sum = 0;
  for (const r of records) {
    const f = Number.isFinite(r.freshness) ? Math.min(1, Math.max(0, r.freshness)) : 0;
    sum += f;
  }
  return Math.min(1, Math.max(0, 1 - sum / records.length));
}

export interface CuriosityInput {
  readonly state: SState;
  /** D 层依恋；缺省会跳过 anxiety 判据（不假装知道象限） */
  readonly attachment?: Attachment;
  readonly contacts?: readonly Contact[];
  /**
   * v5.4-P1 D13：好奇缺口 = 1 − coverage_freshness（0 全熟、1 全陌生）。
   * 不传即跳过 random_exploration 判据并写进 skipped（见文件头第 1 条）。
   */
  readonly curiosityGap?: number;
  /** 应对能力（0..1）；缺省取 `state.energy`，倒 U 的第二个乘子 */
  readonly coping?: number;
}

export interface CuriosityResult {
  readonly targets: readonly CuriosityTarget[];
  /** 因规格缺项而跳过的判据，必须显式返回，不能静默 */
  readonly skipped: readonly string[];
}

const TRUSTED_CONTACT_SOURCE = "player";

/** v5.4-P1 D13：动机触发阈值（`random_exploration` 只在动机够高时才出现） */
const CURIOSITY_MOTIVATION_THRESHOLD = 0.4;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * v5.4-P1 §4.6 好奇心倒 U：`motivation = coping · clamp01(gap(1−gap)² / (p(1−p)²))`。
 *
 * 用峰值 `p` 归一化，使 `gap = CURIOSITY_GAP_PEAK` 时倒 U 项恰为 1；
 * `p` 必须严格在 (0,1)，否则归一化除零——配置错就直接抛，不静默退化。
 * 缺口太小（已经很熟）和太大（完全陌生到无从下手）都不该驱动探索，这是倒 U 的本意。
 */
export function curiosityMotivation(gap: number, coping: number, cfg: EngineConfig): number {
  const p = knobNumber(cfg, "CURIOSITY_GAP_PEAK");
  if (!(p > 0 && p < 1)) throw new RangeError(`CURIOSITY_GAP_PEAK 必须在 (0,1)：${String(p)}`);
  if (!Number.isFinite(gap)) throw new RangeError(`curiosity_gap 非有限值：${String(gap)}`);
  if (!Number.isFinite(coping)) throw new RangeError(`coping 非有限值：${String(coping)}`);
  const g = clamp01(gap);
  const peak = p * (1 - p) ** 2;
  return clamp01(coping) * clamp01((g * (1 - g) ** 2) / peak);
}

/**
 * §10.2 目标生成。顺序与规格一致（关系确认 → 搞笑 → 随机探索 → 共同话题），
 * 便于断言与日志比对；`common_topic` 按 contact 顺序稳定输出。
 */
export function curiosityTargets(input: CuriosityInput, cfg: EngineConfig): CuriosityResult {
  const { state, attachment, contacts = [], curiosityGap, coping } = input;
  const targets: CuriosityTarget[] = [];
  const skipped: string[] = [];

  const anxious = attachment === undefined ? undefined : attachment.anxiety > 0.6;
  if (attachment === undefined) skipped.push("attachment 未配置 → 跳过 anxiety>0.6 判据");

  if (state.pressure > 0.5 || anxious === true) {
    const why: string[] = [];
    if (state.pressure > 0.5) why.push(`pressure=${state.pressure.toFixed(2)}>0.5`);
    if (anxious === true) why.push("anxiety>0.6");
    targets.push({
      kind: "relationship_confirmation",
      label: "relationship_confirmation",
      reason: `关系不确定（${why.join("，")}）——想确认对方还在不在乎`,
      source: TRUSTED_CONTACT_SOURCE,
    });
  }

  if (state.energy > 0.7) {
    targets.push({
      kind: "funny_memes",
      label: "funny_memes",
      reason: `精力足（energy=${state.energy.toFixed(2)}>0.7）——想找点好笑的`,
      // 段子来自网络 ⇒ 不可信来源，写知识时必须带污点
      source: "web",
    });
  }

  if (curiosityGap === undefined) {
    skipped.push("curiosity_gap 未提供（v5.4-P1 D13：boredom 已废弃）→ 跳过 random_exploration 判据");
  } else {
    const motivation = curiosityMotivation(curiosityGap, coping ?? state.energy, cfg);
    // 已经想找乐子的轮次不再叠加随机探索：两条都是 web 来源，会重复打同一个污点
    const wantsFun = targets.some((t) => t.kind === "funny_memes");
    if (motivation >= CURIOSITY_MOTIVATION_THRESHOLD && !wantsFun) {
      targets.push({
        kind: "random_exploration",
        label: "random_exploration",
        reason: `好奇缺口 gap=${curiosityGap.toFixed(2)}（倒 U 峰值 ${knobNumber(cfg, "CURIOSITY_GAP_PEAK").toFixed(2)}，动机 ${motivation.toFixed(2)}）——想随便看看新东西`,
        source: "web",
      });
    }
  }

  for (const c of contacts) {
    if (c.pendingTopic === true) {
      targets.push({
        kind: "common_topic",
        label: `common_topic:${c.id}`,
        reason: `和 ${c.id} 有个没聊完的话题`,
        source: TRUSTED_CONTACT_SOURCE,
      });
    }
  }

  // v5.4-P1 §4.6：目标数上限由配置决定（保持顺序稳定，截尾而不是乱序）
  const cap = knobNumber(cfg, "CURIOSITY_TARGET_COUNT");
  return { targets: targets.slice(0, Math.max(1, Math.trunc(cap))), skipped };
}

/**
 * §8.2 好奇心污点：只要有一个目标来自不可信来源，就把 `curiosity` 标脏并记来源。
 *
 * 只**加**不**清**：清污属于 `shouldClearTaint` 的 2a–2d 判定，别在这里顺手擦掉。
 * 返回新的 taintMap（不原地改 S 层，保持单一写入点纪律）。
 */
export function taintForCuriosity(
  taintMap: SState["taintMap"],
  targets: readonly CuriosityTarget[],
  cfg: EngineConfig,
  now: number,
): { readonly taintMap: SState["taintMap"]; readonly tainted: boolean } {
  const untrusted = new Set(knobStrings(cfg, "UNTRUSTED_SOURCES"));
  const dirty = targets.map((t) => t.source).filter((s) => untrusted.has(s));
  if (dirty.length === 0) return { taintMap, tainted: false };
  const sources = [...new Set(dirty)].sort();
  return {
    taintMap: {
      ...taintMap,
      curiosity: { state: "tainted", since: now, sources },
    },
    tainted: true,
  };
}

/** 一行式摘要，供 `soul_curious` 输出 */
export function curiosityLine(targets: readonly CuriosityTarget[]): string {
  if (targets.length === 0) return "（暂无想弄清的事）";
  return targets.map((t) => `${t.label} ← ${t.reason}`).join("\n");
}
