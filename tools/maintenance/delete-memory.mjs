#!/usr/bin/env node
/**
 * A2 删除执行器（2026-11-02 用户 m09065 裁决 4「现在做」；设计 §6 删除候选）。
 *
 * 与 A1（edit-memory 的 --apply 合并）分开成独立脚本，理由：
 * - A1 只允许 merge；删除是不可逆语义，必须单独一个入口、单独的确认与预检；
 * - 两边都要「stop 窗口 + 备份 + 原子写 + 回滚」，复用 edit-memory.mjs 的已验收原语。
 *
 * 用法（全部在仓库根、daemon 已停后）：
 *   node tools/maintenance/delete-memory.mjs --ids=a,b,c                    # 只读计划（默认）
 *   node tools/maintenance/delete-memory.mjs --ids=a,b,c --json             # 机器可读计划
 *   node tools/maintenance/delete-memory.mjs --ids=a,b,c --out=.tmp/x.json  # 计划落 .tmp
 *   node tools/maintenance/delete-memory.mjs --ids=a,b,c --apply --confirm  # 真实删除（须 daemon 已停）
 *
 * 安全规则（fail-closed）：
 * - 只允许删 `source` 为 selftalk / proactive 的记忆；玩家原话（qq_contact_verified）需显式 `--allow-player`；
 *   其它来源需 `--allow-any-source`。
 * - 默认不删任何东西：--apply 必须同时有 --confirm，且 daemon 三源心跳都过期。
 * - 删除 = WAL 里不再写这个 id 的 put 行（put-only，不留 del/墓碑）→ 记忆文件里没有痕迹。
 * - 引用处理：journal.seeds / intent.source_ids / intent.threads 的 memoryIds|sourceIds|seedIds /
 *   其它记忆的 source_chain|derivation_chain 里指向被删 id 的引用会被移除（不是映射，因为目标不存在了）。
 * - 备份 data/.bak-hygiene-<ms>/（与 A1 同前缀、同 manifest 形状）；写失败回滚。
 * - `--apply` 不接受 `--now-ms`：执行期心跳用真实时钟。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDaemonStopped,
  createBackup,
  HEARTBEAT_FRESH_MS,
  readConsumed,
  readIntentFile,
  readJournal,
  readMemoryStore,
  readRepoHead,
  refCandidates,
  serializeMemory,
  writeFileAtomicRetry,
} from "./edit-memory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = "delete-memory";
const MODE_PLAN = "A2-plan";
const MODE_APPLY = "A2-apply";
const BACKUP_DIR_PREFIX = ".bak-hygiene-";
const ALLOWED_SOURCES = new Set(["selftalk", "proactive"]);

const DEFAULT_DEPS = {
  copyFile: copyFileSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  stat: statSync,
  writeFile: writeFileSync,
  sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
};

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  const found = args.find((item) => item.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function isUnderTmp(path) {
  return path.includes(`${ROOT}`.replaceAll("/", "\\") + "\\.tmp") || /[\\/]\.tmp[\\/]/.test(path);
}

function buildPaths({ dataDir, character }) {
  return {
    dataDir,
    character,
    memoryPath: join(dataDir, `memory-${character}.ndjson`),
    journalPath: join(dataDir, `selftalk-${character}.json`),
    intentPath: join(dataDir, `intent-${character}.json`),
    consumedPath: join(dataDir, `selftalk-consumed-${character}.json`),
    statePath: join(dataDir, `state-${character}.json`),
  };
}

function parseIds(raw) {
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 一条引用是否指向被删 id（兼容 `replay:<id>` 等前缀）。 */
function vividRefId(raw) {
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  if (raw !== null && typeof raw === "object" && typeof raw.id === "string") return raw.id;
  return String(raw ?? "");
}

function vividHitsDeletion(raw, deleted) {
  return deleted.has(vividRefId(raw));
}

export function refHitsDeletion(raw, deleted) {
  return refCandidates(raw).some((id) => deleted.has(id));
}

function filterRefList(list, deleted) {
  if (!Array.isArray(list)) return { list, removed: 0 };
  const kept = list.filter((item) => !refHitsDeletion(item, deleted));
  return { list: kept, removed: list.length - kept.length };
}

