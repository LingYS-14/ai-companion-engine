#!/usr/bin/env node
/**
 * 测试矩阵台账检查器（M11-01，SPEC v5.2 §11）。
 *
 * 这里检查的是**矩阵台账本身**，不是"断言跑了没有"。原因：§11 的 78 条编号断言里，
 * 有一批（T7 离线扭曲、P1 虚假记忆、P3 自信-准确解耦、A14 CoT 时序…）需要标注集或
 * 可重放黄金轨迹才谈得上"跑"，仓库现在没有。**把没做的写成 missing 是诚实，
 * 把没做的删掉是自欺**——所以这份台账强制覆盖全部 78 个编号，状态只许三档。
 *
 * 三道闸：
 *   1. 结构闸：id 必须是规格里真实存在的编号、不重复、分组计数与 §11 一致、状态合法。
 *   2. 证据闸：`covered` 必须给证据且证据路径真实存在；`missing` 必须写清楚为什么缺。
 *   3. 棘轮闸：与 `test-matrix-baseline.json` 比，**covered 只许增、missing 只许减**。
 *      防的是"某个 PR 删掉一条 covered 假装没覆盖过"。
 *
 * 退出码：0 通过（missing 不判失败，它只是事实）；1 有结构/证据/棘轮问题；2 参数错。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

export const MATRIX_PATH = "spec/config/test-matrix.json";
export const BASELINE_PATH = "spec/config/test-matrix-baseline.json";

/** §11 的编号清单（写死，作为"台账不许漏条目"的基准）。 */
export const SPEC_IDS = {
  T: Array.from({ length: 8 }, (_, i) => `T${i + 1}`),
  P: Array.from({ length: 12 }, (_, i) => `P${i + 1}`),
  L: Array.from({ length: 10 }, (_, i) => `L${i + 1}`),
  O: Array.from({ length: 5 }, (_, i) => `O${i + 1}`),
  A: Array.from({ length: 26 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`),
  B: ["B1-1", "B1-2", "B1-4a", "B1-4b", "B1-4c", "B1-6", "B1-7", "B1-8", "B2-1", "B2-2", "B2-3", "B2-4", "B3-A", "B3-B", "B3-C", "B3-D", "B3-E"],
};

export const STATUSES = ["covered", "partial", "missing"];
const MIN_NOTE_CHARS = 8;
const ID_PATTERNS = {
  T: /^T[1-8]$/,
  P: /^P(?:[1-9]|1[0-2])$/,
  L: /^L(?:[1-9]|10)$/,
  O: /^O[1-5]$/,
  A: /^A(?:0[1-9]|1[0-9]|2[0-6])$/,
  B: /^B(?:1-[124678]|1-4[abc]|2-[1-4]|3-[A-E])$/,
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadMatrix(root = DEFAULT_ROOT) {
  const path = join(root, MATRIX_PATH);
  if (!existsSync(path)) return { ok: false, error: { code: "matrix-missing", message: `找不到台账：${path}` } };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: { code: "matrix-unreadable", message: String(err) } };
  }
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: { code: "matrix-bad-json", message: `${path} 不是合法 JSON：${String(err)}` } };
  }
  return { ok: true, ledger };
}

export function loadBaseline(root = DEFAULT_ROOT) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return { ok: false, error: { code: "baseline-missing", message: `找不到基线：${path}（可先跑 --init-baseline）` } };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.counts)) {
      return { ok: false, error: { code: "baseline-bad-json", message: `${path} 结构不对（需要 {counts:{covered,partial,missing}}）` } };
    }
    return { ok: true, baseline: parsed };
  } catch (err) {
    return { ok: false, error: { code: "baseline-bad-json", message: `${path} 不是合法 JSON：${String(err)}` } };
  }
}

function evidenceExists(root, evidence) {
  if (!nonEmptyString(evidence)) return false;
  // 证据允许是文件（test/…、tools/…）或目录；都按仓库相对路径解析
  return existsSync(join(root, evidence.replace(/^[./\\]+/, "").replace(/\\/g, "/")));
}

export function validateMatrix(ledger, root = DEFAULT_ROOT) {
  const errors = [];
  const warn = [];

  if (!isRecord(ledger)) return { ok: false, errors: [{ code: "matrix-shape", message: "台账必须是对象" }], stats: null };
  if (ledger.version !== 1) errors.push({ code: "matrix-shape", message: `version 必须是 1（实际 ${String(ledger.version)}）` });
  if (!Array.isArray(ledger.entries)) {
    return { ok: false, errors: [{ code: "matrix-shape", message: "entries 必须是数组" }], stats: null };
  }
  if (ledger.groups !== undefined) {
    if (!isRecord(ledger.groups)) errors.push({ code: "matrix-shape", message: "groups 必须是对象" });
  }

  const seen = new Map();
  for (const entry of ledger.entries) {
    if (!isRecord(entry)) {
      errors.push({ code: "matrix-shape", message: "entries 里每一项都必须是对象" });
      continue;
    }
    const id = entry.id;
    if (!nonEmptyString(id)) {
      errors.push({ code: "bad-id", message: `条目缺少 id：${JSON.stringify(entry).slice(0, 80)}` });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: "duplicate-id", message: `id 重复：${id}` });
      continue;
    }
    seen.set(id, entry);

    const group = String(id).charAt(0);
    if (ID_PATTERNS[group] === undefined || !ID_PATTERNS[group].test(id)) {
      errors.push({ code: "bad-id", message: `id 不在规格 §11 的编号里：${id}` });
      continue;
    }
    if (entry.group !== group) {
      errors.push({ code: "bad-group", message: `${id} 的 group 应为 ${group}（实际 ${String(entry.group)}）` });
    }
    if (!nonEmptyString(entry.title)) errors.push({ code: "missing-title", message: `${id} 缺少 title（规格原文的短名）` });
    if (!STATUSES.includes(entry.status)) {
      errors.push({ code: "bad-status", message: `${id} 的 status 必须是 ${STATUSES.join("/")}（实际 ${String(entry.status)}）` });
      continue;
    }
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (!Array.isArray(entry.evidence)) errors.push({ code: "matrix-shape", message: `${id} 的 evidence 必须是数组` });
    if (entry.status === "covered" && evidence.length === 0) {
      errors.push({ code: "missing-evidence", message: `${id} 标了 covered 却没给证据` });
    }
    if ((entry.status === "covered" || entry.status === "partial") && evidence.length > 0) {
      for (const ev of evidence) {
        if (!evidenceExists(root, ev)) {
          errors.push({ code: "missing-path", message: `${id} 的证据路径不存在：${String(ev)}` });
        }
      }
    }
    if (entry.status === "missing") {
      if (!nonEmptyString(entry.note) || String(entry.note).trim().length < MIN_NOTE_CHARS) {
        errors.push({ code: "missing-note", message: `${id} 标了 missing，必须写清缺什么（≥${MIN_NOTE_CHARS} 字）` });
      }
      if (evidence.length > 0) {
        warn.push({ code: "missing-has-evidence", message: `${id} 标了 missing 却给了证据，两项自相矛盾` });
      }
    }
  }

  // 编号完整性：规格里每一个编号都必须出现在台账里
  const expected = Object.values(SPEC_IDS).flat();
  for (const id of expected) {
    if (!seen.has(id)) errors.push({ code: "missing-id", message: `台账缺少规格编号：${id}` });
  }
  const unknown = [...seen.keys()].filter((id) => !expected.includes(id));
  for (const id of unknown) {
    if (ID_PATTERNS[String(id).charAt(0)]?.test(id) !== true) {
      errors.push({ code: "unexpected-id", message: `台账里有规格外的编号：${id}` });
    }
  }

  // 分组计数必须与 §11 一致
  const actual = { T: 0, P: 0, L: 0, O: 0, A: 0, B: 0 };
  for (const entry of ledger.entries) {
    const g = String(entry?.id ?? "").charAt(0);
    if (actual[g] !== undefined) actual[g] += 1;
  }
  for (const [group, ids] of Object.entries(SPEC_IDS)) {
    if (actual[group] !== ids.length) {
      errors.push({ code: "group-count-mismatch", message: `${group} 组应有 ${ids.length} 条（实际 ${actual[group]}）` });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warn,
    stats: summarize(ledger),
  };
}

export function summarize(ledger) {
  const counts = { covered: 0, partial: 0, missing: 0 };
  const byGroup = { T: 0, P: 0, L: 0, O: 0, A: 0, B: 0 };
  const gaps = [];
  for (const entry of ledger.entries ?? []) {
    if (counts[entry.status] !== undefined) counts[entry.status] += 1;
    const g = String(entry.id).charAt(0);
    if (byGroup[g] !== undefined) byGroup[g] += 1;
    if (entry.status === "missing") gaps.push(entry.id);
  }
  return { total: (ledger.entries ?? []).length, counts, byGroup, gaps };
}

/** 棘轮：covered 只许增、missing 只许减（partial 不计，因为它不是承诺）。 */
export function checkBaseline(stats, baseline) {
  const errors = [];
  const base = baseline?.counts ?? {};
  const covered = Number(base.covered ?? 0);
  const missing = Number(base.missing ?? 0);
  if (stats.counts.covered < covered) {
    errors.push({
      code: "coverage-regress",
      message: `covered 从基线 ${covered} 掉到 ${stats.counts.covered}（删掉覆盖声明也算回归）`,
    });
  }
  if (stats.counts.missing > missing) {
    errors.push({
      code: "coverage-regress",
      message: `missing 从基线 ${missing} 涨到 ${stats.counts.missing}（新增未覆盖项必须先在台账里说明，并用 --update-baseline 显式接受）`,
    });
  }
  return { ok: errors.length === 0, errors };
}

export function formatReport(stats) {
  const lines = [];
  lines.push(`测试矩阵：${stats.total} 条编号断言（T${stats.byGroup.T}/P${stats.byGroup.P}/L${stats.byGroup.L}/O${stats.byGroup.O}/A${stats.byGroup.A}/B${stats.byGroup.B}）`);
  lines.push(`  状态：covered ${stats.counts.covered} / partial ${stats.counts.partial} / missing ${stats.counts.missing}`);
  if (stats.gaps.length > 0) lines.push(`  未覆盖：${stats.gaps.join("·")}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { json: false, list: false, gaps: false, initBaseline: false, updateBaseline: false, root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--gaps") opts.gaps = true;
    else if (arg === "--init-baseline") opts.initBaseline = true;
    else if (arg === "--update-baseline") opts.updateBaseline = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root 需要一个目录");
      opts.root = resolve(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

function writeBaseline(root, stats) {
  const path = join(root, BASELINE_PATH);
  const payload = { version: 1, counts: { covered: stats.counts.covered, partial: stats.counts.partial, missing: stats.counts.missing } };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(`用法：node tools/lint/test-matrix.mjs [--json] [--list] [--gaps] [--root <dir>] [--init-baseline|--update-baseline]`);
    return;
  }

  const loaded = loadMatrix(opts.root);
  if (!loaded.ok) {
    console.error(`✗ [${loaded.error.code}] ${loaded.error.message}`);
    process.exit(1);
  }
  const checked = validateMatrix(loaded.ledger, opts.root);
  const stats = checked.stats ?? summarize(loaded.ledger);

  if (opts.initBaseline || opts.updateBaseline) {
    const path = writeBaseline(opts.root, stats);
    console.log(`✓ 已写入基线：${path}（covered ${stats.counts.covered} / partial ${stats.counts.partial} / missing ${stats.counts.missing}）`);
    return;
  }

  const errors = [...checked.errors];
  const baseline = loadBaseline(opts.root);
  if (baseline.ok) {
    const ratchet = checkBaseline(stats, baseline.baseline);
    errors.push(...ratchet.errors);
  } else if (opts.root === DEFAULT_ROOT) {
    errors.push(baseline.error);
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, stats, errors, warn: checked.warn }, null, 2));
  } else if (opts.list) {
    for (const entry of loaded.ledger.entries) {
      const ev = entry.evidence.length > 0 ? entry.evidence.join(", ") : "-";
      console.log(`${entry.status.padEnd(8)} ${entry.id.padEnd(6)} ${entry.title}${entry.evidence.length > 0 ? `　[${ev}]` : ""}`);
    }
  } else if (opts.gaps) {
    for (const id of stats.gaps) {
      const entry = loaded.ledger.entries.find((e) => e.id === id);
      console.log(`missing ${id} ${entry?.title ?? ""}：${entry?.note ?? ""}`);
    }
  } else if (errors.length === 0) {
    console.log(`✓ ${formatReport(stats)}`);
    for (const w of checked.warn) console.log(`⚠ ${w.message}`);
  } else {
    for (const e of errors) console.error(`✗ [${e.code}] ${e.message}`);
    console.error(`\n${formatReport(stats)}`);
  }

  process.exit(errors.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
