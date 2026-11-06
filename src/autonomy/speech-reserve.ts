/**
 * 额度优先级（用户 2026-10-31 17:17 选 A）：**给「开口」留一次预算**。
 *
 * 问题：她一小时的模型调用额度（谷 10 / 峰 6）很容易被后台活动吃掉——
 * 自言自语约每 20 分钟一次、夜间洞见/再巩固各一次、学习轮转也要调模型。
 * 结果 121 拍里 106 拍被 `gate=quota` 挡下：**她不是不想说话，是轮不到她说话**。
 *
 * 这个模块只回答一个问题：现在这一拍，后台活动该不该让路？
 * 答案：剩余额度 ≤ 预留数时让路（够留给「她想开口」或「回消息」）。
 *
 * 为什么不是定时器/主动门：它不决定她要不要说，只决定**谁先花这笔额度**；
 * 开口与否仍由意图拍板 + HOLD 决定（用户 D1 裁决）。
 */

/** 留给「开口/回信」的额度格数。1 = 至少还有一次真调用可用。 */
export const SPEECH_RESERVE = 1;

export interface ReserveInput {
  readonly usedCalls: number;
  readonly maxCalls: number;
  /** 覆盖默认预留（测试/特殊窗口用） */
  readonly reserve?: number;
}

function checkNumbers(input: ReserveInput): void {
  if (!Number.isFinite(input.usedCalls) || input.usedCalls < 0) {
    throw new RangeError(`speech-reserve: usedCalls 非法：${String(input.usedCalls)}`);
  }
  if (!Number.isFinite(input.maxCalls) || input.maxCalls < 0) {
    throw new RangeError(`speech-reserve: maxCalls 非法：${String(input.maxCalls)}`);
  }
  const reserve = input.reserve ?? SPEECH_RESERVE;
  if (!Number.isInteger(reserve) || reserve < 0) {
    throw new RangeError(`speech-reserve: reserve 非法：${String(input.reserve)}`);
  }
}

/** 这一小时还剩几格额度（不会小于 0）。 */
export function remainingCalls(input: ReserveInput): number {
  checkNumbers(input);
  return Math.max(0, input.maxCalls - input.usedCalls);
}

/** 后台活动是否该让路：剩余 ≤ 预留。 */
export function shouldYieldForSpeech(input: ReserveInput): boolean {
  return remainingCalls(input) <= (input.reserve ?? SPEECH_RESERVE);
}

/** 日志用一句话；不让路时返回 null（调用方不会刷屏）。 */
export function describeSpeechReserve(input: ReserveInput): string | null {
  const remaining = remainingCalls(input);
  if (remaining > (input.reserve ?? SPEECH_RESERVE)) return null;
  return `给开口留额度（本小时已用 ${String(input.usedCalls)}/${String(input.maxCalls)}，还剩 ${String(remaining)} 格）`;
}
