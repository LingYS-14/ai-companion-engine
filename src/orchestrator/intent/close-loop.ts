/**
 * 闭环：意图真的被"做"了，就在它自己身上留一笔（纯函数）
 *
 * 为什么：F193/F194 之后意图表能记住"她想做什么"，但一旦她真的开口了，
 * 表里那条仍是 pending——于是下一拍还会认为"这类事还没做"，同一类意图会反复堆积。
 * P1 的真出口（F187）已经知道"这次主动开口成功"，缺的只是把这件事记回意图表。
 *
 * 本文件做一件事：给定意图表 + 刚成功开口的那条意图 id，
 * 沿 `activate → addAttempt(ok)` 把它标记为"做了、结果好"，返回新表。
 *
 * 不读时钟、不读写文件、不调模型；`agency` 先给中性值（归因闭环接上后再写真值）。
 */

import { activate, addAttempt, newIntention } from "./bus.js";
import { CHAT_REPLY_SOURCE, PROACTIVE_SOURCE } from "../../memory/echo-sources.js";
import { formatUtc } from "./episode.js";
import { deriveTrigger } from "./lookahead.js";
import type { Candidate, IntentKind, IntentionRecord, IntentionStatus } from "./types.js";

/** 归因闭环（P3 `learning-loop.ts`）还没接进 tick 前，先给中性值；不是"算出来的" */
export const NEUTRAL_AGENCY = 0.5;

export interface SpokenAttemptInput {
  readonly records: readonly IntentionRecord[];
  /** 这次开口对应哪条意图；没有（第一拍/未浮现）就传 null/undefined */
  readonly intentionId: string | null | undefined;
  readonly nowMs: number;
  /** 动作名，写进 attempt.act；默认 proactive_speak */
  readonly act?: string;
  /** 归因（0..1）；不传用中性 0.5 */
  readonly agency?: number;
}

export interface SpokenAttemptResult {
  readonly records: readonly IntentionRecord[];
  /** 真的被标记的那条（没有则是 null） */
  readonly closed: IntentionRecord | null;
  readonly note: string;
}

/**
 * 把"这次开口成功"记到对应意图上。
 * 找不到 / 已了结 / 没给 id 都**原样返回**，并在 note 里说清为什么——
 * 宁可少记一笔，也不要凭空造一条 attempt。
 */
export function recordSpokenAttempt(input: SpokenAttemptInput): SpokenAttemptResult {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("recordSpokenAttempt: nowMs 非法");
  const agency = input.agency ?? NEUTRAL_AGENCY;
  if (!Number.isFinite(agency) || agency < 0 || agency > 1) {
    throw new RangeError(`recordSpokenAttempt: agency 必须在 [0,1]，收到 ${String(agency)}`);
  }
  const intentionId = input.intentionId;
  if (intentionId === null || intentionId === undefined || intentionId === "") {
    return { records: input.records, closed: null, note: "这一拍没有对应的意图记录（第一拍或还没浮现），不追记" };
  }
  const index = input.records.findIndex((record) => record.id === intentionId);
  if (index < 0) {
    return { records: input.records, closed: null, note: `意图表里没有 ${intentionId}，不追记` };
  }
  const record = input.records[index] as IntentionRecord;
  if (record.status === "done" || record.status === "dropped") {
    return { records: input.records, closed: null, note: `${intentionId} 已了结（${record.status}），不重复记` };
  }
  const closed = addAttempt(activate(record), {
    at: formatUtc(input.nowMs),
    act: input.act ?? "proactive_speak",
    outcome: "ok",
    agency,
  });
  const records = [...input.records];
  records[index] = closed;
  return {
    records,
    closed,
    note: `${intentionId} 记了一笔成功（try=${String(closed.attempts.length)}，agency=${agency.toFixed(2)}）`,
  };
}

/* ------------------------------------------------------------------ *
 * F195 补记：这一拍真有话说，但表里没有对应的 open 记录
 * ------------------------------------------------------------------ */

/**
 * 会「占着」一类事的非终态：pending/active/blocked 是 `topRecord` 的原口径，
 * held 是她上一拍看过、决定先不说（`recordHeldAttempt` 会把它落到这个状态）。
 */
const OPEN_STATUSES: ReadonlySet<IntentionStatus> = new Set<IntentionStatus>([
  "pending",
  "active",
  "blocked",
  "held",
]);

