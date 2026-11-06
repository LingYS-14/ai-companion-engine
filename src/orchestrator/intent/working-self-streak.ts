/**
 * §5.2 的具体性 streak：把「连续几次只想起结论、想不起事情」跨回合记住。
 *
 * 为什么需要它：`working-self.ts` 的 `diagnoseWorkingSelf` 早就算得出
 * 「具体性 <0.5 连续 20 次 → 放宽闸门 1.2」，但那个计数器一直是调用方手里的 0——
 * 每次召回都是新的一轮，计数器丢了，放宽条件在线上永远不会成立。
 *
 * 为什么放在**调用侧**而不是检索内核：`retrieve.ts` 的权重/ACT-R/top-k 是冻结区，
 * 这里只记「最近几轮具体性怎么样」，不参与打分。
 *
 * 并发：插件进程（窗口）与常驻 qq-runner 可能同时写同一个文件。这类文件只是诊断计数，
 * 丢一次更新最多让"连续"多数一轮、不会造成错误放宽；因此用「读-改-原子写」的尽力而为，
 * 不加锁（加锁会把她唯一的写者纪律扩展到两个进程，得不偿失）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WORKING_SELF_STATE_VERSION = 1 as const;

/** 具体性低于这个值算「只记得结论」；与 `working-self.ts` 的 `CONCRETENESS_FLOOR` 同源。 */
export const CONCRETENESS_FLOOR = 0.5;
/** 连续多少轮低具体性才放宽（§5.2 的 N≈20）。 */
export const LOW_CONCRETENESS_STREAK = 20;
/** 放宽系数：门槛 ÷1.2（方向见 `working-self.ts:relaxedValueFloor` 的说明）。 */
export const RELAX_FACTOR = 1.2;
/** 具体性回到这个水平，就收回放宽（临时档位，不是永久松绑）。 */
export const RECOVER_CONCRETENESS = 0.8;

export interface WorkingSelfState {
  readonly version: typeof WORKING_SELF_STATE_VERSION;
  /** 写入时刻（调用方给，本层不读时钟） */
  readonly savedAtMs: number;
  /** 连续多少轮具体性低于阈值 */
  readonly lowConcretenessStreak: number;
  /** 最近一轮的具体性；null = 这一轮没有命中（不能当成"具体性 0"） */
  readonly lastConcreteness: number | null;
  /** 最近一次触发的闸门备注（给看板/早报读，没有就 null） */
  readonly lastAlarm: string | null;
  /** 当前放宽系数（1 = 正常；1.2 = 具体性长期太低后放宽一档） */
  readonly relaxFactor: number;
}

/** `<root>/data/working-self-<characterId>.json`；root 通常是数据目录的父目录。 */
export function workingSelfStatePath(root: string, characterId: string): string {
  return join(root, "data", `working-self-${characterId}.json`);
}

/** 调用方手里已经是数据目录时用它（装配点通常只有 `conf.dataDir`）。 */
export function workingSelfStatePathInDataDir(dataDir: string, characterId: string): string {
  return join(dataDir, `working-self-${characterId}.json`);
}

export function initialWorkingSelfState(savedAtMs: number): WorkingSelfState {
  return {
    version: WORKING_SELF_STATE_VERSION,
    savedAtMs,
    lowConcretenessStreak: 0,
    lastConcreteness: null,
    lastAlarm: null,
    relaxFactor: 1,
  };
}

/** 键序固定，便于 diff / 人工核对。 */
export function serializeWorkingSelfState(state: WorkingSelfState): string {
  const out = {
    version: WORKING_SELF_STATE_VERSION,
    savedAtMs: state.savedAtMs,
    lowConcretenessStreak: state.lowConcretenessStreak,
    lastConcreteness: state.lastConcreteness,
    lastAlarm: state.lastAlarm,
    relaxFactor: state.relaxFactor,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface ParseWorkingSelfStateResult {
  readonly state: WorkingSelfState | null;
  readonly errors: readonly string[];
}

/**
 * 解析。坏文件返回 null 而不是「从零开始」：
 * 调用方可以选择重置，但必须显式知道文件坏了——静默重置会让 streak 悄悄归零、
 * 放宽条件永远差一口气，而日志里什么都看不出来。
 */
export function parseWorkingSelfState(raw: string): ParseWorkingSelfStateResult {
  const errors: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: null, errors: ["不是合法 JSON"] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { state: null, errors: ["顶层不是对象"] };
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "savedAtMs",
    "lowConcretenessStreak",
    "lastConcreteness",
    "lastAlarm",
    "relaxFactor",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`未知字段：${key}`);
  }
  if (record.version !== WORKING_SELF_STATE_VERSION) errors.push(`版本不符：${String(record.version)}`);
  if (typeof record.savedAtMs !== "number" || !Number.isFinite(record.savedAtMs) || record.savedAtMs <= 0) {
    errors.push("savedAtMs 非法");
  }
  if (
    typeof record.lowConcretenessStreak !== "number" ||
    !Number.isInteger(record.lowConcretenessStreak) ||
    record.lowConcretenessStreak < 0
  ) {
    errors.push("lowConcretenessStreak 必须是非负整数");
  }
  if (record.lastConcreteness !== null) {
    const c = record.lastConcreteness;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) errors.push("lastConcreteness 必须在 [0,1]");
  }
  if (record.lastAlarm !== null && typeof record.lastAlarm !== "string") errors.push("lastAlarm 必须是字符串或 null");
  // F205 之前的文件没有 relaxFactor：缺省按 1 读，不算坏文件（向后兼容，不升版本号）
  if (record.relaxFactor !== undefined) {
    const r = record.relaxFactor;
    if (typeof r !== "number" || !Number.isFinite(r) || r < 1) errors.push("relaxFactor 必须是 ≥1 的数");
  }
  if (errors.length > 0) return { state: null, errors };
  return {
    state: {
      version: WORKING_SELF_STATE_VERSION,
      savedAtMs: record.savedAtMs as number,
      lowConcretenessStreak: record.lowConcretenessStreak as number,
      lastConcreteness: (record.lastConcreteness as number | null) ?? null,
      lastAlarm: (record.lastAlarm as string | null) ?? null,
      relaxFactor: typeof record.relaxFactor === "number" ? record.relaxFactor : 1,
    },
    errors: [],
  };
}

