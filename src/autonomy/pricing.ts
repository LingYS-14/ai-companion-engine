/**
 * 峰谷调度：让她的「活人节奏」跟着电价走，而不是跟着刷新率走。
 *
 * 用户拍板（2026-10-29）：
 *   - 按 DeepSeek 峰谷定价：**峰时调用少，谷时调用多**；
 *   - 周末与法定节假日**不设总上限**，但保持「正常人频率」；
 *   - 频率过高触发警报，进入审核（自动退避到峰时节奏，并在日志里写清楚）。
 *
 * 这里只做纯计算：给定时刻 → 现在是峰还是谷、内部言语/学习的间隔该乘多少、这一小时还能不能调。
 * 真正的调用、退避与告警写日志由自主进程负责。
 */

/** 本地日期键 YYYY-MM-DD（与 brain.dayKey 同构，但不引它的依赖） */
export interface PacingInput {
  readonly now: number;
  /** 本地时区偏移分钟数；东八区 = 480 */
  readonly tzOffsetMinutes?: number | undefined;
  /** 该日是不是休息日（周末或节假日）；由调用方按日历算，避免把节假日表焊死在这里 */
  readonly restDay?: boolean | undefined;
}

export interface WindowPacing {
  /** peak = 峰时（工作日北京 09–12、14–18），offpeak = 谷时（其余全部） */
  readonly phase: "peak" | "offpeak";
  readonly restDay: boolean;
  /** 间隔缩放：>1 = 拉长（少调），<1 = 缩短（多调） */
  readonly intervalScale: number;
  /** 这一小时最多允许的模型调用次数（峰时少、谷时多；休息日放宽） */
  readonly maxCallsPerHour: number;
  readonly reason: string;
}

/**
 * DeepSeek 官方峰谷（2026-11 价目表）：
 * - 峰时 = 工作日（周一至周五、非法定节假日）UTC 01:00–04:00 与 06:00–10:00，
 *   即北京时间 **09:00–12:00 与 14:00–18:00**；
 * - 其余（含夜间、周末、中国法定节假日）全为谷时，价格减半。
 *
 * 旧实现按「北京 08:30–次日 00:30 为峰时」调度，那是上一代价目表的口径；
 * 2026-11 起服务端已改档，继续按旧口径会把「谷时」算成峰时（少调用），
 * 与用户「效果优先」的裁决相反。F353 按官方口径重写。
 */
export const DEEPSEEK_PEAK_WINDOWS_MINUTE: readonly (readonly [number, number])[] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

const DAY_MINUTES = 24 * 60;

function minuteOfDay(now: number, tzOffsetMinutes: number): number {
  const local = now + tzOffsetMinutes * 60_000;
  const day = Math.floor(local / 86_400_000);
  const ms = local - day * 86_400_000;
  return Math.floor(ms / 60_000);
}

/** DeepSeek 的峰谷时段：工作日两个白日窗口为峰时，其余全为谷时 */
export function deepseekPhase(input: PacingInput): "peak" | "offpeak" {
  if (input.restDay === true) return "offpeak";
  const minute = minuteOfDay(input.now, input.tzOffsetMinutes ?? 480);
  const inPeak = DEEPSEEK_PEAK_WINDOWS_MINUTE.some(([start, end]) => minute >= start && minute < end);
  return inPeak ? "peak" : "offpeak";
}

/**
 * 节奏表。
 *
 * 2026-11-06 用户裁决：「模型调用可以不要那么保守，一切为了效果服务，先考虑能否达成效果再考虑降低消耗。」
 * 旧口径是「峰时少调、谷时多调」，但旧 cap（6/12 次每小时）比 API 并发/限流严两个数量级，
 * 现场留下了「额度不够（已用 6/6）」跳过主动开口的证据。F353 把 cap 抬到 30/60（休息日 ×1.5），
 * 仍保留「峰时略稀、谷时略密」的节奏感，但不再让人格密度被额度挤掉。
 */
