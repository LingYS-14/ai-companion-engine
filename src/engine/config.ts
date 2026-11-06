/**
 * 配置装载 —— spec/config/engine.json 是唯一旋钮来源（SSOT），由
 * tools/audit/build_engine_v531.py 从 v5.3.1 附录 A 生成，禁止手改。
 *
 * 三条硬约束（教训来自 v5.0–v5.3 的五轮"假修"）：
 *   1. 引擎代码里不得出现裸数字：阈值/速率一律走 knobNumber / knobObject。
 *   2. kind 不对就抛错：把 `text`（"见 §9.3"）当数字用，等于静默默认值。
 *   3. 附录 A 的取值有三种形态，必须显式区分——number / object / strings / text / literal。
 *      其中 literal 是纯文本表达式（如 STAGE_THRESHOLD 的区间表），代码自己解析，
 *      解析失败必须抛错，不得"猜一个差不多的"。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type KnobKind = "number" | "object" | "strings" | "text" | "literal";

export interface Knob {
  /** 附录 A 的簇号，如 "A.1a" */
  readonly cluster: string;
  /** 原样保留的取值文本（人类可读，错误信息里要带出来） */
  readonly valueText: string;
  /** 解析后的值；kind=text/literal 时为 null 或字符串 */
  readonly value: unknown;
  readonly kind: KnobKind;
  readonly unit: string;
  readonly timeBase: string;
  readonly heat: "cold" | "warm" | "hot";
  readonly perArchetype: boolean;
  /** 该旋钮的真源不在附录（如 MODE_THRESHOLDS 来自 §4.6） */
  readonly derivedFrom?: string;
  // ── v5.4-P1 overlay 新增的登记字段（见 docs/DESIGN.md D14）──
  readonly owner?: string;
  readonly readers?: readonly string[];
  readonly range?: readonly [number, number];
  readonly derived_from?: string;
  readonly calibration?: string;
}

export interface ModeThresholdsRaw {
  readonly break_mask_max: number;
  readonly break_pressure_min: number;
  readonly defense_pressure_min: number;
  readonly obsession_entropy_min: number;
  readonly obsession_valence_max: number;
  readonly overdrive_valence_min: number;
  readonly overdrive_arousal_min: number;
  readonly lazy_energy_max: number;
}

export interface EngineConfig {
  readonly meta: {
    readonly spec: string;
    readonly source: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly selfCheck?: { readonly declared?: number; readonly actual?: number; readonly problems?: string[]; readonly ok?: boolean };
    readonly limits?: Readonly<Record<string, number>>;
    readonly modeThresholds: ModeThresholdsRaw;
    readonly supplemental: readonly { readonly name: string; readonly value: number; readonly unit: string }[];
  };
  readonly knobs: Readonly<Record<string, Knob>>;
}

export const DEFAULT_CONFIG_URL = new URL("../../spec/config/engine.json", import.meta.url);

/** v5.4-P1 overlay 的文件名；与 engine.json 同目录，键名冲突即 fail-closed */
export const OVERLAY_FILE = "v54.overlay.json";

interface OverlayDoc {
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly knobs?: Readonly<Record<string, Omit<Partial<Knob>, "value"> & { readonly value: unknown; readonly kind: KnobKind }>>;
}

function overlayPathFor(url: URL | string): string | null {
  const file = typeof url === "string" ? (url.startsWith("file:") ? fileURLToPath(url) : url) : fileURLToPath(url);
  const candidate = join(dirname(file), OVERLAY_FILE);
  return existsSync(candidate) ? candidate : null;
}

/**
 * 把 overlay 合进 v5.3.1 的 93 键表。
 *
 * 为什么不是「新 YAML 分层」（审计 B3/D14）：现有 `engine.json` 已经带 timeBase/perArchetype 元数据，
 * 再拆 10 个 schema 文件只会让 93 键迁移出错；overlay 只加不覆盖，冲突立刻抛错。
 */
