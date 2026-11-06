/**
 * 频率审核的跨重启账本。
 *
 * 用户拍板（2026-10-29）：不设总上限，但「过高要触发警报、进行审核」，且像正常人。
 * 上一轮把「一小时内的调用时刻」放在内存里——重启就归零，等于自审表每次开机重写，
 * 频繁起停时会悄悄绕过上限。这里落一个小文件，只存最近一小时的调用时刻。
 *
 * 纯 I/O 工具，不含策略：什么时候调用、上限多少由 pricing.ts 决定。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const USAGE_WINDOW_MS = 3_600_000;
export const USAGE_FILE_VERSION = 1;

interface UsageFile {
  readonly version: number;
  readonly calls: readonly number[];
}

/** 只留下最近一小时内、有限且不晚于 now 的时刻，升序。 */
export function pruneUsage(calls: readonly number[], now: number): number[] {
  return calls
    .filter((t) => Number.isFinite(t) && t <= now && now - t < USAGE_WINDOW_MS)
    .sort((a, b) => a - b);
}

/** 读账本；文件缺失或损坏都当成「没有记录」——审核宁可从严，不能因为坏文件把额度清零。 */
export function loadUsage(file: string, now: number): number[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UsageFile>;
    if (!Array.isArray(parsed.calls)) return [];
    return pruneUsage(parsed.calls.filter((t): t is number => typeof t === "number"), now);
  } catch {
    return [];
  }
}

/** 原子写：先 tmp 再 rename，避免进程被杀时留下半个 JSON 把审核额度清零。 */
export function saveUsage(file: string, calls: readonly number[], now: number): void {
  const payload: UsageFile = { version: USAGE_FILE_VERSION, calls: pruneUsage(calls, now) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 记一次调用并落盘，返回落盘后的窗口。 */
export function recordUsage(file: string, calls: readonly number[], now: number): number[] {
  const next = pruneUsage([...calls, now], now);
  saveUsage(file, next, now);
  return next;
}

/**
 * 记一次调用（读窗口 → 追加 → 落盘），给"一次调用就是一个动作"的装配点用。
 *
 * 为什么要这个便捷函数：QQ 接待（`qq-runner`）与宿主生成各是一次模型调用，
 * 但它们的装配点没有常驻内存里的 `callTimes`；要求每个装配点自己实现
 * read-modify-write，迟早会有人漏掉——漏掉就是账外调用（P0-2）。
 */
export function recordUsageOnce(file: string, now: number): number[] {
  return recordUsage(file, loadUsage(file, now), now);
}
