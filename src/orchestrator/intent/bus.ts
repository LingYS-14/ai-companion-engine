/**
 * 意向引擎 P0 —— B2 仲裁总线：累积器 / veto 窗口 / append-only 意图 WAL（VISION §4.3(b)、§4.5 #3、§5）。
 *
 * 为什么是"累积器越阈"而不是"声明一个意图"：§1 的工程结论——意图是**事件**，不是状态。
 * 缺口在扩大时（`driveDelta > 0`）累积器才会自然"憋不住"；越阈之后进 veto 窗口，窗口内只允许
 * risk 0 动作，窗口结束**重赛一局**（赢才执行，输降 `pending`），veto 是取消权而不是排队。
 *
 * 时钟纪律：本文件不调用系统时间函数；`at` 全部由调用方给（`Clock`），P0 因此可重放。
 * WAL 是 append-only NDJSON：每行是一条**版本**，同 id 后写覆盖先读；坏行只计数，绝不断档。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IntentionAttempt, IntentionRecord, IntentionStatus, IntentKind } from "./types.js";
import { INTENT_KINDS } from "./types.js";
import type { DriveVector } from "./types.js";

/* ------------------------------------------------------------------ *
 * 累积器
 * ------------------------------------------------------------------ */

/**
 * λ：累积器的"忘记速度"。规格（`docs/DESIGN.md`）写的是
 * `v(t+1)=(1−λ)v(t)+drift+ξ`，是连续时间的记忆衰减；而这里的 tick 是 5 分钟一拍
 * （`src/autonomy/config.ts` 的 `stateIntervalMs`）。**λ 必须按时间定义**：
 * 按"拍"直接给 0.35 等于每小时忘掉 99.8%，缺口刚长出来就被抹掉
 * ——这正是审计 §1 P0-1「94 拍 emitted=none」的一半原因。
 * 先验值：每小时忘 35%（不是运行期旋钮）。
 */
export const ACC_DECAY_PER_HOUR = 0.35;

/** 基准拍长（5 分钟），只用于把"每小时"折算成"一拍"的默认值。 */
export const ACC_TICK_MS = 5 * 60_000;

/**
 * 把"每小时忘记比例"折算成 dtMs 这一段时间的衰减系数：
 * `λ(dt) = 1 − (1−λ_hour)^(dt / hour)`。纯算术，不改全局状态。
 */
export function decayPerTick(dtMs: number, perHour: number = ACC_DECAY_PER_HOUR): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`decayPerTick: dtMs 必须是正有限数，收到 ${String(dtMs)}`);
  }
  if (!Number.isFinite(perHour) || perHour < 0 || perHour > 1) {
    throw new RangeError(`decayPerTick: perHour 必须在 [0,1]，收到 ${String(perHour)}`);
  }
  if (perHour === 0) return 0;
  return 1 - Math.pow(1 - perHour, dtMs / 3_600_000);
}

/** 5 分钟拍上的 λ（≈0.03553）。保留旧名：语义仍是"一拍的衰减系数"。 */
export const ACC_DECAY = decayPerTick(ACC_TICK_MS);

/**
 * drift 增益：缺口扩大 1.0 时给该类别加多少。
 *
 * 0.6 是按"每拍忘 35%"手算的；λ 改成按小时后，稳态 `v ≈ drift/λ` 被放大
 * 约 1/0.0355 ≈ 28 倍，若沿用 0.6 反而会在 ~57 拍（≈4.8 小时）才越阈，太慢。
 * 4.3 的标定要连同**缺口封顶**一起看：connection = 阶段基线 + 0.35×ramp(min/180)，
 * stranger 基线 0.8，所以 103 分钟就到顶 —— 可用的 widening 只有 ~21 拍。
 * 每拍 widening ≈0.00972、×4.3 ≈0.0418，在 λ=0.0355 下第 20 拍（≈100 分钟）越过
 * reach_out 的 θ=0.6（v20≈0.606），第 21 拍 ≈0.626。见
 * `test/intent-emission-reachable.test.ts`（数值不是运行期旋钮）。
 */
export const ACC_GAIN = 4.3;
/** 噪声尺度：`noise` 逐类乘这个数（P0 噪声由调用方给，确定性）。 */
export const ACC_NOISE_SCALE = 0.05;

/** 越阈阈值 θ_k（先验值）。越信任的类别（reach_out）门槛略高，避免"整天想说话"。 */
export const EMIT_THETA: Readonly<Record<IntentKind, number>> = Object.freeze({
  reach_out: 0.6,
  continue_thread: 0.55,
  explore: 0.5,
  create: 0.6,
  repair: 0.5,
  withdraw: 0.75,
  idle: 0.9,
});

