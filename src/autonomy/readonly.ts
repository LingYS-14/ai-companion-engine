/**
 * 开发面只读闸（目标 ④）。
 *
 * 约定（docs/OPERATIONS.md）：她的常驻进程是状态的**默认写者**；开发会话（本 DSH 主机，
 * 也就是我）默认只读。要临时放开写，必须由人显式放一个开关文件 `data/dev-write.on`——
 * 这样"读"不需要授权、"写"需要，而且授权这一步落成文件、看得见、可审计、可撤销。
 *
 * 为什么不做成"抢锁"：抢锁会把她的进程饿死（实测过：宿主持锁时她每拍都 `locked`），
 * 而且开发会话不该因为一次查询就把她挤下线。只读闸是**拒绝写**，不是**抢锁**。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { pidAlive } from "./lock.js";

export const WRITER_LOCK_FILE = ".writer-lock";
/** 心跳文件：`autonomy-<characterId>.beat`，由常驻进程每拍写一次 */
export const HEARTBEAT_FILE_PREFIX = "autonomy-";
export const HEARTBEAT_SUFFIX = ".beat";
export const DEV_WRITE_FLAG = "dev-write.on";
/** 心跳超过这个时长就认为自主进程不在了（与 lock.ts 默认值一致） */
export const AUTONOMY_STALE_MS = 10 * 60_000;
/** 心跳超过这个时长就认为她不在了（比锁宽松：一拍可能因模型调用跑得久） */
export const HEARTBEAT_STALE_MS = 15 * 60_000;

interface LockSnapshot {
  readonly version?: unknown;
  readonly pid?: unknown;
  readonly owner?: unknown;
  readonly heartbeatAt?: unknown;
}

function readLock(dataDir: string): LockSnapshot | null {
  const path = join(dataDir, WRITER_LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as LockSnapshot) : null;
  } catch {
    return null;
  }
}

/** 自主进程此刻是否真的持有写锁（owner=autonomy、心跳新鲜、进程还活着） */
export function autonomyOwnsLock(dataDir: string, now: number, staleMs = AUTONOMY_STALE_MS): boolean {
  const lock = readLock(dataDir);
  if (lock === null) return false;
  const pid = lock.pid;
  const beat = lock.heartbeatAt;
  if (typeof pid !== "number" || typeof beat !== "number") return false;
  if (!pidAlive(pid)) return false;
  if (now - beat > staleMs) return false;
  // 心跳新鲜且持有者活着就算"有人在写"——不管是她、还是宿主按回合接待 QQ。
  // 无 version 的旧格式锁也一样 fail-closed：可能是宿主旧实例泄漏的长心跳定时器，
  // 分不清就宁可多让一步，也不能在别人可能正在写的时候动状态文件。
  void lock.version;
  return true;
}

interface Heartbeat {
  readonly pid?: unknown;
  readonly at?: unknown;
}

function readHeartbeat(dataDir: string, characterId: string): Heartbeat | null {
  const path = join(dataDir, `${HEARTBEAT_FILE_PREFIX}${characterId}${HEARTBEAT_SUFFIX}`);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Heartbeat) : null;
  } catch {
    return null;
  }
}

/**
 * 自主进程是否活着。
 *
 * 为什么不只看写锁：她的循环是"一拍一锁"（跑完就放，避免把宿主饿死），所以锁大部分时间是空的；
 * 只读闸若以锁为准，开发会话就能在她两拍之间随手写状态——那就等于没有只读。
 * 心跳是她"活着"的持续证据，锁只是"正在写"的瞬时证据。
 */
export function autonomyAlive(dataDir: string, characterId: string, now: number, staleMs = HEARTBEAT_STALE_MS): boolean {
  const beat = readHeartbeat(dataDir, characterId);
  if (beat === null) return false;
  if (typeof beat.pid !== "number" || typeof beat.at !== "number") return false;
  if (!pidAlive(beat.pid)) return false;
  return now - beat.at <= staleMs;
}

/** 人在场时打开的写入授权；不存在 = 开发会话只读 */
export function devWriteAuthorized(dataDir: string): boolean {
  return existsSync(join(dataDir, DEV_WRITE_FLAG));
}

/**
 * 写工具的前置检查。
 *
 * 返回 null = 放行；返回字符串 = 拒绝理由（直接回给调用者，不抛异常——
 * 工具抛异常在宿主里只会显示成一条红字，模型看不到"为什么"，也就不会改用只读路径）。
 */
export function devWriteBlocked(dataDir: string, characterId: string, now: number): string | null {
  if (devWriteAuthorized(dataDir)) return null;
  if (!autonomyOwnsLock(dataDir, now) && !autonomyAlive(dataDir, characterId, now)) return null;
  return [
    "[只读] 她的常驻进程正持有写锁，开发会话默认只读。",
    `要临时放开写：新建 ${join(dataDir, DEV_WRITE_FLAG)}（用完删掉）。`,
    "只读的查法：soul_state / soul_recall / soul_stats / soul_persona / soul_stats 等仍可用。",
  ].join("\n");
}