export interface EnsureSpokenRecordInput {
  readonly records: readonly IntentionRecord[];
  /** 这一拍要说的是哪一类事；null/undefined（没有类别）就不补，保持旧行为 */
  readonly kind: IntentKind | null | undefined;
  readonly nowMs: number;
  /** 补建时写进 goal；缺省用「想开口说这件事（kind）」，不编具体内容 */
  readonly goal?: string;
  /** 补建时写进 why；缺省空串（没有依据就不编动机） */
  readonly why?: string;
  readonly sourceIds?: readonly string[];
}

export interface EnsureSpokenRecordResult {
  readonly records: readonly IntentionRecord[];
  /** 这一拍开口要记到哪条记录上（kind 为空时是 null） */
  readonly record: IntentionRecord | null;
  /** 真的补了一条新的 pending */
  readonly created: boolean;
  /** 把上一拍的 held 放回了 pending（保留 attempts） */
  readonly reopened: boolean;
  readonly note: string;
}

/** 补建 id 的格式与 main.mjs 里 emitted 落表时一致（`itn-<kind>-<nowMs>`），撞了才加后缀 */
function spokenRecordId(records: readonly IntentionRecord[], kind: IntentKind, nowMs: number): string {
  const base = `itn-${kind}-${String(nowMs)}`;
  let id = base;
  let suffix = 1;
  while (records.some((record) => record.id === id)) {
    suffix += 1;
    id = `${base}-${String(suffix)}`;
  }
  return id;
}

/**
 * 开口之前的记账兜底：**要开口却没有对应的 open 记录**时，补建/重开一条 pending。
 *
 * 为什么需要：`main.mjs` 的 `topRecord` 只认 pending/active/blocked，找不到就没有
 * `intentionId`；闭环（`recordSpokenAttempt`）拿不到 id 就整段跳过——审计里
 * 「84 条实发、只有 2 条对得上账」正是这条路断的。
 *
 * 规则（宁可少造，也不改写历史）：
 *   · 已有 pending/active/blocked → 原样返回那条，不新建；
 *   · 只有 held → 放回 pending（重开），attempts 保留——她上一拍只是"先不说"，不是没想过；
 *   · 只有 done/dropped/没有 → 补一条新的 pending（旧的终态一个字不动），
 *     让她这一次开口有地方记账、下一拍也不会因为"同类还开着"被卡住。
 */
export function ensureSpokenRecord(input: EnsureSpokenRecordInput): EnsureSpokenRecordResult {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("ensureSpokenRecord: nowMs 非法");
  const kind = input.kind;
  if (kind === null || kind === undefined) {
    return { records: input.records, record: null, created: false, reopened: false, note: "这一拍没有意图类别，不补记录" };
  }
  const index = input.records.findIndex((record) => record.kind === kind && OPEN_STATUSES.has(record.status));
  if (index >= 0) {
    const record = input.records[index] as IntentionRecord;
    if (record.status !== "held") {
      return {
        records: input.records,
        record,
        created: false,
        reopened: false,
        note: `${record.id} 已经开着（${record.status}），直接用`,
      };
    }
    // D11-2：重开表示「现在就说」，必须清掉旧的到点 trigger——否则这条刚回到 pending
    // 就会被 due 判定立刻再次浮现（见 spec §2.4）。
    const reopened: IntentionRecord = { ...record, status: "pending", blocked_by: null, trigger: null };
    const records = [...input.records];
    records[index] = reopened;
    return {
      records,
      record: reopened,
      created: false,
      reopened: true,
      note: `${record.id} 从 held 放回 pending（保留 ${String(record.attempts.length)} 笔旧账）`,
    };
  }
  const id = spokenRecordId(input.records, kind, input.nowMs);
  const record = newIntention({
    id,
    at: formatUtc(input.nowMs),
    kind,
    goal: input.goal !== undefined && input.goal.trim() !== "" ? input.goal : `想开口说这件事（${kind}）`,
    why: input.why ?? "",
    ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
  });
  return {
    records: [...input.records, record],
    record,
    created: true,
    reopened: false,
    note: `表里没有 ${kind} 的 open 记录，补了一条 pending（${id}）`,
  };
}

/* ------------------------------------------------------------------ *
 * F349 I3：补建记录按实际出口补来源（source_ids）
 * ------------------------------------------------------------------ */

