/**
 * 时间观 P1（DESIGN-TEMPORALITY-SLEEP-PERSONA v0.2 §2）——事实层 `TemporalSnapshot`。
 *
 * 由来：她原来的提示词里写着「现在是 N 点」和「称呼对方为「用户」」——前者是**硬编码推断**，
 * 后者是**硬编码规则**。设计的核心不是再给她一条规则，而是把她本来就能感知、却被丢掉的
 * 事实交给她：现在几点、醒了多久、他上一次说话是多久前、她主动说了几句他还没回。
 *
 * 三条纪律（与 situation-note 同源）：
 * - **纯数据零推断**：这里只做算术与字段整理；「他多半睡了」这类判断属于模型，不属于代码。
 * - **不知道就不编**：没有线索给 null，绝不把「没测到」写成「他不在」。
 * - **时间由调用方注入**：本层不读时钟（`tools/lint/writers.mjs` 规则 2：src 里除
 *   `src/engine/clock.ts` 外禁止构造 Date 或调用 Date 的 now——注释里也不写这两个字面，
 *   因为规则是裸正则扫全文），本地日期/星期用纯算术算。
 *
 * P1 范围只到「事实」。节律层（作息先验）的骨架 P2a 已落：`hisRhythm` 由调用方注入
 * `src/orchestrator/intent/rhythm.ts` 的纯函数结果（样本门槛未达标时必须为 null，不编）；
 * 睡眠状态机是 P3——`lastSleep.hours` 仍留空（P3 才有真实睡眠时长，不编）。
 */

/** 在场事实：DSH 侧手工信号或操作系统键鼠探针给的「他刚在/刚走」。 */
export interface TemporalPresence {
  readonly atMs: number;
  readonly active: boolean;
  readonly ttlMs: number;
}

/**
 * 他的作息事实（P2a）：只由 `rhythm.ts` 的统计产出，本层只透传、不推断。
 *
 * 放在 temporal.ts 里是为了避免 `rhythm.ts → temporal.ts → rhythm.ts` 的循环依赖；
 * 字段全部是**观察结果**（计数/最常小时/覆盖日期），不含「他多半睡了」这类判断。
 */
export interface HisRhythm {
  /** 计入的入站样本数（只算 player / qq_contact_verified）。 */
  readonly sampleCount: number;
  /** 覆盖的本地日期数（去重）。 */
  readonly distinctLocalDates: number;
  /** 落在工作日（含 calendar.workDays 覆盖）的**不同本地日期数**。 */
  readonly workdayDays: number;
  /** 落在休息日（含 calendar.restDays 覆盖）的**不同本地日期数**。 */
  readonly restdayDays: number;
  /** 24 个本地小时的样本计数，下标即小时 0..23。 */
  readonly byLocalHour: readonly number[];
  /** 样本最多的小时；平局取最早的小时。 */
  readonly peakLocalHour: number;
  /** 置信度 0..1（DESIGN §2.3 的分档公式）。 */
  readonly confidence: number;
  /** 最早/最晚的本地日期，形如 `2026-11-01`。 */
  readonly firstLocalDate: string;
  readonly lastLocalDate: string;
}

