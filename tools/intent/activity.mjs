#!/usr/bin/env node
/**
 * 「她一昼夜在干什么」一页纸（只读、零模型调用）。
 *
 * 把散在 data/ 下的七份事实合成一页：意图节拍（gate/出口/浮现/回放）、意图表、
 * 能力缺口、求助历史与监护人收件箱、working self 状态、再巩固补丁。
 *
 * 诚实边界：
 *   - 只报文件里真有的事实；没有样本就说没有样本，不填 0；
 *   - 不写"她很主动"这类评价句；异常只以「提示」出现；
 *   - 读数失败（坏行/坏文件）会数出来，不静默当成空。
 *
 * 用法：
 *   node tools/intent/activity.mjs
 *   node tools/intent/activity.mjs --json
 *   node tools/intent/activity.mjs --data X:/tmp/ai-companion-runtime/data --character assistant
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/**
 * 从自主进程日志里数「真的发出去的消息」（最近 24 小时窗口）。
 *
 * 为什么单独数：tick 记的是"这一拍她判定想开口"，日志记的是"真的发出去了"。
 * 验收要的是后者能回溯到意图（F240 收紧 A4 之后，每条主动消息都该带 `intent=outlet:speak`）。
 *
 * 日志行形如：
 *   2026-10-31T11:12:07.608Z [autonomy] proactive opened=true reason=spoke intent=outlet:speak reply=…
 * 分桶：outlet:speak = 由意图决定；outlet:journal|idle = 意图说了但不该开口；gate:true = 闸放行即发（A4 前）；
 *       intent=none = 显式「无意图」（A4 之前的老行，单列一桶）；没有 intent= = 旧主动路径。
 * 只读日志文本，不读时钟以外的状态。
 */

/**
 * 日志行时间戳：F278（2026-10-31T18:14:12Z）起由毫秒级改成秒级，两种都得认。
 * 旧写法 `line.slice(0, 24)` 在秒级行上截出来是 `...12Z [autonomy] proa`，Date.parse 直接 NaN，
 * 等于把 18:14 之后的所有发送都当成没发生（R8：24h 发送数被少算一半）。
 */
const LOG_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

export function summarizeSendsFromLog(text, nowMs, sinceMs) {
  const since = Number.isFinite(sinceMs) ? Math.max(sinceMs, nowMs - 24 * 60 * 60_000) : nowMs - 24 * 60 * 60_000;
  const buckets = { total: 0, byIntent: 0, byNonSpeakOutlet: 0, byGateOnly: 0, byNoIntent: 0, byLegacy: 0, byKind: {} };
  for (const line of String(text).split("\n")) {
    if (!line.includes("proactive opened=true reason=spoke")) continue;
    const at = Date.parse(LOG_TS.exec(line)?.[1] ?? "");
    if (!Number.isFinite(at) || at < since || at > nowMs) continue;
    buckets.total += 1;
    const match = /intent=([^\s]+)/.exec(line);
    if (match === null) {
      buckets.byLegacy += 1;
    } else if (match[1] === "outlet:speak") {
      buckets.byIntent += 1;
      // F252：kind 让"这条是哪一类心事让她开口的"可回溯（旧行没有 kind=none）。
      const kindMatch = /kind=([a-z_]+)/.exec(line);
      const kind = kindMatch?.[1];
      if (kind !== undefined && kind !== "none") {
        buckets.byKind[kind] = (buckets.byKind[kind] ?? 0) + 1;
      }
    } else if (match[1].startsWith("outlet:")) {
      buckets.byNonSpeakOutlet += 1;
    } else if (match[1] === "gate:true") {
      buckets.byGateOnly += 1;
    } else if (match[1] === "none") {
      // 显式「无意图」（A4 之前的老行）：单独一桶，别混进「旧路径」——
      // 它不是「接线退化」，而是那个时代还没有 intent 出口，混算会误导排查。
      buckets.byNoIntent += 1;
    } else {
      buckets.byLegacy += 1;
    }
  }
  return buckets;
}

export function parseArgs(argv) {
  const args = {
    root: REPO_ROOT,
    data: null,
    character: "assistant",
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[i + 1] ?? REPO_ROOT);
      i += 1;
    } else if (arg === "--data") {
      args.data = path.resolve(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--character") {
      args.character = argv[i + 1] ?? "assistant";
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`未知参数：${arg}（--help 看用法）`);
    }
  }
  return args;
}