/** 生成只读计划。不写 data/；--out 由 CLI 处理。 */
export function generateDeletePlan({ records, journal, intent, paths, ids, allowPlayer = false, allowAnySource = false, allowMissing = false, dropConsumed = false, lastConsumedAt = null }) {
  const wanted = [...new Set(ids)];
  const byId = new Map(records.map((record) => [record.id, record]));
  const deleted = new Set();
  const deletable = [];
  const refusals = [];
  let missingCount = 0;

  for (const id of wanted) {
    const record = byId.get(id);
    if (record === undefined) {
      if (allowMissing) {
        missingCount += 1;
        continue;
      }
      refusals.push({ code: "not-found", id, detail: "记忆库里没有这个 id（可能已删过）" });
      continue;
    }
    const source = String(record.source ?? "");
    if (source === "qq_contact_verified" && !allowPlayer) {
      refusals.push({ code: "protected-player", id, detail: "这是玩家原话，需 --allow-player 明确允许" });
      continue;
    }
    const playerAllowed = source === "qq_contact_verified" && allowPlayer;
    if (!playerAllowed && !ALLOWED_SOURCES.has(source) && !allowAnySource) {
      refusals.push({ code: "unknown-source", id, detail: `source=${source} 不在可删白名单（selftalk/proactive），需 --allow-any-source` });
      continue;
    }
    deleted.add(id);
    const journalSeeds = journal.entries.reduce((sum, entry) => sum + (entry.seeds ?? []).filter((seed) => refHitsDeletion(seed, new Set([id]))).length, 0);
    const intentRefs = (intent.records ?? []).reduce((sum, rec) => {
      const one = new Set([id]);
      const sourceIds = (rec?.source_ids ?? []).filter((ref) => refHitsDeletion(ref, one)).length;
      const threadRefs = (rec?.threads ?? []).reduce((inner, thread) => {
        let count = 0;
        for (const field of ["memoryIds", "sourceIds", "seedIds"]) {
          count += (thread?.[field] ?? []).filter((ref) => refHitsDeletion(ref, one)).length;
        }
        return inner + count;
      }, 0);
      return sum + sourceIds + threadRefs;
    }, 0);
    const journalVividness = journal.entries.reduce((sum, entry) => sum + (Array.isArray(entry.vividness) ? entry.vividness : []).filter((pair) => vividHitsDeletion(pair, new Set([id]))).length, 0);
    const chainRefs = records.reduce((sum, other) => {
      const one = new Set([id]);
      return sum + [...(other.source_chain ?? []), ...(other.derivation_chain ?? [])].filter((ref) => refHitsDeletion(ref, one)).length;
    }, 0);
    deletable.push({
      id,
      source,
      createdAt: record.created_at ?? null,
      preview: String(record.content ?? "").slice(0, 40),
      journalSeedRefs: journalSeeds,
      journalVividnessRefs: journalVividness,
      intentRefs,
      chainRefs,
    });
  }

  // 引用计数在“整批”口径下会重复，这里再算一次整批汇总（报告用）
  const deletedAll = new Set(deletable.map((item) => item.id));
  let journalSeedsRemoved = 0;
  for (const entry of journal.entries) journalSeedsRemoved += (entry.seeds ?? []).filter((seed) => refHitsDeletion(seed, deletedAll)).length;
  let intentRefsRemoved = 0;
  for (const rec of intent.records ?? []) {
    intentRefsRemoved += (rec?.source_ids ?? []).filter((ref) => refHitsDeletion(ref, deletedAll)).length;
    for (const thread of rec?.threads ?? []) {
      for (const field of ["memoryIds", "sourceIds", "seedIds"]) intentRefsRemoved += (thread?.[field] ?? []).filter((ref) => refHitsDeletion(ref, deletedAll)).length;
    }
  }
  let journalVividnessRemoved = 0;
  for (const entry of journal.entries) {
    journalVividnessRemoved += (Array.isArray(entry.vividness) ? entry.vividness : []).filter((pair) => vividHitsDeletion(pair, deletedAll)).length;
  }
  const pendingDropped = [];
  for (const entry of journal.entries) {
    const at = Number(entry.at);
    const pending = lastConsumedAt === null || !Number.isFinite(at) ? true : at > lastConsumedAt;
    const seedHit = (entry.seeds ?? []).some((seed) => refHitsDeletion(seed, deletedAll));
    const vividHit = (Array.isArray(entry.vividness) ? entry.vividness : []).some((pair) => vividHitsDeletion(pair, deletedAll));
    if (pending && (seedHit || vividHit)) pendingDropped.push(String(entry.id ?? at));
  }
  const consumedDropped = [];
  if (dropConsumed === true) {
    for (const entry of journal.entries) {
      const at = Number(entry.at);
      const pending = lastConsumedAt === null || !Number.isFinite(at) ? true : at > lastConsumedAt;
      if (pending) continue;
      const seedHit = (entry.seeds ?? []).some((seed) => refHitsDeletion(seed, deletedAll));
      const vividHit = (Array.isArray(entry.vividness) ? entry.vividness : []).some((pair) => vividHitsDeletion(pair, deletedAll));
      if (seedHit || vividHit) consumedDropped.push(String(entry.id ?? at));
    }
  }
  let chainRefsRemoved = 0;
  for (const record of records) {
    chainRefsRemoved += [...(record.source_chain ?? []), ...(record.derivation_chain ?? [])].filter((ref) => refHitsDeletion(ref, deletedAll)).length;
  }

  return {
    tool: TOOL,
    mode: MODE_PLAN,
    planVersion: 1,
    ids: wanted,
    deletedIds: [...deletedAll],
    deletable,
    refusals,
    references: {
      journalSeedsRemoved,
      journalVividnessRemoved,
      journalPendingDropped: pendingDropped.length,
      journalPendingDroppedIds: pendingDropped,
      journalConsumedDropped: consumedDropped.length,
      journalConsumedDroppedIds: consumedDropped,
      intentRefsRemoved,
      chainRefsRemoved,
      lastConsumedAt,
    },
    dataSnapshot: {
      memoryLines: records.length === 0 ? 0 : undefined, // CLI 会覆盖成 WAL 行数
      memoryUnique: records.length,
      journalEntries: journal.entries.length,
      intentRecords: (intent.records ?? []).length,
    },
    dropConsumed: dropConsumed === true,
    repoHead: readRepoHead(),
    applyAllowed: refusals.length === 0 && deletedAll.size === wanted.length - missingCount && deletedAll.size > 0,
  };
}

