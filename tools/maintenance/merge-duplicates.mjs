#!/usr/bin/env node
/**
 * 合并「同一句话在 24 小时内重复出现」的重复记忆（存量清理）。
 *
 *   node tools/maintenance/merge-duplicates.mjs                  # 只报告
 *   node tools/maintenance/merge-duplicates.mjs --apply          # 备份后重写
 *   node tools/maintenance/merge-duplicates.mjs --file=...       # 指定别的记忆库
 *
 * 为什么需要它：运行时的写路径从 2026-10-30 起会自动合并重复（`MemoryStore.write` 的
 * `duplicate` 分支），但**已经存在的**重复不会自己消失。实测 23 条记忆里 9 条是同句重复
 * （「在吗？我回来了。」×5、「昨晚学到什么」×4），后果是内部言语没有材料可说、
 * 只能反复念「刚才那件小事」。
 *
 * 合并规则：同 source、同归一化内容（忽略空白/标点/大小写）、相邻两次写入间隔 ≤ 24 小时
 * 视为同一次事件 → 保留最早那条的 id 与 created_at，取最大 vividness，
 * access_count 相加，last_accessed 取最近。
 *
 * 默认只报告；`--apply` 先备份成 `<file>.bak-dedup-<ms>`，再原子重写（写 .tmp 后 rename）。
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, pid, exit } from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = argv.slice(2);
const apply = args.includes("--apply");
const fileArg = args.find((a) => a.startsWith("--file="));
const target = fileArg === undefined ? join(ROOT, "data", "memory-assistant.ndjson") : resolve(fileArg.slice("--file=".length));

const WINDOW_MS = 24 * 3_600_000;

const comparable = (content) => String(content ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 从 NDJSON 读出当前记录（put 覆盖、del 删除），坏行计数 */
export function readStore(raw) {
  const byId = new Map();
  let corrupt = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (row.op === "put" && row.rec && row.rec.id) byId.set(row.rec.id, row.rec);
    else if (row.op === "del" && row.id) byId.delete(row.id);
  }
  return { records: [...byId.values()], corrupt };
}

/**
 * 纯函数：给定当前记录，算出合并计划。
 * 返回 { merged: [{ids, content, into}], records: 最新记录数组, dropped }。
 */
export function planMerge(records) {
  const sorted = [...records].sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const groups = new Map();
  for (const rec of sorted) {
    const key = `${rec.source ?? ""}${comparable(rec.content)}`;
    if (comparable(rec.content) === "") continue;
    const list = groups.get(key) ?? [];
    list.push(rec);
    groups.set(key, list);
  }

  const dropped = new Set();
  const merged = [];
  const keepers = new Map();
  for (const list of groups.values()) {
    let current = list[0];
    const finals = [current];
    for (const rec of list.slice(1)) {
      if (Number(rec.created_at) - Number(current.created_at) > WINDOW_MS) {
        current = rec;
        finals.push(rec);
        continue;
      }
      const prev = finals[finals.length - 1];
      dropped.add(rec.id);
      merged.push({ into: prev.id, dropped: rec.id, content: String(rec.content ?? "") });
      finals[finals.length - 1] = {
        ...prev,
        vividness: Math.max(Number(prev.vividness) || 0, Number(rec.vividness) || 0),
        access_count: (Number(prev.access_count) || 0) + (Number(rec.access_count) || 0),
        last_accessed: Math.max(Number(prev.last_accessed) || 0, Number(rec.last_accessed) || 0),
      };
    }
    for (const rec of finals) keepers.set(rec.id, rec);
  }

  const recordsOut = records.filter((r) => !dropped.has(r.id)).map((r) => keepers.get(r.id) ?? r);
  return { merged, records: recordsOut, dropped: dropped.size };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (!existsSync(target)) {
    console.error(`找不到记忆库：${target}`);
    exit(2);
  }
  const raw = readFileSync(target, "utf8");
  const { records, corrupt } = readStore(raw);
  const { merged, records: next, dropped } = planMerge(records);

  console.log(`# 记忆去重（${target}）`);
  console.log(`- 当前记录：${records.length} 条${corrupt > 0 ? `（坏行 ${corrupt} 行已跳过）` : ""}`);
  console.log(`- 可合并：${dropped} 条 → 归并进 ${new Set(merged.map((m) => m.into)).size} 条`);
  for (const m of merged.slice(0, 20)) console.log(`  - 「${m.content.slice(0, 30)}」 ${m.dropped} → ${m.into}`);
  if (merged.length > 20) console.log(`  …还有 ${merged.length - 20} 条`);
  console.log(`- 合并后：${next.length} 条`);

  if (!apply) {
    console.log("\n（只报告。要真正合并：加 --apply）");
    exit(0);
  }

  const backup = `${target}.bak-dedup-${Date.now()}`;
  copyFileSync(target, backup);
  const tmp = `${target}.tmp-${pid}`;
  writeFileSync(tmp, next.map((rec) => JSON.stringify({ op: "put", rec })).join("\n") + "\n", "utf8");
  renameSync(tmp, target);
  console.log(`\n已合并并重写。备份：${backup}`);
}
