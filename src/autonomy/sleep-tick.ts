/**
 * P3-1c：睡眠期编排 + 夜间额度账本原语（spine 层，纯编排、零状态）。
 *
 * 职责边界（v2.2 §4.4）：
 *   - `runtime.advance` 只负责「推进真实时间」，**不判断睡眠状态**；
 *   - 是否 asleep、这一拍要不要恢复能量，由调用方（loop / main.mjs）用本模块决定；
 *   - 本模块只做两件事：asleep 时调一次 `recoverEnergy(dtHours)`、打一条观测日志。
 *
 * 夜间额度（B2 裁决）：P3 只交**账本原语**，不消费、也不调用模型；
 *   - `normalizeNightBudget`：跨夜重置 / 同夜保留；
 *   - `remainingNightBudget`：剩余额度；
 *   - `consumeNightBudget`：P4 消费者接口，消耗一次（越界抛错）。
 *   账本按「本地日历日」分夜：`nightKeyOf` 的时区由调用方传入（与 temporal/main 的 480 同源），
 *   本模块不自带时区、不读系统时钟、不持有全局状态。
 *
 * 本模块**不接收 quota / usage**：白天开口额度（quota / rph）与夜间预算无关，不得混用；
 * 睡眠期调用准入在 P4 的消费者里，不在本模块。
 */

/**
 * 用户 m02886 裁决：每夜 8 次睡眠功课（范围 6–10，取 8；P4 可调）。
 * 先做数值常量，不注册 overlay。
 */
export const SLEEP_NIGHT_BUDGET = 8;

export type SleepPhase = "awake" | "drowsy" | "asleep" | "waking";

const SLEEP_PHASES: readonly SleepPhase[] = ["awake", "drowsy", "asleep", "waking"];

/** 夜间额度账本：nightKey 是本地日历日（YYYY-MM-DD），used 是当晚已用次数。 */
export interface NightBudget {
  readonly nightKey: string;
  readonly used: number;
}

export interface SleepTickInput {
  /** 本拍的逻辑时间（毫秒）；只做合法性校验，不参与日期推导（nightKey 由 budget 提供） */
  readonly nowMs: number;
  /** 本拍覆盖的小时数。asleep 时必须 ∈ (0,1]；非 asleep 不推进，仅要求有限数 */
  readonly dtHours: number;
  readonly sleep: {
    readonly phase: SleepPhase;
    readonly asleep: boolean;
  };
  /** 夜间额度账本：nightKey 由调用方用 nightKeyOf 算好，used 是已用次数（P3 不增） */
  readonly budget: NightBudget;
}

export interface SleepTickDeps {
  /** 睡眠期能量恢复：只允许调用方在 asleep 时调一次；内部通常转 runtime.advance 的睡眠 tick */
  recoverEnergy(dtHours: number): void;
  /** 观测日志（测试可省略） */
  log?(line: string): void;
}

export interface SleepTickResult {
  readonly asleep: boolean;
  readonly recovered: boolean;
  readonly budgetUsed: number;
  readonly budgetLeft: number;
  readonly nightKey: string;
}

