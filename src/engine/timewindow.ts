/**
 * 窗口时间工具：静默时段判定。
 *
 * 从 `src/qq/proactive.ts` 提出来，是为了让 `src/orchestrator/initiative.ts`（§4.9 阶段 0 门控）
 * 也能用同一个判定，又不必让 orchestrator 反向依赖 qq 层（会形成循环 import）。
 * `proactive.ts` 仍原样 re-export `inQuietHours`，旧调用点不需要改。
 */

/** 本地小时是否落在 [from, to) 静默窗内（支持跨零点，如 23 → 7） */
export function inQuietHours(localHour: number, from: number, to: number): boolean {
  const h = ((localHour % 24) + 24) % 24;
  if (from === to) return false;
  return from < to ? h >= from && h < to : h >= from || h < to;
}