/** 一条意图最多带 3 个来源 id：够解释"为什么这时候开口"，又不把记录撑爆 */
export const MAX_OUTLET_SOURCES = 3;

export interface SourcesForOutletInput {
  /** 到点的旧意图（lookahead 浮现）；优先级最高，出口就是它 */
  readonly dueHit: IntentionRecord | null;
  /** 额度回来后被重提的旧意图；次优先 */
  readonly speakable: IntentionRecord | null;
  /** 这一拍的候选；只在基础 outlet（会新建记录）时用它的 because 当来源 */
  readonly top: Candidate | null;
}

/**
 * 按实际出口取这次开口的"来源"（memoryId 列表），给 `ensureSpokenRecord` 落 source_ids。
 *
 * 为什么只取一个出口而不是合并三个：source_ids 是"这条新记录为什么会出现"的依据，
 * 必须与真正决定这次开口的那条记录一致；混进另外两个出口的来源会把因果写糊。
 *
 * 规则：due 有 → due.source_ids；否则 speakable 有 → speakable.source_ids；
 * 否则（基础 outlet，唯一会新建记录的情形）→ top.because 的 memoryId。
 * 统一去空/去重/截 3；空数组表示"没有可写的来源"，调用方应省略 sourceIds 而不是写 []。
 */