export interface TemporalSnapshot {
  readonly nowMs: number;
  /** 本地时间，形如 `2026-11-01 09:42`（由 nowMs + tzOffsetMinutes 纯算术得到）。 */
  readonly localIso: string;
  /** 本地日期，形如 `2026-11-01`（与入口的 dayKey 同口径）。 */
  readonly localDate: string;
  /** 本地小时 0..23。 */
  readonly localHour: number;
  /** 本地分钟 0..59。 */
  readonly localMinute: number;
  /** ISO 星期：1=周一 … 7=周日。 */
  readonly weekday: number;
  /** 星期中文标签（周一…周日），给提示词用。 */
  readonly weekdayLabel: string;
  /** 距上一次跨睡点（上次真正睡过）多少小时；没有记录给 null（不编）。 */
  readonly awakeForHours: number | null;
  /** 他上一次说话/回消息距今多少分钟；没有线索给 null。 */
  readonly sinceLastUserMsgMin: number | null;
  /** 她上一次主动开口距今多少分钟；没有记录给 null。 */
  readonly sinceLastOwnMsgMin: number | null;
  /** 他上次说话之后，她主动开口了几次（都还没被回）。 */
  readonly unansweredOwnMsgs: number;
  /** 上一次睡：atMs + 本地时刻 + 睡了多久（P3 前 hours 恒 null，不编）。 */
  readonly lastSleep: { readonly atMs: number; readonly hours: number | null; readonly localTime: string } | null;
  /** 距下一个睡点还有几小时（当前只是展示/预告事实，不参与判定；P3 才接状态机）。 */
  readonly nextSleepInHours: number | null;
  readonly presence: TemporalPresence | null;
  /** 节律层：作息先验（P2a 起可注入）。样本门槛未达标时必须为 null（见 DESIGN §2.3）。 */
  readonly hisRhythm: HisRhythm | null;
}

export interface TemporalInput {
  readonly nowMs: number;
  /** 时区偏移（分钟，东八区=480）：入口与 health/面板必须同一口径。 */
  readonly tzOffsetMinutes: number;
  readonly sinceLastUserMsgMin?: number | null;
  readonly sinceLastOwnMsgMin?: number | null;
  readonly unansweredOwnMsgs?: number;
  readonly lastSleepAt?: number | null;
  /**
   * P3-2b（task-57 B1）：上一次**醒来**的时刻。有它时 awakeForHours 从醒来算起，
   * 没有才回退到上次睡点（lastSleepAt）。缺省/null → 回退，不编。
   */
  readonly awakeSinceMs?: number | null;
  /** P3 睡眠状态机才有的「睡了多久」；缺省/null → 不编（lastSleep.hours 给 null）。 */
  readonly lastSleepHours?: number | null;
  readonly nextSleepInHours?: number | null;
  readonly presence?: TemporalPresence | null;
  /** P2a 节律结果（`rhythm.buildHisRhythm` 的产物）；缺省/非法 → null，由本层兜底。 */
  readonly hisRhythm?: HisRhythm | null;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 从「1970-01-01 起算的天数」还原公历年月日（Howard Hinnant 的 civil_from_days）。
 * 不构造 Date：既满足 lint:writers，也保证同一 nowMs 在任意机器上结果一致。
 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  // 把纪元从 1970-01-01 挪到 0000-03-01，消掉闰年规则在 2 月的分支。
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/** nowMs + 时区偏移 → 本地日期/时刻/星期（纯算术，不碰 Date）。 */
export function localPartsAt(
  nowMs: number,
  tzOffsetMinutes: number,
): { localDate: string; localTime: string; localHour: number; localMinute: number; weekday: number; weekdayLabel: string } {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(tzOffsetMinutes)) throw new RangeError("tzOffsetMinutes 必须是有限数");
  const shifted = nowMs + tzOffsetMinutes * 60_000;
  const days = Math.floor(shifted / 86_400_000);
  const msOfDay = shifted - days * 86_400_000;
  const localHour = Math.floor(msOfDay / 3_600_000);
  const localMinute = Math.floor((msOfDay % 3_600_000) / 60_000);
  const { year, month, day } = civilFromDays(days);
  // 1970-01-01 是周四：ISO 里 Mon=1 … Sun=7 → 偏移 3 后取模（负数也安全，nowMs 理论上非负）。
  const weekday = (((days + 3) % 7) + 7) % 7 + 1;
  return {
    localDate: `${year}-${pad2(month)}-${pad2(day)}`,
    localTime: `${pad2(localHour)}:${pad2(localMinute)}`,
    localHour,
    localMinute,
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday - 1] ?? "",
  };
}

