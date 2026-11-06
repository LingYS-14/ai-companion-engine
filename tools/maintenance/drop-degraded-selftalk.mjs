#!/usr/bin/env node
/**
 * 清掉内部言语日志里的「降级模板」条目。
 *
 * 为什么需要：没有模型 key 时 runSelfTalk 会写模板（"又绕回…"），那不是她想出来的话。
 * 现在 runner 会给这类条目打 degraded=true、消费端也会跳过；但**历史条目**没有标记，
 * 所以给一次显式清理（默认只报告，--apply 才动，先备份）。
 *
 * 用法：
 *   node tools/maintenance/drop-degraded-selftalk.mjs            # 只报告
 *   node tools/maintenance/drop-degraded-selftalk.mjs --apply    # 备份后重写
 *   node tools/maintenance/drop-degraded-selftalk.mjs --character default --apply
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const charIdx = args.indexOf("--character");
const characterId = charIdx >= 0 ? args[charIdx + 1] : "assistant";
const file = join(root, "data", `selftalk-${characterId}.json`);

/** 旧模板的特征：固定开场 + "那件事"；只用来识别历史残留，不参与运行时判定 */
const TEMPLATE_PREFIXES = ["又绕回", "刚才那件小事"];

function isTemplate(entry) {
  if (entry.degraded === true) return true;
  const text = typeof entry.text === "string" ? entry.text : "";
  return TEMPLATE_PREFIXES.some((p) => text.startsWith(p));
}

if (!existsSync(file)) {
  console.log(`没有日志：${file}`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(raw)) {
  console.error(`日志不是数组：${file}`);
  process.exit(1);
}

const keep = raw.filter((e) => !isTemplate(e));
const drop = raw.length - keep.length;
console.log(`[selftalk] ${characterId}: 共 ${raw.length} 条，将清掉 ${drop} 条模板，保留 ${keep.length} 条`);

if (!apply) {
  console.log("（只报告。加 --apply 才会写盘）");
  process.exit(0);
}
if (drop === 0) {
  console.log("没有可清的，未改文件");
  process.exit(0);
}

const backup = `${file}.bak-template-${Date.now()}`;
copyFileSync(file, backup);
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(keep, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(tmp, file);
console.log(`已重写：保留 ${keep.length} 条；备份 ${backup}`);