function applyOverlay(doc: EngineConfig, path: string): EngineConfig {
  const overlay = JSON.parse(readFileSync(path, "utf8")) as OverlayDoc;
  const knobs: Record<string, Knob> = { ...doc.knobs };
  for (const [name, raw] of Object.entries(overlay.knobs ?? {})) {
    const existing = knobs[name];
    if (existing !== undefined && existing.kind !== "text") {
      throw new Error(`overlay 不得覆盖已注册的旋钮：${name}（${path}；只允许把 text 占位补成结构化值）`);
    }
    if (raw.kind === undefined) throw new Error(`overlay 旋钮 ${name} 缺 kind：${path}`);
    if (raw.value === undefined || raw.value === null) throw new Error(`overlay 旋钮 ${name} 缺 value：${path}`);
    knobs[name] = {
      cluster: raw.cluster ?? "A.7",
      valueText: raw.valueText ?? JSON.stringify(raw.value),
      value: raw.value,
      kind: raw.kind,
      unit: raw.unit ?? "—",
      timeBase: raw.timeBase ?? "none",
      heat: raw.heat ?? "warm",
      perArchetype: raw.perArchetype ?? false,
      ...(raw.owner === undefined ? {} : { owner: raw.owner }),
      ...(raw.readers === undefined ? {} : { readers: raw.readers }),
      ...(raw.range === undefined ? {} : { range: raw.range }),
      ...(raw.derived_from === undefined ? {} : { derived_from: raw.derived_from }),
      ...(raw.calibration === undefined ? {} : { calibration: raw.calibration }),
    };
  }
  return { ...doc, knobs };
}

export function loadConfig(url: URL | string = DEFAULT_CONFIG_URL): EngineConfig {
  const raw = readFileSync(url, "utf8");
  let doc = JSON.parse(raw) as EngineConfig;
  if (doc.meta?.spec === undefined) throw new Error(`engine.json 缺少 meta.spec：${String(url)}`);
  if (doc.meta.modeThresholds === undefined) throw new Error(`engine.json 缺少 meta.modeThresholds：${String(url)}`);
  const overlayPath = overlayPathFor(url);
  if (overlayPath !== null) doc = applyOverlay(doc, overlayPath);
  return doc;
}

function getKnob(cfg: EngineConfig, name: string): Knob {
  const k = cfg.knobs[name];
  if (k === undefined) throw new Error(`未注册的旋钮：${name}（engine.json 里没有；先补附录 A）`);
  return k;
}

function expectKind(cfg: EngineConfig, name: string, kind: KnobKind): Knob {
  const k = getKnob(cfg, name);
  if (k.kind !== kind) {
    throw new Error(`旋钮 ${name} 的 kind 是 ${k.kind}（值 ${JSON.stringify(k.valueText)}），不是 ${kind}：不能这样取值`);
  }
  return k;
}

/** 取数字型旋钮；kind 不是 number 就抛错（text/literal 绝不静默转换） */
export function knobNumber(cfg: EngineConfig, name: string): number {
  const k = expectKind(cfg, name, "number");
  if (typeof k.value !== "number") throw new Error(`旋钮 ${name} 的 value 不是数字：${JSON.stringify(k.value)}`);
  return k.value;
}

/** 取对象型旋钮（嵌套常量，如 LOAD_WEIGHTS / PACING_RATE） */
export function knobObject<T>(cfg: EngineConfig, name: string): T {
  const k = expectKind(cfg, name, "object");
  if (k.value === null || typeof k.value !== "object") throw new Error(`旋钮 ${name} 的 value 不是对象：${String(k.value)}`);
  return k.value as T;
}

/** 取字符串集合型旋钮（如 UNTRUSTED_SOURCES / RELATION_SOURCES） */
export function knobStrings(cfg: EngineConfig, name: string): readonly string[] {
  const k = expectKind(cfg, name, "strings");
  if (!Array.isArray(k.value)) throw new Error(`旋钮 ${name} 的 value 不是字符串数组：${JSON.stringify(k.value)}`);
  return k.value as string[];
}

/** 取纯文本型旋钮（如 STATE_INIT「见 §9.3」）；调用方必须自己解释 */
export function knobText(cfg: EngineConfig, name: string): string {
  const k = getKnob(cfg, name);
  if (k.kind !== "text" && k.kind !== "literal") {
    throw new Error(`旋钮 ${name} 的 kind 是 ${k.kind}，不是 text/literal`);
  }
  return k.valueText;
}

/** meta.supplemental 里的常量（TICK_HOURS / TAINT_WINDOW 等正文引用但未进附录的） */
export function supplementalNumber(cfg: EngineConfig, name: string): number {
  const hit = cfg.meta.supplemental.find((x) => x.name === name);
  if (hit === undefined) throw new Error(`meta.supplemental 里没有 ${name}`);
  return hit.value;
}

/** 基准 tick 的小时数（1/12 h = 5 min），一切"轮"的时间基准 */
export function tickHours(cfg: EngineConfig): number {
  return supplementalNumber(cfg, "TICK_HOURS");
}
