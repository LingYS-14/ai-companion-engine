/**
 * 每日数据快照（2026-10-30）：她成了唯一写者之后，文件一旦写坏就没有第二个副本。
 *
 * 做法很朴素：每天一次把关键状态文件复制到 `data/archive/snapshots/<日期>/`，
 * 写一个 manifest 记录来源与大小，超过保留天数的日期目录整体删掉。
 * 不做增量、不做压缩——几十 KB 的东西，简单比聪明重要。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotOptions {
  readonly dataDir: string;
  readonly now: number;
  /** 本地时区偏移（分钟），用于命名日期目录；默认 0（UTC） */
  readonly tzOffsetMinutes?: number;
  /** 保留多少天（含今天） */
  readonly keepDays?: number;
  /** 要复制的文件名（相对 dataDir）；不传用默认集合 */
  readonly files?: readonly string[];
}

export interface SnapshotResult {
  /** 本次写入的目录；同一天已存在则 null */
  readonly dir: string | null;
  readonly copied: readonly string[];
  readonly pruned: readonly string[];
  /** 跳过原因：already-done / nothing-copied */
  readonly skippedReason?: "already-done" | "nothing-copied";
}

export const DEFAULT_SNAPSHOT_FILES = [
  "memory-assistant.ndjson",
  "knowledge-assistant.ndjson",
  "selftalk-assistant.json",
  "qq-assistant.json",
] as const;

export const SNAPSHOT_KEEP_DAYS = 7;

/**
 * 本地日期（YYYY-MM-DD）。
 * 只用纯算术：`src` 里除 clock.ts 外不许自建时间对象（lint:writers），
 * 这里用 Howard Hinnant 的 civil-from-days 算法，与时区表无关。
 */
export function localDay(now: number, tzOffsetMinutes = 0): string {
  const localMs = now + tzOffsetMinutes * 60_000;
  const days = Math.floor(localMs / 86_400_000);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = m <= 2 ? y0 + 1 : y0;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export function snapshotData(options: SnapshotOptions): SnapshotResult {
  const files = options.files ?? DEFAULT_SNAPSHOT_FILES;
  const keepDays = Math.max(1, Math.floor(options.keepDays ?? SNAPSHOT_KEEP_DAYS));
  const day = localDay(options.now, options.tzOffsetMinutes ?? 0);
  const root = join(options.dataDir, "archive", "snapshots");
  const dir = join(root, day);
  if (existsSync(join(dir, "manifest.json"))) return { dir: null, copied: [], pruned: [], skippedReason: "already-done" };

  mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  const entries: { file: string; bytes: number }[] = [];
  for (const name of files) {
    const from = join(options.dataDir, name);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(dir, name));
      const bytes = statSync(from).size;
      copied.push(name);
      entries.push({ file: name, bytes });
    } catch {
      // 单个文件复制失败不阻断其余：快照的价值在于"多一份"，不是"完美一份"
    }
  }
  if (copied.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return { dir: null, copied: [], pruned: [], skippedReason: "nothing-copied" };
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ day, at: options.now, entries }, null, 2)}\n`, "utf8");

  // 清理超期目录（只删形如 YYYY-MM-DD 的目录，别的东西不碰）
  const pruned: string[] = [];
  const oldest = localDay(options.now - (keepDays - 1) * 86_400_000, options.tzOffsetMinutes ?? 0);
  try {
    for (const name of readdirSync(root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      if (name >= oldest) continue;
      rmSync(join(root, name), { recursive: true, force: true });
      pruned.push(name);
    }
  } catch {
    // 清理失败不影响本次快照
  }
  return { dir, copied, pruned };
}

/** 快照是否已经做过（给常驻进程判断"这一拍还要不要做"用） */
export function snapshotDone(dataDir: string, now: number, tzOffsetMinutes = 0): boolean {
  const day = localDay(now, tzOffsetMinutes);
  const manifest = join(dataDir, "archive", "snapshots", day, "manifest.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { day?: unknown };
    return parsed.day === day;
  } catch {
    return false;
  }
}
