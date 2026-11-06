/**
 * §5.3/§5.6 写入侧的 episode 信封（P2 记忆改造的"写进去"那一半）
 *
 * `episode.ts` 回答的是"这条记忆像不像一次情景、缺哪几样"；本文件回答的是
 * **写下去的那一刻，手上到底有什么**，并把"写的时候不知道的"显式标成 `unknown:`，
 * 而不是让读取端以为那是真的。
 *
 * 落点：现有 27 字段 schema 是冻结的（`docs/DESIGN.md` R1：升格字段要过门禁评审），
 * 所以这里只把五元组与情境指纹写进 `encode_ctx`（`participants` 用正式字段）。
 * 读取端（`episode.ts` 的 `deriveQuintuple`）已经会从 `encode_ctx` 读它们，两条路天然对齐。
 *
 * v3（P2a）：唯一新增字段 `direction`——这句话是收到的（inbound）还是她主动说出的（outbound）。
 * 只有调用方真的知道方向时才写这个键；不知道就不写。旧记录缺键照样可读，"缺失"与"未知"同义。
 *
 * 关键取舍：**写的时候不知道 goal_at_time 就写 `unknown:`**。插件的回合路径里
 * 没有意向引擎的上下文（它在常驻进程里，是另一个装配根），假装知道会让
 * "当时想干什么"变成事后编造。
 */

import { EPISODE_FIELDS, type EpisodeField } from "./episode.js";

/** 推断值的前缀：读取端看到它就知道"这不是记录里写着的"（与 episode.ts 同一口径） */
export const UNKNOWN_PREFIX = "unknown:";

/** 情绪底色分桶：正面 ≥0.62，负面 ≤0.38，其余中性（与 S 层 valence 同一量纲 0..1） */
export const AFFECT_POSITIVE_MIN = 0.62;
export const AFFECT_NEGATIVE_MAX = 0.38;

/** 写下的这条 episode 的 schema 版本（将来升格成正式字段时用来区分） */
export const EPISODE_WRITE_VERSION = 3;

/**
 * 这句话的方向：听来的（inbound）还是她自己主动说出的（outbound）。
 *
 * 只给「知道方向」的写路径用；显式记忆（soul_remember）的调用方通常不知道，
 * 于是不传、encode_ctx 里缺键 = unknown——缺键与未知同义，不写假值。
 */
export type EpisodeDirection = "inbound" | "outbound";

/**
 * 线索重合乘数的地板：完全对不上时保留一半分数（见 scoreWithCueOverlap 的说明）。
 * 调用侧（cue-recall.ts）复用同一个常量，避免两处各写一个 0.5 漂移。
 */
export const SCORE_FLOOR_MULTIPLIER = 0.5;

/** 没有指纹的老记忆不罚：乘数 1（"没记下来"不等于"对不上"） */
export const MISSING_FINGERPRINT_RATIO = 1;

export type AffectBucket = "positive" | "neutral" | "negative";

/**
 * P2a 收尾：一天里的四个时段（写侧从装配层传入的 localHour 派生）。
 * 只写不检索——当前 cue 不传 localHour，所以暂时没有比较对象。
 */
export type DayPart = "late_night" | "morning" | "afternoon" | "evening";

/** §5.6 情境指纹：写入时记下"这条记忆属于什么情境"，供检索时算线索重合。 */
export interface CueFingerprint {
  /** 话题域（本实现 = 第一个 tag；没有就是 conversation） */
  readonly topicDomain: string;
  readonly participants: readonly string[];
  readonly place: string;
  readonly affect: AffectBucket;
  /** 写的时候是什么时段；不知道就是 null（旧记录缺键 = 不知道，不参与比较） */
  readonly timeOfDay: DayPart | null;
  /** 写的时候若正在追一个意图，记它的 id；没有就是 null（不编） */
  readonly goalId: string | null;
}

export interface EpisodeWriteInput {
  readonly text: string;
  readonly source: string;
  readonly channel: string;
  readonly mode: string;
  readonly tags: readonly string[];
  readonly valence: number;
  readonly arousal: number;
  readonly createdAtMs: number;
  /** 调用方知道的在场者（不知道就别传） */
  readonly participants?: readonly string[];
  /** 调用方知道的地点（不知道就用 channel 映射） */
  readonly place?: string;
  /** 写的时候想干什么（只有常驻进程的意向引擎知道；插件回合通常不知道） */
  readonly goalAtTime?: string;
  /** 写的时候正在追的意图 id（同上） */
  readonly goalId?: string;
  /**
   * 写的时候的本地小时（0..23 整数）。由装配层从 `Clock.localHour()` 传入；
   * brain 不读时钟。缺失/非整数/越界 → `timeOfDay` 写 null（不猜）。
   */
  readonly localHour?: number;
  /**
   * 这句话是谁说的：收到的消息 = inbound，她主动说出 = outbound。
   * 不传 = 方向未知（缺键，不写 "unknown" 假值）——旧路径与 soul_remember 就是这种。
   */
  readonly direction?: EpisodeDirection;
}

