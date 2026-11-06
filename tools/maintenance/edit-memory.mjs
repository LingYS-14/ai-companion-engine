#!/usr/bin/env node
/**
 * 记忆卫生工具：A0 只读清单/计划 + A1 --apply --confirm（仅 stop 窗口）。
 *
 *   node tools/maintenance/edit-memory.mjs                      # 默认 = --list（报告，不动文件）
 *   node tools/maintenance/edit-memory.mjs --list [--json]      # 列出记忆、引用计数与候选分组
 *   node tools/maintenance/edit-memory.mjs --plan [--json]      # 从数据生成合并计划（不写）
 *   node tools/maintenance/edit-memory.mjs --dry-run [--json]   # 同 --plan，打印将被改动的文件与引用映射
 *   node tools/maintenance/edit-memory.mjs --plan --out=.tmp/handover/edit-memory-plan-<ts>.json
 *   node tools/maintenance/edit-memory.mjs --apply --confirm    # A1：真实合并（必须 daemon 已停）
 *
 * 依据：`.tmp/handover/repetition-and-hygiene-design.md`（v2.2）§3.1/§3.2/§3.4.1/§3.5。
 *
 * 安全边界：
 * - A0（--list/--plan/--dry-run）只读；唯一写操作是 --plan --out 落 .tmp/ 计划文件；
 * - A1（--apply）只在 --confirm 且预检全过时改写 data/：备份→tmp+rename 原子写→失败回滚；
 * - 不删记录、不移除 seeds、不推进 cursor（删除属 A2）；
 * - 计划里的时间不靠系统时钟：--now-ms 未给时 generatedAt=null。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TOOL_KIND = "edit-memory";
export const TOOL_MODE = "A0-readonly";
export const PLAN_VERSION = 1;
export const MERGE_STRATEGIES = ["exact", "selftalk-near"];
/** selftalk 近重复自动合并区间（设计 §3.3）。 */
export const NEAR_SIMILARITY_FLOOR = 0.65;
export const NEAR_SIMILARITY_CEIL = 0.8;
/** rollback 备份清单（设计 §3.1/§3.5）：memory/journal/consumed/state，intent 不在列。 */
export const ROLLBACK_FILE_KINDS = ["memory", "journal", "consumed", "state"];

// ---------------------------------------------------------------------------
// 归一化与相似度（与 selftalk-journal 写口去重同口径）
// ---------------------------------------------------------------------------