export interface AdvanceWorkingSelfInput {
  /** 这一轮的具体性；null = 没有命中（保持原 streak，不清零） */
  readonly concreteness: number | null;
  /** 这一轮触发的闸门备注（`describeWorkingSelfAlarm` 或 report.selfNote），没有就 null */
  readonly alarmNote?: string | null;
  readonly nowMs: number;
}

/**
 * 推进一轮：低于阈值 +1，够具体就清零，没有命中则原样保留。
 *
 * 纯函数，不改入参；非法 concreteness（NaN/负数/越界）抛 RangeError——
 * 静默夹取会把"我们的 bug"写成"她这轮不够具体"，反而拖慢放宽。
 */
export function advanceWorkingSelfState(prev: WorkingSelfState, input: AdvanceWorkingSelfInput): WorkingSelfState {
  if (!Number.isFinite(input.nowMs) || input.nowMs <= 0) {
    throw new RangeError(`nowMs 必须是正数，收到 ${String(input.nowMs)}`);
  }
  let streak = prev.lowConcretenessStreak;
  let relaxFactor = prev.relaxFactor;
  let lastAlarm = input.alarmNote === undefined ? prev.lastAlarm : input.alarmNote;
  if (input.concreteness !== null) {
    const c = input.concreteness;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      throw new RangeError(`concreteness 必须在 [0,1]，收到 ${String(c)}`);
    }
    streak = c < CONCRETENESS_FLOOR ? streak + 1 : 0;
    // 够具体了：收回放宽（放宽是临时的，看到具体性恢复就回来）
    if (c >= RECOVER_CONCRETENESS) relaxFactor = 1;
    // 连续够多轮只记得结论：放宽一档，并把 streak 归零重新开始数
    // （不归零会每轮都触发一次 self_note，日志上看不出"有没有真的放宽"）
    if (streak >= LOW_CONCRETENESS_STREAK) {
      relaxFactor = RELAX_FACTOR;
      streak = 0;
      if (lastAlarm === null || lastAlarm === undefined) lastAlarm = "我最近只记得结论，不记得事情了。";
    }
  }
  return {
    version: WORKING_SELF_STATE_VERSION,
    savedAtMs: input.nowMs,
    lowConcretenessStreak: streak,
    lastConcreteness: input.concreteness === null ? prev.lastConcreteness : input.concreteness,
    lastAlarm,
    relaxFactor,
  };
}

/** 一行日志：`working-self streak=3 last=0.00`。 */
export function describeWorkingSelfState(state: WorkingSelfState): string {
  const last = state.lastConcreteness === null ? "none" : state.lastConcreteness.toFixed(2);
  const relax = state.relaxFactor === 1 ? "" : ` relax=${state.relaxFactor.toFixed(1)}`;
  return `working-self streak=${String(state.lowConcretenessStreak)} last=${last}${relax}`;
}

export interface ReadWorkingSelfStateResult {
  readonly state: WorkingSelfState;
  readonly existed: boolean;
  readonly errors: readonly string[];
}

/**
 * 读；文件不存在返回初值（existed=false 但不报错——第一天本来就没有文件）。
 * 文件损坏返回初值 + errors，调用方自己决定要不要记日志。
 */
export function readWorkingSelfState(path: string, nowMs: number): ReadWorkingSelfStateResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: initialWorkingSelfState(nowMs), existed: false, errors: [] };
  }
  const parsed = parseWorkingSelfState(raw);
  if (parsed.state === null) {
    return { state: initialWorkingSelfState(nowMs), existed: true, errors: parsed.errors };
  }
  return { state: parsed.state, existed: true, errors: [] };
}

/** 原子写：tmp + rename；目录不存在就建。 */
export function writeWorkingSelfState(path: string, state: WorkingSelfState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, serializeWorkingSelfState(state), "utf8");
  renameSync(tmp, path);
}
