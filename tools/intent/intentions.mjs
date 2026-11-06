#!/usr/bin/env node
/**
 * 意图表查看器（只读、零模型调用）。
 *
 * 她每一拍"想做什么"写进 data/intent-<id>.json，这个工具把它读成人话：
 * 哪些还开着、为什么最终决定不做、失败了几次、被什么挡住。
 *
 * 诚实边界：
 *   - 表不存在/坏了就照实说，不猜、不伪造空表；
 *   - 只读文件，不碰她的进程、不写任何东西、不调模型；
 *   - 状态用 narrative 里的中文说法，与她自己描述同一套词。
 *
 * 用法：
 *   node tools/intent/intentions.mjs
 *   node tools/intent/intentions.mjs --all          # 连已结束的一起看
 *   node tools/intent/intentions.mjs --json
 *   node tools/intent/intentions.mjs --data X:/tmp/ai-companion-runtime/data --character assistant
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const args = { root: REPO_ROOT, data: null, character: "assistant", json: false, all: false, help: false };
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
    } else if (arg === "--all") {
      args.all = true;
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

const USAGE = `意图表（她这一拍想做什么 / 最后做了什么）

  node tools/intent/intentions.mjs [--all] [--json] [--character assistant] [--data <dataDir>] [--root <repo>]

默认只看还开着的（pending/active/blocked/held）；--all 连 done/dropped 一起看。
退出码：0 正常（表不存在也算正常）；1 表存在但读不出来；2 参数错误。`;

async function loadIntentModule(name) {
  const modulePath = path.join(REPO_ROOT, "dist", "orchestrator", "intent", name);
  if (!fs.existsSync(modulePath)) throw new Error("需要先构建：npm run build（本工具读 dist/）");
  return import(pathToFileURL(modulePath).href);
}

function oneLine(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatMinutes(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} 小时前`;
  return `${String(Math.round(hours / 24))} 天前`;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const dataDir = args.data ?? path.join(args.root, "data");
  const id = args.character;
  const filePath = path.join(dataDir, `intent-${id}.json`);
  const now = Date.now();

  const intentFile = await loadIntentModule("intent-file.js");
  const narrative = await loadIntentModule("narrative.js");

  const exists = fs.existsSync(filePath);
  let parsed = { file: null, errors: [] };
  if (exists) {
    parsed = intentFile.parseIntentionFile(fs.readFileSync(filePath, "utf8"));
  }
  const records = parsed.file?.records ?? [];
  const open = intentFile.openIntentions(records);
  const shown = args.all ? records : open;
  const counts = { pending: 0, active: 0, blocked: 0, held: 0, done: 0, dropped: 0 };
  for (const record of records) {
    if (typeof counts[record.status] === "number") counts[record.status] += 1;
  }

  const payload = {
    path: filePath,
    exists,
    savedAt: parsed.file?.savedAtMs ?? null,
    counts,
    shown: shown.map((record) => ({
      id: record.id,
      kind: record.kind,
      goal: record.goal,
      why: record.why,
      status: record.status,
      attempts: record.attempts.length,
      blockedBy: record.blocked_by ?? null,
      createdAt: record.created_at,
      acts: record.attempts.map((attempt) => ({ at: attempt.at, act: attempt.act, outcome: attempt.outcome })),
    })),
    errors: parsed.errors,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return exists && parsed.file === null ? 1 : 0;
  }

  if (!exists) {
    console.log("意图表还没有（她还没真正浮现过意图）。");
    console.log(`看会话记录：${path.join(dataDir, `intent-live-shadow-${id}.ndjson`)}`);
    return 0;
  }
  if (parsed.file === null) {
    console.log("意图表存在但读不出来（fail-closed：不猜内容）。");
    for (const error of parsed.errors) console.log(`  - ${error}`);
    return 1;
  }

  console.log(
    `意图表：${String(records.length)} 条（开着 ${String(open.length)}，结束 ${String(counts.done)}，放弃 ${String(counts.dropped)}）`,
  );
  console.log(`最后写入：${parsed.file.savedAtMs === null ? "?" : formatMinutes(now - parsed.file.savedAtMs)}`);
  if (shown.length === 0) {
    console.log("现在没有开着的事。");
  } else {
    console.log("");
    for (const record of shown) {
      const status = narrative.STATUS_PHRASES[record.status] ?? record.status;
      const why = record.why.trim() === "" ? "（没记原因）" : oneLine(record.why, 60);
      const goal = oneLine(record.goal, 40);
      const blocked = record.blocked_by === null ? "" : `，被「${String(record.blocked_by)}」挡住`;
      console.log(`- [${status}] ${record.kind} · ${goal}`);
      console.log(`  为什么：${why}${blocked}；试过 ${String(record.attempts.length)} 次；${formatMinutes(now - Date.parse(record.created_at))}`);
    }
  }
  if (parsed.errors.length > 0) {
    console.log("");
    console.log(`注意：表里有 ${String(parsed.errors.length)} 条校验问题，但整表仍可用：`);
    for (const error of parsed.errors.slice(0, 5)) console.log(`  - ${error}`);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