function buildDeletedMemory({ records, deleted }) {
  const kept = [];
  for (const record of records) {
    if (deleted.has(record.id)) continue;
    const base = { ...record };
    if (Array.isArray(base.source_chain)) base.source_chain = base.source_chain.filter((ref) => !refHitsDeletion(ref, deleted));
    if (Array.isArray(base.derivation_chain)) base.derivation_chain = base.derivation_chain.filter((ref) => !refHitsDeletion(ref, deleted));
    kept.push(base);
  }
  return { records: kept, removed: records.length - kept.length };
}

function buildDeletedJournal({ entries, deleted, lastConsumedAt = null, dropConsumed = false }) {
  let removedSeeds = 0;
  let removedVividness = 0;
  const droppedPending = [];
  const droppedConsumed = [];
  const next = [];
  for (const entry of entries) {
    const seeds = Array.isArray(entry.seeds) ? entry.seeds : [];
    const vividness = Array.isArray(entry.vividness) ? entry.vividness : [];
    const keptSeeds = seeds.filter((seed) => {
      if (refHitsDeletion(seed, deleted)) {
        removedSeeds += 1;
        return false;
      }
      return true;
    });
    const keptVividness = vividness.filter((pair) => {
      if (vividHitsDeletion(pair, deleted)) {
        removedVividness += 1;
        return false;
      }
      return true;
    });
    const seedHit = keptSeeds.length !== seeds.length;
    const vividHit = keptVividness.length !== vividness.length;
    const at = Number(entry.at);
    const pending = lastConsumedAt === null || !Number.isFinite(at) ? true : at > lastConsumedAt;
    // 未消费的条目会在下次巩固被 seedsFromJournal 换新 id 写回记忆（删了又回来）：
    // 只要它引用了被删 id，就整条丢弃；已消费的条目保留正文、只清引用（历史不造假）。
    if (pending && (seedHit || vividHit)) {
      droppedPending.push(String(entry.id ?? at));
      continue;
    }
    // B 口径（用户 2026-11-02 选 B）：已消费条目命中被删 id 时整条丢弃，做到 journal 文件层也不留痕。
    if (!pending && (seedHit || vividHit) && dropConsumed === true) {
      droppedConsumed.push(String(entry.id ?? at));
      continue;
    }
    if (!seedHit && !vividHit) {
      next.push(entry);
      continue;
    }
    next.push({ ...entry, seeds: keptSeeds, vividness: keptVividness });
  }
  return { entries: next, removedSeeds, removedVividness, droppedPending, droppedConsumed };
}

