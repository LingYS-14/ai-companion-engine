/**
 * 脊髓状态落盘（F267，审计 B.6 的收尾）：让「通道断没断」成为可观测事实。
 *
 * 审计 B.6 的原话：`health.mjs` 与运行日志里 `spine` 命中都是 0，`data/spine-*.json`
 * 不存在——所以「熔断在 10-30 生效」这件事**无法验证**，可确认的只是它上线至今
 * 从未触发。一个只在内存里的保险丝，等于"出事了没人知道它到底有没有动作"。
 *
 * 本文件只负责"快照 ↔ 文件"的序列化与原子写；状态机仍在 `spine.ts`（纯函数，
 * 不碰盘）。落盘失败**不影响**熔断判定（可观测性不该反过来造成故障）。
 *
 * 纪律：不读时钟（调用方把 atMs 放进快照）、不读配置；坏行/坏形状一律 fail-closed
 * 返回 null，不猜"可能是闭合"——健康检查宁可说"没有记录"，也不替她编状态。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SpineSnapshot, SpineState } from "./spine.js";

export const SPINE_SNAPSHOT_VERSION = 1;

const STATES: readonly SpineState[] = ["closed", "open", "half-open"];

/** `data/spine-<characterId>.json` */
export function spineSnapshotPath(dataDir: string, characterId: string): string {
  return join(dataDir, `spine-${characterId}.json`);
}

export function serializeSpineSnapshot(snapshot: SpineSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

/** fail-closed：版本/状态/时间/数字任何一项不对就返回 null（不猜）。 */
export function parseSpineSnapshot(raw: string): SpineSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== SPINE_SNAPSHOT_VERSION) return null;
  if (typeof rec["state"] !== "string" || !STATES.includes(rec["state"] as SpineState)) return null;
  const atMs = rec["atMs"];
  const failures = rec["failures"];
  const threshold = rec["threshold"];
  const cooldownMs = rec["cooldownMs"];
  if (!Number.isFinite(atMs) || !Number.isFinite(failures)) return null;
  if (!Number.isFinite(threshold) || !Number.isFinite(cooldownMs)) return null;
  const openUntilMs = rec["openUntilMs"];
  const probeAtMs = rec["probeAtMs"];
  if (openUntilMs !== null && !Number.isFinite(openUntilMs)) return null;
  if (probeAtMs !== null && !Number.isFinite(probeAtMs)) return null;
  return {
    version: SPINE_SNAPSHOT_VERSION,
    atMs: atMs as number,
    state: rec["state"] as SpineState,
    failures: failures as number,
    openUntilMs: (openUntilMs ?? null) as number | null,
    probeAtMs: (probeAtMs ?? null) as number | null,
    threshold: threshold as number,
    cooldownMs: cooldownMs as number,
  };
}

/** 原子写（tmp + rename）；写失败只记日志，不抛给熔断路径。 */
export function writeSpineSnapshotFile(path: string, snapshot: SpineSnapshot, log?: (line: string) => void): boolean {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, serializeSpineSnapshot(snapshot), "utf8");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log?.(`[spine] 快照落盘失败（不影响熔断）：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 读不到/坏了都返回 null（health 侧据此说"没有记录"）。 */
export function readSpineSnapshotFile(path: string): SpineSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseSpineSnapshot(raw);
}