export interface EpisodeWritePayload {
  /** 合进 encode_ctx 的字段（调用方负责与既有 channel/mode 合并） */
  readonly encodeCtx: Record<string, unknown>;
  /** 正式字段 participants（写进 MemoryRecord，不是 encode_ctx） */
  readonly participants: readonly string[];
  /** 写的时候缺的字段（目前只有 goalAtTime 可能缺） */
  readonly missing: readonly EpisodeField[];
  readonly fingerprint: CueFingerprint;
  /** 五元组是否齐全（齐全才允许被当作"真正的情景记忆"） */
  readonly complete: boolean;
}

/** 渠道 → 地点。地图不是穷举，未知渠道保留原值（比猜"某个地方"诚实）。 */
const PLACE_BY_CHANNEL: Readonly<Record<string, string>> = Object.freeze({
  gui: "本机",
  local: "本机",
  qq: "QQ",
  wechat: "微信",
  bili: "B站",
});

/** 能确认"在场的是用户"的来源；其余来源不替它编在场者。 */
const OWNER_SOURCES: readonly string[] = Object.freeze(["player", "qq_contact_verified"]);

/** 视角固定为第一人称：写下的就是"当时的我所看到的"，不是全知视角。 */
export const VIEWPOINT_SELF = "第一人称（当时的我）";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function affectOf(valence: number, _arousal: number): AffectBucket {
  const v = clamp01(valence);
  if (v >= AFFECT_POSITIVE_MIN) return "positive";
  if (v <= AFFECT_NEGATIVE_MAX) return "negative";
  return "neutral";
}

/**
 * 把 0..23 的本地小时归到四个时段；不知道（非整数/越界/NaN）返回 null。
 * 四桶边界是代码常量（不进 overlay）：[0,6) 深夜、[6,12) 上午、[12,18) 下午、[18,24) 晚上。
 */
export function dayPartOfHour(hour: number): DayPart | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour < 6) return "late_night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** 话题域 = 第一个非空 tag；没有就 conversation（不拿正文首几个字当话题，那会随字句漂移） */
export function topicDomainOf(tags: readonly string[]): string {
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed !== "") return trimmed;
  }
  return "conversation";
}

export function participantsFor(source: string): readonly string[] {
  return OWNER_SOURCES.includes(source) ? ["用户"] : [];
}

/** 来源 → 渠道。QQ 的消息不能再写成 gui/本机：F196 的线索重排要靠这个区分。 */
const CHANNEL_BY_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  player: "gui",
  qq_contact_verified: "qq",
  web: "web",
  parasocial: "bili",
});

/** 来源 → 渠道；未知来源保留原值（不猜），空来源交给 placeForChannel 标 unknown */
export function channelForSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed === "") return "";
  return CHANNEL_BY_SOURCE[trimmed] ?? trimmed;
}

export function placeForChannel(channel: string): string {
  const trimmed = channel.trim();
  if (trimmed === "") return `${UNKNOWN_PREFIX}no-channel`;
  return PLACE_BY_CHANNEL[trimmed] ?? trimmed;
}

export function buildCueFingerprint(input: EpisodeWriteInput, participants: readonly string[], place: string): CueFingerprint {
  const goalId = input.goalId === undefined || input.goalId.trim() === "" ? null : input.goalId.trim();
  return {
    topicDomain: topicDomainOf(input.tags),
    participants: [...participants],
    place,
    affect: affectOf(input.valence, input.arousal),
    timeOfDay: input.localHour === undefined ? null : dayPartOfHour(input.localHour),
    goalId,
  };
}

/**
 * 组装写入信封。**不猜**：写的时候没有的字段进 `missing`，值以 `unknown:` 开头。
 */