function buildDeletedIntent({ intentRaw, deleted }) {
  let removed = 0;
  const records = (Array.isArray(intentRaw.records) ? intentRaw.records : []).map((record) => {
    if (record === null || typeof record !== "object") return record;
    const out = { ...record };
    if (Array.isArray(record.source_ids)) {
      const filtered = record.source_ids.filter((ref) => {
        if (refHitsDeletion(ref, deleted)) {
          removed += 1;
          return false;
        }
        return true;
      });
      out.source_ids = filtered;
    }
    if (Array.isArray(record.threads)) {
      out.threads = record.threads.map((thread) => {
        if (thread === null || typeof thread !== "object") return thread;
        const nextThread = { ...thread };
        for (const field of ["memoryIds", "sourceIds", "seedIds"]) {
          if (!Array.isArray(thread[field])) continue;
          nextThread[field] = thread[field].filter((ref) => {
            if (refHitsDeletion(ref, deleted)) {
              removed += 1;
              return false;
            }
            return true;
          });
        }
        return nextThread;
      });
    }
    return out;
  });
  return { intent: { ...intentRaw, records }, removed };
}

function readIntentRaw(path) {
  if (!existsSync(path)) return { version: 1, records: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`拒绝执行：intent 文件解析失败——${error instanceof Error ? error.message : String(error)}`, 3);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.records)) fail("拒绝执行：intent 文件缺少 records 数组。", 3);
  return parsed;
}

