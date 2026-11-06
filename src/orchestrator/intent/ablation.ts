/**
 * P3 结构性消融（VISION §9 记忆—行为因果性；纯函数，零 IO、零模型调用）
 *
 * 规格（docs/DESIGN.md 左右）对"记忆有没有影响行为"给了一条硬要求：
 * **只有 `structural_ablation` 显著才算因果成立**——不许拿"她提到了知识库里的词"当证据，
 * 也不许自评。理由是：她本来就会说人话，提到某个词很可能是碰巧，不能证明那条记忆起了作用。
 *
 * 做法：同一份输入跑两遍——原样一遍、拿掉某个"记忆组件"一遍——只看**行为**有没有变：
 *   - `replay_threads`：把回放记忆生成的线头（threads）摘掉；
 *   - `drive_history`：把上一拍的驱动向量摘掉（drift 只能来自累积器，历史不再参与）；
 *   - `knowledge_gap`：把知识覆盖缺口换成中性 0.5（知识不再影响好奇）。
 *
 * "行为变了"只认三件：浮现类别（emitted）、最高分意图（topKind）、会不会主动开口（wouldSpeak）。
 * 候选**排序**变了但 top 没变，单独记 `rankingChanged`——它是行为的前兆，不是行为本身，不拿来宣称因果。
 *
 * 本文件不读时钟、不读文件、不生成结论话术之外的人类文案；结果要由调用方交给 `metrics` / 一页纸工具。
 */

import type { IntentKind } from "./types.js";
import { runIntentTick, type IntentTickInput, type IntentTickResult } from "./tick.js";

/** 可以单独摘掉的记忆组件（PLAN-P3 的初始消融集；加新组件只在这里加一个分支与一句标签） */
export type AblationComponent = "replay_threads" | "drive_history" | "knowledge_gap";

export const ABLATION_COMPONENTS: readonly AblationComponent[] = ["replay_threads", "drive_history", "knowledge_gap"];

export const ABLATION_LABELS: Readonly<Record<AblationComponent, string>> = {
  replay_threads: "回放记忆（未完成的事 / 回声 / 沉睡记忆）",
  drive_history: "上一拍驱动历史（累积漂移的来源）",
  knowledge_gap: "知识覆盖缺口（好奇心来源）",
};

/** 样本太少时只报计数、不下结论（避免"两条样本就说因果成立"）。 */
export const MIN_ABLATION_SAMPLES = 5;
/** 行为改变率 < 0.2 记为弱影响；≥ 0.5 记强影响；中间记为有影响。 */
export const WEAK_EFFECT_RATE = 0.2;
export const STRONG_EFFECT_RATE = 0.5;

export interface AblationSample {
  readonly label: string;
  readonly input: IntentTickInput;
}

/** 一眼能看的行为快照：不比较分数，只比较"会做什么"。 */
export interface BehaviorSnapshot {
  readonly topKind: IntentKind | null;
  readonly emitted: readonly IntentKind[];
  readonly wouldSpeak: boolean;
  readonly candidateKinds: readonly IntentKind[];
}

export function behaviorOf(result: IntentTickResult): BehaviorSnapshot {
  return {
    topKind: result.top?.kind ?? null,
    emitted: [...result.emitted],
    wouldSpeak: result.wouldSpeak,
    candidateKinds: result.candidates.map((candidate) => candidate.kind),
  };
}

export interface BehaviorDiff {
  /** 行为是否变了（top / emitted / wouldSpeak 任一变化） */
  readonly changed: boolean;
  readonly topKindChanged: boolean;
  readonly emittedChanged: boolean;
  readonly wouldSpeakChanged: boolean;
  /** 候选排序变了但行为没变（前兆，不单独算因果） */
  readonly rankingChanged: boolean;
  /** 给人看的变化说明（中文短句；空 = 没变化） */
  readonly reasons: readonly string[];
}

function sameKinds(a: readonly IntentKind[], b: readonly IntentKind[]): boolean {
  return a.length === b.length && a.every((kind, index) => kind === b[index]);
}

export function compareBehavior(base: IntentTickResult, ablated: IntentTickResult): BehaviorDiff {
  const before = behaviorOf(base);
  const after = behaviorOf(ablated);
  const topKindChanged = before.topKind !== after.topKind;
  const emittedChanged = !sameKinds(before.emitted, after.emitted);
  const wouldSpeakChanged = before.wouldSpeak !== after.wouldSpeak;
  const rankingChanged = !sameKinds(before.candidateKinds, after.candidateKinds);
  const reasons: string[] = [];
  if (topKindChanged) reasons.push(`最高分意图 ${String(before.topKind)} → ${String(after.topKind)}`);
  if (emittedChanged) {
    reasons.push(`浮现类别 [${before.emitted.join(",") || "无"}] → [${after.emitted.join(",") || "无"}]`);
  }
  if (wouldSpeakChanged) reasons.push(`主动开口 ${before.wouldSpeak ? "会" : "不会"} → ${after.wouldSpeak ? "会" : "不会"}`);
  if (!topKindChanged && !emittedChanged && !wouldSpeakChanged && rankingChanged) {
    reasons.push(`候选排序变了（${before.candidateKinds.join(">")} → ${after.candidateKinds.join(">")}），但行为未变`);
  }
  return {
    changed: topKindChanged || emittedChanged || wouldSpeakChanged,
    topKindChanged,
    emittedChanged,
    wouldSpeakChanged,
    rankingChanged,
    reasons,
  };
}

