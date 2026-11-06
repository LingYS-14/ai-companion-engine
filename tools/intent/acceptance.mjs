#!/usr/bin/env node
/**
 * 验收卡（只读）：把 PLAN §7 的六条标准变成机器可判的一页纸。
 *
 *   node tools/intent/acceptance.mjs [--character assistant] [--data <dataDir>] [--root <repo>] [--gate-green] [--json]
 *
 * 只读 data/ 下的节拍照、日志、dsh-facts；不碰她的进程、不调模型、不写任何文件。
 * 三态：✓ met（有证据满足）/ … pending（窗口没满或样本不够，现在还不能算通过）/ ✗ fail。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { summarizeSendsFromLog } from "./activity.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DAY_MS = 86_400_000;

/**
 * 日志行时间戳：F278（2026-10-31T18:14:12Z）起由毫秒级改成秒级，两种都得认。
 * 旧写法 `line.slice(0, 24)` 在秒级行上截出非时间文本，Date.parse 变 NaN，夜间接待样本会被漏掉（R8）。
 */
const LOG_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

const USAGE = `她到底"通过验收"了没有（只读）

  node tools/intent/acceptance.mjs [--character assistant] [--data <dataDir>] [--root <repo>] [--json]

退出码：0 有输出；2 参数错。pending 不判失败（那是"窗口没满"，不是坏消息）。`;

export function parseArgs(argv) {
  const args = { root: REPO_ROOT, data: null, character: "assistant", json: false, help: false, gateGreen: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = resolve(argv[i + 1] ?? REPO_ROOT);
      i += 1;
    } else if (arg === "--data") {
      args.data = resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--character") {
      args.character = argv[i + 1] ?? "assistant";
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--gate-green") {
      args.gateGreen = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`未知参数：${arg}（--help 看用法）`);
    }
  }
  return args;
}

function readTextOrEmpty(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 本地日 + 小时（与 main.mjs 的 localParts 同口径：用进程本地时区）。 */
function localDayOf(atMs) {
  const d = new Date(atMs);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function readShadowDays(file) {
  const days = new Map();
  for (const line of readTextOrEmpty(file).split("\n")) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row === null || typeof row !== "object" || !Number.isFinite(row.at)) continue;
    const day = localDayOf(row.at);
    const entry = days.get(day) ?? { day, ticks: 0, emittedTicks: 0, latestAt: 0 };
    entry.ticks += 1;
    if (Array.isArray(row.emitted) && row.emitted.length > 0) entry.emittedTicks += 1;
    entry.latestAt = Math.max(entry.latestAt, row.at);
    days.set(day, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** 夜间（23:00–07:00 本地）真发出的条数；没有发送行时返回 null（不是 0）。 */
function countNightSends(logText, nowMs) {
  let sawSend = false;
  let night = 0;
  for (const line of logText.split("\n")) {
    if (!line.includes("proactive opened=true reason=spoke")) continue;
    sawSend = true;
    const at = Date.parse(LOG_TS.exec(line)?.[1] ?? "");
    if (!Number.isFinite(at) || at > nowMs) continue;
    const hour = new Date(at).getHours();
    if (hour >= 23 || hour < 7) night += 1;
  }
  return sawSend ? night : null;
}

/** 当前进程的启动时间（pid 文件里的 startedAt）；没有就退回 24h 前。 */
function readProcessStartedAt(dataDir, character, nowMs) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, `autonomy-${character}.pid`), "utf8"));
    if (typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)) {
      return Math.max(parsed.startedAt, nowMs - DAY_MS);
    }
  } catch {
    // 没 pid 文件就按 24h 窗口
  }
  return nowMs - DAY_MS;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = args.data ?? join(args.root, "data");
  const nowMs = Date.now();
  const character = args.character;

  const shadowFile = join(dataDir, `intent-live-shadow-${character}.ndjson`);
  const logFile = join(dataDir, `autonomy-${character}.log`);
  const factsFile = join(dataDir, `dsh-facts-${character}.ndjson`);

  const days = readShadowDays(shadowFile);
  const logText = readTextOrEmpty(logFile);
  // 因果只看「当前这次构建启动之后」发出的消息：更早的消息是修复前的历史（F240/F252 之前），
  // 拿它们判现在的接线是否退化会把"历史"当成"现状"。启动时间取 pid 文件，缺失时退回 24h。
  const windowStartMs = readProcessStartedAt(dataDir, character, nowMs);
  const buckets = summarizeSendsFromLog(logText, nowMs, windowStartMs);
  const withKind = Object.values(buckets.byKind ?? {}).reduce((sum, n) => sum + n, 0);
  const recent = days.filter((day) => day.latestAt >= nowMs - DAY_MS);
  const presenceObserved = logText.includes("[intent] 在场：");
  const factsText = readTextOrEmpty(factsFile);
  // 回程证据优先看日志（事实文件可能被清理过；日志行是真实发生过的回执）
  const dshRoundTripObserved = factsText.trim() !== "" || logText.includes("[intent] DSH 回执：");

  const modulePath = join(REPO_ROOT, "dist", "orchestrator", "intent", "acceptance.js");
  if (!existsSync(modulePath)) throw new Error("需要先构建：npm run build（本工具读 dist/）");
  const { evaluateAcceptance, renderAcceptance } = await import(pathToFileURL(modulePath).href);
  const report = evaluateAcceptance({
    generatedAtMs: nowMs,
    days: days.map(({ day, ticks, emittedTicks }) => ({ day, ticks, emittedTicks })),
    sends: {
      total: buckets.total,
      byIntent: buckets.byIntent,
      withKind,
      byNonSpeakOutlet: buckets.byNonSpeakOutlet,
      byGateOnly: buckets.byGateOnly,
      byLegacy: buckets.byLegacy,
    },
    nightSends: countNightSends(logText, nowMs),
    presenceObserved,
    dshRoundTripObserved,
    engineOnPathObserved: recent.length > 0,
    gateGreen: args.gateGreen,
  });

  if (args.json) {
    console.log(
      JSON.stringify({ generatedAtMs: nowMs, windowStartMs, source: { shadowFile, logFile, factsFile }, report }, null, 2),
    );
    return 0;
  }
  console.log(`验收卡（${new Date(nowMs).toISOString()}）`);
  console.log(`窗口：本次构建启动 ${new Date(windowStartMs).toISOString()} 之后`);
  console.log(`数据：拍 ${String(days.reduce((n, d) => n + d.ticks, 0))} 行 / 发送 ${String(buckets.total)} 条 / 夜间样本 ${String(countNightSends(logText, nowMs) === null ? "无" : "有")}`);
  console.log(renderAcceptance(report));
  const missing = days.length === 0 && !existsSync(shadowFile);
  if (missing) console.log("（没有拍文件：她可能没在跑，或 data 目录不对）");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
