/**
 * 每拍固定副作用（装配层）：B.4 队列消费、F274 面板快照、3 点数据快照、6 点早报。
 *
 * 为什么放在 assembly 而不是 main.mjs：`scripts/autonomy/main.mjs` 是**装配点**，
 * 它应当只做"把东西接起来"；过去这些"每拍顺手做一下"的副作用堆在入口里，
 * 入口长到 1,700 行、又不在门禁扫描面里（审计 P0-1）。这里把它们搬出来，
 * 入口只留一行调用。
 *
 * 边界：这些动作都不**参与决策**——队列是补偿、快照是备份、面板是投影、早报是记录；
 * 任何一个失败都只记日志，绝不让这一拍失败。
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

import { localHourOf, reportPaths, shouldGenerateReport } from "../autonomy/report-schedule.js";
import { snapshotData, snapshotDone } from "../autonomy/snapshot.js";
import { formatUtc } from "../orchestrator/intent/episode.js";
import {
  buildPanelStateSnapshot,
  panelStateSnapshotPath,
  writePanelStateSnapshotFile,
} from "../orchestrator/intent/panel-snapshot.js";

/** 快照要备份的四份文件（与数据快照文档一致；文件名里的 characterId 由调用方给）。 */
function snapshotFilesOf(characterId: string): string[] {
  return [
    `memory-${characterId}.ndjson`,
    `knowledge-${characterId}.ndjson`,
    `selftalk-${characterId}.json`,
    `qq-${characterId}.json`,
  ];
}

/**
 * 早报生成动作（默认起一个 node 跑脚本）。
 * 单独抽成接口是为了可测：测试里不需要真的生成一份报告，只需要知道"该跑的时候跑了"。
 */
export type MorningReportRunner = (input: {
  readonly repo: string;
  readonly script: string;
  readonly marker: string;
  readonly day: string;
  readonly nowMs: number;
}) => void;

/** 每拍之前需要的东西，全部由装配点注入（便于测试与"为什么这拍没跑"排查）。 */
export interface TickHooksDeps {
  readonly dataDir: string;
  readonly characterId: string;
  readonly repo: string;
  readonly tzOffsetMinutes: number;
  readonly log: (line: string) => void;
  /** 唯一写者的状态视图（读的是 runtime.state / runtime.snapshot()，不复制数据）。 */
  readonly runtime: {
    readonly state: { readonly valence: number; readonly energy: number; readonly pressure: number; readonly maskIntegrity: number };
    snapshot(): Record<string, unknown>;
  };
  /** B.4：at-least-once 队列的消费函数（由入口构造，注入是为了可测）。 */
  readonly drainQueue: () => Promise<void>;
  /** 早报跑法；不给时用默认实现（node + stdio:ignore + 写 marker）。 */
  readonly runMorningReport?: MorningReportRunner;
}

/** 只有这两类动作名算"一拍"；其它 action（learn/proactive/selftalk）不跑这些副作用。 */
export function isTickAction(name: string): boolean {
  return name === "stateTick" || name === "tick";
}

function defaultMorningReportRunner(input: {
  readonly repo: string;
  readonly script: string;
  readonly marker: string;
  readonly day: string;
  readonly nowMs: number;
}): void {
  execFileSync(process.execPath, [input.script], { cwd: input.repo, timeout: 120_000, stdio: "ignore" });
  writeFileSync(input.marker, formatUtc(input.nowMs), "utf8");
}

/** 3 点那一拍的数据快照：她是唯一写者，写坏了没有第二份。 */
function takeDailySnapshot(deps: TickHooksDeps, nowMs: number): void {
  if (snapshotDone(deps.dataDir, nowMs, deps.tzOffsetMinutes)) return;
  const snap = snapshotData({
    dataDir: deps.dataDir,
    now: nowMs,
    tzOffsetMinutes: deps.tzOffsetMinutes,
    files: snapshotFilesOf(deps.characterId),
  });
  deps.log(`[autonomy] 数据快照 dir=${snap.dir ?? "skipped"} copied=${String(snap.copied.length)} pruned=${String(snap.pruned.length)}`);
}

/** 6 点那一拍生成早报的事实段：不依赖哪个会话恰好醒着（判断段由人写，重跑保留）。 */
function generateMorningReport(deps: TickHooksDeps, nowMs: number): void {
  const paths = reportPaths(deps.dataDir, "docs", nowMs, deps.tzOffsetMinutes);
  if (!shouldGenerateReport({ now: nowMs, tzOffsetMinutes: deps.tzOffsetMinutes, generatedDay: existsSync(paths.marker) ? paths.day : null })) return;
  const script = `${deps.repo}/tools/report/morning-report.mjs`;
  try {
    (deps.runMorningReport ?? defaultMorningReportRunner)({
      repo: deps.repo,
      script,
      marker: paths.marker,
      day: paths.day,
      nowMs,
    });
    deps.log(`[autonomy] 早报已生成 docs/MORNING-REPORT-${paths.day}.md`);
  } catch (err) {
    deps.log(`[autonomy] 早报生成失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 跑一拍固定副作用。顺序有意为之：先补偿上一拍的队列，再写快照，最后看今天该不该留档。
 * 全部吞错；`drainQueue` 用 void 触发是为了不阻塞这一拍。
 * `nowMs` 必须由调用方给：本文件在 src/ 下，时钟只能来自 src/engine/clock.ts（lint:writers 规则 2）。
 */
export async function runTickHooks(name: string, deps: TickHooksDeps, nowMs: number): Promise<void> {
  if (!isTickAction(name)) return;

  void deps.drainQueue().catch((err: unknown) => {
    deps.log(`[queue] 重试失败（不影响这一拍）：${err instanceof Error ? err.message : String(err)}`);
  });

  try {
    writePanelStateSnapshotFile(
      panelStateSnapshotPath(deps.dataDir, deps.characterId),
      buildPanelStateSnapshot({ state: deps.runtime.state, snapshot: deps.runtime.snapshot() }, nowMs),
      deps.log,
    );
  } catch (err) {
    deps.log(`[panel] 状态快照写入失败（不影响这一拍）：${err instanceof Error ? err.message : String(err)}`);
  }

  // 3 点：数据快照；6 点：早报。两个都按本地时间判，纯算术（不建时间对象）。
  try {
    if (localHourOf(nowMs, deps.tzOffsetMinutes) === 3) takeDailySnapshot(deps, nowMs);
  } catch (err) {
    deps.log(`[autonomy] 数据快照失败（不影响这一拍）：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (localHourOf(nowMs, deps.tzOffsetMinutes) === 6) generateMorningReport(deps, nowMs);
  } catch (err) {
    deps.log(`[autonomy] 早报调度失败（不影响这一拍）：${err instanceof Error ? err.message : String(err)}`);
  }
}
