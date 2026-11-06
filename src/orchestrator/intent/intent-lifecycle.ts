import type { CandidateCause, IntentionRecord } from "./types.js";
import { DRIVE_LABELS, SPEAK_INTENT_KINDS } from "./types.js";
import { GIVE_UP_ATTEMPTS } from "./capability.js";
import { dropIntention } from "./bus.js";

/**
 * A3：意图表自身的两处断点（审计 §1 P1）。
 *
 * 1. `why` 以前读 `cause.reason`——`CandidateCause` 里没有这个字段
 *    （`types.ts` 只有 `{drive, gap, memoryId?}`），于是每条意图的"为什么"都是
 *    同一句「缺口变大」，看起来像原因，其实什么都没说。
 * 2. `dropIntention` 零生产调用：试满 5 次的意图只能靠 7 天保留自己消失。
 *    这不是"放弃"，是"过期"——规格要的是前者。
 *
 * 两层都做成纯函数，让装配点只负责读/写盘。
 */

/** 把候选的"逐维缺口"拼成一句人话：`想说话（缺口 0.62）、累了（缺口 0.41）`。 */
export function whyPhrase(because: readonly CandidateCause[]): string {
  const parts = because
    .filter((cause) => Number.isFinite(cause.gap) && cause.gap > 0)
    .map((cause) => `${DRIVE_LABELS[cause.drive] ?? String(cause.drive)}（缺口 ${cause.gap.toFixed(2)}）`);
  return parts.length > 0 ? parts.join("、") : "缺口变大";
}

export interface DropExhaustedResult {
  /** 放弃之后的记录（没有变化时返回**同一个数组**，方便调用方判断要不要写盘） */
  readonly records: readonly IntentionRecord[];
  /** 这一轮被放弃的 id（顺序同输入） */
  readonly dropped: readonly string[];
}

/**
 * 试满 `GIVE_UP_ATTEMPTS`（5）次的未结意图 → dropped。
 * 只处理 pending/active/blocked/held；done/dropped 原样保留（历史不改写）。
 *
 * F312：`held` 也算未结。她连续几拍「想过、决定先不说」同样是这条意图没推进；
 * 不纳入的话它会一直占着"同类还开着"，直到 7 天保留期自己过期——那是过期，不是放弃。
 */
export function dropExhaustedIntentions(
  records: readonly IntentionRecord[],
  giveUpAttempts: number = GIVE_UP_ATTEMPTS,
): DropExhaustedResult {
  if (!Number.isInteger(giveUpAttempts) || giveUpAttempts < 1) {
    throw new RangeError(`dropExhaustedIntentions: giveUpAttempts 必须是正整数，收到 ${String(giveUpAttempts)}`);
  }
  const dropped: string[] = [];
  let next: readonly IntentionRecord[] = records;
  for (const record of records) {
    const open =
      record.status === "pending" ||
      record.status === "active" ||
      record.status === "blocked" ||
      record.status === "held";
    if (!open) continue;
    if (record.attempts.length < giveUpAttempts) continue;
    const tail = next.filter((item) => item.id !== record.id);
    next = [...tail, dropIntention(record, null)];
    dropped.push(record.id);
  }
  return { records: next, dropped };
}

/**
 * F239：被**暂时性**硬闸拦下的意图，闸放开后应当重新排队。
 *
 * 为什么单独做：`gate.ts` 的 quota 是"这一小时没有额度"，不是"这件事她不该做"。
 * 但被拦的表记录会一直是 `blocked`，而 `openIntentions` 又让它占着"同类已开着"的位置，
 * 于是额度恢复后同一类意图既不会重试、也不会新建——一句想说而没说的话被永久关在表里。
 *
 * 只复活"会自愈的"拦截（默认 quota）；`distrust`（关系太生）和 `single_writer`（并发写）
 * 各有自己的恢复路径，不在这里替它们决定。attempts 不增加：复活不是一次尝试。
 */
export const RETRYABLE_BLOCKERS: readonly string[] = ["quota"];

export interface ReviveBlockedResult {
  /** 复活之后的记录（没变化时返回**同一个数组**，方便调用方判断要不要写盘） */
  readonly records: readonly IntentionRecord[];
  /** 这一轮被放回 pending 的 id（顺序同输入） */
  readonly revived: readonly string[];
}

export function reviveBlockedIntentions(
  records: readonly IntentionRecord[],
  options: { readonly gateAllowed: boolean; readonly retryable?: readonly string[] },
): ReviveBlockedResult {
  const retryable = options.retryable ?? RETRYABLE_BLOCKERS;
  if (!options.gateAllowed) return { records, revived: [] };
  const revived: string[] = [];
  let next: readonly IntentionRecord[] = records;
  for (const record of records) {
    if (record.status !== "blocked") continue;
    const blocker = record.blocked_by;
    if (typeof blocker !== "string" || !retryable.includes(blocker)) continue;
    next = next.map((item) =>
      item.id === record.id ? { ...item, status: "pending" as const, blocked_by: null } : item,
    );
    revived.push(record.id);
  }
  return { records: revived.length === 0 ? records : next, revived };
}