export function buildEpisodeWrite(input: EpisodeWriteInput): EpisodeWritePayload {
  const participants =
    input.participants === undefined || input.participants.length === 0
      ? participantsFor(input.source)
      : [...input.participants];

  const place = input.place === undefined || input.place.trim() === "" ? placeForChannel(input.channel) : input.place.trim();

  const goalRaw = input.goalAtTime === undefined ? "" : input.goalAtTime.trim();
  const hasGoal = goalRaw !== "";
  const goalAtTime = hasGoal ? goalRaw : `${UNKNOWN_PREFIX}no-goal-at-write`;

  const missing: EpisodeField[] = [];
  // place / viewpoint 在写入端一定有值（渠道映射 + 固定第一人称）；只有 goalAtTime 可能缺
  if (!hasGoal) missing.push("goalAtTime");
  // 在场者不是五元组字段，但空在场者意味着"这条不完整"——仍然写下去，由读取端判断
  const complete = missing.length === 0 && participants.length > 0;

  const fingerprint = buildCueFingerprint(input, participants, place);
  // v3：direction 只在调用方知道时写入。缺键 = unknown；不写 "unknown" 字符串是因为
  // 缺失与未知同义，多一个会被读成"真的判断过、结论是未知"的假值。
  const direction = input.direction;
  const encodeCtx: Record<string, unknown> = {
    place,
    viewpoint: VIEWPOINT_SELF,
    ...(direction === undefined ? {} : { direction }),
    goal_at_time: goalAtTime,
    episode_write_version: EPISODE_WRITE_VERSION,
    episode_missing: [...missing],
    cue_fingerprint: {
      topicDomain: fingerprint.topicDomain,
      participants: [...fingerprint.participants],
      place: fingerprint.place,
      affect: fingerprint.affect,
      timeOfDay: fingerprint.timeOfDay,
      goalId: fingerprint.goalId,
    },
  };
  return { encodeCtx, participants, missing, fingerprint, complete };
}

export interface CueOverlap {
  /** 对上的字段数 */
  readonly matched: number;
  /** 参与比较的字段数（goalId 只有两边都知道时才计入） */
  readonly total: number;
  /** 重合度 0..1；没有可比字段时返回 1（没有信息 ≠ 不匹配） */
  readonly ratio: number;
}

/**
 * §5.6 线索重合：`|写时指纹 ∩ 当前情境| / |写时指纹|`。
 *
 * 本实现按**字段**比较（不按字符串相似度）：话题域/地点/情绪底色相等记 1；
 * 在场者只要有一个重合记 1（"那天有你"是比"人数一样"更接近的记忆线索）；
 * goalId 只有两边都知道时才参与——不知道的不该被算成"不匹配"。
 */
export function cueOverlap(written: CueFingerprint, current: CueFingerprint): CueOverlap {
  let matched = 0;
  let total = 0;

  // 只比较"写的时候确实记下来的"字段：空字符串/空在场者不是信息，
  // 拿它去和当前情境比会把"我们不知道"当成"对不上"。
  if (written.topicDomain !== "") {
    total += 1;
    if (written.topicDomain === current.topicDomain) matched += 1;
  }

  if (written.participants.length > 0) {
    total += 1;
    if (written.participants.some((p) => current.participants.includes(p))) matched += 1;
  }

  if (written.place !== "") {
    total += 1;
    if (written.place === current.place) matched += 1;
  }

  // 情绪底色是写时一定有值的（neutral 本身也是信息：那天很平淡）
  total += 1;
  if (written.affect === current.affect) matched += 1;

  // 时段只有「两边都知道」时才比较：旧记录没有 timeOfDay、当前 cue 也不传 localHour，
  // 拿未知去比会把「不知道」误算成「对不上」。
  if (written.timeOfDay !== null && current.timeOfDay !== null) {
    total += 1;
    if (written.timeOfDay === current.timeOfDay) matched += 1;
  }

  if (written.goalId !== null && current.goalId !== null) {
    total += 1;
    if (written.goalId === current.goalId) matched += 1;
  }

  return { matched, total, ratio: total === 0 ? 1 : matched / total };
}

/**
 * 把重合度乘到打分上（§5.6「乘到最终分上」）。
 *
 * 与规格字面的一处偏离：**下限 0.5，不清零**。字面乘法在"线索一个都对不上"时
 * 把分数打成 0，等于这条记忆永远想不起来——而"线索不对"不等于"不存在"。
 * 这里保留一半分数作为"想不起来但仍在"的地板；要改成字面乘法只改这一处。
 */
export function scoreWithCueOverlap(baseScore: number, overlap: CueOverlap): number {
  if (!Number.isFinite(baseScore) || baseScore < 0) return baseScore;
  const ratio = clamp01(overlap.ratio);
  return baseScore * (SCORE_FLOOR_MULTIPLIER + (1 - SCORE_FLOOR_MULTIPLIER) * ratio);
}

/** 一行摘要：给日志/台账看，不给她看。 */
export function describeEpisodeWrite(payload: EpisodeWritePayload): string {
  const missing = payload.missing.length === 0 ? "完整" : `缺 ${payload.missing.join("+")}`;
  return `episode(${payload.fingerprint.topicDomain}/${payload.fingerprint.place}/${payload.fingerprint.affect}) ${missing}`;
}

/** 导出五元组字段名，方便调用方/测试核对"哪些字段算五元组"（与 episode.ts 同一份） */
export const EPISODE_WRITE_FIELDS: readonly EpisodeField[] = EPISODE_FIELDS;