/** 本地日期里的某个时刻（用于「上一次睡是 03:12」这类事实行）。 */
export function localTimeOf(atMs: number, tzOffsetMinutes: number): string {
  return localPartsAt(atMs, tzOffsetMinutes).localTime;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function minutesOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n === null ? null : Math.max(0, n);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 透传 P2a 节律：形状不对就当「不知道」（null），不猜、不修出半个事实。
 *
 * 正常来源只有 `rhythm.buildHisRhythm`；这里做一次运行时兜底，是为了让调用方传错时
 * 快照仍然诚实——宁可没有节律，也不能让 situation-note 拿一条残缺统计去描述他的作息。
 */
function rhythmOrNull(value: unknown): HisRhythm | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const r = value as Partial<HisRhythm>;
  const numbers = [r.sampleCount, r.distinctLocalDates, r.workdayDays, r.restdayDays, r.confidence];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (typeof r.peakLocalHour !== "number" || !Number.isInteger(r.peakLocalHour) || r.peakLocalHour < 0 || r.peakLocalHour > 23) {
    return null;
  }
  if (!Array.isArray(r.byLocalHour) || r.byLocalHour.length !== 24) return null;
  if (!r.byLocalHour.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  if (typeof r.firstLocalDate !== "string" || typeof r.lastLocalDate !== "string") return null;
  return r as HisRhythm;
}

/**
 * 把这一拍能拿到的信号整理成时间快照。
 *
 * 输入全部由装配层注入：入口持有 nowMs / 时区 / QQ 状态 / sleepInfo / 在场信号，
 * 本层只做校验与整理。任何一个字段缺失或非法 → 对应字段给 null（不知道就不编）。
 */
export function buildTemporalSnapshot(input: TemporalInput): TemporalSnapshot {
  if (!Number.isFinite(input.nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(input.tzOffsetMinutes)) throw new RangeError("tzOffsetMinutes 必须是有限数");

  const local = localPartsAt(input.nowMs, input.tzOffsetMinutes);

  const unanswered = input.unansweredOwnMsgs ?? 0;
  if (!Number.isInteger(unanswered) || unanswered < 0) {
    throw new RangeError("unansweredOwnMsgs 必须是非负整数");
  }

  const lastSleepAt = finiteOrNull(input.lastSleepAt);
  const lastSleep =
    lastSleepAt === null || lastSleepAt <= 0
      ? null
      : {
          atMs: lastSleepAt,
          hours: minutesOrNull(input.lastSleepHours),
          localTime: localTimeOf(lastSleepAt, input.tzOffsetMinutes),
        };

  // P3-2b（task-57 B1）：优先「上次醒来」（waking→awake 的时刻），没有才回退上次睡点。
  // 两者都没有/非正 → null：宁可不知道，也不拿 nowMs 编一个 0。
  const awakeSince = finiteOrNull(input.awakeSinceMs) ?? lastSleepAt;
  const awakeForHours =
    awakeSince === null || awakeSince <= 0
      ? null
      : round1(Math.max(0, (input.nowMs - awakeSince) / 3_600_000));

  const rawPresence = input.presence ?? null;
  const presence: TemporalPresence | null =
    rawPresence === null ||
    !Number.isFinite(rawPresence.atMs) ||
    typeof rawPresence.active !== "boolean" ||
    !Number.isFinite(rawPresence.ttlMs)
      ? null
      : { atMs: rawPresence.atMs, active: rawPresence.active, ttlMs: Math.max(0, rawPresence.ttlMs) };

  return {
    nowMs: input.nowMs,
    localIso: `${local.localDate} ${local.localTime}`,
    localDate: local.localDate,
    localHour: local.localHour,
    localMinute: local.localMinute,
    weekday: local.weekday,
    weekdayLabel: local.weekdayLabel,
    awakeForHours,
    sinceLastUserMsgMin: minutesOrNull(input.sinceLastUserMsgMin),
    sinceLastOwnMsgMin: minutesOrNull(input.sinceLastOwnMsgMin),
    unansweredOwnMsgs: unanswered,
    lastSleep,
    nextSleepInHours: minutesOrNull(input.nextSleepInHours),
    presence,
    hisRhythm: rhythmOrNull(input.hisRhythm),
  };
}
