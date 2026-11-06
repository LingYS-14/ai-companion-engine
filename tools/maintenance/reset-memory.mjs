#!/usr/bin/env node
/**
 * 清空她的旧数据：只删「她经历过的东西」，保留「她是谁 / 怎么连上外界」。
 *
 * 为什么单独一个脚本、而不是手敲 rm：
 *   1. 删之前必须先备份（--yes 才真删，默认 dry-run 只打印清单）；
 *   2. 删哪些要写死在代码里、逐项打印——漏删会被看见，多删不会；
 *   3. 她还在跑的时候删会被她边删边写，所以要先检查 pid 与写锁。
 *
 * 保留（硬编码 KEEP）：
 *   - persona/（她是谁）
 *   - bili-<id>.json（B 站登录）、qq 的 OneBot 连接配置（在 config，不在 data）
 *   - holidays.txt / workdays.txt（环境事实）
 *   - knowledge-default.ndjson / state-default.json / archive/memory-default.ndjson（种子样本）
 *   - whisper-base/（ASR 模型，不是记忆）
 *
 * 用法：
 *   node tools/maintenance/reset-memory.mjs            # 只看清单（默认，不删）
 *   node tools/maintenance/reset-memory.mjs --yes      # 备份 → 删除 → 打印报告
 *   node tools/maintenance/reset-memory.mjs --yes --backup-dir D:\ase-backup
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dataDir = join(repo, "data");
const personaDir = join(repo, "persona");
const character = process.env.ACE_CHARACTER_ID ?? "assistant";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const yes = process.argv.includes("--yes");
const bdIndex = process.argv.indexOf("--backup-dir");
const backupRoot = bdIndex >= 0 ? resolve(process.argv[bdIndex + 1]) : join("C:\\AI\\backups", `ase-pre-reset-${stamp}`);
const backupDir = join(backupRoot);

/** 要删的文件名（精确）+ 前缀（备份/临时/测试残留） */
const DELETE_FILES = [
  `memory-${character}.ndjson`,
  `knowledge-${character}.ndjson`,
  `state-${character}.json`,
  `qq-${character}.json`,
  `onebot-relay-${character}.jsonl`,
  `autonomy-${character}.log`,
  `qq-${character}.log`,
  `autonomy-${character}.pid`,
  `autonomy-${character}.beat`,
  "watchdog.log",
  "apply-report.json",
  "autonomy-learn-assistant.json",
  "autonomy-usage.json",
  "autonomy-review-cleared.json",
  "consolidation-hubs.json",
  `insight-${character}.json`,
  `openworld-${character}.json`,
  `selftalk-${character}.json`,
  `selftalk-consumed-${character}.json`,
  `intent-acc-${character}.json`,
  `intent-shadow-${character}.ndjson`,
  `intent-live-shadow-${character}.ndjson`,
  ".writer-lock",
];
const DELETE_PREFIXES = [
  `memory-${character}.ndjson.bak`,
  `knowledge-${character}.ndjson.bak`,
  `selftalk-${character}.json.bak`,
  "autonomy-learn-assistant.json.bak",
  "autonomy-review.json.cleared",
  ".report-",
];
/** 整个目录删（保留目录本身） */
const CLEAR_DIRS = ["archive/backups", "archive/snapshots", "execution", "frames", "screens", "voice", "tmp"];
/** 目录里要留的东西（只对 data/archive 顶层生效） */
const KEEP = [
  `bili-${character}.json`,
  "holidays.txt",
  "workdays.txt",
  "knowledge-default.ndjson",
  "state-default.json",
  "whisper-base",
];
const KEEP_IN_ARCHIVE = ["memory-default.ndjson"];

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function planned() {
  const files = [];
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在：${dataDir}`);
  for (const name of readdirSync(dataDir)) {
    const full = join(dataDir, name);
    const st = statSync(full);
    if (st.isDirectory()) continue;
    if (KEEP.includes(name)) continue;
    if (DELETE_FILES.includes(name) || DELETE_PREFIXES.some((p) => name.startsWith(p))) files.push(full);
  }
  for (const rel of CLEAR_DIRS) {
    const dir = join(dataDir, rel);
    for (const f of walk(dir)) files.push(f);
  }
  // archive 顶层的旧备份删掉，只留种子
  const archive = join(dataDir, "archive");
  if (existsSync(archive)) {
    for (const name of readdirSync(archive)) {
      const full = join(archive, name);
      if (statSync(full).isFile() && !KEEP_IN_ARCHIVE.includes(name)) files.push(full);
    }
  }
  return files;
}

function describe(files) {
  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  return { count: files.length, total };
}

function running() {
  const pidPath = join(dataDir, `autonomy-${character}.pid`);
  try {
    const info = JSON.parse(readFileSync(pidPath, "utf8"));
    if (typeof info.pid === "number") {
      process.kill(info.pid, 0); // 只探测，不发信号
      return info.pid;
    }
  } catch {
    // 没有 pid 文件 / 进程不存在：都算没在跑
  }
  return null;
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const files = planned();
const { count, total } = describe(files);
const pid = running();

console.log(`仓库：${repo}`);
console.log(`数据：${dataDir}`);
console.log(`角色：${character}`);
console.log("");
console.log(`将删除 ${count} 个文件（${human(total)}），清空 ${CLEAR_DIRS.length} 个目录：`);
for (const dir of CLEAR_DIRS) {
  const n = walk(join(dataDir, dir)).length;
  if (n > 0) console.log(`  [清空] ${dir}/（${n} 个文件）`);
}
for (const f of files.filter((x) => !CLEAR_DIRS.some((d) => x.startsWith(join(dataDir, d)))).slice(0, 40)) {
  console.log(`  [删]   ${relative(dataDir, f)}（${human(statSync(f).size)}）`);
}
if (count > 40) console.log(`  …另外 ${count - 40} 个文件略`);
console.log("");
console.log(`保留：${KEEP.join(" / ")}，以及 archive/${KEEP_IN_ARCHIVE.join("、")}、persona/、config/`);
console.log(`备份到：${backupDir}`);

if (!yes) {
  if (pid !== null) console.log(`\n⚠ 她还在跑（pid=${pid}）：dry-run 不受影响，但真删前必须先停。`);
  console.log("\n这是 dry-run（没有删任何东西）。确认后加 --yes 执行。");
  process.exit(0);
}
if (pid !== null) {
  console.error(`\n✗ 她还在跑（pid=${pid}），不能边跑边删。先停：\n  powershell -ExecutionPolicy Bypass -File "${join(repo, "scripts", "autonomy", "stop.ps1")}"`);
  process.exit(1);
}

// ── 备份：整个 data（whisper-base 是模型不是记忆，跳过）+ persona + 关键配置 ──────────
mkdirSync(join(backupDir, "data"), { recursive: true });
let copied = 0;
for (const name of readdirSync(dataDir)) {
  if (name === "whisper-base") continue;
  cpSync(join(dataDir, name), join(backupDir, "data", name), { recursive: true });
  copied += 1;
}
cpSync(personaDir, join(backupDir, "persona"), { recursive: true });
const configDir = join(repo, "spec", "config");
if (existsSync(configDir)) cpSync(configDir, join(backupDir, "spec-config"), { recursive: true });
const copiedBytes = walk(join(backupDir, "data")).reduce((n, f) => n + statSync(f).size, 0);
console.log(`\n已备份 ${copied} 项到 ${backupDir}（data 部分 ${human(copiedBytes)}，跳过 whisper-base）`);

// ── 删除 ────────────────────────────────────────────────────────────────────────
let removed = 0;
for (const f of files) {
  try {
    rmSync(f, { force: true });
    removed += 1;
  } catch (err) {
    console.error(`删除失败：${relative(dataDir, f)}：${err instanceof Error ? err.message : String(err)}`);
  }
}
for (const dir of CLEAR_DIRS) mkdirSync(join(dataDir, dir), { recursive: true });

const report = {
  version: 1,
  at: new Date().toISOString(),
  character,
  removedFiles: removed,
  removedBytes: total,
  backupDir,
  kept: KEEP,
  note: "备份在用户确认新她无问题前不要删。",
};
writeFileSync(join(backupDir, "reset-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n✓ 删除完成：${removed} 个文件（${human(total)}）。报告：${join(backupDir, "reset-report.json")}`);
console.log("下一步：publish-runtime（停→复制→起）。备份先别删。");