/** 拿掉某个记忆组件后的输入（纯复制，不改原对象；本来就没有该组件时原样返回） */
export function ablateIntentInput(input: IntentTickInput, component: AblationComponent): IntentTickInput {
  switch (component) {
    case "replay_threads": {
      if (input.threads === undefined) return input;
      const { threads: _threads, ...rest } = input;
      return rest;
    }
    case "drive_history": {
      if (input.previousDrive === undefined) return input;
      const { previousDrive: _previousDrive, ...rest } = input;
      return rest;
    }
    case "knowledge_gap": {
      if (input.coverageGap === undefined) return input;
      const { coverageGap: _coverageGap, ...rest } = input;
      return rest;
    }
    default: {
      const exhaustive: never = component;
      throw new Error(`ablateIntentInput: 未知消融组件 ${String(exhaustive)}`);
    }
  }
}

export interface AblationSampleResult {
  readonly label: string;
  readonly changed: boolean;
  readonly topKindChanged: boolean;
  readonly emittedChanged: boolean;
  readonly wouldSpeakChanged: boolean;
  readonly rankingChanged: boolean;
  readonly reasons: readonly string[];
}

export interface AblationRow {
  readonly component: AblationComponent;
  readonly label: string;
  readonly samples: number;
  readonly changed: number;
  /** changed / samples；samples 为 0 时 null（不填 0） */
  readonly changedRate: number | null;
  readonly rankingChanged: number;
  readonly verdict: string;
  readonly details: readonly AblationSampleResult[];
}

export interface AblationReport {
  readonly samples: number;
  readonly minSamples: number;
  readonly rows: readonly AblationRow[];
  /** 一句话结论（中文；样本不足时不下因果结论） */
  readonly verdict: string;
  readonly note: string;
}

function rateOf(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

function rowVerdict(samples: number, changed: number): string {
  if (samples < MIN_ABLATION_SAMPLES) return `样本不足（${samples} < ${MIN_ABLATION_SAMPLES}），只报计数不下结论`;
  const rate = rateOf(changed, samples) ?? 0;
  if (changed === 0) return "无行为影响（这批样本上摘掉它也照样做同样的事）";
  if (rate < WEAK_EFFECT_RATE) return `弱影响（${changed}/${samples} 样本行为改变）`;
  if (rate < STRONG_EFFECT_RATE) return `有影响（${changed}/${samples} 样本行为改变）`;
  return `强影响（${changed}/${samples} 样本行为改变）`;
}

/**
 * 对一批样本跑结构性消融。
 *
 * 每个组件独立跑一遍（不组合消融——组合会互相掩盖，也说不清是谁的作用）。
 * 同一批输入 + 同一组件 + 固定噪声 → 结果逐字节相同（可复算），这是它能当证据的前提。
 */
export function runAblation(
  samples: readonly AblationSample[],
  components: readonly AblationComponent[] = ABLATION_COMPONENTS,
): AblationReport {
  const rows: AblationRow[] = [];
  for (const component of components) {
    const details: AblationSampleResult[] = [];
    let changed = 0;
    let rankingChanged = 0;
    for (const sample of samples) {
      const base = runIntentTick(sample.input);
      const ablated = runIntentTick(ablateIntentInput(sample.input, component));
      const diff = compareBehavior(base, ablated);
      if (diff.changed) changed += 1;
      if (diff.rankingChanged) rankingChanged += 1;
      details.push({
        label: sample.label,
        changed: diff.changed,
        topKindChanged: diff.topKindChanged,
        emittedChanged: diff.emittedChanged,
        wouldSpeakChanged: diff.wouldSpeakChanged,
        rankingChanged: diff.rankingChanged,
        reasons: diff.reasons,
      });
    }
    rows.push({
      component,
      label: ABLATION_LABELS[component],
      samples: samples.length,
      changed,
      changedRate: rateOf(changed, samples.length),
      rankingChanged,
      verdict: rowVerdict(samples.length, changed),
      details,
    });
  }

  const usable = rows.filter((row) => row.samples >= MIN_ABLATION_SAMPLES);
  const positive = usable.filter((row) => row.changed > 0);
  const verdict =
    samples.length < MIN_ABLATION_SAMPLES
      ? `样本不足（${samples.length} < ${MIN_ABLATION_SAMPLES}），本次消融不构成因果证据`
      : positive.length === 0
        ? "这批样本上没有观察到行为改变：记忆组件未显示因果作用（不等于没有，可能是样本不含相关情境）"
        : `观察到 ${positive.length}/${usable.length} 个记忆组件改变了行为：${positive.map((row) => row.component).join("、")}`;

  return {
    samples: samples.length,
    minSamples: MIN_ABLATION_SAMPLES,
    rows,
    verdict,
    note: "结构性消融只检验「摘掉该组件后行为是否变化」；行为不变不等于组件无用（可能本批样本里它没被触发）。",
  };
}

/** 一页纸文本（每行 ≤ 一行；调用方直接 console.log 或写报告） */
export function describeAblation(report: AblationReport): readonly string[] {
  const lines: string[] = [];
  lines.push(`结构性消融：${report.samples} 个样本（最少 ${report.minSamples} 个才下结论）`);
  for (const row of report.rows) {
    const rate = row.changedRate === null ? "—" : `${(row.changedRate * 100).toFixed(1)}%`;
    lines.push(`- ${row.component}（${row.label}）：行为改变 ${row.changed}/${row.samples}（${rate}）｜排序改变 ${row.rankingChanged}｜${row.verdict}`);
  }
  lines.push(`结论：${report.verdict}`);
  lines.push(`说明：${report.note}`);
  return lines;
}
