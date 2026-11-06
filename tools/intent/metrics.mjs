#!/usr/bin/env node
/**
 * 六指标一页纸（P3 看板的最小可跑版本；只读、零模型调用）
 *
 * 输入：shadow 记录（`data/intent-shadow-<id>.ndjson` 离线样本，或
 *       `data/intent-live-shadow-<id>.ndjson` 线上采样）。两种格式都认：
 *   - 线上记录带 `outlet {target,kind,note,seed}` 和 `gate {allowed,verdict}`，直接用；
 *   - 离线样本没有 `outlet`，本工具按"硬闸为空 且 topKind 非空"近似 `wouldSpeak`，
 *     并在输出里明确标 `approximated=N`——近似不能当证据，所以要说出来。
 *
 * 输出：
 *   - 默认终端一页纸（metrics.ts 的 lines + 近似说明）；
 *   - `--json` 打完整 JSON（给后续看板/台账引用）。
 *
 * 用法：
 *   node tools/intent/metrics.mjs                 # 自动找最新一份 shadow 文件
 *   node tools/intent/metrics.mjs --file <路径>   # 指定文件
 *   node tools/intent/metrics.mjs --json --file <路径>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const args = { file: null, json: false, root: REPO_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      args.file = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--root") {
      args.root = path.resolve(argv[i + 1] ?? REPO_ROOT);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`未知参数：${arg}（--help 看用法）`);
    }
  }
  return args;
}

/** 在 data/ 下找最近修改的一份 shadow 文件（live 优先于离线样本之外的旧文件，只按 mtime 排）。 */
export function findShadowFile(root) {
  const dataDir = path.join(root, "data");
  if (!fs.existsSync(dataDir)) return null;
  const candidates = fs
    .readdirSync(dataDir)
    .filter((name) => /^intent-(shadow|live-shadow)-.+\.ndjson$/.test(name))
    .map((name) => {
      const full = path.join(dataDir, name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.full ?? null;
}

/** 读 ndjson，坏行跳过并计数（不因一行坏掉整份样本）。 */
export function readShadowFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const records = [];
  let corrupt = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      corrupt += 1;
    }
  }
  return { records, corrupt };
}

/**
 * 把 shadow 记录映射成 metrics.ts 的 MetricTickRecord。
 * 返回 {ticks, approximated, notes}：近似条数必须显式带出去，不能悄悄当成观测。
 */
export function toMetricTicks(records) {
  const ticks = [];
  const notes = [];
  let approximated = 0;
  records.forEach((record, index) => {
    const emitted = Array.isArray(record.emitted)
      ? record.emitted
      : typeof record.topKind === "string"
        ? [record.topKind]
        : [];
    const candidates = Array.isArray(record.candidates) ? record.candidates.length : 0;

    let gateAllowed;
    let wouldSpeak;
    if (record.gate !== null && typeof record.gate === "object" && typeof record.gate.allowed === "boolean") {
      gateAllowed = record.gate.allowed;
      wouldSpeak = safeBoolean(record.wouldSpeak, gateAllowed && emitted.length > 0);
    } else {
      gateAllowed = Array.isArray(record.hardBlocks) ? record.hardBlocks.length === 0 : true;
      wouldSpeak = gateAllowed && emitted.length > 0;
      approximated += 1;
    }

    ticks.push({
      at: typeof record.at === "string" ? record.at : `tick-${String(index + 1)}`,
      emitted,
      candidates,
      gateAllowed,
      wouldSpeak,
    });
  });
  if (approximated > 0) notes.push(`approximated=${String(approximated)}：离线样本没有 gate/wouldSpeak，按"硬闸为空且 topKind 非空"近似`);
  return { ticks, approximated, notes };
}

function safeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** 读意图记录（可选；没有就是 0 条样本，存活指标会如实写"未测"）。 */
export function readIntentions(root) {
  const dataDir = path.join(root, "data");
  if (!fs.existsSync(dataDir)) return [];
  const files = fs
    .readdirSync(dataDir)
    .filter((name) => /^intent-intentions-.+\.ndjson$/.test(name))
    .map((name) => path.join(dataDir, name));
  const out = [];
  for (const file of files) {
    const { records } = readShadowFile(file);
    for (const record of records) {
      const current = record.current ?? record;
      if (current !== null && typeof current === "object" && typeof current.id === "string") out.push(current);
    }
  }
  return out;
}

async function loadMetricsModule() {
  const modulePath = path.join(REPO_ROOT, "dist", "orchestrator", "intent", "metrics.js");
  if (!fs.existsSync(modulePath)) {
    throw new Error("需要先构建：npm run build（本工具读 dist/）");
  }
  return import(pathToFileURL(modulePath).href);
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("用法：node tools/intent/metrics.mjs [--file <ndjson>] [--json] [--root <仓库根>]");
    return 0;
  }
  const root = args.root;
  const file = args.file === null ? findShadowFile(root) : path.resolve(args.file);
  if (file === null) throw new Error("data/ 下没有 intent-shadow-*.ndjson；先跑 npm run intent:shadow");
  const { records, corrupt } = readShadowFile(file);
  const { ticks, approximated, notes } = toMetricTicks(records);
  const intentions = readIntentions(root);
  const metrics = await loadMetricsModule();
  const report = metrics.metricsReport({ intentions, ticks });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          file: path.relative(root, file),
          records: records.length,
          corrupt,
          approximated,
          notes,
          report,
        },
        null,
        2,
      ),
    );
    return corrupt > 0 ? 0 : 0;
  }

  console.log(`六指标（样本 ${path.relative(root, file)}，${String(records.length)} 条${corrupt > 0 ? `，坏行 ${String(corrupt)}` : ""}）`);
  for (const line of report.lines) console.log(`  ${line}`);
  for (const note of notes) console.log(`  注意：${note}`);
  console.log("  说明：因果性指标在 P3 消融工具落地前恒为未测；不自评，只报数。");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