/**
 * 7×6 的"缺口扩大 → 哪一类意图更憋不住"方向表（+1 = 该维扩大推高此类别；0 = 无关）。
 * 与 `candidates.KIND_IMPACT`（候选对缺口的**影响**）方向相反、用途不同，故单独一张表；
 * 写死，不进运行期配置（§4.3(a) 的纪律）。
 */
export const KIND_DRIFT_SIGN: Readonly<Record<IntentKind, Readonly<Partial<Record<keyof DriveVector, 1>>>>> =
  Object.freeze({
    reach_out: Object.freeze({ connection: 1 }),
    continue_thread: Object.freeze({ connection: 1, coherence: 1 }),
    explore: Object.freeze({ novelty: 1 }),
    create: Object.freeze({ coherence: 1, competence: 1 }),
    repair: Object.freeze({ integrity: 1, connection: 1 }),
    withdraw: Object.freeze({ energy: 1, integrity: 1 }),
    idle: Object.freeze({ energy: 1 }),
  });

export type Accumulator = Record<IntentKind, number>;

export function initialAccumulator(): Accumulator {
  const out = {} as Accumulator;
  for (const kind of INTENT_KINDS) out[kind] = 0;
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 逐维缺口变化率（本 tick − 上一 tick）；正 = 缺口在扩大。 */
export function gapWidening(previous: DriveVector, current: DriveVector): DriveVector {
  const out = {} as DriveVector;
  for (const key of Object.keys(current) as (keyof DriveVector)[]) {
    out[key] = current[key] - previous[key];
  }
  return out;
}

/** 把缺口扩大折成逐类 drift：只算正扩大（缺口缩小不会让意图更"憋不住"）。 */
export function driftFromWidening(widening: DriveVector, gain = ACC_GAIN): Accumulator {
  if (!Number.isFinite(gain) || gain < 0) throw new RangeError(`driftFromWidening: gain 非法：${String(gain)}`);
  const out = initialAccumulator();
  for (const kind of INTENT_KINDS) {
    let sum = 0;
    for (const [dim, sign] of Object.entries(KIND_DRIFT_SIGN[kind])) {
      if (sign !== 1) continue;
      const delta = widening[dim as keyof DriveVector];
      if (Number.isFinite(delta) && delta > 0) sum += delta;
    }
    out[kind] = sum * gain;
  }
  return out;
}

/**
 * 第 t 拍的确定性噪声 ξ（§4.3 的随机冲击项）。
 *
 * 为什么是确定性的：整条意图链要求同一份输入 + 同一份落盘状态能 100% 重放（P0 验收）。
 * 所以这里用 FNV-1a 把"这一拍的毫秒时间戳 + 类别名"哈希成一个稳定的 [-1, 1] 值，
 * 而不是 `Math.random()`——看起来像噪声，但重放时一模一样。
 *
 * 调用方（常驻进程）每拍传一次；测试与 golden 不传（缺省 0）。
 */
export function tickNoise(seedMs: number): Record<IntentKind, number> {
  if (!Number.isFinite(seedMs)) throw new RangeError(`tickNoise: seedMs 非法：${String(seedMs)}`);
  const out = {} as Record<IntentKind, number>;
  for (const kind of INTENT_KINDS) {
    let hash = 0x811c9dc5;
    const text = `${String(Math.floor(seedMs))}:${kind}`;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // 映射到 [-1,1)：除以 2^31 而不是 2^32，保证不会恰好等于 1
    out[kind] = (hash >>> 0) / 0x80000000 - 1;
  }
  return out;
}

export interface StepInput {
  /** 缺口扩大折算出的 drift（由 `driftFromWidening` 给；也可直接给 0 测衰减） */
  drift?: Partial<Record<IntentKind, number>>;
  /** 确定性噪声（P0 不引入 RNG；真随机 P1 再注入） */
  noise?: Partial<Record<IntentKind, number>>;
  /** 显式给 decay 时优先于 dtMs（测试/回放用）；不给则按 dtMs 折算。 */
  decay?: number;
  /** 距上一拍的时间（毫秒）；缺省 = 基准拍 `ACC_TICK_MS`（5 分钟）。 */
  dtMs?: number;
  noiseScale?: number;
}

/** v_k(t+1) = (1−λ)·v_k(t) + drift_k + ξ_k，clamp 到 [0,1]。纯函数。 */
export function stepAccumulator(
  previous: Readonly<Accumulator>,
  input: StepInput = {},
): Accumulator {
  const decay = input.decay ?? (input.dtMs === undefined ? ACC_DECAY : decayPerTick(input.dtMs));
  const noiseScale = input.noiseScale ?? ACC_NOISE_SCALE;
  if (!Number.isFinite(decay) || decay < 0 || decay > 1) {
    throw new RangeError(`stepAccumulator: decay 必须在 [0,1]，收到 ${String(decay)}`);
  }
  if (!Number.isFinite(noiseScale) || noiseScale < 0) {
    throw new RangeError(`stepAccumulator: noiseScale 非法：${String(noiseScale)}`);
  }
  const out = initialAccumulator();
  for (const kind of INTENT_KINDS) {
    const v = previous[kind] ?? 0;
    const drift = input.drift?.[kind] ?? 0;
    const noise = input.noise?.[kind] ?? 0;
    if (!Number.isFinite(v) || !Number.isFinite(drift) || !Number.isFinite(noise)) {
      throw new RangeError(`stepAccumulator: ${kind} 分量出现非有限值`);
    }
    out[kind] = clamp01((1 - decay) * v + drift + noise * noiseScale);
  }
  return out;
}

/**
 * 越阈即"浮现"：v_k > θ_k 且**没有同类活跃意图**（同类别同时只允许一个在跑，防止抖振）。
 * 返回顺序固定（`INTENT_KINDS`），便于 golden replay 对拍。
 */
export function emittedKinds(
  values: Readonly<Accumulator>,
  activeKinds: readonly IntentKind[],
  thetas: Readonly<Record<IntentKind, number>> = EMIT_THETA,
): IntentKind[] {
  const active = new Set(activeKinds);
  const out: IntentKind[] = [];
  for (const kind of INTENT_KINDS) {
    if (active.has(kind)) continue;
    const value = values[kind] ?? 0;
    const theta = thetas[kind];
    if (!Number.isFinite(value) || !Number.isFinite(theta)) continue;
    if (value > theta) out.push(kind);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * veto 窗口：T = clamp(T0·(1−urgency), T_min, T_max)，窗口结束重赛
 * ------------------------------------------------------------------ */

export const VETO_T0_MS = 180_000;
export const VETO_MIN_MS = 5_000;
export const VETO_MAX_MS = 600_000;

export function vetoWindowMs(urgency: number, opts: {
  t0?: number;
  min?: number;
  max?: number;
} = {}): number {
  const t0 = opts.t0 ?? VETO_T0_MS;
  const min = opts.min ?? VETO_MIN_MS;
  const max = opts.max ?? VETO_MAX_MS;
  for (const [name, value] of [["urgency", urgency], ["t0", t0], ["min", min], ["max", max]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`vetoWindowMs: ${name} 非法：${String(value)}`);
  }
  if (min > max) throw new RangeError(`vetoWindowMs: min(${min}) > max(${max})`);
  const raw = t0 * (1 - clamp01(urgency));
  return Math.min(max, Math.max(min, raw));
}

/** 是否仍在 veto 窗口内（elapsed 从 emit 时刻算起）。 */
export function withinVetoWindow(elapsedMs: number, windowMs: number): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError(`withinVetoWindow: elapsedMs 非法：${String(elapsedMs)}`);
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError(`withinVetoWindow: windowMs 非法：${String(windowMs)}`);
  }
  return elapsedMs < windowMs;
}

/** veto 窗口内只允许 risk 0（看/查/读）；副作用动作不得执行。 */
export function allowedDuringVeto(risk: number): boolean {
  return risk === 0;
}

export type CompetitionResult = "current" | "challenger";

/**
 * 二次竞争：窗口结束时重赛一局。挑战者**严格更高**才算赢——同分时在位者留任（滞回，§4.5 #5）。
 */
export function secondCompetition(currentScore: number, challengerScore: number): CompetitionResult {
  if (!Number.isFinite(currentScore) || !Number.isFinite(challengerScore)) {
    throw new RangeError("secondCompetition: 分数必须是有限数字");
  }
  return challengerScore > currentScore ? "challenger" : "current";
}

/* ------------------------------------------------------------------ *
 * IntentionRecord 的状态迁移（纯函数，每次都返回新对象）
 * ------------------------------------------------------------------ */

export interface NewIntentionInput {
  id: string;
  at: string;
  kind: IntentKind;
  goal: string;
  why: string;
  trigger?: IntentionRecord["trigger"];
  deadline?: string | null;
  sourceIds?: readonly string[];
}

export function newIntention(input: NewIntentionInput): IntentionRecord {
  if (!input.id || !input.at || !input.goal) {
    throw new RangeError("newIntention: id/at/goal 必填");
  }
  return {
    id: input.id,
    created_at: input.at,
    kind: input.kind,
    goal: input.goal,
    why: input.why,
    trigger: input.trigger ?? null,
    deadline: input.deadline ?? null,
    status: "pending",
    blocked_by: null,
    attempts: [],
    superseded_by: null,
    survival: 0,
    source_ids: [...(input.sourceIds ?? [])],
  };
}

/** 被 B3 之前的硬闸拦下：status='blocked' + blocked_by，**不丢弃**（可审计的事实）。 */
export function markBlocked(record: IntentionRecord, blockedBy: string): IntentionRecord {
  if (!blockedBy) throw new RangeError("markBlocked: blockedBy 必填（要能回答是被什么拦下的）");
  return { ...record, status: "blocked", blocked_by: blockedBy, survival: record.survival + 1 };
}

/** 赢得二次竞争 → active，存活计数 +1。 */
export function activate(record: IntentionRecord): IntentionRecord {
  if (record.status === "done" || record.status === "dropped") {
    throw new RangeError(`activate: ${record.status} 的意图不能再激活`);
  }
  return { ...record, status: "active", blocked_by: null, survival: record.survival + 1 };
}

export function addAttempt(record: IntentionRecord, attempt: IntentionAttempt): IntentionRecord {
  if (!Number.isFinite(attempt.agency) || attempt.agency < 0 || attempt.agency > 1) {
    throw new RangeError(`addAttempt: agency 必须在 [0,1]，收到 ${String(attempt.agency)}`);
  }
  const status: IntentionStatus = attempt.outcome === "ok" ? "done" : "pending";
  return {
    ...record,
    status,
    attempts: [...record.attempts, { ...attempt }],
    survival: record.survival + 1,
  };
}

export function dropIntention(record: IntentionRecord, supersededBy: string | null = null): IntentionRecord {
  return { ...record, status: "dropped", superseded_by: supersededBy };
}

/* ------------------------------------------------------------------ *
 * 意图 WAL：append-only NDJSON，同 id 后写覆盖先读
 * ------------------------------------------------------------------ */

export interface WalReadResult {
  /** 全部版本，按文件顺序 */
  versions: IntentionRecord[];
  /** 每个 id 的最新版本 */
  current: Map<string, IntentionRecord>;
  /** 坏行计数（JSON 解析失败 / 结构不符） */
  corrupt: number;
}

export interface WalAudit {
  versions: number;
  current: number;
  corrupt: number;
  byStatus: Record<IntentionStatus, number>;
  byKind: Record<IntentKind, number>;
  /** 存活率素材：有过 attempt 的意图占比（0..1） */
  withAttempts: number;
}

function isRecordShape(value: unknown): value is IntentionRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<IntentionRecord>;
  return (
    typeof rec.id === "string" &&
    typeof rec.created_at === "string" &&
    typeof rec.kind === "string" &&
    (INTENT_KINDS as readonly string[]).includes(rec.kind) &&
    typeof rec.goal === "string" &&
    typeof rec.status === "string" &&
    (rec.attempts === undefined || Array.isArray(rec.attempts))
  );
}

