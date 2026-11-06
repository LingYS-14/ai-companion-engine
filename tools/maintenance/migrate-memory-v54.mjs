#!/usr/bin/env node
/**
 * v5.4-P1 记忆迁移（S1 1.1 / D2）：给 v5.3.1 的落盘记忆补 `base_activation`。
 *
 * 为什么要有独立脚本：运行时也会懒迁移（`MemoryStore.migrateActivation`），但那是**静默改写**
 * 玩家存档；一次性归档动档之前必须先备份，并把「改了什么」打印出来。
 *
 * 用法：
 *   node tools/maintenance/migrate-memory-v54.mjs                 # 只报告
 *   node tools/maintenance/migrate-memory-v54.mjs --apply         # 备份后改写
 *   node tools/maintenance/migrate-memory-v54.mjs --file <path>   # 指定文件
 *
 * 安全：默认 dry-run；--apply 先写 `<file>.bak-migrate-<ms>`，再写 `.tmp-<pid>` 原子替换。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = join(ROOT, "spec/config/v54.overlay.json");
const HOUR_MS = 3_600_000;
const SCHEMA_VERSION = "v5.4-p1/memory-2";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const apply = process.argv.includes("--apply");
const files = [];
const explicit = arg("--file");
if (explicit) files.push(resolve(explicit));
else {
  const dataDir = join(ROOT, "data");
  for (const id of ["assistant", "default"]) {
    const p = join(dataDir, `memory-${id}.ndjson`);
    if (existsSync(p)) files.push(p);
  }
}

const overlay = JSON.parse(readFileSync(OVERLAY, "utf8"));
const decay = overlay.knobs.ACT_R_DECAY?.value;
const cold = overlay.knobs.ACT_R_THRESHOLD_COLD?.value;
if (typeof decay !== "number" || typeof cold !== "number") {
  console.error(`overlay 缺 ACT_R_DECAY / ACT_R_THRESHOLD_COLD：${OVERLAY}`);
  process.exit(2);
}

function migrated(rec, now) {
  const ageHours = Math.max(0, (now - (rec.last_accessed ?? rec.created_at ?? now)) / HOUR_MS);
  const raw = Math.log(1 + Math.max(0, rec.access_count ?? 0)) - decay * ageHours;
  return Math.max(cold, Math.min(0, raw));
}

let totalChanged = 0;
const now = Date.now();
for (const file of files) {
  if (!existsSync(file)) {
    console.log(`跳过（不存在）：${file}`);
    continue;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      return line; // 坏行原样保留：WAL 的容错语义不由迁移脚本破坏
    }
    if (op?.op !== "put" || !op.rec || typeof op.rec !== "object") return line;
    if (Number.isFinite(op.rec.base_activation)) return line;
    const next = { ...op.rec, base_activation: migrated(op.rec, now), schema_version: SCHEMA_VERSION };
    // 保持字段顺序稳定：base_activation 紧跟在 access_count 后
    const ordered = {};
    for (const [k, v] of Object.entries(next)) {
      ordered[k] = v;
      if (k === "access_count") ordered.base_activation = next.base_activation;
    }
    changed += 1;
    return JSON.stringify({ op: "put", rec: ordered });
  });
  totalChanged += changed;
  console.log(`${apply ? "迁移" : "将迁移"} ${changed} 条：${file}`);
  if (!apply || changed === 0) continue;
  const backup = `${file}.bak-migrate-${Date.now()}`;
  copyFileSync(file, backup);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, out.join("\n"), "utf8");
  renameSync(tmp, file);
  console.log(`  备份：${backup}（schema=${SCHEMA_VERSION}）`);
}

if (totalChanged === 0) console.log("没有需要迁移的记录（都已有 base_activation）。");
else if (!apply) console.log(`dry-run：共 ${totalChanged} 条待迁移；加 --apply 执行（会先备份）。`);
