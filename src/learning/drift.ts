/**
 * 人格漂移（§5.4 双层判据）——第一层：只让**有行为证据**的三个维度慢慢动。
 *
 * 为什么只做 A/N/E 三个维度：
 * - A（宜人）有直接代理 = 最近一段时间的 valence 均值；
 * - N（神经质）有直接代理 = pressure 与 rumination 的均值；
 * - E（外向）有直接代理 = arousal 均值（她的唤醒水平就是"向外使劲"的量）。
 * O（开放）与 C（尽责）在我们现有的遥测里**没有可信代理**——用策略多样性硬凑一个数，
 * 等于凭空发明科学。所以这两维明确不漂，注释里写清楚，比编一个数好。
 *
 * 双层判据沿用 `learn.ts` 的 `classifyDrift`：先看幅度（EWMA 阈值），再看方向一致性；
 * 只有连续同向且幅度够，才记为签名级漂移；否则只做阻尼回 baseline（A20）。
 * 每次结账的步长被 `MAGNITUDE_CAP.ocean` 限幅（0.02），所以人格是**慢变量**，
 * 不会因为一晚的情绪把她的性格改掉。
 */

import { clamp01 } from "../engine/state.js";
import { knobNumber, type EngineConfig } from "../engine/config.js";
import { applyOceanDelta, classifyDrift, driftDelta, type DriftVerdict } from "./learn.js";

/** 会漂的三个维度；O/C 见文件头注释（不漂是决定，不是遗漏） */
export const DRIFT_DIMS = ["A", "N", "E"] as const;
export type DriftDim = (typeof DRIFT_DIMS)[number];

export type DriftOcean = Readonly<Record<DriftDim, number>>;

/** 每回合记一条"当时她是什么样"，攒够样本才结账 */
export interface TraitSample {
  readonly at: number;
  readonly valence: number;
  readonly arousal: number;
  readonly pressure: number;
  readonly rumination: number;
}

/** 样本上限：200 条 ≈ 一天多的对话量，超了丢最老——它是滚动证据，不是档案 */
export const TRAIT_SAMPLE_CAP = 200;

/** 少于这么多条样本不结账：一两条情绪不能算"人格倾向" */
export const TRAIT_SAMPLE_MIN = 12;

/** 漂移还需要至少这么多期历史才允许判"签名级"——否则第一晚就会被判成漂移 */
export const DRIFT_HISTORY_MIN = 7;

export interface DriftState {
  /** 当前生效的 OCEAN（只有 A/N/E 有意义）；缺省时等于 baseline */
  readonly ocean: DriftOcean;
  /** 每个维度最近几期的"估计值减当前值"，喂给 classifyDrift 的 EWMA/一致性判据 */
  readonly history: Readonly<Record<DriftDim, readonly number[]>>;
}

export interface DriftSettle {
  readonly verdicts: Readonly<Record<DriftDim, DriftVerdict>>;
  readonly ocean: DriftOcean;
  readonly history: Readonly<Record<DriftDim, readonly number[]>>;
  /** 有没有任何一维真的动了（动 = 变化量至少 1e-6，避免浮点噪声被记成"变了"） */
  readonly changed: boolean;
  /** 给人看的一句话（日志/台账用）：`A+0.012 N-0.003 E0（noise）` */
  readonly note: string;
}

/** 从最近这批样本估她的"实际倾向"。样本为空时返回空表（不结账） */
export function estimateTraits(samples: readonly TraitSample[]): Partial<Record<DriftDim, number>> {
  if (samples.length === 0) return {};
  const mean = (f: (s: TraitSample) => number): number => samples.reduce((sum, s) => sum + f(s), 0) / samples.length;
  return {
    A: clamp01(mean((s) => s.valence)),
    // 压力本身已经含"被压住"的部分，反刍再补一半权重：反复想同一件事，比一次压力更像 N
    N: clamp01(mean((s) => s.pressure) + 0.5 * mean((s) => s.rumination)),
    E: clamp01(mean((s) => s.arousal)),
  };
}

