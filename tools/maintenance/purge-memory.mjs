#!/usr/bin/env node
/**
 * 把「测试消息 / 工程对话」从她的情景记忆里清掉。
 *
 *   node tools/maintenance/purge-memory.mjs                 # 只报告，不动文件
 *   node tools/maintenance/purge-memory.mjs --apply         # 备份后重写文件
 *   node tools/maintenance/purge-memory.mjs --file=...      # 指定别的记忆库
 *
 * 设计说明：
 * - 判定逻辑在 `src/maintenance/memory-hygiene.ts`（有单测），这个脚本只负责读写文件；
 * - 默认只报告，是因为删记忆不可逆——先让人看一眼清单再决定；
 * - `--apply` 先整份备份成 `<file>.bak-purge-<ms>` 再原子替换（写 .tmp 后 rename）；
 * - 同一 id 出现多行（WAL 重复追加）会合并成一行，取最后一次写入。
 *
 * 注意：运行中的插件在内存里持有旧副本。清完要热重载一次插件，
 * 否则下一次对话可能把旧条目再写回文件（插件侧已有 refreshIfChanged 的只有知识库）。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HYGIENE = join(ROOT, "dist", "maintenance", "memory-hygiene.js");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fileArg = args.find((a) => a.startsWith("--file="));
const target = fileArg === undefined ? join(ROOT, "data", "memory-assistant.ndjson") : resolve(fileArg.slice("--file=".length));

if (!existsSync(HYGIENE)) {
  console.error(`找不到 ${HYGIENE}\n先跑一次 \`npm run build\`（清洗规则在 TypeScript 里，脚本不重复实现它）。`);
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`找不到记忆库：${target}`);
  process.exit(2);
}

const { planMemoryPurge } = await import(pathToFileURL(HYGIENE).href);

/** 从 NDJSON 读记录；坏行与 tombstone 单独计数 */
function readStore(path) {
  const raw = readFileSync(path, "utf8");
  const records = [];
  let corrupt = 0;
  let tombstones = 0;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      corrupt += 1;
      continue;
    }
    if (row.op !== "put" || row.rec === undefined) {
      tombstones += 1;
      continue;
    }
    records.push(row.rec);
  }
  return { records, corrupt, tombstones, raw };
}

const { records, corrupt, tombstones, raw } = readStore(target);
const plan = planMemoryPurge(records);
const TOTAL_LINES = records.length;

const stamp = new Date().toISOString().slice(11, 19);
console.log(`[purge] ${target}`);
console.log(`[purge] 读取 ${TOTAL_LINES} 条 · 重复行 ${plan.duplicateLines} · 坏行 ${corrupt} · 其他 op ${tombstones}`);
console.log(`[purge] 判定：保留 ${plan.keep.length} · 清除 ${plan.drop.length}（自检 ${plan.drop.filter((d) => d.reason === "self-check").length} / 工程 ${plan.drop.filter((d) => d.reason === "engineering").length} / 占位 ${plan.drop.filter((d) => d.reason === "placeholder").length} / 空 ${plan.drop.filter((d) => d.reason === "empty").length}）`);

if (plan.drop.length === 0) {
  console.log("[purge] 没有需要清除的条目。");
  process.exit(0);
}

console.log("\n将清除：");
for (const item of plan.drop) {
  const when = item.created_at === undefined ? "" : new Date(item.created_at).toISOString().slice(5, 16).replace("T", " ");
  console.log(`  - ${item.id} ${when} [${item.reason}] ${item.content.replace(/\s+/g, " ").slice(0, 60)}  ← ${item.matched.slice(0, 24)}`);
}

if (!apply) {
  console.log(`\n[purge] 这是报告模式（${stamp}）。确认无误后加 --apply 执行；会先备份原文件。`);
  process.exit(0);
}

const backup = `${target}.bak-purge-${Date.now()}`;
copyFileSync(target, backup);

const keepIds = new Set(plan.keep.map((r) => r.id));
const byId = new Map();
for (const rec of records) if (keepIds.has(rec.id)) byId.set(rec.id, rec);
const lines = [...byId.values()].map((rec) => JSON.stringify({ op: "put", rec }));
const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
const tmp = `${target}.tmp-${process.pid}`;
writeFileSync(tmp, body, "utf8");
renameSync(tmp, target);

console.log(`\n[purge] 已写入 ${lines.length} 条（删除 ${plan.drop.length}，合并重复 ${plan.duplicateLines}）。`);
console.log(`[purge] 备份：${backup}`);
console.log("[purge] 下一步：热重载插件（plugin_manager set_plugin include:ai-companion-engine false/true），让运行中的实例重新读盘。");
