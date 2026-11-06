#!/usr/bin/env node
/**
 * 知识库体检：把「现在已经不该入库」的条目找出来。
 *
 * 为什么需要：闸门只作用于**入库那一刻**。闸门上线之前已经进库的擦边/离题条目
 * 不会自己消失，而它们会继续被检索、影响她说什么。这是一个一次性的清账工具，
 * 也适合以后定期跑（默认只报告，`--fix` 才真的删）。
 *
 * 只读默认；--fix 时先备份再原子替换。
 * 用法：node tools/report/audit-knowledge.mjs [--fix] [--character assistant]
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const ci = argv.indexOf("--character");
const characterId = ci >= 0 ? argv[ci + 1] : (process.env.ACE_CHARACTER ?? "assistant");

const root = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (m) => m.slice(1)));
const dataDir = join(root, "data");
const kPath = join(dataDir, `knowledge-${characterId}.ndjson`);
if (!existsSync(kPath)) {
  console.error(`没有知识库文件：${kPath}`);
  process.exit(2);
}

const mod = await import(new URL("../../dist/bili/ingest.js", import.meta.url).href);
const lines = readFileSync(kPath, "utf8").split("\n").filter((l) => l.trim() !== "");

/** 从蒸馏文本里还原出一个「像 BiliVideo」的壳：闸门函数只看 title/description/tags。 */
function asVideo(rec) {
  const content = String(rec?.content ?? "");
  return { title: content, description: content, tags: [] };
}

const offenders = [];
for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row?.op !== "put" || !row.rec?.id) continue;
  const v = asVideo(row.rec);
  const off = mod.explainOffTopic?.(v);
  const bad = mod.explainUnsuitable?.(v);
  if (off || bad) {
    offenders.push({ id: row.rec.id, kind: off ? "off-topic" : "blocked", rule: (off ?? bad).rule, term: (off ?? bad).term, title: String(row.rec.content ?? "").slice(0, 60) });
  }
}

console.log(`知识库：${kPath}`);
console.log(`行数 ${lines.length}，命中「现在不该入库」${offenders.length} 条`);
for (const o of offenders) console.log(` - [${o.kind}/${o.rule}:${o.term}] ${o.id} ${o.title}`);

if (!fix) {
  if (offenders.length > 0) console.log("（只报告；加 --fix 才会删除）");
  process.exit(offenders.length > 0 ? 1 : 0);
}
if (offenders.length === 0) process.exit(0);

const drop = new Set(offenders.filter((o) => o.kind !== "blocked" || true).map((o) => o.id));
const kept = lines.filter((line) => {
  try {
    const row = JSON.parse(line);
    return !(row?.op === "put" && drop.has(row.rec?.id));
  } catch {
    return true;
  }
});
const backup = `${kPath}.bak-offtopic-${Date.now()}`;
writeFileSync(backup, `${lines.join("\n")}\n`, "utf8");
const tmp = `${kPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${kept.join("\n")}\n`, "utf8");
renameSync(tmp, kPath);
console.log(`已删除 ${lines.length - kept.length} 行；备份：${backup}`);