/** 执行真实删除（调用方保证在 stop 窗口）。返回 {exitCode,message,summary?}。 */
export function executeDelete({ paths, plan, nowMs = Date.now(), confirm = false, deps = DEFAULT_DEPS }) {
  const d = { ...DEFAULT_DEPS, ...(deps ?? {}) };
  if (confirm !== true) return { exitCode: 2, message: "A2 需要 --confirm：--apply 会真实删除记忆并在引用位置移除它们。" };
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.deletable)) return { exitCode: 3, message: "拒绝执行：plan 结构非法。" };
  if (plan.applyAllowed !== true || (plan.refusals ?? []).length > 0) {
    return { exitCode: 3, message: `拒绝执行：applyAllowed=${String(plan.applyAllowed)}，refusals=${(plan.refusals ?? []).length}（须 true / 0）。` };
  }
  if ((plan.deletedIds ?? []).length === 0) return { exitCode: 0, message: "没有要删的 id（幂等 no-op）。" };

  if (!existsSync(paths.memoryPath)) return { exitCode: 3, message: `拒绝执行：找不到记忆库 ${paths.memoryPath}` };
  const store = readMemoryStore(readFileSync(paths.memoryPath, "utf8"));
  if (store.corrupt > 0) return { exitCode: 3, message: `拒绝执行：记忆 WAL 有 ${store.corrupt} 行无法解析，拒绝整批。` };

  const journal = readJournal(paths.journalPath);
  if (!journal.exists) return { exitCode: 3, message: `拒绝执行：journal 文件不存在（${paths.journalPath}），无法证明它是空文件。` };
  if (journal.error !== null) return { exitCode: 3, message: `拒绝执行：journal 解析失败——${journal.error}` };
  const intentRaw = readIntentRaw(paths.intentPath);
  const consumed = readConsumed(paths.consumedPath);
  if (consumed.error !== null) return { exitCode: 3, message: `拒绝执行：consumed 解析失败——${consumed.error}` };

  const expected = plan.dataSnapshot ?? {};
  if (Number(expected.memoryUnique) !== store.records.length || Number(expected.journalEntries) !== journal.entries.length) {
    return { exitCode: 3, message: `拒绝执行：磁盘快照与 plan 不一致（plan unique=${expected.memoryUnique}/journal=${expected.journalEntries}；磁盘 ${store.records.length}/${journal.entries.length}）。请重新跑 --plan。` };
  }

  const deleted = new Set(plan.deletedIds);
  const missing = [...deleted].filter((id) => !store.records.some((record) => record.id === id));
  if (missing.length > 0) return { exitCode: 3, message: `拒绝执行：这些 id 在磁盘上已不存在——${missing.join(", ")}；请重新跑 --plan。` };

  const daemon = checkDaemonStopped(paths, Date.now());
  if (!daemon.stopped) {
    const names = daemon.blockers.map((signal) => `${signal.kind}(${signal.ageMs === null ? "?" : `${signal.ageMs}ms`})`).join(", ");
    return { exitCode: 3, message: `拒绝执行：daemon 心跳仍新鲜 [${names}]（阈值 ${HEARTBEAT_FRESH_MS}ms）。请先 npm run stop 并等进程退出。` };
  }

  const memory = buildDeletedMemory({ records: store.records, deleted });
  const lastConsumedAt = consumed.lastConsumedAt;
  const journalNext = buildDeletedJournal({ entries: journal.entries, deleted, lastConsumedAt, dropConsumed: plan.dropConsumed === true });
  const intentNext = buildDeletedIntent({ intentRaw, deleted });
  const intentChanged = JSON.stringify(intentNext.intent.records) !== JSON.stringify(intentRaw.records);
  const kinds = ["memory", "journal", "consumed", "state", ...(intentChanged ? ["intent"] : [])];

  let backup;
  try {
    backup = createBackup({
      paths,
      nowMs,
      plan: { repoHead: plan.repoHead ?? null },
      kinds,
      deps: d,
      tool: TOOL,
      mode: MODE_APPLY,
      planSummary: {
        ids: plan.ids,
        deletedIds: plan.deletedIds,
        deletable: Array.isArray(plan.deletable) ? plan.deletable.length : plan.deletable,
        references: plan.references,
        refusals: plan.refusals,
        applyAllowed: plan.applyAllowed === true,
        dropConsumed: plan.dropConsumed === true,
      },
    });
  } catch (error) {
    return { exitCode: 4, message: `备份失败，未改任何数据：${error instanceof Error ? error.message : String(error)}` };
  }

  const writes = [
    { path: paths.memoryPath, text: serializeMemory(memory.records) },
    { path: paths.journalPath, text: JSON.stringify(journalNext.entries) },
    ...(intentChanged ? [{ path: paths.intentPath, text: `${JSON.stringify(intentNext.intent, null, 2)}\n` }] : []),
  ];

  try {
    for (const write of writes) writeFileAtomicRetry(write.path, write.text, d);
  } catch (error) {
    const backupNames = Object.fromEntries(Object.entries(backup.manifest.files).map(([name, info]) => [info.kind, name]));
    let restored = [];
    try {
      for (const [kind, name] of Object.entries(backupNames)) {
        const source = join(backup.backupDir, name);
        if (existsSync(source)) {
          d.copyFile(source, kind === "memory" ? paths.memoryPath : kind === "journal" ? paths.journalPath : kind === "intent" ? paths.intentPath : kind === "consumed" ? paths.consumedPath : paths.statePath);
          restored.push(name);
        }
      }
    } catch {
      /* 回滚失败：仍报 exit 4，让用户从备份手工恢复 */
    }
    return { exitCode: 4, message: `写入失败：${error instanceof Error ? error.message : String(error)}；已回滚 ${restored.length} 个文件。备份在 ${backup.backupDir}` };
  }

  const summary = {
    backupDir: backup.backupDir,
    deleted: memory.removed,
    deletedIds: [...deleted],
    journalSeedsRemoved: journalNext.removedSeeds,
    journalVividnessRemoved: journalNext.removedVividness,
    journalPendingDropped: journalNext.droppedPending.length,
    journalConsumedDropped: journalNext.droppedConsumed.length,
    intentRefsRemoved: intentNext.removed,
    memoryBefore: store.records.length,
    memoryAfter: memory.records.length,
    journalEntries: journalNext.entries.length,
  };
  return {
    exitCode: 0,
    message: `[delete-memory] A2 完成：memory ${summary.memoryBefore}→${summary.memoryAfter}（删 ${summary.deleted} 条）；journal seeds 移除 ${summary.journalSeedsRemoved} 处、vividness ${summary.journalVividnessRemoved} 处、未消费条目丢弃 ${summary.journalPendingDropped} 条、已消费条目整条丢弃 ${summary.journalConsumedDropped} 条；intent 引用移除 ${summary.intentRefsRemoved} 处；备份 ${summary.backupDir}`,
    summary,
  };
}

