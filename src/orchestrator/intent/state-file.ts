/**
 * P2 跨重启一致性：把"一拍之后的状态"落成可以重启后读回的形状
 *
 * 规格验收第一条（docs/DESIGN.md）：**跨重启一致性探针通过**。
 * 这句话在工程上意味着两件事，必须分开验证：
 *   1. 状态能落盘、能读回，且读回的值与落盘前逐字段相同（本文件的 parse/equal）；
 *   2. 用读回的状态再跑一拍，结果与"没重启过"逐字段相同（consistency.ts 的探针）。
 *
 * 诚实边界：本文件不写文件（装配点负责写），只负责**形状、校验与比较**。
 * 落盘格式带 `version`；不认识的版本 fail-closed 返回错误，不猜测旧格式——
 * 静默兼容旧格式会让"字段丢了"变成"值变成默认 0"，这正是 F147/F170 两个坑的同构版本。
 */

import { DRIVE_KEYS, INTENT_KINDS, type DriveVector, type IntentKind } from "./types.js";
import { initialAccumulator, type Accumulator } from "./bus.js";

/** 落盘格式版本。改字段必须升版本，并写清迁移方式。 */
export const INTENT_STATE_VERSION = 1;

/** 常驻进程重启时需要接上的全部意图状态。 */
export interface IntentRuntimeState {
  readonly version: number;
  /** 落盘时刻（毫秒；由调用方从 Clock 取） */
  readonly savedAtMs: number;
  /** 上一拍结束时的累积器（7 类，全部 0..1） */
  readonly accumulator: Accumulator;
  /** 上一拍的驱动向量（6 维，全部 0..1）；null = 还没跑过 */
  readonly previousDrive: DriveVector | null;
  /** 上一次 tick 的时刻；null = 还没跑过 */
  readonly lastTickAtMs: number | null;
}

/** 新建一个"还没跑过"的初始状态。 */
export function initialIntentState(nowMs: number): IntentRuntimeState {
  return {
    version: INTENT_STATE_VERSION,
    savedAtMs: nowMs,
    accumulator: initialAccumulator(),
    previousDrive: null,
    lastTickAtMs: null,
  };
}

/** 序列化成稳定的 JSON 文本（键顺序固定：先 7 类再 6 维，便于 diff 与 golden）。 */
export function serializeIntentState(state: IntentRuntimeState): string {
  const accumulator: Record<string, number> = {};
  for (const kind of INTENT_KINDS) accumulator[kind] = state.accumulator[kind] ?? 0;
  const drive = state.previousDrive;
  const previousDrive = drive === null ? null : Object.fromEntries(DRIVE_KEYS.map((key) => [key, drive[key]]));
  return JSON.stringify(
    {
      version: state.version,
      savedAtMs: state.savedAtMs,
      accumulator,
      previousDrive,
      lastTickAtMs: state.lastTickAtMs,
    },
    null,
    0,
  );
}