/** 每个维度最近 `DRIFT_HISTORY_MIN` 期的偏差（新的在后） */
function pushHistory(prev: readonly number[], next: number): readonly number[] {
  const merged = [...prev, next];
  return merged.slice(Math.max(0, merged.length - DRIFT_HISTORY_MIN));
}

/**
 * 结账一次：用 `samples` 的估计值推进当前 OCEAN。
 *
 * - `baseline` 来自人格卡（她"本来是谁"）；
 * - `state` 是上次结账留下的当前值与历史（没有就按 baseline 开始）；
 * - 证据不足（样本少 / 历史短）时**只做阻尼**，不动人格；
 * - 判成 NOISE / OSCILLATION 时也回 baseline，只是慢（`DRIFT_DAMPING_RATE`）。
 */
export function settleDrift(
  baseline: DriftOcean,
  state: DriftState | null,
  samples: readonly TraitSample[],
  cfg: EngineConfig,
): DriftSettle {
  const estimate = estimateTraits(samples);
  const verdicts = {} as Record<DriftDim, DriftVerdict>;
  const nextOcean = {} as Record<DriftDim, number>;
  const nextHistory = {} as Record<DriftDim, readonly number[]>;
  let changed = false;
  const parts: string[] = [];

  for (const dim of DRIFT_DIMS) {
    const current = state === null ? baseline[dim] : state.ocean[dim];
    const prevHistory = state === null ? [] : state.history[dim];
    const guess = estimate[dim];
    const dev = guess === undefined ? 0 : guess - current;

    // 历史不够长就不许判"签名级"：classifyDrift 对 1 条 0.2 的偏差也会判 SIGNATURE，
    // 那会让第一晚就改人格。这里显式要求满窗。
    const verdict: DriftVerdict =
      samples.length < TRAIT_SAMPLE_MIN || prevHistory.length + 1 < DRIFT_HISTORY_MIN
        ? "NOISE"
        : classifyDrift({ deltas: [...prevHistory, dev] }, cfg);

    // 证据型漂移：按"估计 - 当前"推；无证据：把已积累的偏离阻尼回 baseline
    const raw = verdict === "SIGNATURE_DRIFT" ? dev : current - baseline[dim];
    const step = driftDelta(verdict, raw, cfg);
    const next = applyOceanDelta(current, step, cfg);
    verdicts[dim] = verdict;
    nextOcean[dim] = next;
    nextHistory[dim] = pushHistory(prevHistory, dev);
    const moved = next - current;
    if (Math.abs(moved) >= 1e-6) changed = true;
    parts.push(`${dim}${moved >= 0 ? "+" : ""}${moved.toFixed(3)}`);
  }

  return {
    verdicts,
    ocean: nextOcean,
    history: nextHistory,
    changed,
    note: `${parts.join(" ")}（${verdicts.A === "SIGNATURE_DRIFT" || verdicts.N === "SIGNATURE_DRIFT" || verdicts.E === "SIGNATURE_DRIFT" ? "signature" : "steady"}）`,
  };
}

/** 从人格卡里取 baseline；O/C 不参与，所以这里只投影 A/N/E */
export function baselineFrom(ocean: { readonly A: number; readonly N: number; readonly E: number }): DriftOcean {
  return { A: clamp01(ocean.A), N: clamp01(ocean.N), E: clamp01(ocean.E) };
}

/** 给面板/日志用：这一版漂移的幅度（每个维度相对 baseline 的偏离） */
export function driftOffsets(baseline: DriftOcean, ocean: DriftOcean): DriftOcean {
  return {
    A: ocean.A - baseline.A,
    N: ocean.N - baseline.N,
    E: ocean.E - baseline.E,
  };
}

/** 读一个旋钮：漂移的四个参数都在注册表里，缺失就抛（fail-closed 是这个项目的口径） */
export function driftConfig(cfg: EngineConfig): { ewma: number; consistency: number; damping: number } {
  return {
    ewma: knobNumber(cfg, "DRIFT_EWMA_THRESHOLD"),
    consistency: knobNumber(cfg, "DRIFT_CONSISTENCY_THRESHOLD"),
    damping: knobNumber(cfg, "DRIFT_DAMPING_RATE"),
  };
}
