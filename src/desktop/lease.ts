/**
 * 桌面输入「许可租约」——把用户的 H6 授权变成一个可执行、可撤销、可审计的机制。
 *
 * 为什么不直接把 allowInput 打开：
 * - 工具层不该自己判断"该不该动"，但也不该把闸门拆掉；现在的问题是**授权没有形状**——
 *   `--allow-input` 是命令行上的一个开关，它不留下"谁在什么时候允许了什么、用了几次"。
 * - 租约把这四件事写进一个文件：谁授权、允许哪几类动作、几次、什么时候过期。
 *   输入动作每次成功都要消耗一次；过期或次数用完就回到"拒绝"。
 *
 * 边界（PLAN-3LAYER Phase 4 / 大脑与脊髓.txt）：
 * - 这里只有纯规则 + 文件读写，不判断"她此刻想做什么"；决策仍在大脑层。
 * - 失败一律 fail-closed：文件读不出、字段不对、版本不对 → 当作没有租约。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type InputAction = "click" | "type" | "key";

export interface DesktopLeaseFile {
  readonly version: 1;
  readonly grantedAt: number;
  readonly expiresAt: number;
  /** 谁授权的：写进审计日志，事后能回答"这个点击是谁允许的" */
  readonly grantedBy: string;
  readonly allow: Readonly<Record<InputAction, boolean>>;
  readonly maxActions: number;
  /** 已经用掉的次数（成功才算） */
  readonly used: number;
}

export type LeaseState = "none" | "expired" | "exhausted" | "active";

export interface LeaseStatus {
  readonly state: LeaseState;
  readonly remaining: number;
  /** 人类可读的一句话，直接给拒绝原因用 */
  readonly detail: string;
}

const MAX_MINUTES = 120;

/** 造一张租约（纯函数）。minutes 会被夹到 1..120，maxActions 夹到 1..50。 */
export function createLease(input: {
  readonly now: number;
  readonly minutes: number;
  readonly maxActions: number;
  readonly grantedBy: string;
  readonly allow?: Partial<Record<InputAction, boolean>>;
}): DesktopLeaseFile {
  const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.trunc(input.minutes)));
  const maxActions = Math.min(50, Math.max(1, Math.trunc(input.maxActions)));
  return {
    version: 1,
    grantedAt: input.now,
    expiresAt: input.now + minutes * 60_000,
    grantedBy: input.grantedBy.trim() === "" ? "unknown" : input.grantedBy.trim(),
    allow: {
      click: input.allow?.click ?? true,
      type: input.allow?.type ?? true,
      key: input.allow?.key ?? true,
    },
    maxActions,
    used: 0,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 解析租约文件：任何形状不对都返回 null（fail-closed，不猜）。 */
export function parseLease(raw: unknown): DesktopLeaseFile | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== 1) return null;
  const grantedAt = num(raw["grantedAt"]);
  const expiresAt = num(raw["expiresAt"]);
  const maxActions = num(raw["maxActions"]);
  const used = num(raw["used"]);
  const grantedBy = raw["grantedBy"];
  const allow = raw["allow"];
  if (grantedAt === null || expiresAt === null || maxActions === null || used === null) return null;
  if (typeof grantedBy !== "string" || !isRecord(allow)) return null;
  if (!Number.isInteger(maxActions) || maxActions < 1 || !Number.isInteger(used) || used < 0) return null;
  if (used > maxActions) return null;
  return {
    version: 1,
    grantedAt,
    expiresAt,
    grantedBy,
    allow: {
      click: allow["click"] === true,
      type: allow["type"] === true,
      key: allow["key"] === true,
    },
    maxActions,
    used,
  };
}

/** 当前状态（纯函数；`lease=null` 表示从来没有过）。 */
export function leaseStatus(lease: DesktopLeaseFile | null, now: number): LeaseStatus {
  if (lease === null) return { state: "none", remaining: 0, detail: "没有桌面输入租约（需要用户显式授权）" };
  if (now >= lease.expiresAt) {
    return { state: "expired", remaining: 0, detail: `桌面输入租约已过期（${lease.grantedBy} 授权）` };
  }
  const remaining = lease.maxActions - lease.used;
  if (remaining <= 0) {
    return { state: "exhausted", remaining: 0, detail: "桌面输入租约的次数已用完" };
  }
  return { state: "active", remaining, detail: `可用 ${remaining} 次（${lease.grantedBy} 授权）` };
}

export interface LeaseDecision {
  readonly ok: boolean;
  readonly reason: string;
  /** 通过时给出"消耗一次之后"的新租约；不通过时原样返回 */
  readonly lease: DesktopLeaseFile | null;
}

/** 判定一次输入动作能不能做；通过时返回消耗一次后的租约（由调用方落盘）。 */
export function authorizeLease(
  lease: DesktopLeaseFile | null,
  now: number,
  action: InputAction,
): LeaseDecision {
  const status = leaseStatus(lease, now);
  if (lease === null || status.state !== "active") return { ok: false, reason: status.detail, lease };
  if (!lease.allow[action]) return { ok: false, reason: `租约不允许「${action}」这类动作`, lease };
  return {
    ok: true,
    reason: `通过（剩余 ${status.remaining - 1} 次）`,
    lease: { ...lease, used: lease.used + 1 },
  };
}

/** 读租约文件；不存在/坏文件一律 null。 */
export function readLease(path: string): DesktopLeaseFile | null {
  if (!existsSync(path)) return null;
  try {
    return parseLease(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** 原子写租约文件；失败只返回 false，不抛（工具层不能因为记账失败而炸掉动作）。 */
export function writeLease(path: string, lease: DesktopLeaseFile): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export interface DesktopAuditEntry {
  readonly at: number;
  readonly action: string;
  readonly ok: boolean;
  readonly detail: string;
  /** 输入动作才有：这次是哪个租约授权、消耗到第几次 */
  readonly lease?: { readonly grantedBy: string; readonly used: number; readonly maxActions: number };
  readonly path?: string;
}

/** 追加式审计日志（NDJSON）。写不进去只返回 false，不抛。 */
export function appendAudit(path: string, entry: DesktopAuditEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 默认路径：跟其他数据一起放 data/ 下（仓库形态与运行时形态都可覆盖）。 */
export function defaultLeasePath(dataDir: string): string {
  return join(dataDir, "desktop-lease.json");
}

export function defaultAuditPath(dataDir: string): string {
  return join(dataDir, "desktop-actions.ndjson");
}