export class IntentionWAL {
  constructor(readonly path: string) {}

  /** 追加一条版本（append-only；先落盘再返回，失败直接抛给调用方，不假装写成功）。 */
  append(record: IntentionRecord): void {
    if (!isRecordShape(record)) throw new RangeError("IntentionWAL.append: 记录结构不合法");
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** 读全量版本 + 每个 id 的当前版本；坏行只计数。 */
  read(): WalReadResult {
    if (!existsSync(this.path)) return { versions: [], current: new Map(), corrupt: 0 };
    const text = readFileSync(this.path, "utf8");
    const versions: IntentionRecord[] = [];
    const current = new Map<string, IntentionRecord>();
    let corrupt = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      if (!isRecordShape(parsed)) {
        corrupt += 1;
        continue;
      }
      versions.push(parsed);
      current.set(parsed.id, parsed);
    }
    return { versions, current, corrupt };
  }

  /** 审计口径（给 health / 早报 / §9 指标用）：条数、状态分布、类别分布、有尝试占比。 */
  audit(): WalAudit {
    const { versions, current, corrupt } = this.read();
    const byStatus = Object.fromEntries(
      ["pending", "active", "blocked", "done", "dropped"].map((status) => [status, 0]),
    ) as Record<IntentionStatus, number>;
    const byKind = Object.fromEntries(INTENT_KINDS.map((kind) => [kind, 0])) as Record<IntentKind, number>;
    for (const record of current.values()) {
      byStatus[record.status] += 1;
      byKind[record.kind] += 1;
    }
    const total = current.size;
    const withAttempts = total === 0
      ? 0
      : [...current.values()].filter((record) => record.attempts.length > 0).length / total;
    return { versions: versions.length, current: total, corrupt, byStatus, byKind, withAttempts };
  }
}