export interface ParseStateResult {
  readonly state: IntentRuntimeState | null;
  readonly errors: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readUnit(obj: Record<string, unknown>, key: string, errors: string[], where: string): number | null {
  const raw = obj[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errors.push(`${where}.${key} 必须是有限数`);
    return null;
  }
  if (raw < 0 || raw > 1) {
    errors.push(`${where}.${key}=${String(raw)} 超出 [0,1]`);
    return null;
  }
  return raw;
}

/** 解析落盘状态；任何字段不合法都返回 state=null + 错误清单（fail-closed）。 */
export function parseIntentState(raw: string): ParseStateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: null, errors: ["不是合法 JSON"] };
  }
  if (!isPlainObject(parsed)) return { state: null, errors: ["顶层必须是对象"] };
  const errors: string[] = [];

  if (parsed["version"] !== INTENT_STATE_VERSION) {
    return { state: null, errors: [`不认识的版本 ${String(parsed["version"])}（只认 ${String(INTENT_STATE_VERSION)}）`] };
  }
  const KNOWN_TOP_KEYS = ["version", "savedAtMs", "accumulator", "previousDrive", "lastTickAtMs"] as const;
  for (const key of Object.keys(parsed)) {
    if (!(KNOWN_TOP_KEYS as readonly string[]).includes(key)) errors.push(`未知字段「${key}」（落盘格式变了要显式升版本）`);
  }

  const savedAtMs = parsed["savedAtMs"];
  if (typeof savedAtMs !== "number" || !Number.isFinite(savedAtMs) || savedAtMs <= 0) {
    errors.push("savedAtMs 必须是正有限数");
  }

  const rawAcc = parsed["accumulator"];
  const accumulator = {} as Accumulator;
  if (!isPlainObject(rawAcc)) {
    errors.push("accumulator 必须是对象");
  } else {
    for (const kind of INTENT_KINDS) {
      const value = readUnit(rawAcc, kind, errors, "accumulator");
      accumulator[kind] = value ?? 0;
    }
    for (const key of Object.keys(rawAcc)) {
      if (!(INTENT_KINDS as readonly string[]).includes(key)) errors.push(`accumulator 里有未知类别「${key}」`);
    }
  }

  const rawDrive = parsed["previousDrive"];
  let previousDrive: DriveVector | null = null;
  if (rawDrive !== null) {
    if (!isPlainObject(rawDrive)) {
      errors.push("previousDrive 必须是对象或 null");
    } else {
      const drive = {} as DriveVector;
      let ok = true;
      for (const key of DRIVE_KEYS) {
        const value = readUnit(rawDrive, key, errors, "previousDrive");
        if (value === null) ok = false;
        drive[key] = value ?? 0;
      }
      for (const key of Object.keys(rawDrive)) {
        if (!(DRIVE_KEYS as readonly string[]).includes(key)) errors.push(`previousDrive 里有未知维度「${key}」`);
      }
      previousDrive = ok ? drive : null;
    }
  }

  const rawLast = parsed["lastTickAtMs"];
  let lastTickAtMs: number | null = null;
  if (rawLast !== null) {
    if (typeof rawLast !== "number" || !Number.isFinite(rawLast) || rawLast <= 0) errors.push("lastTickAtMs 必须是正有限数或 null");
    else lastTickAtMs = rawLast;
  }

  if (errors.length > 0) return { state: null, errors };
  return {
    state: {
      version: INTENT_STATE_VERSION,
      savedAtMs: savedAtMs as number,
      accumulator,
      previousDrive,
      lastTickAtMs,
    },
    errors: [],
  };
}

/** 逐字段比较两份状态（浮点容差 1e-12，避免序列化往返的末位误差）。 */
export function stateEquals(a: IntentRuntimeState, b: IntentRuntimeState, epsilon = 1e-12): boolean {
  if (a.version !== b.version || a.lastTickAtMs !== b.lastTickAtMs) return false;
  for (const kind of INTENT_KINDS) {
    if (Math.abs(a.accumulator[kind] - b.accumulator[kind]) > epsilon) return false;
  }
  if (a.previousDrive === null || b.previousDrive === null) return a.previousDrive === b.previousDrive;
  for (const key of DRIVE_KEYS) {
    if (Math.abs(a.previousDrive[key] - b.previousDrive[key]) > epsilon) return false;
  }
  return true;
}

/** 一行摘要，供日志/探针输出。 */
export function describeIntentState(state: IntentRuntimeState): string {
  const top = (INTENT_KINDS as readonly IntentKind[])
    .map((kind) => ({ kind, value: state.accumulator[kind] }))
    .sort((x, y) => y.value - x.value)[0];
  const peak = top === undefined || top.value === 0 ? "无累积" : `${top.kind}=${top.value.toFixed(3)}`;
  const drive = state.previousDrive === null ? "未跑过" : "已投影";
  return `意图状态 v${String(state.version)}：${peak}，驱动 ${drive}，上一拍 ${String(state.lastTickAtMs ?? "无")}`;
}