const NIGHT_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地日期 YYYY-MM-DD：纯算术，不构造日期对象（writers 规则禁止时间 API）。 */
export function nightKeyOf(nowMs: number, tzOffsetMinutes: number): string {
  if (!Number.isFinite(nowMs)) throw new RangeError(`nowMs 必须是有限数：${nowMs}`);
  if (!Number.isFinite(tzOffsetMinutes)) {
    throw new RangeError(`tzOffsetMinutes 必须是有限数：${tzOffsetMinutes}`);
  }
  const localMs = nowMs + tzOffsetMinutes * 60_000;
  const days = Math.floor(localMs / 86_400_000);
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Howard Hinnant 的 civil_from_days：把「自 1970-01-01 起的天数」换算成年月日。 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function assertNightBudget(budget: NightBudget): void {
  if (typeof budget !== "object" || budget === null) {
    throw new RangeError("budget 必须是对象");
  }
  const { nightKey, used } = budget;
  if (typeof nightKey !== "string" || !NIGHT_KEY_RE.test(nightKey)) {
    throw new RangeError(`nightKey 必须是 YYYY-MM-DD：${String(nightKey)}`);
  }
  if (!Number.isInteger(used) || used < 0 || used > SLEEP_NIGHT_BUDGET) {
    throw new RangeError(`budget.used 必须是 0..${SLEEP_NIGHT_BUDGET} 的整数：${String(used)}`);
  }
}

/**
 * 把旧账本规范化到「当前时刻所在的夜」：
 *   - 无旧账本 → `{ nightKey, used: 0 }`；
 *   - 同一夜（nightKey 相同）→ 原样保留 used；
 *   - 跨夜（nightKey 变了）→ 重置 used 为 0。
 * `nowMs/tzOffsetMinutes` 与 `nightKeyOf` 同口径；模块不自带时区。
 */
export function normalizeNightBudget(
  nowMs: number,
  tzOffsetMinutes: number,
  budget?: NightBudget,
): NightBudget {
  const nightKey = nightKeyOf(nowMs, tzOffsetMinutes);
  if (budget === undefined) return { nightKey, used: 0 };
  assertNightBudget(budget);
  if (budget.nightKey !== nightKey) return { nightKey, used: 0 };
  return { nightKey, used: budget.used };
}

/** 剩余额度 = max(0, 8 − used)；账本非法（格式/越界）直接抛 RangeError。 */
export function remainingNightBudget(budget: NightBudget): number {
  assertNightBudget(budget);
  return Math.max(0, SLEEP_NIGHT_BUDGET - budget.used);
}

/**
 * P4 消费者接口：消耗 `count` 次夜间额度（默认 1），返回**新账本**（不改入参）。
 * count 非正整数、或 used + count 超过 SLEEP_NIGHT_BUDGET 时抛 RangeError。
 */
export function consumeNightBudget(budget: NightBudget, count = 1): NightBudget {
  assertNightBudget(budget);
  if (!Number.isInteger(count) || count <= 0) {
    throw new RangeError(`count 必须是正整数：${String(count)}`);
  }
  const used = budget.used + count;
  if (used > SLEEP_NIGHT_BUDGET) {
    throw new RangeError(
      `夜间额度不足：已用 ${budget.used}/${SLEEP_NIGHT_BUDGET}，再消耗 ${count} 次`,
    );
  }
  return { nightKey: budget.nightKey, used };
}

function assertSleepTickInput(input: SleepTickInput): void {
  if (!Number.isFinite(input.nowMs)) {
    throw new RangeError(`nowMs 必须是有限数：${input.nowMs}`);
  }
  if (!Number.isFinite(input.dtHours)) {
    throw new RangeError(`dtHours 必须是有限数：${input.dtHours}`);
  }
  const phase = input.sleep.phase;
  if (!SLEEP_PHASES.includes(phase)) {
    throw new RangeError(`未知的睡眠相位：${String(phase)}`);
  }
  if (typeof input.sleep.asleep !== "boolean") {
    throw new RangeError("sleep.asleep 必须是布尔值");
  }
  if (input.sleep.asleep !== (phase === "asleep")) {
    throw new RangeError(`sleep.asleep 与相位不一致：phase=${phase} asleep=${input.sleep.asleep}`);
  }
  assertNightBudget(input.budget);
}

/**
 * 一拍睡眠编排：
 *   - 非 asleep：不恢复、不写日志，仅透传账本；
 *   - asleep：dtHours 必须 ∈ (0,1]（睡眠 tick 是每 5 分钟一拍，不会超过 1 小时），
 *     调一次 recoverEnergy，并写一条 `[sleep-tick] ...`；预算原样返回（P3 不消耗）。
 */
export function runSleepTick(input: SleepTickInput, deps: SleepTickDeps): SleepTickResult {
  if (typeof deps?.recoverEnergy !== "function") {
    throw new RangeError("deps.recoverEnergy 必须是函数");
  }
  if (deps.log !== undefined && typeof deps.log !== "function") {
    throw new RangeError("deps.log 必须是函数或省略");
  }
  assertSleepTickInput(input);

  const { nightKey, used } = input.budget;
  const budgetLeft = remainingNightBudget(input.budget);
  const asleep = input.sleep.asleep;

  if (!asleep) {
    return { asleep: false, recovered: false, budgetUsed: used, budgetLeft, nightKey };
  }

  if (!(input.dtHours > 0 && input.dtHours <= 1)) {
    throw new RangeError(`asleep 时 dtHours 必须在 (0,1] 内：${input.dtHours}`);
  }

  deps.recoverEnergy(input.dtHours);
  deps.log?.(
    `[sleep-tick] dt=${input.dtHours} budget=${used}/${SLEEP_NIGHT_BUDGET} night=${nightKey}`,
  );

  return { asleep: true, recovered: true, budgetUsed: used, budgetLeft, nightKey };
}