export function sourcesForOutlet(input: SourcesForOutletInput): readonly string[] {
  const raw: readonly (string | undefined)[] =
    input.dueHit !== null
      ? input.dueHit.source_ids
      : input.speakable !== null
        ? input.speakable.source_ids
        : (input.top?.because ?? []).map((cause) => cause.memoryId);
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    picked.push(id);
    if (picked.length >= MAX_OUTLET_SOURCES) break;
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * F350 I1：同题 24h 去重（只读纯函数）
 * ------------------------------------------------------------------ */

export interface RecentRepeatInput {
  readonly records: readonly IntentionRecord[];
  /** 这一拍准备说的目标；null/空串表示没有 goal 可比 */
  readonly goal: string | null;
  /** 预留给后续按类别收紧；本版命中口径不按 kind 过滤（spec §3.1） */
  readonly kind?: IntentKind | null;
  /** 这一拍的实际来源（I3 的 outletSources）；空数组表示没有来源可比 */
  readonly sourceIds?: readonly string[];
  readonly nowMs: number;
  readonly windowMs: number;
}

/**
 * 窗口内是否刚说过同一个目标（只看 `done` 记录，只读不写）。
 *
 * 目的：同一 goal/来源在 24h 内不重复主动开口（I2 删掉 T2 补位后，
 * 这是防「同题复读」的第二道闸）。命中口径按 spec §3.1：
 * goal trim 后精确相等 **或** sourceIds 与记录 source_ids 有交集；
 * 多条命中取 created_at 最新（同时间按 id 字典序稳定）；两者都空 → null（不猜）。
 */
export function findRecentRepeat(input: RecentRepeatInput): IntentionRecord | null {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("findRecentRepeat: nowMs 非法");
  if (!Number.isFinite(input.windowMs) || input.windowMs < 0) {
    throw new RangeError("findRecentRepeat: windowMs 非法");
  }
  const goal = input.goal?.trim() ?? "";
  const sourceIds = new Set(
    (input.sourceIds ?? []).map((id) => id.trim()).filter((id) => id !== ""),
  );
  if (goal === "" && sourceIds.size === 0) return null;

  let best: IntentionRecord | null = null;
  let bestAtMs = Number.NEGATIVE_INFINITY;
  for (const record of input.records) {
    if (record.status !== "done") continue;
    const createdMs = Date.parse(record.created_at);
    if (!Number.isFinite(createdMs) || createdMs > input.nowMs) continue;
    if (input.nowMs - createdMs > input.windowMs) continue;
    const goalHit = goal !== "" && record.goal.trim() === goal;
    const sourceHit = sourceIds.size > 0 && record.source_ids.some((id) => sourceIds.has(id.trim()));
    if (!goalHit && !sourceHit) continue;
    if (best === null || createdMs > bestAtMs || (createdMs === bestAtMs && record.id < best.id)) {
      best = record;
      bestAtMs = createdMs;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * P0-F：她真的说出口的话，也要进记忆
 * ------------------------------------------------------------------ */

/**
 * 她自己的话的来源标签。
 *
 * 为什么不写 `player`：那是用户的话（`channelForSource` 会把它当成 gui 渠道）；
 * 为什么不写 `web`/`parasocial`/`unknown`：这三档在 `UNTRUSTED_SOURCES` 里，
 * 会被防火墙打污点。`proactive` 不在名单里，落盘是 clean 的——但也就不是
 * 「用户说的」，`participants` 为空（`buildEpisodeWrite` 只给 OWNER_SOURCES 填用户），
 * 访客侧也不可见，与"她自己的心里话"一致。
 */
export const SPOKEN_MEMORY_SOURCE = PROACTIVE_SOURCE;

export interface SpokenMemorySeedInput {
  readonly reply: string;
  /** 开口时对应哪类意图；只用来打标签，不参与内容生成 */
  readonly kind?: IntentKind | null;
  /**
   * P2a：这一拍意图上下文里的目标与 id（main.mjs 从 lastIntentContext 展开传入）。
   * 拿不到就不传——不编空串。
   */
  readonly goalAtTime?: string;
  readonly goalId?: string;
}

/** 组装 `BrainPort.remember` 的入参（结构兼容 `RememberInput`，本层不 import 端口，避免跨层依赖） */
export interface SpokenMemorySeed {
  readonly content: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly vividness: number;
  readonly selfRelevance: number;
  /**
   * P2a：她主动说出的话方向固定是 outbound。写成必填而不是可选，
   * 因为这条路径**永远知道**方向——让"知道却漏传"在编译期就报错。
   */
  readonly direction: "outbound";
  /**
   * P2a：把"这一拍她在追什么"一起写进 encode_ctx；缺键 = unknown。
   * 只有装配层真的知道时才出现（trim 后空串 = 不传，不伪造）。
   */
  readonly goalAtTime?: string;
  readonly goalId?: string;
}

/**
 * 把"她主动说了什么"做成一条记忆种子（纯函数，便于单测）。
 *
 * 只做形状转换、不判断该不该写：调用点已经确认 `acted && reply`（真的发出去了）。
 * 鲜活度 0.5：她说过的话比听来的淡，但比 selftalk（0.35）实——毕竟是对着人说的。
 */
export function spokenMemorySeed(input: SpokenMemorySeedInput): SpokenMemorySeed {
  const reply = input.reply.trim();
  if (reply === "") throw new RangeError("spokenMemorySeed: reply 为空（只有真的发出去的话才该写记忆）");
  const kind = input.kind ?? null;
  // P2a：意图上下文只在装配层知道时才带；trim 后空串 = 不传（不伪造空串）
  const goalAtTime = input.goalAtTime?.trim();
  const goalId = input.goalId?.trim();
  return {
    content: `我主动开口说：「${reply}」`,
    source: SPOKEN_MEMORY_SOURCE,
    tags: kind === null ? ["proactive"] : ["proactive", kind],
    vividness: 0.5,
    selfRelevance: 0.6,
    // P2a：她主动说出的话 = outbound；main.mjs 把 seed 原样交给 runtime.remember
    direction: "outbound",
    ...(goalAtTime === undefined || goalAtTime === "" ? {} : { goalAtTime }),
    ...(goalId === undefined || goalId === "" ? {} : { goalId }),
  };
}

/* ------------------------------------------------------------------ *
 * P2a（B1）：这一拍意图上下文（main.mjs 原来是内联对象）
 * ------------------------------------------------------------------ */

/** 出口的结构子集（与 outlet.ts 的 IntentOutlet 同形；本层不 import 它） */
export interface IntentContextOutlet {
  readonly target: "speak" | "journal" | "idle";
  readonly kind: IntentKind | null;
  readonly line: string | null;
  readonly whyLine: string;
  readonly note: string;
}

export interface IntentContextGate {
  readonly allowed: boolean;
  readonly verdict: string;
  readonly note: string;
}

/** 这一拍"最想做的事"对应的意图记录（只用 id 与目标） */
export interface IntentContextTopRecord {
  readonly id: string;
  readonly goal: string;
}

export interface IntentContextInput {
  readonly outlet: IntentContextOutlet;
  readonly emitted: readonly string[];
  readonly gate: IntentContextGate;
  readonly topRecord: IntentContextTopRecord | undefined;
  readonly situation: readonly string[] | undefined;
  readonly lookaheadSurfacedId: string | undefined;
}

/**
 * 交给主动开口桥的上下文（结构由 main.mjs 与 onebot-bridge 消费）。
 *
 * P2a：goalAtTime/goalId 与 intentionId 同源——speakable / dueHit / ensuredSpoken
 * 三类出口都经 topRecord 汇聚到同一处，避免"某条出口忘了带目标"。
 */
export interface IntentContext {
  readonly outlet: string;
  readonly emitted: readonly string[];
  readonly kind?: IntentKind;
  readonly gate?: IntentContextGate;
  readonly note?: { readonly line: string; readonly whyLine: string; readonly statusLine?: string };
  readonly intentionId?: string;
  readonly goalAtTime?: string;
  readonly goalId?: string;
  readonly situation?: { readonly lines: readonly string[] };
  readonly lookaheadSurfacedId?: string;
}

/** 纯函数：把 tick 里的出口/门/记录/处境拼成 IntentContext（缺省不伪造键） */
export function intentContextOf(input: IntentContextInput): IntentContext {
  const { outlet } = input;
  return {
    outlet: outlet.target,
    emitted: input.emitted,
    ...(outlet.kind === null ? {} : { kind: outlet.kind }),
    ...(outlet.target !== "speak"
      ? {}
      : { gate: { allowed: input.gate.allowed, verdict: input.gate.verdict, note: input.gate.note } }),
    ...(outlet.line === null
      ? {}
      : {
          note: {
            line: outlet.line,
            whyLine: outlet.whyLine ?? "",
            ...(outlet.note === "" ? {} : { statusLine: outlet.note }),
          },
        }),
    ...(input.topRecord === undefined
      ? {}
      : { intentionId: input.topRecord.id, goalAtTime: input.topRecord.goal, goalId: input.topRecord.id }),
    ...(input.situation === undefined || input.situation.length === 0
      ? {}
      : { situation: { lines: input.situation } }),
    ...(input.lookaheadSurfacedId === undefined ? {} : { lookaheadSurfacedId: input.lookaheadSurfacedId }),
  };
}

/* ------------------------------------------------------------------ *
 * P2：网页聊天里她说出去的话，也要进记忆
 * ------------------------------------------------------------------ */

/**
 * 网页聊天回复的来源标签。
 *
 * 为什么不复用 `SPOKEN_MEMORY_SOURCE`（`proactive`）：那条路径是"她主动开口"，
 * 用于节律/意图统计；网页聊天是"人对她说、她回"，语义与标签都应该分开。
 * 为什么不是 `web`：`web` 在 `UNTRUSTED_SOURCES` 里，会被防火墙当外部内容打污点——
 * 她自己的回复不是不可信来源。
 *
 * 注意：`chat_reply` 不在 `RELATION_SOURCES` 里，`consolidate` 对这类来源返回
 * `REJECTED_SOURCE` → 这条记忆**只存不巩固**（设计 §3 语义 4 接受的口径）。
 */
export const CHAT_REPLY_MEMORY_SOURCE = CHAT_REPLY_SOURCE;

export interface ChatReplyMemorySeedInput {
  readonly reply: string;
  /**
   * 通道标签（P0-F）：网页聊天默认 `["chat"]`；QQ 回信传 `["chat","qq"]`。
   * 不传时与旧行为逐位一致。
   */
  readonly tags?: readonly string[];
}

/** 组装 `BrainPort.remember` 的入参（结构兼容 `RememberInput`，与 `SpokenMemorySeed` 同思路）。 */
export interface ChatReplyMemorySeed {
  readonly content: string;
  readonly source: string;
  readonly tags: readonly string[];
  readonly vividness: number;
  readonly selfRelevance: number;
  readonly direction: "outbound";
}

/**
 * 把"她在网页聊天里回了什么"做成一条记忆种子（纯函数）。
 *
 * 与 `spokenMemorySeed` 的差别只在语义面：正文用「我说：」，标签固定 `chat`，
 * 来源固定 `chat_reply`。鲜活度/自相关沿用同档（对着人说的，比 selftalk 实）。
 */
export function chatReplyMemorySeed(input: ChatReplyMemorySeedInput): ChatReplyMemorySeed {
  const reply = input.reply.trim();
  if (reply === "") throw new RangeError("chatReplyMemorySeed: reply 为空（只有真的发出去的话才该写记忆）");
  return {
    content: `我说：「${reply}」`,
    source: CHAT_REPLY_MEMORY_SOURCE,
    tags: input.tags ?? ["chat"],
    vividness: 0.5,
    selfRelevance: 0.6,
    direction: "outbound",
  };
}

/** A5：她把"想说"判断成了"现在先不说"——同样是一次真实的判断，也要留痕。 */
export interface HeldAttemptInput {
  readonly records: readonly IntentionRecord[];
  readonly intentionId: string | null | undefined;
  readonly nowMs: number;
  readonly agency?: number;
}

export interface HeldAttemptResult {
  readonly records: readonly IntentionRecord[];
  readonly held: IntentionRecord | null;
  readonly note: string;
}

/**
 * 记一笔 held：状态置 `held`、attempts +1（**不**算失败、**不**增加 survival 的墓碑）。
 *
 * 为什么不复用 `recordSpokenAttempt`：`addAttempt` 会把 noop 归回 pending，
 * 那会丢掉"她这一拍看过、决定先不说"这件事；而 held 要能被下一拍看见
 * （`activeKindsOf` 把 held 也算占用，避免同一条每一拍都重新浮现）。
 */
export function recordHeldAttempt(input: HeldAttemptInput): HeldAttemptResult {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("recordHeldAttempt: nowMs 非法");
  const agency = input.agency ?? NEUTRAL_AGENCY;
  if (!Number.isFinite(agency) || agency < 0 || agency > 1) {
    throw new RangeError(`recordHeldAttempt: agency 必须在 [0,1]，收到 ${String(agency)}`);
  }
  const intentionId = input.intentionId;
  if (intentionId === null || intentionId === undefined || intentionId === "") {
    return { records: input.records, held: null, note: "这一拍没有对应的意图记录，不记 held" };
  }
  const index = input.records.findIndex((record) => record.id === intentionId);
  if (index < 0) {
    return { records: input.records, held: null, note: `意图表里没有 ${intentionId}，不记 held` };
  }
  const record = input.records[index] as IntentionRecord;
  if (record.status === "done" || record.status === "dropped") {
    return { records: input.records, held: null, note: `${intentionId} 已了结（${record.status}），不记 held` };
  }
  const attempted = addAttempt(record, {
    at: formatUtc(input.nowMs),
    act: "proactive_hold",
    outcome: "noop",
    agency,
  });
  // D11-2：held 也要有「下次自己回来」的时间点；idle/explore 等无时间语义的 kind 为 null。
  const held: IntentionRecord = { ...attempted, status: "held", trigger: deriveTrigger(record.kind, input.nowMs) };
  const records = [...input.records];
  records[index] = held;
  return {
    records,
    held,
    note: `${intentionId} 记了一笔"先不说"（try=${String(held.attempts.length)}）`,
  };
}

/** lookahead 浮现后，这一拍最终没发出去（不是 held、也不是成功）——记为 held，不再自动重提。 */
export interface SurfacedFailureInput {
  readonly records: readonly IntentionRecord[];
  readonly intentionId: string | null | undefined;
  readonly nowMs: number;
  readonly agency?: number;
}

export interface SurfacedFailureResult {
  readonly records: readonly IntentionRecord[];
  readonly failed: IntentionRecord | null;
  readonly note: string;
}

/**
 * 到点的旧意图浮出后，主动路径最终没发（`r.verdict !== "held"` 且没成功）：
 * attempts +1、status=held。held 不在 pending/active 集合里，下一拍照样不会被 `pickSpeakableIntention` 重提。
 * done/dropped 不动；没 id / 表里没有都不记。
 */
export function recordSurfacedFailure(input: SurfacedFailureInput): SurfacedFailureResult {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("recordSurfacedFailure: nowMs 非法");
  const agency = input.agency ?? NEUTRAL_AGENCY;
  if (!Number.isFinite(agency) || agency < 0 || agency > 1) {
    throw new RangeError(`recordSurfacedFailure: agency 必须在 [0,1]，收到 ${String(agency)}`);
  }
  const intentionId = input.intentionId;
  if (intentionId === null || intentionId === undefined || intentionId === "") {
    return { records: input.records, failed: null, note: "这一拍没有对应的意图记录，不记失败" };
  }
  const index = input.records.findIndex((record) => record.id === intentionId);
  if (index < 0) {
    return { records: input.records, failed: null, note: `意图表里没有 ${intentionId}，不记失败` };
  }
  const record = input.records[index] as IntentionRecord;
  if (record.status === "done" || record.status === "dropped") {
    return { records: input.records, failed: null, note: `${intentionId} 已了结（${record.status}），不记失败` };
  }
  const attempted = addAttempt(record, {
    at: formatUtc(input.nowMs),
    act: "lookahead_surface",
    outcome: "noop",
    agency,
  });
  // D11-2：浮现后没发出去 → 也补一个 +6/12/24h 的 trigger，下一段自己回来（spec §2.1）。
  const failed: IntentionRecord = { ...attempted, status: "held", trigger: deriveTrigger(record.kind, input.nowMs) };
  const records = [...input.records];
  records[index] = failed;
  return {
    records,
    failed,
    note: `${intentionId} 记了一笔"浮现后没发"（try=${String(failed.attempts.length)}，不自动重提）`,
  };
}

/* ------------------------------------------------------------------ *
 * D11-2：普通开口失败（非 lookahead 记录）也补写 time trigger
 * ------------------------------------------------------------------ */

/**
 * 哪些 verdict 才算“真的失败了”（allowlist，不是“所有 acted=false”）。
 * `held` 已由 recordHeldAttempt 记账；`dry-run` 没发送不算失败；
 * `calm`/`gap`/`daily`/`disabled`/`quiet` 等决策层早退根本没生成/发送；未知 verdict 不猜。
 */
export const FAILED_SPEAK_VERDICTS = Object.freeze([
  "llm-failed",
  "empty-reply",
  "send-failed",
] as const);

export function isFailedSpeakVerdict(verdict: string): boolean {
  return (FAILED_SPEAK_VERDICTS as readonly string[]).includes(verdict);
}

/** 普通开口失败（非 lookahead 浮现）：与 recordSurfacedFailure 同构，只换记账 act。 */
export interface SpeakFailureInput {
  readonly records: readonly IntentionRecord[];
  readonly intentionId: string | null | undefined;
  readonly nowMs: number;
  readonly agency?: number;
}

export interface SpeakFailureResult {
  readonly records: readonly IntentionRecord[];
  readonly failed: IntentionRecord | null;
  readonly note: string;
}

/**
 * 普通 speak 记录这一拍最终没发出去（`llm-failed`/`empty-reply`/`send-failed`）：
 * attempts +1、status=held，并补写 +6/12/24h 的 time trigger——下一段到点自己回来。
 * done/dropped 不动；没 id / 表里没有都不记。
 */
export function recordSpeakFailure(input: SpeakFailureInput): SpeakFailureResult {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError("recordSpeakFailure: nowMs 非法");
  const agency = input.agency ?? NEUTRAL_AGENCY;
  if (!Number.isFinite(agency) || agency < 0 || agency > 1) {
    throw new RangeError(`recordSpeakFailure: agency 必须在 [0,1]，收到 ${String(agency)}`);
  }
  const intentionId = input.intentionId;
  if (intentionId === null || intentionId === undefined || intentionId === "") {
    return { records: input.records, failed: null, note: "这一拍没有对应的意图记录，不记失败" };
  }
  const index = input.records.findIndex((record) => record.id === intentionId);
  if (index < 0) {
    return { records: input.records, failed: null, note: `意图表里没有 ${intentionId}，不记失败` };
  }
  const record = input.records[index] as IntentionRecord;
  if (record.status === "done" || record.status === "dropped") {
    return { records: input.records, failed: null, note: `${intentionId} 已了结（${record.status}），不记失败` };
  }
  const attempted = addAttempt(record, {
    at: formatUtc(input.nowMs),
    act: "proactive_speak_failed",
    outcome: "noop",
    agency,
  });
  const failed: IntentionRecord = { ...attempted, status: "held", trigger: deriveTrigger(record.kind, input.nowMs) };
  const records = [...input.records];
  records[index] = failed;
  return {
    records,
    failed,
    note: `${intentionId} 记了一笔"开口失败"（try=${String(failed.attempts.length)}；到点后再试）`,
  };
}
