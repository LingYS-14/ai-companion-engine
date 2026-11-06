/**
 * 真实接触时间（修复计划 A1）
 *
 * 为什么需要：`state-<id>.json` 的 `updatedAt` 由心跳每 5 分钟重写，
 * 拿它算「上次聊天是多久前」永远得到 0–5 分钟 → `connection` 的接触项恒≈0。
 *
 * 真实的最后一次来往记录在 `data/qq-<id>.json`：
 * - `onebotLastEventAt`：收到的最后一条真实消息时间（`commit()` / `recordOnly()` 写入；
 *   meta_event 不写，所以心跳不会被误当成"他找过她"）；
 * - `lastReplyAt`：她最后一次真回复的时间。
 *
 * 本文件只做解析与算术：不读文件、不读时钟。装配点在 `scripts/autonomy/main.mjs`。
 */

export interface QQContactTimes {
  readonly lastEventAt: number | null;
  readonly lastReplyAt: number | null;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 从 QQ 状态文件的内容里取两个时间；坏字段当没有，不猜。 */
export function parseQQContact(raw: unknown): QQContactTimes {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    lastEventAt: positiveFinite(obj.onebotLastEventAt),
    lastReplyAt: positiveFinite(obj.lastReplyAt),
  };
}

/**
 * 最后一次真实来往的毫秒时间戳（她收到消息或她发出回复，取较晚者）。
 * 没有可用的时间就返回 null——不返回 0，避免把"没有记录"当成"刚刚聊过"。
 */
export function lastContactMs(raw: unknown): number | null {
  const { lastEventAt, lastReplyAt } = parseQQContact(raw);
  if (lastEventAt === null) return lastReplyAt;
  if (lastReplyAt === null) return lastEventAt;
  return Math.max(lastEventAt, lastReplyAt);
}

/** 距上次真实来往多少分钟（向下取整；未来时间按 0 算）；没有记录返回 null。 */
export function lastContactMinutesFrom(raw: unknown, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`lastContactMinutesFrom: nowMs 必须是有限数字，收到 ${String(nowMs)}`);
  }
  const at = lastContactMs(raw);
  if (at === null) return null;
  return Math.max(0, Math.floor((nowMs - at) / 60_000));
}
