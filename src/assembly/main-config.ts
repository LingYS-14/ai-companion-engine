/**
 * 常驻进程的引导件（装配层，F278）。
 *
 * 为什么从 `scripts/autonomy/main.mjs` 搬出来：
 * 审计 §3 P0-1 说过常驻入口不在规则里——`main.mjs` 原先带着日志轮转、环境文件解析、
 * 节假日/调休表、OneBot 配置读取、本地时间换算这些**可单测的纯逻辑**，写在入口里
 * 既没法测，也让入口一直很厚（1700 行）。这里只放引导用的纯函数：
 * 不读时钟（时间由调用方传入）、不读全局状态（路径与 env 由调用方传入）、
 * 写日志失败只吞掉（日志坏了不能让她停摆）。
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { dayKey } from "../autonomy/tick-plan.js";
import { formatUtc } from "../orchestrator/intent/episode.js";
import { readOneBotConn, type OneBotConn } from "../autonomy/onebot-config.js";
import { parseHolidayList } from "../autonomy/pricing.js";

/** 日志超过这个大小就轮转一份 `.1`：常驻进程不能把磁盘写满。 */
export const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

export interface RuntimeLogInput {
  readonly logPath: string;
  readonly line: string;
  readonly nowMs: number;
  /** 测试里关掉 stdout 回显，免得污染测试输出 */
  readonly echo?: boolean;
}

/**
 * 写一行带时间戳的日志，返回写出去的那行。
 *
 * - 时间戳用 ISO（UTC），与仓库既有日志格式一致；
 * - 轮转失败（文件被别的进程占着等）只吞掉，不能因为这个让她停摆；
 * - `nowMs` 由调用方传入而不是在这一层取时钟：入口里可以有一个地方取时钟，
 *   但这一层必须能注入（否则没法测「轮转发生在什么时候」）。
 */
export function appendRuntimeLog(input: RuntimeLogInput): string {
  // 时间格式化走纯算术（lint:writers 禁止这一层自己取时钟；秒级够用，与其它日志一致）。
  const text = `${formatUtc(input.nowMs)} ${input.line}`;
  try {
    if (existsSync(input.logPath) && statSync(input.logPath).size > LOG_ROTATE_BYTES) {
      renameSync(input.logPath, `${input.logPath}.1`);
    }
  } catch {
    // 轮转失败不阻断她
  }
  appendFileSync(input.logPath, `${text}\n`, "utf8");
  if (input.echo !== false) process.stdout.write(`${text}\n`);
  return text;
}

/**
 * 把 `data/autonomy.env`（KEY=VALUE 每行一条、# 注释）注入环境。
 *
 * 规则：不覆盖已经存在的变量（shell 里显式给的优先）；坏行跳过不抛。
 * 文件不进版本库，也不打印值。
 */
export function loadEnvFile(
  path: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== "" && env[key] === undefined) env[key] = value;
  }
}

/** 节假日表：文件不存在/读不了都返回空数组（不是错误，只是没有配置）。 */
export function readHolidayFile(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return parseHolidayList(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/** 调休上班日：与节假日表配对使用。 */
export function readWorkdayFile(path: string): string[] {
  return readHolidayFile(path);
}

/** OneBot 连接参数：读不到返回 null（她就只写日记，不对外说）。 */
export function readOneBotConfig(path: string): OneBotConn | null {
  if (!existsSync(path)) return null;
  try {
    return readOneBotConn(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface LocalPartsResult {
  readonly localHour: number;
  readonly localDay: string;
}

/**
 * 把 UTC 毫秒换成本地小时与本地日（按固定时区偏移，不依赖系统时区）。
 *
 * 常驻进程用 `tzOffsetMinutes=480`（UTC+8）。`dayKey` 来自 tick-plan，
 * 保证「凌晨算哪一天」与 tick 的日会计口径一致。
 */
export function localPartsOf(nowMs: number, tzOffsetMinutes: number): LocalPartsResult {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isFinite(tzOffsetMinutes)) throw new RangeError("tzOffsetMinutes 必须是有限数");
  // 同样不构造 Date：本地小时就是「UTC 毫秒 + 偏移」按小时取模。
  const localMs = nowMs + tzOffsetMinutes * 60_000;
  const localHour = Math.floor(localMs / 3_600_000) % 24;
  return { localHour, localDay: dayKey(nowMs, tzOffsetMinutes) };
}

/** 数据目录下的固定文件名（入口不必自己拼）。 */
export function dataFile(dataDir: string, name: string): string {
  return join(dataDir, name);
}