const USAGE = `她用意图引擎这 24 小时在干什么（只读）

  node tools/intent/activity.mjs [--character assistant] [--data <dataDir>] [--root <repo>] [--json]

退出码：0 有输出；1 读不到任何数据文件（先确认她跑过、data 目录对）。`;

async function loadIntentModule(name) {
  const modulePath = path.join(REPO_ROOT, "dist", "orchestrator", "intent", name);
  if (!fs.existsSync(modulePath)) throw new Error("需要先构建：npm run build（本工具读 dist/）");
  return import(pathToFileURL(modulePath).href);
}

function readJsonLines(filePath, onLine) {
  if (!fs.existsSync(filePath)) return { lines: 0, bad: 0, existed: false };
  const raw = fs.readFileSync(filePath, "utf8");
  let lines = 0;
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    lines += 1;
    try {
      onLine(JSON.parse(trimmed));
    } catch {
      bad += 1;
    }
  }
  return { lines, bad, existed: true };
}

/** live shadow 行 → ActivityTick（形状以 scripts/autonomy/main.mjs 的 appendFileSync 为准）。 */
export function toActivityTick(row) {
  if (row === null || typeof row !== "object") return null;
  const at = row.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const outlet = row.outlet !== null && typeof row.outlet === "object" ? row.outlet : null;
  const replay = row.replay !== null && typeof row.replay === "object" ? row.replay : null;
  return {
    at,
    gate: typeof row.gate === "string" && row.gate !== "" ? row.gate : "unknown",
    outlet: outlet !== null && typeof outlet.target === "string" ? outlet.target : "none",
    wouldSpeak: row.wouldSpeak === true,
    // F247：装配层重提旧意图的拍（tick 自己的 wouldSpeak 是 false，但她确实开口了）
    reRaised: row.reRaised !== null && typeof row.reRaised === "object",
    emitted: Array.isArray(row.emitted) ? row.emitted.filter((kind) => typeof kind === "string") : [],
    top: null,
    replay: replay !== null && Array.isArray(replay.threads) ? replay.threads.length : 0,
  };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = args.data ?? path.join(args.root, "data");
  const id = args.character;
  const now = Date.now();

  const activity = await loadIntentModule("activity.js");
  const intentFile = await loadIntentModule("intent-file.js");
  const capability = await loadIntentModule("capability-signal.js");
  const persist = await loadIntentModule("persist.js");
  const streak = await loadIntentModule("working-self-streak.js");
  const versionFile = await loadIntentModule("version-file.js");

  // 1) 拍记录：优先 live-shadow（常驻进程真数据），退回离线 shadow。
  let shadowFile = path.join(dataDir, `intent-live-shadow-${id}.ndjson`);
  if (!fs.existsSync(shadowFile)) shadowFile = path.join(dataDir, `intent-shadow-${id}.ndjson`);
  const ticks = [];
  const shadow = readJsonLines(shadowFile, (row) => {
    const tick = toActivityTick(row);
    if (tick !== null) ticks.push(tick);
  });

  // 2) 意图表（fail-closed：坏表不猜，计数为 0 但记 error）。
  const intentionsPath = path.join(dataDir, `intent-${id}.json`);
  let intentions = { list: [], errors: [] };
  if (fs.existsSync(intentionsPath)) {
    const parsed = intentFile.parseIntentionFile(fs.readFileSync(intentionsPath, "utf8"));
    intentions = { list: parsed.file?.records ?? [], errors: parsed.errors ?? [] };
  }

  // 3) 能力缺口：按天聚合（复用它自己的窗口逻辑）。
  const gapPath = path.join(dataDir, `capability-gaps-${id}.ndjson`);
  const sightings = [];
  readJsonLines(gapPath, (row) => {
    if (row === null || typeof row !== "object") return;
    if (typeof row.kind !== "string" || typeof row.missingFamily !== "string" || typeof row.at !== "number") return;
    sightings.push({
      kind: row.kind,
      missingFamily: row.missingFamily,
      at: row.at,
      ...(typeof row.desire === "number" ? { desire: row.desire } : {}),
    });
  });
  let gapProbes = [];
  let gapError = null;
  try {
    gapProbes = capability.summarizeGapProbes(sightings, now);
  } catch (err) {
    gapError = err instanceof Error ? err.message : String(err);
  }

  // 4) 求助历史 + 监护人收件箱/应答。
  const historyPath = persist.askHistoryPath(args.root, id);
  const history = fs.existsSync(historyPath) ? persist.readAskHistory(historyPath) : { entries: [] };
  const asks = {
    asked: history.entries.length,
    lastAtMs: history.entries.reduce((max, entry) => (entry.askedAtMs > max ? entry.askedAtMs : max), 0) || null,
  };
  const inboxPath = persist.guardianInboxPath(args.root, id);
  const guardianRequests = fs.existsSync(inboxPath) ? persist.readGuardianRequests(inboxPath) : { requests: [] };
  const replyDir = persist.guardianReplyDir(args.root);
  const guardianReplies = fs.existsSync(replyDir) ? persist.readGuardianReplies(replyDir) : { replies: [] };
  const guardian = {
    requests: guardianRequests.requests.length,
    replies: guardianReplies.replies.length,
    errors: [...(guardianRequests.errors ?? []), ...(guardianReplies.errors ?? [])],
  };

  // 5) working self 状态。
  const wsPath = streak.workingSelfStatePathInDataDir(dataDir, id);
  let workingSelf = null;
  let workingSelfErrors = [];
  if (fs.existsSync(wsPath)) {
    const parsed = streak.readWorkingSelfState(wsPath);
    workingSelf = {
      lowConcretenessStreak: parsed.state.lowConcretenessStreak,
      relaxFactor: parsed.state.relaxFactor,
    };
    workingSelfErrors = parsed.errors ?? [];
  }

  // 6) 再巩固补丁。
  const versionPath = versionFile.reconsolidationFilePath(args.root, id);
  let reconsolidationPatches = 0;
  if (fs.existsSync(versionPath)) {
    const parsed = versionFile.parseReconsolidationFile(fs.readFileSync(versionPath, "utf8"));
    reconsolidationPatches = parsed.file?.patches.length ?? 0;
    if (parsed.file === null && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      workingSelfErrors = [...workingSelfErrors, ...parsed.errors];
    }
  }

  // 7) 真发出的消息（日志口径，F251）。
  const logPath = path.join(dataDir, `autonomy-${id}.log`);
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const sends = summarizeSendsFromLog(logText, now);

  const report = activity.buildActivityReport({
    generatedAtMs: now,
    ticks,
    intentions: intentions.list,
    gapProbes,
    asks,
    guardian: { requests: guardian.requests, replies: guardian.replies },
    workingSelf,
    reconsolidationPatches,
    sends,
  });

  const diagnostics = [];
  if (shadow.bad > 0) diagnostics.push(`拍文件 ${shadow.bad} 行读不成 JSON（已跳过）`);
  if (!shadow.existed) diagnostics.push(`没有拍文件：${shadowFile}`);
  if (intentions.errors.length > 0) diagnostics.push(`意图表需要复查：${intentions.errors.slice(0, 3).join("；")}`);
  if (gapError !== null) diagnostics.push(`缺口聚合失败：${gapError}`);
  if (guardian.errors.length > 0) diagnostics.push(`监护人文件有坏行：${guardian.errors.slice(0, 3).join("；")}`);
  if (workingSelfErrors.length > 0) diagnostics.push(`状态文件/版本文件有异常：${workingSelfErrors.slice(0, 3).join("；")}`);

  const warnings = [...report.warnings];
  const payload = {
    generatedAtMs: now,
    dataDir,
    characterId: id,
    files: {
      shadow: shadowFile,
      intentions: intentionsPath,
      gaps: gapPath,
      askHistory: historyPath,
      guardianInbox: inboxPath,
      guardianReplies: replyDir,
      workingSelf: wsPath,
      reconsolidation: versionPath,
    },
    lines: report.lines,
    warnings,
    diagnostics,
    windowTicks: report.windowTicks,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  for (const line of report.lines) console.log(line);
  if (warnings.length > 0) {
    console.log("");
    console.log("提示：");
    for (const warning of warnings) console.log(`! ${warning}`);
  }
  if (diagnostics.length > 0) {
    console.log("");
    console.log("读取异常（不影响其余统计）：");
    for (const diagnostic of diagnostics) console.log(`- ${diagnostic}`);
  }
  if (!shadow.existed && !fs.existsSync(intentionsPath) && !fs.existsSync(gapPath)) {
    console.log("");
    console.log("没有任何意图数据文件——她可能还没跑满一拍，或 --data 指向不对。");
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  }
}