export function normalizeContent(content) {
  return String(content ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function bigrams(text) {
  const chars = [...text];
  const out = new Map();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const key = `${chars[i]}${chars[i + 1]}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** 二元组 Dice 相似度；空串按 0 处理。 */
export function diceSimilarity(a, b) {
  const left = bigrams(normalizeContent(a));
  const right = bigrams(normalizeContent(b));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) leftTotal += count;
  for (const count of right.values()) rightTotal += count;
  for (const [key, count] of left) overlap += Math.min(count, right.get(key) ?? 0);
  return (2 * overlap) / (leftTotal + rightTotal);
}

// ---------------------------------------------------------------------------
// 读文件（只读）
// ---------------------------------------------------------------------------

/** 读记忆 WAL（`{op:"put",rec}` / `{op:"del",id}`），按 id 回放去重。 */
export function readMemoryStore(raw) {
  const byId = new Map();
  let corrupt = 0;
  let tombstones = 0;
  let putLines = 0;
  let lines = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    lines += 1;
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      corrupt += 1;
      continue;
    }
    if (row?.op === "put" && row.rec !== undefined && row.rec !== null) {
      if (typeof row.rec.id !== "string" || row.rec.id === "") {
        corrupt += 1;
        continue;
      }
      byId.set(row.rec.id, row.rec);
      putLines += 1;
      continue;
    }
    if (row?.op === "del" && typeof row.id === "string") {
      byId.delete(row.id);
      tombstones += 1;
      continue;
    }
    tombstones += 1;
  }
  return { records: [...byId.values()], corrupt, tombstones, putLines, lines, duplicateLines: putLines - byId.size };
}

/**
 * 读 selftalk journal（JSON 数组）。
 * 缺 `seeds` 数组的条目**不丢**：保留 entry、seeds 按空数组参与列表，并计数 `missingSeeds`（报告告警）。
 */
export function readJournal(path) {
  if (!existsSync(path)) return { path, entries: [], error: null, exists: false, missingSeeds: 0 };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return { path, entries: [], error: "journal 不是数组", exists: true, missingSeeds: 0 };
    let missingSeeds = 0;
    const entries = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object") continue;
      const seeds = Array.isArray(entry.seeds) ? entry.seeds : [];
      if (!Array.isArray(entry.seeds)) missingSeeds += 1;
      entries.push({ ...entry, seeds });
    }
    return { path, entries, error: null, exists: true, missingSeeds };
  } catch (error) {
    return { path, entries: [], error: `journal 解析失败：${error instanceof Error ? error.message : String(error)}`, exists: true, missingSeeds: 0 };
  }
}

/** 读意图表（`{version, records}`；坏文件不抛，返回 error）。 */
export function readIntentFile(path) {
  if (!existsSync(path)) return { path, records: [], error: null, exists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
      return { path, records: [], error: "intent 文件缺少 records 数组", exists: true };
    }
    return { path, records: parsed.records, error: null, exists: true };
  } catch (error) {
    return { path, records: [], error: `intent 解析失败：${error instanceof Error ? error.message : String(error)}`, exists: true };
  }
}

/** 读已消费游标（只读；用于 journal exact 组的 consumed 标注与 pending 计数）。 */
export function readConsumed(path) {
  if (!existsSync(path)) return { path, lastConsumedAt: null, error: null, exists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const value = Number(parsed?.lastConsumedAt);
    return { path, lastConsumedAt: Number.isFinite(value) ? value : null, error: null, exists: true };
  } catch (error) {
    return { path, lastConsumedAt: null, error: `consumed 解析失败：${error instanceof Error ? error.message : String(error)}`, exists: true };
  }
}

/** 读 `.git/HEAD` 得 repoHead（纯读文件；失败为 null）。 */
export function readRepoHead(root = ROOT) {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(root, ".git", head.slice(5));
      const sha = readFileSync(refPath, "utf8").trim();
      return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
    }
    return /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 引用扫描
// ---------------------------------------------------------------------------

/** 把一个引用串解析成候选 id 列表（兼容 `replay:<id>` 前缀与裸 id）。 */
export function refCandidates(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return [];
  const out = new Set([text]);
  if (text.includes(":")) {
    const tail = text.slice(text.lastIndexOf(":") + 1);
    if (tail !== "") out.add(tail);
  }
  return [...out];
}

/**
 * 所有会引用记忆 id 的位置：journal.seeds / intent.source_ids（+未来 threads 字段）/
 * 其它记忆的 source_chain、derivation_chain。threads 当前不落盘，但字段出现时不放过。
 */
export function collectReferences({ records, journal, intent }) {
  const refs = [];
  for (const entry of journal.entries) {
    const location = `journal:${String(entry.id ?? "?")}`;
    for (const seed of entry.seeds) {
      refs.push({ where: "journal.seeds", location, rawId: String(seed), ids: refCandidates(seed) });
    }
  }
  for (const record of intent.records ?? []) {
    const location = `intent:${String(record?.id ?? "?")}`;
    const sourceIds = Array.isArray(record?.source_ids) ? record.source_ids : [];
    for (const rawId of sourceIds) {
      refs.push({ where: "intent.source_ids", location, rawId: String(rawId), ids: refCandidates(rawId) });
    }
    const threads = Array.isArray(record?.threads) ? record.threads : [];
    for (const thread of threads) {
      if (thread === null || typeof thread !== "object") continue;
      for (const field of ["memoryIds", "sourceIds", "seedIds"]) {
        const values = Array.isArray(thread[field]) ? thread[field] : [];
        for (const rawId of values) {
          refs.push({ where: `intent.threads.${field}`, location, rawId: String(rawId), ids: refCandidates(rawId) });
        }
      }
    }
  }
  for (const record of records) {
    for (const field of ["source_chain", "derivation_chain"]) {
      const values = Array.isArray(record?.[field]) ? record[field] : [];
      for (const rawId of values) {
        refs.push({ where: `memory.${field}`, location: `memory:${String(record.id)}`, rawId: String(rawId), ids: refCandidates(rawId) });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// --list：事实清单 + 候选分组（不做判定）
// ---------------------------------------------------------------------------

function metadataIssuesOf(record) {
  const issues = [];
  if (typeof record.id !== "string" || record.id === "") issues.push("missing-id");
  if (typeof record.source !== "string" || record.source === "") issues.push("missing-source");
  if (typeof record.content !== "string" || record.content.trim() === "") issues.push("empty-content");
  if (!Number.isFinite(Number(record.created_at))) issues.push("bad-created-at");
  if (!Array.isArray(record.tags)) issues.push("bad-tags");
  const vividness = Number(record.vividness);
  if (!Number.isFinite(vividness) || vividness < 0 || vividness > 1) issues.push("bad-vividness");
  return issues;
}

/** 归一化内容完全相同的内存组（exact 候选）。 */
function exactGroupsOf(records) {
  const byNormalized = new Map();
  for (const record of records) {
    const key = normalizeContent(record.content);
    if (key === "") continue;
    const list = byNormalized.get(key) ?? [];
    list.push(record);
    byNormalized.set(key, list);
  }
  return [...byNormalized.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key: key.slice(0, 40), ids: list.map((record) => record.id), sources: [...new Set(list.map((record) => String(record.source ?? "")))] }));
}

/** 同 source 的 Dice 近重复对（selftalk 内标 merge-suggestion；其余 report-only）。 */
function nearPairsOf(records) {
  const pairs = [];
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const left = records[i];
      const right = records[j];
      if (String(left.source ?? "") !== String(right.source ?? "")) continue;
      const similarity = diceSimilarity(left.content, right.content);
      if (similarity < NEAR_SIMILARITY_FLOOR || similarity >= 1) continue;
      const bothSelftalk = String(left.source) === "selftalk" && String(right.source) === "selftalk";
      pairs.push({ a: left.id, b: right.id, source: String(left.source ?? ""), similarity: Number(similarity.toFixed(4)), strategy: bothSelftalk ? "selftalk-near" : "report-only" });
    }
  }
  return pairs.sort((left, right) => right.similarity - left.similarity);
}

/** journal 内归一化完全相同的组（含跨 cursor；设计 §3.4.1 的 A1 对象；A0 只列事实）。 */
function journalExactGroupsOf(journal, cursor) {
  const byNormalized = new Map();
  for (const entry of journal.entries) {
    const key = normalizeContent(entry.text ?? entry.content ?? "");
    if (key === "") continue;
    const list = byNormalized.get(key) ?? [];
    list.push(entry);
    byNormalized.set(key, list);
  }
  return [...byNormalized.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const entries = list.map((entry) => ({ id: String(entry.id ?? "?"), at: Number(entry.at), consumed: cursor !== null && Number(entry.at) < cursor }));
      return {
        key: normalizeContent(list[0].text ?? list[0].content ?? "").slice(0, 40),
        entries,
        consumedCount: entries.filter((entry) => entry.consumed).length,
        pendingCount: entries.filter((entry) => !entry.consumed).length,
      };
    });
}

export function analyzeList({ records, journal, intent, consumed, corrupt = 0, tombstones = 0, lines = 0 }) {
  const cursor = consumed?.lastConsumedAt ?? null;
  const refs = collectReferences({ records, journal, intent });
  const journalRefCounts = new Map();
  const intentRefCounts = new Map();
  for (const ref of refs) {
    if (ref.where === "journal.seeds") {
      for (const id of ref.ids) journalRefCounts.set(id, (journalRefCounts.get(id) ?? 0) + 1);
    } else if (ref.where === "intent.source_ids") {
      for (const id of ref.ids) intentRefCounts.set(id, (intentRefCounts.get(id) ?? 0) + 1);
    }
  }

  const exactGroups = exactGroupsOf(records);
  const nearPairs = nearPairsOf(records);
  const exactMemberIds = new Set(exactGroups.flatMap((group) => group.ids));
  const byCreatedAt = (left, right) => Number(left.created_at) - Number(right.created_at) || String(left.id).localeCompare(String(right.id));
  const deleteCandidates = [];
  for (const group of exactGroups) {
    const members = records.filter((record) => {
      const source = String(record.source ?? "");
      return exactMemberIds.has(record.id) && group.ids.includes(record.id) && ["selftalk", "proactive"].includes(source);
    });
    if (members.length < 2) continue;
    const ordered = [...members].sort(byCreatedAt);
    const keepSuggestion = ordered[0].id;
    for (const record of ordered.slice(1)) {
      deleteCandidates.push({
        id: record.id,
        source: String(record.source ?? ""),
        reason: "exact-duplicate-of-internal-source",
        groupKey: group.key,
        members: group.ids,
        keepSuggestion,
        note: "整组成员（含建议保留者）见 members；本项只标可被合并的重复成员",
      });
    }
  }

  const fixMetadata = records.map((record) => ({ id: record.id, issues: metadataIssuesOf(record) })).filter((item) => item.issues.length > 0);

  const listedRecords = records.map((record) => ({
    id: record.id,
    source: String(record.source ?? ""),
    created_at: Number(record.created_at),
    vividness: Number(record.vividness),
    access_count: Number(record.access_count),
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    contentPreview: String(record.content ?? "").replace(/\s+/g, " ").slice(0, 60),
    refs: { journalEntries: journalRefCounts.get(record.id) ?? 0, intentRecords: intentRefCounts.get(record.id) ?? 0 },
    metadataIssues: metadataIssuesOf(record),
  }));

  const sources = {};
  for (const record of records) {
    const source = String(record.source ?? "");
    sources[source] = (sources[source] ?? 0) + 1;
  }

  const pendingJournal = cursor === null ? journal.entries.length : journal.entries.filter((entry) => Number(entry.at) > cursor).length;
  const journalExactGroups = journalExactGroupsOf(journal, cursor);

  return {
    tool: TOOL_KIND,
    mode: TOOL_MODE,
    counts: {
      memoryLines: lines,
      memoryUnique: records.length,
      corrupt,
      tombstones,
      journalEntries: journal.entries.length,
      journalMissingSeeds: journal.missingSeeds ?? 0,
      intentRecords: intent.records.length,
      pendingJournal,
      bySource: sources,
    },
    records: listedRecords,
    candidates: {
      exactGroups,
      nearPairs,
      fixMetadata,
      deleteCandidates,
      journalExactGroups,
      stats: {
        exactGroups: exactGroups.length,
        nearPairs: nearPairs.length,
        mergeSuggestions: nearPairs.filter((pair) => pair.strategy === "selftalk-near" && pair.similarity < NEAR_SIMILARITY_CEIL).length,
        fixMetadata: fixMetadata.length,
        deleteCandidates: deleteCandidates.length,
        journalExactGroups: journalExactGroups.length,
      },
    },
    journalError: journal.error,
    intentError: intent.error,
    consumedError: consumed?.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// 计划生成（--plan / --dry-run）：从候选生成 ops，再做引用完整性校验
// ---------------------------------------------------------------------------

function byCreatedAtAsc(left, right) {
  return Number(left.created_at) - Number(right.created_at) || String(left.id).localeCompare(String(right.id));
}

/** 并查集，把 exact 组与 selftalk 近重复对合成互斥的合并分量。 */
function mergeComponents(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const parent = new Map(records.map((record) => [record.id, record.id]));
  const find = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const group of exactGroupsOf(records)) {
    const members = group.ids.filter((id) => byId.has(id) && String(byId.get(id).source) === "selftalk");
    for (const id of members.slice(1)) union(members[0], id);
  }
  for (const pair of nearPairsOf(records)) {
    if (pair.strategy !== "selftalk-near" || pair.similarity >= NEAR_SIMILARITY_CEIL) continue;
    if (byId.has(pair.a) && byId.has(pair.b)) union(pair.a, pair.b);
  }

  const components = new Map();
  for (const record of records) {
    const root = find(record.id);
    const list = components.get(root) ?? [];
    list.push(record);
    components.set(root, list);
  }
  return [...components.values()].filter((list) => list.length > 1);
}

/** 生成 ops：只动 selftalk（exact / 0.65–0.80）；proactive 与玩家原话只报告，不进 ops。 */
export function generateOps(records) {
  const ops = [];
  for (const component of mergeComponents(records)) {
    const ordered = [...component].sort(byCreatedAtAsc);
    const keep = ordered[0].id;
    const drop = ordered.slice(1).map((record) => record.id);
    const normalized = new Set(component.map((record) => normalizeContent(record.content)));
    const reason = normalized.size === 1 ? "exact" : "dice";
    let dice = null;
    if (reason === "dice") {
      for (let i = 0; i < component.length; i += 1) {
        for (let j = i + 1; j < component.length; j += 1) {
          const value = diceSimilarity(component[i].content, component[j].content);
          dice = dice === null ? value : Math.max(dice, value);
        }
      }
    }
    ops.push({ kind: "merge", drop, keep, reason, ...(dice === null ? {} : { dice: Number(dice.toFixed(4)) }) });
  }
  return ops;
}

/** 实现 `--plan`：先由数据生成 ops，再走统一校验。 */
export function generatePlan({ records, journal, intent, consumed, paths, nowMs = null, repoHead = null, memoryLines = records.length }) {
  const ops = generateOps(records);
  const cursor = consumed?.lastConsumedAt ?? null;
  const pendingJournal = cursor === null ? journal.entries.length : journal.entries.filter((entry) => Number(entry.at) > cursor).length;
  const plan = {
    generatedAt: Number.isFinite(nowMs) ? Number(nowMs) : null,
    repoHead,
    dataSnapshot: {
      memoryLines: Number.isFinite(memoryLines) ? memoryLines : records.length,
      memoryUnique: records.length,
      journalEntries: journal.entries.length,
      pendingJournal,
    },
    ops,
    references: [],
    refusals: [],
    applyAllowed: false,
    rollback: buildRollback(paths),
  };
  return evaluatePlan({ records, journal, intent, plan, paths });
}

/**
 * 统一校验（B2）：
 * - keep 不得在 removed；映射目标不得在 removed；拒绝链式合并（keep 本身是别的 merge 的 drop）；
 * - 拒绝重复移除、同一 id 既 keep 又 drop/delete、未知 id；
 * - 引用点命中 removed：有映射 → mapped；无映射 → DANGLING_REFERENCE refusal；
 * - 任何 refusal ⇒ applyAllowed=false（整批拒绝）。
 */
export function evaluatePlan({ records, journal, intent, plan, paths }) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) throw new RangeError("plan 必须是对象");
  const ops = Array.isArray(plan.ops) ? plan.ops : [];
  const errors = [];
  const refusals = [];
  const mappings = new Map();
  const removed = new Set();
  const dropSet = new Set();
  const keeps = new Set();

  const addRefusal = (code, id, at) => {
    refusals.push({ code, id: String(id), at: String(at) });
  };

  for (const [index, op] of ops.entries()) {
    if (op === null || typeof op !== "object") {
      errors.push(`ops[${index}] 不是对象`);
      continue;
    }
    const at = `plan.ops[${index}]`;
    if (op.kind === "merge") {
      const keep = op.keep;
      const drops = Array.isArray(op.drop) ? op.drop : [];
      if (typeof keep !== "string" || keep === "") {
        errors.push(`${at}.keep 缺失`);
        continue;
      }
      if (op.reason !== undefined && !["exact", "dice"].includes(op.reason)) addRefusal("BAD_REASON", keep, at);
      const keepRecord = records.find((record) => record.id === keep);
      if (keepRecord === undefined) addRefusal("UNKNOWN_ID", keep, at);
      else if (String(keepRecord.source ?? "") !== "selftalk") addRefusal("NON_SELFTALK_MERGE", keep, at);
      for (const dropId of drops) {
        if (typeof dropId !== "string" || dropId === "") {
          errors.push(`${at}.drop 含非法 id`);
          continue;
        }
        if (records.find((record) => record.id === dropId) === undefined) {
          addRefusal("UNKNOWN_ID", dropId, `${at}.drop`);
          continue;
        }
        if (dropSet.has(dropId) || removed.has(dropId)) {
          addRefusal("DUPLICATE_REMOVAL", dropId, `${at}.drop`);
          continue;
        }
        dropSet.add(dropId);
        removed.add(dropId);
        mappings.set(dropId, keep);
      }
      keeps.add(keep);
      continue;
    }
    if (op.kind === "delete") {
      const drops = Array.isArray(op.drop) ? op.drop : [];
      for (const dropId of drops) {
        if (typeof dropId !== "string" || dropId === "") {
          errors.push(`${at}.drop 含非法 id`);
          continue;
        }
        if (records.find((record) => record.id === dropId) === undefined) {
          addRefusal("UNKNOWN_ID", dropId, `${at}.drop`);
          continue;
        }
        if (removed.has(dropId)) {
          addRefusal("DUPLICATE_REMOVAL", dropId, `${at}.drop`);
          continue;
        }
        removed.add(dropId);
      }
      continue;
    }
    if (op.kind === "fixMetadata") {
      if (typeof op.id !== "string" || op.id === "") errors.push(`${at}.id 缺失`);
      else if (records.find((record) => record.id === op.id) === undefined) addRefusal("UNKNOWN_ID", op.id, at);
      continue;
    }
    errors.push(`ops[${index}].kind 非法：${String(op.kind)}`);
  }

  // 收齐后的全局校验：保留者与映射目标必须最终存活；不得链式映射。
  for (const keep of keeps) {
    if (removed.has(keep)) addRefusal(dropSet.has(keep) ? "CHAINED_MERGE" : "KEEP_REMOVED", keep, "plan.keep");
  }
  for (const [from, to] of mappings) {
    if (removed.has(to)) addRefusal("KEEP_REMOVED", to, `mapping:${from}`);
  }

  const references = [];
  for (const ref of collectReferences({ records, journal, intent })) {
    const hit = ref.ids.find((id) => removed.has(id));
    if (hit === undefined) continue;
    const to = mappings.get(hit);
    if (to !== undefined && !removed.has(to)) {
      references.push({ from: ref.location, field: ref.where, old: hit, new: to, status: "mapped" });
      continue;
    }
    references.push({ from: ref.location, field: ref.where, old: hit, new: null, status: "refuse" });
    addRefusal("DANGLING_REFERENCE", hit, `${ref.where}:${ref.location}`);
  }

  const applyAllowed = errors.length === 0 && refusals.length === 0;
  return {
    generatedAt: plan.generatedAt ?? null,
    repoHead: plan.repoHead ?? null,
    dataSnapshot: plan.dataSnapshot ?? null,
    ops,
    references,
    refusals,
    applyAllowed,
    rollback: plan.rollback ?? buildRollback(paths),
    errors,
  };
}

/** A1 执行器的回退清单；A0 只打印、不执行。 */
export function buildRollback(paths) {
  const files = ROLLBACK_FILE_KINDS.map((kind) => {
    if (kind === "memory") return `memory-${paths.character}.ndjson`;
    if (kind === "journal") return `selftalk-${paths.character}.json`;
    if (kind === "consumed") return `selftalk-consumed-${paths.character}.json`;
    return `state-${paths.character}.json`;
  });
  const backupDir = join(paths.dataDir, ".bak-hygiene-<ms>");
  const commands = [
    "npm run stop",
    ...files.map((name) => `copy /Y "${join(backupDir, name)}" "${join(paths.dataDir, name)}"`),
    "npm run start",
  ];
  return { backupDir, files, commands };
}

// ---------------------------------------------------------------------------
// 输出（文本）
// ---------------------------------------------------------------------------

export function formatList(result) {
  const lines = [];
  lines.push(`# 记忆事实清单（${TOOL_MODE}）`);
  lines.push(`- 记忆：${result.counts.memoryUnique} 条唯一（行 ${result.counts.memoryLines}，坏行 ${result.counts.corrupt}，其它 op ${result.counts.tombstones}）`);
  lines.push(`- journal：${result.counts.journalEntries} 条（缺 seeds ${result.counts.journalMissingSeeds} 条已保留并计数）；intent：${result.counts.intentRecords} 条；pending journal：${result.counts.pendingJournal}`);
  const bySource = Object.entries(result.counts.bySource ?? {}).map(([source, count]) => `${source || "(空)"} ${count}`).join(" / ");
  if (bySource !== "") lines.push(`- 来源：${bySource}`);
  if (result.journalError) lines.push(`- [警告] ${result.journalError}`);
  if (result.intentError) lines.push(`- [警告] ${result.intentError}`);
  if (result.consumedError) lines.push(`- [警告] ${result.consumedError}`);
  lines.push("");
  lines.push("| id | source | created_at | vivid | access | journal | intent | 摘要 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const record of result.records) {
    lines.push(`| ${record.id} | ${record.source} | ${record.created_at} | ${record.vividness.toFixed(2)} | ${record.access_count} | ${record.refs.journalEntries} | ${record.refs.intentRecords} | ${record.contentPreview.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## 候选分组（只列事实，不执行）");
  const stats = result.candidates.stats;
  lines.push(`- exact 组：${stats.exactGroups}；近重复对：${stats.nearPairs}（其中 selftalk 合并建议 ${stats.mergeSuggestions}）；metadata 异常：${stats.fixMetadata}；内部来源重复成员：${stats.deleteCandidates}；journal exact 组：${stats.journalExactGroups}`);
  for (const group of result.candidates.exactGroups) lines.push(`  - memory exact：${group.ids.join(" = ")}（${group.sources.join("/")}）`);
  for (const pair of result.candidates.nearPairs.slice(0, 20)) lines.push(`  - near ${pair.similarity}：${pair.a} ≈ ${pair.b}（${pair.source}，${pair.strategy}）`);
  if (result.candidates.nearPairs.length > 20) lines.push(`  …还有 ${result.candidates.nearPairs.length - 20} 对`);
  for (const item of result.candidates.fixMetadata) lines.push(`  - metadata：${item.id}（${item.issues.join(", ")}）`);
  for (const group of result.candidates.journalExactGroups) {
    lines.push(`  - journal exact（${group.consumedCount} consumed / ${group.pendingCount} pending）：${group.entries.map((entry) => entry.id).join(" = ")}`);
  }
  for (const item of result.candidates.deleteCandidates.slice(0, 10)) {
    lines.push(`  - 重复成员：${item.id}（组 ${item.members.join("=")}，建议保留 ${item.keepSuggestion}；${item.note}）`);
  }
  return lines.join("\n");
}

export function formatPlan(result) {
  const lines = [];
  lines.push(`# 记忆卫生计划（${TOOL_MODE}，只算不写）`);
  lines.push(`- generatedAt：${result.generatedAt ?? "null"}；repoHead：${result.repoHead ?? "null"}`);
  if (result.dataSnapshot) lines.push(`- 数据快照：memory ${result.dataSnapshot.memoryUnique} 唯一 / ${result.dataSnapshot.memoryLines} 行；journal ${result.dataSnapshot.journalEntries} 条（pending ${result.dataSnapshot.pendingJournal}）`);
  if (result.errors.length > 0) lines.push(`- 结构错误：${result.errors.join("；")}`);
  lines.push(`- ops：${result.ops.length} 组${result.ops.length === 0 ? "（无可自动处理项）" : ""}`);
  for (const op of result.ops) {
    if (op.kind === "merge") lines.push(`  - merge：${(op.drop ?? []).join(",")} → ${op.keep}（${op.reason}${op.dice === undefined ? "" : ` / dice ${op.dice}`}）`);
    else if (op.kind === "delete") lines.push(`  - delete：${(op.drop ?? []).join(",")}`);
    else lines.push(`  - ${op.kind}：${op.id}`);
  }
  if (result.references.length > 0) {
    lines.push(`- 引用映射：${result.references.length} 处（mapped ${result.references.filter((ref) => ref.status === "mapped").length} / refuse ${result.references.filter((ref) => ref.status === "refuse").length}）`);
    for (const ref of result.references.slice(0, 30)) lines.push(`  - ${ref.status}：${ref.from} ${ref.field} ${ref.old}${ref.status === "mapped" ? ` → ${ref.new}` : ""}`);
    if (result.references.length > 30) lines.push(`  …还有 ${result.references.length - 30} 处`);
  } else {
    lines.push("- 引用映射：无（没有引用点命中被移除 id）");
  }
  if (result.refusals.length > 0) {
    lines.push(`- **refusals（${result.refusals.length}）——整批拒绝，A1 不得继续**：`);
    for (const refusal of result.refusals.slice(0, 30)) lines.push(`  - ${refusal.code}：${refusal.id} @ ${refusal.at}`);
    if (result.refusals.length > 30) lines.push(`  …还有 ${result.refusals.length - 30} 条`);
  }
  lines.push(`- applyAllowed：${result.applyAllowed}`);
  if (result.rollback) {
    lines.push(`- 将被改动的文件（--dry-run 打印；A0 不执行）：${result.rollback.files.join(" / ")}`);
    lines.push(`- 回退：备份到 ${result.rollback.backupDir}`);
    for (const command of result.rollback.commands.slice(0, 2)) lines.push(`  - ${command}`);
  }
  lines.push("- （A0 只读：本工具只可能在 --out 下写 .tmp 计划文件；--apply 一律拒绝）");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ==== A1 BLOCK START ====
// ---------------------------------------------------------------------------
// A1 执行器（设计 v2.2 §3.3/§3.4.1/§3.5）：--apply --confirm
// ---------------------------------------------------------------------------

export const APPLY_MODE = "A1-apply";
export const APPLY_TOOL_KIND = TOOL_KIND;
/** daemon 三处心跳（pid/beat/lock）任一在这个窗口内就拒绝执行（设计 §3.5）。 */
export const HEARTBEAT_FRESH_MS = 60_000;
/** 备份目录前缀（与 purge/merge 先例一致，源文件同目录）。 */
export const BACKUP_DIR_PREFIX = ".bak-hygiene-";
/** 原子写 rename 重试次数（设计 §3.5：最多 3 次、小退避）。 */
export const ATOMIC_WRITE_ATTEMPTS = 3;
/** A1 只允许 merge；删除属 A2。 */
const A1_ALLOWED_OPS = new Set(["merge"]);

const DEFAULT_DEPS = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text) => writeFileSync(path, text, "utf8"),
  copyFile: (source, target) => copyFileSync(source, target),
  rename: (source, target) => renameSync(source, target),
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  stat: (path) => statSync(path),
  sha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
};

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 原子写：tmp + rename；EPERM/EBUSY/EACCES 时最多重试 3 次（设计 §3.5）。 */
export function writeFileAtomicRetry(path, text, deps = DEFAULT_DEPS) {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  deps.writeFile(tmpPath, text);
  let lastError = null;
  for (let attempt = 1; attempt <= ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
    try {
      deps.rename(tmpPath, path);
      return { path, attempts: attempt };
    } catch (error) {
      lastError = error;
      const code = error?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      sleepSync(attempt * 10);
    }
  }
  try {
    deps.remove(tmpPath);
  } catch {
    // tmp 清理失败不覆盖主错误
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 读 daemon 三处信号文件（不存在 → exists=false）。 */
export function readDaemonSignals(paths) {
  const definitions = [
    { kind: "pid", path: join(paths.dataDir, `autonomy-${paths.character}.pid`) },
    { kind: "beat", path: join(paths.dataDir, `autonomy-${paths.character}.beat`) },
    { kind: "lock", path: join(paths.dataDir, ".writer-lock") },
  ];
  return definitions.map(({ kind, path }) => {
    if (!existsSync(path)) return { kind, path, exists: false, mtimeMs: null };
    return { kind, path, exists: true, mtimeMs: statSync(path).mtimeMs };
  });
}

/**
 * 解析 pid 文件（B1）：真实 daemon 写 JSON `{pid,startedAt,characterId}`
 * （src/assembly/lifecycle.ts），旧格式是裸数字。两者都兼容；其余一律 fail-closed。
 */
export function parsePidFile(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { pid: null, error: "pid 文件为空" };
  if (text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { pid: null, error: `pid JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const pid = parsed?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return { pid, error: null };
    return { pid: null, error: `pid 字段非法：${JSON.stringify(pid)}` };
  }
  const pid = Number(text);
  if (Number.isInteger(pid) && pid > 0) return { pid, error: null };
  return { pid: null, error: `pid 不是正整数：${text}` };
}

/**
 * 判断 pid 存活（fail-closed）：
 * - 文件读不到 / 解析失败 / pid 非正整数 → "unknown"（无法证明已停，按未停处理）；
 * - kill(pid,0) 成功 → "alive"；ESRCH → "dead"；
 * - EPERM/EACCES 等其它错误 → "alive"（进程存在但无权限探测）；
 * - 其它异常 → "unknown"。
 */
export function pidLiveness(pidPath) {
  let raw;
  try {
    raw = readFileSync(pidPath, "utf8");
  } catch (error) {
    return { status: "unknown", pid: null, error: `读 pid 文件失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parsePidFile(raw);
  if (parsed.error !== null) return { status: "unknown", pid: null, error: parsed.error };
  try {
    process.kill(parsed.pid, 0);
    return { status: "alive", pid: parsed.pid, error: null };
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "dead", pid: parsed.pid, error: null };
    return { status: "unknown", pid: parsed.pid, error: `探测 pid ${parsed.pid} 失败：${error?.code ?? (error instanceof Error ? error.message : String(error))}` };
  }
}

/**
 * 预检：daemon 是否已停（fail-closed，B1/B2）。
 * - pid 文件：JSON/裸数字解析；活/无法证明 → 未停；只有 ESRCH 才算已停；
 * - beat/lock：mtime 在 HEARTBEAT_FRESH_MS 内 → 未停；
 * - 传入的 nowMs 只用于 fallback 计算，执行期由调用方传真实 Date.now()。
 */
export function checkDaemonStopped(paths, nowMs) {
  const details = readDaemonSignals(paths).map((signal) => {
    if (!signal.exists) return { ...signal, ageMs: null, alive: null, pidStatus: null, error: null, fresh: false };
    const ageMs = Number(nowMs) - signal.mtimeMs;
    if (signal.kind === "pid") {
      const liveness = pidLiveness(signal.path);
      const fresh = liveness.status !== "dead";
      return {
        ...signal,
        ageMs,
        alive: liveness.status === "alive" ? true : liveness.status === "dead" ? false : null,
        pidStatus: liveness.status,
        error: liveness.error,
        fresh,
      };
    }
    const fresh = ageMs <= HEARTBEAT_FRESH_MS;
    return { ...signal, ageMs, alive: null, pidStatus: null, error: null, fresh };
  });
  const blockers = details.filter((signal) => signal.fresh);
  return { stopped: blockers.length === 0, details, blockers };
}

/** 引用串映射：裸 id 或 `prefix:id`（如 replay:<id>）都映射到 kept id。 */
export function mapRefString(raw, mapping) {
  const text = String(raw ?? "");
  if (mapping.has(text)) return mapping.get(text);
  const index = text.lastIndexOf(":");
  if (index >= 0) {
    const tail = text.slice(index + 1);
    if (mapping.has(tail)) return `${text.slice(0, index + 1)}${mapping.get(tail)}`;
  }
  return text;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function maxNumber(values, fallback = 0) {
  let out = fallback;
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > out) out = number;
  }
  return out;
}

/**
 * memory 合并（设计 §3.3）：
 * - 保留最早 id；正文取最新版本；created_at 取最早；vividness 取 max；access_count 相加；
 *   last_accessed 取 max；tags 并集；source_chain 并集去重；unresolved_score 取 max。
 * - 所有记录的 source_chain / derivation_chain 做 old→new 映射。
 * 返回 {records, mapping, removed, mergedGroups}。
 */
export function buildMergedMemory({ records, ops }) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const mergedByKeep = new Map();
  const removed = new Set();
  const mapping = new Map();
  let mergedGroups = 0;

  for (const op of ops) {
    if (op === null || typeof op !== "object" || op.kind !== "merge") {
      throw new RangeError("A1 只允许 kind=merge 的 op（删除属 A2）");
    }
    const keepId = op.keep;
    const drops = Array.isArray(op.drop) ? op.drop : [];
    if (typeof keepId !== "string" || keepId === "" || drops.length === 0) continue;
    if (!byId.has(keepId)) throw new RangeError(`merge keep 不存在：${keepId}`);
    const members = [keepId, ...drops].map((id) => byId.get(id)).filter((record) => record !== undefined);
    if (members.length < 2) continue;
    const keepRecord = byId.get(keepId);
    const latest = [...members].sort(
      (left, right) => Number(right.created_at) - Number(left.created_at) || String(right.id).localeCompare(String(left.id)),
    )[0];
    const tags = [];
    for (const member of members) for (const tag of member.tags ?? []) pushUnique(tags, String(tag));
    const sourceChain = [];
    for (const member of members) for (const item of member.source_chain ?? []) pushUnique(sourceChain, String(item));
    const merged = {
      ...keepRecord,
      content: latest.content,
      created_at: Math.min(...members.map((member) => Number(member.created_at))),
      last_accessed: maxNumber(members.map((member) => member.last_accessed), 0),
      access_count: members.reduce((sum, member) => sum + (Number(member.access_count) || 0), 0),
      vividness: maxNumber(members.map((member) => member.vividness), 0),
      unresolved_score: maxNumber(members.map((member) => member.unresolved_score), 0),
      tags,
      source_chain: sourceChain,
    };
    mergedByKeep.set(keepId, merged);
    for (const id of drops) {
      removed.add(id);
      mapping.set(id, keepId);
    }
    mergedGroups += 1;
  }

  const finalRecords = [];
  for (const record of records) {
    if (removed.has(record.id)) continue;
    const base = { ...(mergedByKeep.get(record.id) ?? record) };
    if (Array.isArray(base.source_chain)) base.source_chain = base.source_chain.map((item) => mapRefString(item, mapping));
    if (Array.isArray(base.derivation_chain)) base.derivation_chain = base.derivation_chain.map((item) => mapRefString(item, mapping));
    finalRecords.push(base);
  }
  return { records: finalRecords, mapping, removed, mergedGroups };
}

/**
 * journal 合并（设计 §3.4/§3.4.1）：
 * - 先对所有 entry 的 seeds 做 old→new 映射（不删 seed、不丢 entry）；
 * - 归一化正文完全相同的组：保留较早 at；跨 cursor 组正文以保留条目为准、consumed 继承；
 *   非跨 cursor 组正文取最新；spoken 取 OR；seeds 并集去重；
 * - 不推 cursor（调用方不动 consumed 文件）。
 */
export function mergeJournal({ entries, lastConsumedAt, mapping }) {
  const cursor = lastConsumedAt ?? null;
  const remapped = entries.map((entry) => ({
    ...entry,
    seeds: (Array.isArray(entry.seeds) ? entry.seeds : []).map((seed) => mapRefString(seed, mapping)),
  }));

  const groups = new Map();
  for (const entry of remapped) {
    const key = normalizeContent(entry.text ?? entry.content ?? "");
    if (key === "") continue;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  const removeIds = new Set();
  const replacements = new Map();
  let mergedGroups = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    mergedGroups += 1;
    const ordered = [...list].sort((left, right) => Number(left.at) - Number(right.at) || String(left.id).localeCompare(String(right.id)));
    const keep = ordered[0];
    const rest = ordered.slice(1);
    const crossCursor = cursor !== null && ordered.some((entry) => Number(entry.at) < cursor) && ordered.some((entry) => Number(entry.at) > cursor);
    const latest = [...ordered].sort((left, right) => Number(right.at) - Number(left.at) || String(right.id).localeCompare(String(left.id)))[0];
    const seeds = [];
    for (const entry of ordered) for (const seed of entry.seeds ?? []) pushUnique(seeds, String(seed));
    const spoken = ordered.some((entry) => entry.spoken === true);
    const merged = {
      ...keep,
      at: Number(keep.at),
      text: crossCursor ? keep.text : (latest.text ?? keep.text),
      seeds,
      spoken,
      ...(crossCursor ? { crossCursor: true, consumedInherited: true } : {}),
    };
    replacements.set(keep.id, merged);
    for (const entry of rest) removeIds.add(entry.id);
  }

  const finalEntries = remapped.filter((entry) => !removeIds.has(entry.id)).map((entry) => replacements.get(entry.id) ?? entry);
  return { entries: finalEntries, mergedGroups, removedEntries: removeIds.size };
}

/** intent 引用映射：source_ids（+threads 未来字段）。返回新对象（保序、保留其它字段）。 */
export function applyReferencesToIntent(intentRaw, mapping) {
  const next = { ...intentRaw };
  next.records = (Array.isArray(intentRaw.records) ? intentRaw.records : []).map((record) => {
    if (record === null || typeof record !== "object") return record;
    const out = { ...record };
    if (Array.isArray(record.source_ids)) out.source_ids = record.source_ids.map((id) => mapRefString(id, mapping));
    if (Array.isArray(record.threads)) {
      out.threads = record.threads.map((thread) => {
        if (thread === null || typeof thread !== "object") return thread;
        const nextThread = { ...thread };
        for (const field of ["memoryIds", "sourceIds", "seedIds"]) {
          if (Array.isArray(thread[field])) nextThread[field] = thread[field].map((id) => mapRefString(id, mapping));
        }
        return nextThread;
      });
    }
    return out;
  });
  return next;
}

export function serializeMemory(records) {
  return `${records.map((record) => JSON.stringify({ op: "put", rec: record })).join("\n")}\n`;
}

function fileKindsForBackup() {
  return ["memory", "journal", "consumed", "state"];
}

function pathForKind(paths, kind) {
  switch (kind) {
    case "memory": return paths.memoryPath;
    case "journal": return paths.journalPath;
    case "intent": return paths.intentPath;
    case "consumed": return paths.consumedPath;
    case "state": return paths.statePath;
    default: throw new RangeError(`未知备份类型：${kind}`);
  }
}

function backupFileName(paths, kind) {
  switch (kind) {
    case "memory": return `memory-${paths.character}.ndjson`;
    case "journal": return `selftalk-${paths.character}.json`;
    case "intent": return `intent-${paths.character}.json`;
    case "consumed": return `selftalk-consumed-${paths.character}.json`;
    case "state": return `state-${paths.character}.json`;
    default: throw new RangeError(`未知备份类型：${kind}`);
  }
}

/** 备份到 data/.bak-hygiene-<ms>/，写 manifest.json（sha256/字节数/plan 摘要）。 */
export function createBackup({ paths, nowMs, plan, kinds, deps = DEFAULT_DEPS, tool = TOOL_KIND, mode = APPLY_MODE, planSummary }) {
  const backupDir = join(paths.dataDir, `${BACKUP_DIR_PREFIX}${nowMs}`);
  deps.mkdir(backupDir);
  const manifest = {
    tool,
    mode,
    createdAt: Number(nowMs),
    repoHead: plan.repoHead ?? null,
    plan: planSummary ?? {
      ops: plan.ops ?? [],
      references: plan.references ?? [],
      refusals: plan.refusals ?? [],
      applyAllowed: plan.applyAllowed === true,
    },
    files: {},
    missing: [],
  };
  for (const kind of kinds) {
    const sourcePath = pathForKind(paths, kind);
    if (!existsSync(sourcePath)) {
      manifest.missing.push(backupFileName(paths, kind));
      continue;
    }
    const targetName = backupFileName(paths, kind);
    deps.copyFile(sourcePath, join(backupDir, targetName));
    manifest.files[targetName] = {
      kind,
      sha256: deps.sha256(sourcePath),
      bytes: deps.stat(sourcePath).size,
    };
  }
  deps.writeFile(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupDir, manifest };
}

function rollbackFromBackup({ backupDir, backupNames, paths, deps = DEFAULT_DEPS }) {
  const restored = [];
  for (const [kind, name] of Object.entries(backupNames)) {
    const source = join(backupDir, name);
    if (!existsSync(source)) continue;
    const target = pathForKind(paths, kind);
    deps.copyFile(source, target);
    restored.push(name);
  }
  return restored;
}

/**
 * 执行 A1（调用方已在 stop 窗口内）：
 * - 预检：confirm、refusals=0/applyAllowed、只 merge、磁盘快照与 plan 一致、daemon 三处心跳旧；
 * - 备份 → memory/journal[/intent] 原子重写 → 成功 summary；任一步失败回滚并 exit 4。
 * 返回 { exitCode, message, summary? }；不 process.exit（CLI 负责）。
 */
export function executeApply({ paths, plan, nowMs = Date.now(), confirm = false, deps = DEFAULT_DEPS }) {
  const d = { ...DEFAULT_DEPS, ...(deps ?? {}) };
  if (confirm !== true) {
    return { exitCode: 2, message: "A1 需要 --confirm：--apply 会真实改写 data/ 下的记忆与 journal，请确认 daemon 已停（npm run stop）后重试。" };
  }
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.ops)) {
    return { exitCode: 3, message: "拒绝执行：plan 结构非法。" };
  }
  if ((plan.errors ?? []).length > 0) {
    return { exitCode: 3, message: `拒绝执行：plan 结构错误 ${(plan.errors ?? []).length} 条。` };
  }
  if ((plan.refusals ?? []).length > 0 || plan.applyAllowed !== true) {
    return { exitCode: 3, message: `拒绝执行：refusals=${(plan.refusals ?? []).length} 或 applyAllowed=${String(plan.applyAllowed)}（须 0 / true）。` };
  }
  const badOp = (plan.ops ?? []).find((op) => !A1_ALLOWED_OPS.has(op?.kind));
  if (badOp !== undefined) {
    return { exitCode: 3, message: `拒绝执行：A1 只允许 merge，发现 ${String(badOp?.kind)}（删除/元数据修补属其它批次）。` };
  }

  if (!existsSync(paths.memoryPath)) return { exitCode: 3, message: `拒绝执行：找不到记忆库 ${paths.memoryPath}` };
  const store = readMemoryStore(readFileSync(paths.memoryPath, "utf8"));
  if (store.corrupt > 0) {
    return { exitCode: 3, message: `拒绝执行：记忆 WAL 有 ${store.corrupt} 行无法解析（corrupt），拒绝整批以免静默丢行。` };
  }

  const journal = readJournal(paths.journalPath);
  if (!journal.exists) {
    return { exitCode: 3, message: `拒绝执行：journal 文件不存在（${paths.journalPath}），无法证明它是空文件。` };
  }
  if (journal.error !== null) {
    return { exitCode: 3, message: `拒绝执行：journal 解析失败——${journal.error}；拒绝整批以免把它重写为空。` };
  }

  let intentRaw;
  if (existsSync(paths.intentPath)) {
    try {
      intentRaw = JSON.parse(readFileSync(paths.intentPath, "utf8"));
    } catch (error) {
      return { exitCode: 3, message: `拒绝执行：intent 文件解析失败——${error instanceof Error ? error.message : String(error)}` };
    }
    if (intentRaw === null || typeof intentRaw !== "object" || !Array.isArray(intentRaw.records)) {
      return { exitCode: 3, message: "拒绝执行：intent 文件缺少 records 数组。" };
    }
  } else {
    intentRaw = { version: 1, records: [] };
  }

  const consumed = readConsumed(paths.consumedPath);
  if (consumed.error !== null) {
    return { exitCode: 3, message: `拒绝执行：consumed 文件解析失败——${consumed.error}` };
  }

  const expected = plan.dataSnapshot ?? {};
  if (Number(expected.memoryLines) !== store.lines || Number(expected.memoryUnique) !== store.records.length || Number(expected.journalEntries) !== journal.entries.length) {
    return {
      exitCode: 3,
      message: `拒绝执行：磁盘快照与 plan 不一致（plan memoryLines=${expected.memoryLines}/unique=${expected.memoryUnique}/journal=${expected.journalEntries}；磁盘 ${store.lines}/${store.records.length}/${journal.entries.length}）。请重新跑 --plan。`,
    };
  }

  const freshPlan = generatePlan({
    records: store.records,
    journal,
    intent: intentRaw,
    consumed,
    paths,
    nowMs,
    repoHead: readRepoHead(),
    memoryLines: store.lines,
  });
  if (JSON.stringify(freshPlan.ops) !== JSON.stringify(plan.ops)) {
    return { exitCode: 3, message: "拒绝执行：plan 与当前数据重算结果不一致（数据或工具版本已变），请重新跑 --plan。" };
  }

  // B2：daemon 心跳判断只用真实时钟；--now-ms 只用于只读计划与备份命名。
  const daemon = checkDaemonStopped(paths, Date.now());
  if (!daemon.stopped) {
    const names = daemon.blockers.map((signal) => `${signal.kind}(${signal.ageMs === null ? "?" : `${signal.ageMs}ms`})`).join(", ");
    return { exitCode: 3, message: `拒绝执行：daemon 心跳仍新鲜 [${names}]（阈值 ${HEARTBEAT_FRESH_MS}ms）。请先 npm run stop 并等进程退出。`, daemon };
  }

  const memory = buildMergedMemory({ records: store.records, ops: plan.ops });
  const journalMerged = mergeJournal({ entries: journal.entries, lastConsumedAt: consumed.lastConsumedAt, mapping: memory.mapping });
  const intentMerged = applyReferencesToIntent(intentRaw, memory.mapping);
  const intentChanged = JSON.stringify(intentMerged.records) !== JSON.stringify(intentRaw.records);

  const pendingBefore = consumed.lastConsumedAt === null ? journal.entries.length : journal.entries.filter((entry) => Number(entry.at) > consumed.lastConsumedAt).length;
  const pendingAfter = consumed.lastConsumedAt === null ? journalMerged.entries.length : journalMerged.entries.filter((entry) => Number(entry.at) > consumed.lastConsumedAt).length;

  const kinds = [...fileKindsForBackup(), ...(intentChanged ? ["intent"] : [])];
  let backup;
  try {
    backup = createBackup({ paths, nowMs, plan, kinds, deps: d });
  } catch (error) {
    return { exitCode: 4, message: `备份失败，未改任何数据：${error instanceof Error ? error.message : String(error)}` };
  }

  const writes = [
    { path: paths.memoryPath, text: serializeMemory(memory.records) },
    { path: paths.journalPath, text: JSON.stringify(journalMerged.entries) },
    ...(intentChanged ? [{ path: paths.intentPath, text: `${JSON.stringify(intentMerged, null, 2)}\n` }] : []),
  ];

  try {
    for (const write of writes) writeFileAtomicRetry(write.path, write.text, d);
  } catch (error) {
    const backupNames = Object.fromEntries(Object.entries(backup.manifest.files).map(([name, info]) => [info.kind, name]));
    let restored = [];
    try {
      restored = rollbackFromBackup({ backupDir: backup.backupDir, backupNames, paths, deps: d });
    } catch (rollbackError) {
      return {
        exitCode: 4,
        message: `写盘失败且回滚也失败：${error instanceof Error ? error.message : String(error)}；回滚错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}。备份仍在 ${backup.backupDir}`,
      };
    }
    return {
      exitCode: 4,
      message: `写盘失败，已回滚 ${restored.length} 个文件：${error instanceof Error ? error.message : String(error)}（备份 ${backup.backupDir}）`,
      summary: { rolledBack: true, restored, backupDir: backup.backupDir },
    };
  }

  const summary = {
    recordsBefore: store.records.length,
    recordsAfter: memory.records.length,
    mergedMemoryGroups: memory.mergedGroups,
    journalEntriesBefore: journal.entries.length,
    journalEntriesAfter: journalMerged.entries.length,
    mergedJournalGroups: journalMerged.mergedGroups,
    pendingJournalBefore: pendingBefore,
    pendingJournalAfter: pendingAfter,
    referencesMapped: (plan.references ?? []).filter((reference) => reference.status === "mapped").length,
    droppedIds: [...memory.removed],
    mapping: Object.fromEntries(memory.mapping),
    intentChanged,
    backupDir: backup.backupDir,
    backupFiles: Object.keys(backup.manifest.files),
    manifestMissing: backup.manifest.missing,
  };
  return { exitCode: 0, message: formatApplySummary(summary), summary };
}

export function formatApplySummary(summary) {
  const lines = [];
  lines.push(`[hygiene] A1 完成：memory ${summary.recordsBefore}→${summary.recordsAfter}（合并 ${summary.mergedMemoryGroups} 组）`);
  lines.push(`[hygiene] journal ${summary.journalEntriesBefore}→${summary.journalEntriesAfter}（exact 合并 ${summary.mergedJournalGroups} 组，pending ${summary.pendingJournalBefore}→${summary.pendingJournalAfter}）`);
  lines.push(`[hygiene] 引用映射 ${summary.referencesMapped} 处；intent 文件${summary.intentChanged ? "已" : "未"}改动；cursor 未推进`);
  lines.push(`[hygiene] 备份：${summary.backupDir}（${summary.backupFiles.join(" / ")}）`);
  if (summary.manifestMissing?.length > 0) lines.push(`[hygiene] 备份跳过（源文件不存在）：${summary.manifestMissing.join(" / ")}`);
  lines.push("[hygiene] 验证：memory 重写为 put-only（无 del/墓碑）；journal 保留条目仍 consumed；下次 03:00 消费不再选中被并条。");
  return lines.join("\n");
}
// ==== A1 BLOCK END ====

function argValue(args, name) {
  const inline = args.find((item) => item.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith("--")) return args[index + 1];
  return undefined;
}

function usage() {
  return [
    "用法：node tools/maintenance/edit-memory.mjs [--list | --plan | --dry-run | --apply --confirm] [--json] [--out=<path>] [--data-dir=<dir>] [--character=<id>]",
    "",
    "  --list             列出去重后的记忆、引用计数与候选分组（默认动作）",
    "  --plan             从数据生成清理/合并计划（不写）",
    "  --dry-run          同 --plan，并打印将被改动的文件与引用映射",
    "  --out=<path>       仅与 --plan/--dry-run 同用，把计划 JSON 写到 .tmp/ 下",
    "  --apply            A1 执行器：真实改写 data/ memory+journal（必须与 --confirm 同用）",
    "  --confirm          确认 daemon 已停（npm run stop）；缺少它时 --apply exit 2",
    "  --json             JSON 输出",
    "  --data-dir=<dir>   数据目录（默认仓库 data/）",
    "  --character=<id>   角色 id（默认 assistant）",
    "  --now-ms=<ms>      只读模式（--list/--plan/--dry-run）使用；--apply 不接受（执行期心跳用真实时钟）",
    "",
    "退出码：0 成功；1 plan 有 refusal（A0）；2 用法/--confirm 缺失；3 A1 预检拒绝；4 A1 执行失败已回滚",
  ].join("\n");
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function isUnderTmp(target) {
  const tmpRoot = resolve(ROOT, ".tmp");
  return target === tmpRoot || target.startsWith(`${tmpRoot}\\`) || target.startsWith(`${tmpRoot}/`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  if (args.some((item) => item.startsWith("--apply="))) {
    fail("不支持 --apply=...；A1 只接受裸 --apply 并必须同时给 --confirm。", 2);
  }
  const applyMode = args.includes("--apply");
  if (args.includes("--confirm") && !applyMode) fail("--confirm 只能与 --apply 同用。", 2);
  if (args.some((item) => item.startsWith("--plan="))) fail("--plan 不接受外部计划文件：计划由模板从数据生成（设计 §3.1）。", 2);

  const dataDir = resolve(argValue(args, "data-dir") ?? join(ROOT, "data"));
  const character = argValue(args, "character") ?? "assistant";
  const paths = {
    dataDir,
    character,
    memoryPath: join(dataDir, `memory-${character}.ndjson`),
    journalPath: join(dataDir, `selftalk-${character}.json`),
    intentPath: join(dataDir, `intent-${character}.json`),
    consumedPath: join(dataDir, `selftalk-consumed-${character}.json`),
    statePath: join(dataDir, `state-${character}.json`),
  };
  const asJson = args.includes("--json");
  const planMode = args.includes("--plan") || args.includes("--dry-run");
  const outArg = argValue(args, "out");
  if (outArg !== undefined && !planMode) fail("--out 只能与 --plan/--dry-run 同用。", 2);
  if (outArg !== undefined) {
    const outPath = resolve(outArg);
    if (!isUnderTmp(outPath)) fail(`--out 只允许写到 <repo>/.tmp/ 下：${outPath}`, 2);
  }
  const nowArg = argValue(args, "now-ms");
  const nowMsArg = nowArg === undefined ? null : Number(nowArg);
  if (nowArg !== undefined && !Number.isFinite(nowMsArg)) fail("--now-ms 必须是有限数字。", 2);
  if (applyMode && nowArg !== undefined) {
    fail("--apply 不接受 --now-ms：执行期心跳必须用真实时钟（--now-ms 仅供 --list/--plan）。", 2);
  }
  if (!existsSync(paths.memoryPath)) fail(`找不到记忆库：${paths.memoryPath}`, 2);

  const store = readMemoryStore(readFileSync(paths.memoryPath, "utf8"));
  const journal = readJournal(paths.journalPath);
  const intent = readIntentFile(paths.intentPath);
  const consumed = readConsumed(paths.consumedPath);

  if (applyMode) {
    if (args.includes("--list") || args.includes("--plan") || args.includes("--dry-run")) {
      fail("--apply 不能与 --list/--plan/--dry-run 同时使用（A1 预检）。", 3);
    }
    if (!args.includes("--confirm")) {
      fail("A1 需要 --confirm：--apply 会真实改写 data/ 下的记忆与 journal；请确认 daemon 已停（npm run stop）后重跑。", 2);
    }
    const nowMs = Date.now(); // B2：--apply 不接受 --now-ms，执行期一律真实时钟
    const plan = generatePlan({ records: store.records, journal, intent, consumed, paths, nowMs, repoHead: readRepoHead(), memoryLines: store.lines });
    const result = executeApply({ paths, plan, nowMs, confirm: true });
    if (asJson) {
      console.log(JSON.stringify({ tool: TOOL_KIND, mode: APPLY_MODE, planVersion: PLAN_VERSION, ...result }, null, 2));
    } else if (result.exitCode === 0) {
      console.log(result.message);
    }
    if (result.exitCode !== 0) {
      console.error(result.message);
      process.exit(result.exitCode);
    }
    return;
  }

  if (!planMode) {
    const result = analyzeList({ records: store.records, journal, intent, consumed, corrupt: store.corrupt, tombstones: store.tombstones, lines: store.lines });
    console.log(asJson ? JSON.stringify(result, null, 2) : formatList(result));
    return;
  }

  const plan = generatePlan({ records: store.records, journal, intent, consumed, paths, nowMs: nowMsArg, repoHead: readRepoHead(), memoryLines: store.lines });
  const json = JSON.stringify({ tool: TOOL_KIND, mode: TOOL_MODE, planVersion: PLAN_VERSION, ...plan }, null, 2);
  if (outArg !== undefined) {
    const outPath = resolve(outArg);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify({ tool: TOOL_KIND, mode: TOOL_MODE, planVersion: PLAN_VERSION, ...plan }, null, 2)}
`, "utf8");
    console.log(asJson ? json : `${formatPlan(plan)}

已写入计划：${outPath}`);
  } else {
    console.log(asJson ? json : formatPlan(plan));
  }
  if (plan.errors.length > 0) process.exit(2);
  if (!plan.applyAllowed) process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