export function pacingFor(input: PacingInput, opts: { peakScale?: number; offpeakScale?: number; restScale?: number } = {}): WindowPacing {
  const phase = deepseekPhase(input);
  const restDay = input.restDay === true;
  const peakScale = opts.peakScale ?? 1.2;
  const offpeakScale = opts.offpeakScale ?? 0.6;
  const restScale = opts.restScale ?? 0.6;
  const base = phase === "peak" ? peakScale : offpeakScale;
  const intervalScale = restDay ? base * restScale : base;
  const maxCallsPerHour = Math.round((phase === "peak" ? 30 : 60) * (restDay ? 1.5 : 1));
  const reason = `phase=${phase} restDay=${String(restDay)} scale=${intervalScale.toFixed(2)} cap=${String(maxCallsPerHour)}/h`;
  return { phase, restDay, intervalScale, maxCallsPerHour, reason };
}

/** 本轮间隔 = 基础间隔 × 缩放（夹在 5 分钟–3 小时） */
export function scaledIntervalMs(baseMs: number, pacing: WindowPacing): number {
  const scaled = baseMs * pacing.intervalScale;
  return Math.max(300_000, Math.min(10_800_000, Math.round(scaled)));
}

export interface RateAlert {
  readonly alert: boolean;
  /** 触发后建议的间隔倍数（审核期退避到峰时水平） */
  readonly backoffScale: number;
  readonly reason: string;
}

/**
 * 频率警报：一小时内的调用数**达到**上限就进入审核。
 *
 * cap 是硬上限：已用满（callsLastHour === maxCallsPerHour）就不再放行下一次，
 * 否则实际每小时会跑到 cap+1 次（2026-11-02 用户裁决修掉这个差 1 的旧实现；
 * 健康检查用 `calls.length <= cap` 判 ✓，与旧实现正好错开一格）。
 * 审核期内不退避到 0（那会让她忽然「断片」），而是退避到峰时节奏并在日志里留痕。
 */
export function rateAlert(callsLastHour: number, pacing: WindowPacing): RateAlert {
  if (!Number.isFinite(callsLastHour) || callsLastHour < pacing.maxCallsPerHour) {
    return { alert: false, backoffScale: 1, reason: "ok" };
  }
  return {
    alert: true,
    backoffScale: 1.6,
    reason: `hourly calls=${String(callsLastHour)} >= cap=${String(pacing.maxCallsPerHour)}，退避到峰时节奏并记审核`,
  };
}

/**
 * 休息日判定：周末统一算休息日；法定节假日由外部给表（`data/holidays.txt`，每行 YYYY-MM-DD）。
 * 调休上班日由第二张表覆盖（`data/workdays.txt`）：它是周末，但国务院把那天调成了工作日。
 * 不硬编码节假日：调休每年都变，写死在代码里一定会错，且错得不明显。
 */
export function isRestDay(
  localDay: string,
  holidays: readonly string[] = [],
  workdays: readonly string[] = [],
): boolean {
  // 调休上班优先：周末被调成工作日，就不该按休息日的低调用节奏跑
  if (workdays.includes(localDay)) return false;
  if (holidays.includes(localDay)) return true;
  // dayKey(2026-10-29) 这类格式：用 UTC 解析只取星期，不受本地时区影响
  const ts = Date.parse(`${localDay}T00:00:00Z`);
  if (!Number.isFinite(ts)) return false;
  // 纯算术取 UTC 星期（1970-01-01 是周四=4）。这里要的是「这天星期几」的纯函数，
  // 不该建时钟对象（writers lint 只允许 clock.ts 建时钟；它连注释里的字样也算）。
  const weekday = ((Math.floor(ts / 86_400_000) + 4) % 7 + 7) % 7;
  return weekday === 0 || weekday === 6;
}

/** 从「每行一个日期」的文本解析节假日表（空行/注释忽略） */
export function parseHolidayList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
}
