/**
 * 面板「状态快照」（F274，审计 P1-8 后半）。
 *
 * 问题：插件进程有自己的 SoulRuntime，它只在「自己投递过一次写」之后才
 * `reloadState()`。而她的状态是自主进程每 5 分钟推进的——两次投递之间，
 * 面板上显示的心情/精力/压力/面具是**上一次插件写操作时的旧值**，
 * 看起来像"她没在动"，其实是插件不知道。
 *
 * 做法：唯一写者（daemon）每拍结束后把「面板要的那几个字段」写成一份小快照
 * `data/panel-<id>.json`；插件渲染面板时先读它（15 分钟内算新鲜），读不到或
 * 过期才退回本进程 runtime 的值。**只读，不反向写**：插件永远不会用快照覆盖状态。
 *
 * 为什么不是整份 state：快照是给人看的截面，字段越少越不容易出现"两个版本"的
 * 解析漂移；关系/记忆/知识仍由插件自己的 runtime 读（那些在插件视角下本来就没变）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PANEL_SNAPSHOT_VERSION = 1 as const;
export const PANEL_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/** 面板状态快照：只包含会随拍变化的几个数字。 */
export interface PanelStateSnapshot {
  readonly version: typeof PANEL_SNAPSHOT_VERSION;
  readonly atMs: number;
  readonly turns: number;
  readonly mode: string;
  readonly valence: number;
  readonly energy: number;
  readonly pressure: number;
  readonly maskIntegrity: number;
}

export interface PanelStateSource {
  /** `SoulRuntime.state`（SState：13 个 0..1 的量） */
  readonly state: {
    readonly valence: number;
    readonly energy: number;
    readonly pressure: number;
    readonly maskIntegrity: number;
  };
  /** `SoulRuntime.snapshot()` 里至少有 turns / mode */
  readonly snapshot: Record<string, unknown>;
}

export function panelStateSnapshotPath(dataDir: string, characterId: string): string {
  return join(dataDir, `panel-${characterId}.json`);
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 从一个运行时的只读视图折出快照（daemon 每拍调用）。 */
export function buildPanelStateSnapshot(source: PanelStateSource, atMs: number): PanelStateSnapshot {
  if (!Number.isFinite(atMs)) throw new RangeError("buildPanelStateSnapshot：atMs 必须是有限数");
  const turns = Number(source.snapshot["turns"]);
  const mode = source.snapshot["mode"];
  if (typeof mode !== "string" || mode === "") {
    throw new RangeError("buildPanelStateSnapshot：snapshot.mode 不是非空字符串");
  }
  const s = source.state;
  for (const [key, value] of Object.entries({
    valence: s.valence,
    energy: s.energy,
    pressure: s.pressure,
    maskIntegrity: s.maskIntegrity,
  })) {
    if (!isUnit(value)) throw new RangeError(`buildPanelStateSnapshot：${key} 不在 0..1`);
  }
  return {
    version: PANEL_SNAPSHOT_VERSION,
    atMs: Math.trunc(atMs),
    turns: Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0,
    mode,
    valence: s.valence,
    energy: s.energy,
    pressure: s.pressure,
    maskIntegrity: s.maskIntegrity,
  };
}

export function serializePanelStateSnapshot(snapshot: PanelStateSnapshot): string {
  return JSON.stringify(snapshot);
}

/** fail-closed：形状不对返回 null（宁可不显示新鲜值，也不显示编的）。 */
export function parsePanelStateSnapshot(raw: string): PanelStateSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== PANEL_SNAPSHOT_VERSION) return null;
  const atMs = v["atMs"];
  const mode = v["mode"];
  const turns = v["turns"];
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  if (typeof mode !== "string" || mode === "") return null;
  if (typeof turns !== "number" || !Number.isFinite(turns) || turns < 0) return null;
  for (const key of ["valence", "energy", "pressure", "maskIntegrity"]) {
    if (!isUnit(v[key])) return null;
  }
  return {
    version: PANEL_SNAPSHOT_VERSION,
    atMs,
    turns: Math.trunc(turns),
    mode,
    valence: v["valence"] as number,
    energy: v["energy"] as number,
    pressure: v["pressure"] as number,
    maskIntegrity: v["maskIntegrity"] as number,
  };
}

/** 原子写；失败只记日志（面板新鲜度不值当让这一拍失败）。 */
export function writePanelStateSnapshotFile(
  path: string,
  snapshot: PanelStateSnapshot,
  log?: (line: string) => void,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, serializePanelStateSnapshot(snapshot) + "\n", "utf8");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log?.(`[panel] 状态快照写入失败（不影响这一拍）：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 读快照；读不到 / 坏了 / 过期都返回 null（调用方退回 runtime 的旧值）。 */
export function readPanelStateSnapshotFile(
  path: string,
  options: { readonly nowMs: number; readonly maxAgeMs?: number },
): PanelStateSnapshot | null {
  if (!Number.isFinite(options.nowMs)) throw new RangeError("readPanelStateSnapshotFile：nowMs 必须是有限数");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const snapshot = parsePanelStateSnapshot(raw);
  if (snapshot === null) return null;
  const maxAge = options.maxAgeMs ?? PANEL_SNAPSHOT_MAX_AGE_MS;
  if (options.nowMs - snapshot.atMs > maxAge) return null;
  return snapshot;
}