function formatPlan(plan) {
  const lines = [];
  lines.push(`[delete-memory] ${MODE_PLAN}：请求 ${plan.ids.length} 个 id，可删 ${plan.deletable.length}，refusals ${plan.refusals.length}`);
  for (const item of plan.deletable) {
    lines.push(`  ✓ ${item.id}（source=${item.source}，journal seed ${item.journalSeedRefs} / vividness ${item.journalVividnessRefs}、intent ${item.intentRefs}、chain ${item.chainRefs}）「${item.preview}」`);
  }
  for (const refusal of plan.refusals) lines.push(`  ✗ ${refusal.id}：${refusal.code} —— ${refusal.detail}`);
  lines.push(`  引用汇总：journal seeds ${plan.references.journalSeedsRemoved} / vividness ${plan.references.journalVividnessRemoved} / 未消费条目丢弃 ${plan.references.journalPendingDropped} / 已消费条目整条丢弃 ${plan.references.journalConsumedDropped ?? 0} / intent ${plan.references.intentRefsRemoved} / chain ${plan.references.chainRefsRemoved}`);
  lines.push(`  applyAllowed=${String(plan.applyAllowed)}（--apply 需同时 --confirm 且 daemon 已停）`);
  return lines.join("\n");
}

function usage() {
  return [
    "A2 删除执行器（stop 窗口）：",
    "  node tools/maintenance/delete-memory.mjs --ids=a,b,c                 # 只读计划（默认）",
    "  node tools/maintenance/delete-memory.mjs --ids=a,b,c --json          # 机器可读",
    "  node tools/maintenance/delete-memory.mjs --ids=a,b,c --out=.tmp/x.json",
    "  node tools/maintenance/delete-memory.mjs --ids=a,b,c --apply --confirm",
    "可选：--allow-player（允许删玩家原话）、--allow-any-source、--allow-missing（幂等重跑）、--drop-consumed（B 口径：已消费 journal 条目命中时整条丢弃）、--data-dir=、--character=",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const dataDir = resolve(argValue(args, "data-dir") ?? join(ROOT, "data"));
  const character = argValue(args, "character") ?? "assistant";
  const paths = buildPaths({ dataDir, character });
  const ids = parseIds(argValue(args, "ids"));
  if (ids.length === 0) fail("必须给 --ids=a,b,c（至少一个 id）。", 2);

  const applyMode = args.includes("--apply");
  if (applyMode && !args.includes("--confirm")) fail("--apply 需要 --confirm（真实删除不可逆；请确认 daemon 已停）。", 2);
  if (applyMode && argValue(args, "now-ms") !== undefined) fail("--apply 不接受 --now-ms：执行期心跳必须用真实时钟。", 2);
  if (!applyMode && args.includes("--confirm")) fail("--confirm 只能与 --apply 同用。", 2);

  const outArg = argValue(args, "out");
  if (outArg !== undefined && applyMode) fail("--out 只能用于计划模式。", 2);
  if (outArg !== undefined && !isUnderTmp(resolve(outArg))) fail(`--out 只允许写到 <repo>/.tmp/ 下：${resolve(outArg)}`, 2);
  if (!existsSync(paths.memoryPath)) fail(`找不到记忆库：${paths.memoryPath}`, 2);

  const store = readMemoryStore(readFileSync(paths.memoryPath, "utf8"));
  const journal = readJournal(paths.journalPath);
  const intent = readIntentFile(paths.intentPath);
  const consumed = readConsumed(paths.consumedPath);
  const allowPlayer = args.includes("--allow-player");
  const allowAnySource = args.includes("--allow-any-source");
  const allowMissing = args.includes("--allow-missing");
  const dropConsumed = args.includes("--drop-consumed");

  if (consumed.error !== null) fail(`consumed 文件解析失败——${consumed.error}`, 3);
  const plan = generateDeletePlan({ records: store.records, journal, intent, paths, ids, allowPlayer, allowAnySource, allowMissing, dropConsumed, lastConsumedAt: consumed.lastConsumedAt });
  plan.dataSnapshot.memoryLines = store.lines;

  const asJson = args.includes("--json");
  if (applyMode) {
    const result = executeDelete({ paths, plan, nowMs: Date.now(), confirm: true });
    console.log(asJson ? JSON.stringify({ tool: TOOL, mode: MODE_APPLY, ...result }, null, 2) : result.message);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const body = asJson ? JSON.stringify(plan, null, 2) : formatPlan(plan);
  if (outArg !== undefined) {
    const outPath = resolve(outArg);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(asJson ? body : `${body}\n\n已写入计划：${outPath}`);
  } else {
    console.log(body);
  }
  if (plan.refusals.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 2);
  });
}
