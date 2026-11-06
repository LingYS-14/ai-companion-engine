#!/usr/bin/env node
/**
 * P3 指标看板：一页纸把「六指标 + 结构性消融 + 来源与边界」拼在一起（只读、零模型调用）
 *
 * 输入：
 *   - shadow 记录（`data/intent-shadow-*.ndjson` 或 `data/intent-live-shadow-*.ndjson`），默认自动找最新一份；
 *   - 可选 `--ablation <json>`：`npm run intent:ablation -- --json > ablation.json` 的输出。
 *
 * 输出：终端一页纸；`--json` 打完整结构化数据（给早报/面板将来引用）。
 *
 * 诚实边界（写在页面里，不靠口头约定）：
 *   - 离线样本没有 gate/wouldSpeak 时按近似算，并显式标 `approximated=N`；
 *   - 消融没跑就写「未跑」，不拿别的指标顶替因果性；
 *   - 样本不足只给计数，不给"稳定"的结论。
 *
 * 用法：
 *   node tools/intent/dashboard.mjs
 *   node tools/intent/dashboard.mjs --ablation .tmp/ablation.json
 *   node tools/intent/dashboard.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findShadowFile, readIntentions, readShadowFile, toMetricTicks } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const args = { file: null, ablation: null, root: REPO_ROOT, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      args.file = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--ablation") {
      args.ablation = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--root") {
      args.root = path.resolve(argv[i + 1] ?? REPO_ROOT);
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

async function loadIntentModule(name) {
  const modulePath = path.join(REPO_ROOT, "dist", "orchestrator", "intent", name);
  if (!fs.existsSync(modulePath)) throw new Error("需要先构建：npm run build（本工具读 dist/）");
  return import(pathToFileURL(modulePath).href);
}

/** 读消融 JSON；结构不对就明说，不把坏文件当"没跑"。 */
export function readAblationFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`消融文件不是合法 JSON：${path.basename(file)}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const report = value && typeof value === "object" && value.report !== undefined ? value.report : value;
  if (report === null || typeof report !== "object" || !Array.isArray(report.rows)) {
    throw new Error("消融文件缺少 rows（应是 npm run intent:ablation -- --json 的输出）");
  }
  return report;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("用法：node tools/intent/dashboard.mjs [--file <ndjson>] [--ablation <json>] [--json] [--root <仓库根>]");
    return 0;
  }
  const root = args.root;
  const file = args.file === null ? findShadowFile(root) : path.resolve(args.file);
  if (file === null) throw new Error("data/ 下没有 intent-shadow-*.ndjson；先跑 npm run intent:shadow");
  const { records, corrupt } = readShadowFile(file);
  const { ticks, approximated, notes } = toMetricTicks(records);
  const intentions = readIntentions(root);
  const metricsModule = await loadIntentModule("metrics.js");
  const dashboardModule = await loadIntentModule("dashboard.js");
  const report = metricsModule.metricsReport({ intentions, ticks });
  const ablation = args.ablation === null ? null : readAblationFile(path.resolve(args.ablation));
  const generatedAt = new Date().toISOString();
  const source = `${path.relative(root, file)}${corrupt > 0 ? `（坏行 ${String(corrupt)}）` : ""}`;
  const dashboard = dashboardModule.buildDashboard({
    generatedAt,
    source,
    ticks: records.length,
    metrics: report,
    ablation,
    causalityNote: undefined,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          file: path.relative(root, file),
          records: records.length,
          corrupt,
          approximated,
          notes,
          ablation: ablation === null ? null : path.relative(root, path.resolve(args.ablation)),
          report,
          dashboard,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(dashboardModule.renderDashboard(dashboard));
  for (const note of notes) console.log(`注意：${note}`);
  if (approximated > 0) console.log(`注意：${String(approximated)} 条离线样本按近似口径计算（见上）`);
  for (const warning of dashboard.warnings) console.log(`提醒：${warning}`);
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
