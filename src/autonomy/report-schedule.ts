/**
 * 早报的生成时机：每天本地 06:00 由常驻进程自己生成一次。
 *
 * 为什么放在她这边、而不是只靠 DSH 的定时提醒：06:00 那份报告本来就是「她这一夜的记录」，
 * 不该依赖某个会话恰好醒着。常驻进程生成「事实段」，人写「判断段」——脚本重跑会保留判断（F101）。
 *
 * 时间一律用纯算术（src 里不许自建时间对象，lint:writers 会拦）：
 * 本地小时 = ((now + tz*60_000) mod 一天) / 一小时。
 */
import { localDay } from "./snapshot.js";

export const REPORT_HOUR = 6;
export const REPORT_FILE_PREFIX = "MORNING-REPORT-";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 本地小时（0–23） */
export function localHourOf(now: number, tzOffsetMinutes = 0): number {
  const shifted = now + tzOffsetMinutes * 60_000;
  const inDay = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  return Math.floor(inDay / HOUR_MS);
}

/** 今天是否已经生成过（marker 由常驻进程写，人手动生成的报告不算，避免 06:00 拿不到新事实） */
export function shouldGenerateReport(input: {
  readonly now: number;
  readonly tzOffsetMinutes?: number;
  readonly generatedDay: string | null;
}): boolean {
  const tz = input.tzOffsetMinutes ?? 0;
  if (localHourOf(input.now, tz) !== REPORT_HOUR) return false;
  return input.generatedDay !== localDay(input.now, tz);
}

/** 报告与 marker 的路径：报告在 docs/，marker 在 data/（她写 data 是常规操作） */
export function reportPaths(dataDir: string, docsDir: string, now: number, tzOffsetMinutes = 0): {
  readonly day: string;
  readonly report: string;
  readonly marker: string;
} {
  const day = localDay(now, tzOffsetMinutes);
  return {
    day,
    report: `${docsDir}/${REPORT_FILE_PREFIX}${day}.md`,
    marker: `${dataDir}/.report-${day}.done`,
  };
}
