#!/usr/bin/env node
/**
 * 反查她"为什么这么说"（v5.2 §12.1 硬指标 2：1 分钟定位一句台词的来龙去脉）。
 *
 * 用法：
 *   node tools/trace/query.mjs --last 5
 *   node tools/trace/query.mjs --id tr-<...>
 *   node tools/trace/query.mjs --kind turn --last 20 --json
 *
 * 数据目录默认 `ACE_DATA_DIR` → 仓内的 `data/`。运行时副本在
 * `C:\ai-companion-runtime\data`，所以常驻形态要显式给 `--data`：
 *   node tools/trace/query.mjs --data X:/tmp/ai-companion-runtime/data --last 3
 *
 * 它只读：不改任何文件，也不启动 runtime（不需要模型、不碰写锁）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const dataDir = String(arg("data", process.env["ACE_DATA_DIR"] ?? join(root, "data")));
const character = String(arg("character", "assistant"));
const id = arg("id");
const kind = arg("kind");
const last = arg("last");
const asJson = arg("json", false) === true;

const path = join(dataDir, `trace-${character}.ndjson`);
if (!existsSync(path)) {
  console.error(`没有 trace 文件：${path}`);
  const dir = dirname(path);
  if (existsSync(dir)) {
    const others = readdirSync(dir).filter((f) => f.startsWith("trace-"));
    if (others.length > 0) console.error(`同目录里有：${others.join("、")}（--character 传对了吗？）`);
  }
  process.exit(2);
}

const rows = [];
let corrupt = 0;
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    corrupt += 1;
    continue;
  }
  if (typeof rec.traceId !== "string") continue;
  if (id !== undefined && rec.traceId !== id) continue;
  if (kind !== undefined && rec.kind !== kind) continue;
  rows.push(rec);
}

const wanted = last === undefined ? 5 : Number(last);
const picked = Number.isFinite(wanted) && wanted > 0 ? rows.slice(-wanted) : rows;

if (asJson) {
  console.log(JSON.stringify({ path, total: rows.length, corrupt, rows: picked }, null, 2));
  process.exit(0);
}

console.log(`trace: ${path}（匹配 ${String(rows.length)} 条，坏行 ${String(corrupt)} 行）`);
for (const rec of picked) {
  const t = new Date(rec.at).toISOString().replace("T", " ").slice(0, 19);
  if (rec.kind === "turn") {
    const bits = [
      `mode=${String(rec.mode)}`,
      `strategy=${String(rec.strategy)}`,
      `event=${String(rec.eventType)}`,
      `强度=${Number(rec.intensity).toFixed(2)}`,
      `预期=${Number(rec.predicted).toFixed(2)}`,
      `落差=${Number(rec.error).toFixed(2)}`,
      `V=${Number(rec.valence).toFixed(2)}`,
      `压力=${Number(rec.pressure).toFixed(2)}`,
      `面具=${Number(rec.maskIntegrity).toFixed(2)}`,
    ];
    if (rec.intrusion !== null && rec.intrusion !== undefined) bits.push(`闯入=${String(rec.intrusion)}`);
    if (rec.repair !== null && rec.repair !== undefined) bits.push(`里程碑=${String(rec.repair)}`);
    console.log(`${t}Z ${String(rec.traceId)} ${bits.join(" ")}`);
  } else {
    console.log(`${t}Z ${String(rec.traceId)} ${JSON.stringify(rec)}`);
  }
}