/**
 * F240：从意图表里挑出"还没说出口、但值得再说一次"的那条。
 *
 * 为什么要它：A4 把"主动开口"收紧成只有 `outlet=speak`（这一拍确实憋不住）才走；
 * 但额度常常在她憋不住的那一拍刚好用完——那条话被记成 `blocked`，额度回来复活成 `pending`，
 * 而 pending 本身不会让任何一拍照常开口。于是"想说而没说的话"仍然会烂在表里。
 *
 * 规则：只看 pending/active（blocked 等复活、done/dropped 是历史），只看会开口的类别，
 * 试满次数的不再看；同一时刻挑**最新**那条（最近的心里话优先），同时间按 id 稳定排序。
 * 纯函数，不改入参。
 */
export function pickSpeakableIntention(
  records: readonly IntentionRecord[],
  kinds: readonly string[] = SPEAK_INTENT_KINDS,
): IntentionRecord | null {
  let best: IntentionRecord | null = null;
  for (const record of records) {
    if (record.status !== "pending" && record.status !== "active") continue;
    if (!kinds.includes(record.kind)) continue;
    if (record.attempts.length >= GIVE_UP_ATTEMPTS) continue;
    if (
      best === null ||
      record.created_at > best.created_at ||
      (record.created_at === best.created_at && record.id < best.id)
    ) {
      best = record;
    }
  }
  return best;
}

export interface ReRaiseDecision {
  /** 这一拍可以重提的记录；`null` 表示先放着 */
  readonly speakable: IntentionRecord | null;
  /** 被哪条规则挡住：`suppressed`（同类说够了）/ `recently-spoke`（刚开口过）；通过时为 null */
  readonly blocked: "suppressed" | "recently-spoke" | null;
}

/**
 * F312 接线修复（supervisor 打回）：把「旧 pending 能不能重提」做成独立纯函数。
 *
 * 之前装配层写成 `candidate !== null && !suppressed && minutes < 10 ? null : candidate`，
 * 四连 `&&` 一短路，被压时条件变 false → 反而返回 candidate，被压的类别从重提后门照发，
 * 注释与代码相反；而原来只有字符串锁，逻辑写反测试仍然绿。这里改成两个正向条件，
 * 主逻辑只有一条 `if`，装配层只负责传参和打日志。
 */
export function decideReRaise(input: {
  readonly candidate: IntentionRecord | null;
  readonly suppressedKinds: readonly string[];
  readonly minutesSinceLastProactive: number | null;
  readonly reRaiseQuietMin: number;
}): ReRaiseDecision {
  if (!Number.isFinite(input.reRaiseQuietMin) || input.reRaiseQuietMin < 0) {
    throw new RangeError(`decideReRaise: reRaiseQuietMin 必须是非负有限数，收到 ${String(input.reRaiseQuietMin)}`);
  }
  if (input.candidate === null) return { speakable: null, blocked: null };
  if (input.suppressedKinds.includes(input.candidate.kind)) {
    return { speakable: null, blocked: "suppressed" };
  }
  const minutes = input.minutesSinceLastProactive;
  if (minutes !== null && minutes < input.reRaiseQuietMin) {
    return { speakable: null, blocked: "recently-spoke" };
  }
  return { speakable: input.candidate, blocked: null };
}

/**
 * F312：同一类话的重复刹车窗口。
 *
 * 为什么按"成功开口次数"而不是单条记录 attempts：批次1B 选的是「每次开口写一条独立记录、
 * 成功即 done」（审计 P0-C 给出的两条路线之一），所以一条记录天然只有 1 笔 attempts；
 * 真正会无限重复的是**同一类事每拍重新浮现**。这里按 kind 统计窗口内的 ok 笔数，
 * 与"一条意图试了 5 次"是两件事，各管一段。
 */
export const SPEAK_REPEAT_WINDOW_MS = 6 * 3_600_000;

export interface ExhaustedSpeakKindsOptions {
  /** 统计窗口，缺省 6 小时 */
  readonly windowMs?: number;
  /** 达到几次算"说够了"，缺省 GIVE_UP_ATTEMPTS（5） */
  readonly limit?: number;
  /** 只看哪些类别，缺省会开口的那些（reach_out / continue_thread / repair） */
  readonly kinds?: readonly string[];
}

/**
 * F312：窗口内这一类已经成功开口 `limit` 次 → 这一拍不要再浮现/开口这一类。
 *
 * 纯函数、只读、不改历史；由装配层把结果作为 `runIntentTick.suppressedKinds` 传进去，
 * 候选与浮现都过滤掉这些类别（她自己还是可以选别的类别，或被情境说服先不说）。
 */
export function exhaustedSpeakKinds(
  records: readonly IntentionRecord[],
  nowMs: number,
  options: ExhaustedSpeakKindsOptions = {},
): IntentionRecord["kind"][] {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError("exhaustedSpeakKinds: nowMs 非法");
  const windowMs = options.windowMs ?? SPEAK_REPEAT_WINDOW_MS;
  const limit = options.limit ?? GIVE_UP_ATTEMPTS;
  const kinds = options.kinds ?? SPEAK_INTENT_KINDS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`exhaustedSpeakKinds: windowMs 必须是正数，收到 ${String(windowMs)}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`exhaustedSpeakKinds: limit 必须是正整数，收到 ${String(limit)}`);
  }
  const counts = new Map<IntentionRecord["kind"], number>();
  for (const record of records) {
    if (!kinds.includes(record.kind)) continue;
    for (const attempt of record.attempts) {
      if (attempt.outcome !== "ok") continue;
      const at = Date.parse(attempt.at);
      if (Number.isNaN(at)) continue;
      const age = nowMs - at;
      if (age < 0 || age > windowMs) continue;
      counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= limit)
    .map(([kind]) => kind)
    .sort();
}
