#!/usr/bin/env node
/**
 * tools/lint/superseded.mjs — 「谁取代了谁」台账校验（v5.2 §12.2 P-A / 审计 M12-04）
 *
 * 为什么要有这个文件（F161）：
 *   审计发现 11–12 处规格条目已经被后面的版本取代，但仓库里没有任何**机器可读**的记录说明
 *   「谁取代了谁」。结果是每次审计都要重新推一遍，而且代码与规格对不上时无法判断是 bug
 *   还是有意为之。本文件把那份台账变成 `spec/config/superseded.json`，并在这里校验它：
 *
 *     ✓ id 唯一、格式正确，kind/status 在枚举里，reason 不是一句话敷衍
 *     ✓ 每个 supersededBy 引用都能解析：
 *         knob:NAME   → NAME 必须真的在 spec/config/engine.json 或 v54.overlay.json 里
 *         doc:/test:/code:PATH → 文件必须真的存在（不许指空气）
 *         ledger:ID   → 必须指向另一条真实条目
 *     ✓ 链必须能终止：不许自指、不许成环、不许停在一条 status=removed 的条目上
 *       （指向「已经没了的旧东西」等于没说明现在变成了什么）
 *     ✓ 每条 evidence 的 path:line 必须真的存在，行号不能超出文件行数
 *
 * 用法：
 *   node tools/lint/superseded.mjs               # 校验，exit 0/1
 *   node tools/lint/superseded.mjs --json        # 机器可读
 *   node tools/lint/superseded.mjs --list        # 人工看一眼台账
 *   node tools/lint/superseded.mjs --root <dir>  # 指定仓库根（默认当前目录）
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 用法/IO 错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const LEDGER_PATH = "spec/config/superseded.json";
export const ENGINE_PATH = "spec/config/engine.json";
export const OVERLAY_PATH = "spec/config/v54.overlay.json";

export const KINDS = ["knob", "spec-section", "assertion", "concept", "schema", "module"];
export const STATUSES = ["removed", "dormant", "renamed", "layer-moved", "retyped", "replaced", "deferred"];
export const REF_PREFIXES = ["knob", "doc", "test", "code", "ledger"];
/** 链最多翻这么深；超过就当写错了（正常情况 1–2 跳） */
export const MAX_CHAIN_DEPTH = 8;
export const MIN_REASON_CHARS = 10;

// id 允许大写：旋钮类的 id 直接沿用注册表名（如 DECAY_RATE），便于 grep
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_PATTERN = /^(knob|doc|test|code|ledger):(\S+)$/;
const EVIDENCE_PATTERN = /^(\S+?)(?::(\d+))?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 注册表里有名字的旋钮集合（engine 93 + overlay 35，允许重叠） */
export function registryKeys(root) {
  const keys = new Set();
  for (const rel of [ENGINE_PATH, OVERLAY_PATH]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const doc = readJson(abs);
    const knobs = doc?.knobs;
    if (knobs && typeof knobs === "object") {
      for (const name of Object.keys(knobs)) keys.add(name);
    }
    // overlay 也允许把旋钮直接放在顶层（历史形态）
    for (const [name, value] of Object.entries(doc ?? {})) {
      if (value && typeof value === "object" && ("kind" in value || "value" in value)) keys.add(name);
    }
  }
  return keys;
}

export function loadLedger(root) {
  const abs = join(root, LEDGER_PATH);
  if (!existsSync(abs)) {
    return { error: { code: "ledger-missing", detail: `${LEDGER_PATH} 不存在` } };
  }
  try {
    return { ledger: readJson(abs) };
  } catch (err) {
    return { error: { code: "ledger-bad-json", detail: String(err?.message ?? err) } };
  }
}

function countLines(abs) {
  try {
    const text = readFileSync(abs, "utf8");
    if (text.length === 0) return 0;
    return text.split("\n").length;
  } catch {
    return null; // 读不出来就不查行号上限（存在性已经查过）
  }
}

/** 引用解析：返回 {ok:true} 或 {ok:false, code, detail} */
function resolveRef(ref, ctx) {
  const m = REF_PATTERN.exec(ref);
  if (m === null) {
    return { ok: false, code: "bad-ref-format", detail: `引用格式不对（要 knob:/doc:/test:/code:/ledger:）：${ref}` };
  }
  const [, prefix, target] = m;
  if (prefix === "knob") {
    if (!ctx.registry.has(target)) {
      return { ok: false, code: "unknown-knob", detail: `knob:${target} 不在注册表（engine.json / v54.overlay.json）里` };
    }
    return { ok: true };
  }
  if (prefix === "ledger") {
    if (!ctx.byId.has(target)) {
      return { ok: false, code: "dangling-ledger", detail: `ledger:${target} 指向的条目不存在` };
    }
    return { ok: true };
  }
  // doc / test / code：都是「这个文件必须存在」
  if (isAbsolute(target) || target.includes("..")) {
    return { ok: false, code: "bad-ref-path", detail: `引用必须是仓库内相对路径且不许有 ..：${target}` };
  }
  if (!existsSync(join(ctx.root, target))) {
    return { ok: false, code: "missing-path", detail: `${prefix}:${target} 指向的文件不存在` };
  }
  return { ok: true };
}

/** 跟着 ledger 链走到终点；返回错误列表（空=好） */
function checkChain(entry, ctx) {
  const errors = [];
  const seen = new Set([entry.id]);
  let current = entry;
  let depth = 0;
  for (;;) {
    const ledgerRefs = (current.supersededBy ?? []).filter((r) => r.startsWith("ledger:"));
    if (ledgerRefs.length === 0) return errors;
    depth += 1;
    if (depth > MAX_CHAIN_DEPTH) {
      errors.push({ code: "chain-too-deep", id: entry.id, detail: `链超过 ${MAX_CHAIN_DEPTH} 跳（在 ${current.id} 处）` });
      return errors;
    }
    const nextId = ledgerRefs[0].slice("ledger:".length);
    if (seen.has(nextId)) {
      errors.push({ code: "cycle", id: entry.id, detail: `supersededBy 链成环：${[...seen].join(" → ")} → ${nextId}` });
      return errors;
    }
    const next = ctx.byId.get(nextId);
    if (next === undefined) {
      errors.push({ code: "dangling-ledger", id: entry.id, detail: `ledger:${nextId} 指向的条目不存在` });
      return errors;
    }
    if (next.status === "removed") {
      errors.push({
        code: "chain-hits-removed",
        id: entry.id,
        detail: `链停在 status=removed 的 ${nextId} 上——那等于没说现在变成了什么`,
      });
      return errors;
    }
    seen.add(nextId);
    current = next;
  }
}

export function validateLedger(ledger, opts) {
  const root = opts?.root ?? process.cwd();
  const errors = [];
  const warnings = [];
  const ctx = { root, registry: registryKeys(root), byId: new Map() };

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return { errors: [{ code: "ledger-shape", detail: "台账顶层必须是对象" }], warnings, stats: null };
  }
  if (ledger.version !== 1) {
    errors.push({ code: "ledger-shape", detail: `version 必须是 1（现在是 ${JSON.stringify(ledger.version)}）` });
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    errors.push({ code: "ledger-shape", detail: "entries 必须是非空数组" });
    return { errors, warnings, stats: null };
  }

  const ids = new Set();
  for (const entry of ledger.entries) {
    const label = typeof entry?.id === "string" ? entry.id : "(无 id)";
    if (typeof entry?.id !== "string" || !ID_PATTERN.test(entry.id)) {
      errors.push({ code: "bad-id", id: label, detail: `id 必须匹配 ${ID_PATTERN}` });
      continue;
    }
    if (ids.has(entry.id)) {
      errors.push({ code: "duplicate-id", id: entry.id, detail: "id 重复" });
      continue;
    }
    ids.add(entry.id);
    ctx.byId.set(entry.id, entry);
  }

  for (const entry of ledger.entries) {
    if (typeof entry?.id !== "string" || !ctx.byId.has(entry.id)) continue;
    if (!KINDS.includes(entry.kind)) {
      errors.push({ code: "bad-kind", id: entry.id, detail: `kind 必须是 ${KINDS.join(" / ")}之一（现在是 ${JSON.stringify(entry.kind)}）` });
    }
    if (!STATUSES.includes(entry.status)) {
      errors.push({ code: "bad-status", id: entry.id, detail: `status 必须是 ${STATUSES.join(" / ")}之一（现在是 ${JSON.stringify(entry.status)}）` });
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON_CHARS) {
      errors.push({ code: "short-reason", id: entry.id, detail: `reason 要写清楚为什么被取代（至少 ${MIN_REASON_CHARS} 字）` });
    }
    if (typeof entry.since !== "string" || entry.since.trim() === "") {
      errors.push({ code: "missing-since", id: entry.id, detail: "since 不能为空（哪一版/哪条 F 记录取代的）" });
    }
    if (!Array.isArray(entry.supersededBy) || entry.supersededBy.length === 0) {
      errors.push({ code: "empty-superseded-by", id: entry.id, detail: "supersededBy 必须指向至少一个现在的东西" });
    } else {
      for (const ref of entry.supersededBy) {
        if (typeof ref !== "string") {
          errors.push({ code: "bad-ref-format", id: entry.id, detail: `supersededBy 里有非字符串：${JSON.stringify(ref)}` });
          continue;
        }
        if (ref === `ledger:${entry.id}`) {
          errors.push({ code: "self-reference", id: entry.id, detail: "supersededBy 不能指向自己" });
          continue;
        }
        const resolved = resolveRef(ref, ctx);
        if (!resolved.ok) {
          errors.push({ code: resolved.code, id: entry.id, detail: resolved.detail });
        }
      }
      errors.push(...checkChain(entry, ctx));
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      errors.push({ code: "missing-evidence", id: entry.id, detail: "evidence 必须给出至少一处 path:line" });
    } else {
      for (const ev of entry.evidence) {
        const text = String(ev);
        const m = EVIDENCE_PATTERN.exec(text);
        const rel = m?.[1] ?? text;
        const line = m?.[2] === undefined ? null : Number(m[2]);
        if (rel === "" || isAbsolute(rel) || rel.includes("..")) {
          errors.push({ code: "bad-evidence-format", id: entry.id, detail: `evidence 必须是仓库内相对路径：${text}` });
          continue;
        }
        const abs = join(root, rel);
        if (!existsSync(abs)) {
          errors.push({ code: "missing-evidence", id: entry.id, detail: `evidence 指向的文件不存在：${rel}` });
          continue;
        }
        if (line !== null) {
          const total = countLines(abs);
          if (total !== null && line > total) {
            errors.push({ code: "bad-evidence-line", id: entry.id, detail: `${rel} 只有 ${total} 行，指不到第 ${line} 行` });
          }
        }
      }
    }
  }

  const byStatus = {};
  const byKind = {};
  for (const entry of ctx.byId.values()) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }
  return {
    errors,
    warnings,
    stats: { entries: ctx.byId.size, byStatus, byKind, registryKnobs: ctx.registry.size },
  };
}

export function formatReport(result) {
  if (result.errors.length > 0) {
    const lines = [`✗ superseded 台账：${result.errors.length} 个问题`];
    for (const err of result.errors) lines.push(`  - [${err.code}] ${err.id ?? ""} ${err.detail}`);
    return lines.join("\n");
  }
  const { stats } = result;
  const kindText = Object.entries(stats.byKind).map(([k, n]) => `${k} ${n}`).join(" / ");
  const statusText = Object.entries(stats.byStatus).map(([k, n]) => `${k} ${n}`).join(" / ");
  return `✓ superseded 台账：${stats.entries} 条被取代关系（${kindText}），状态 ${statusText}，引用全部可解析`;
}

export function listLedger(ledger) {
  const lines = ["被取代条目" + " ".repeat(2) + "→ 现在"];
  for (const entry of ledger.entries ?? []) {
    lines.push(`  ${entry.id} [${entry.kind}/${entry.status}] → ${(entry.supersededBy ?? []).join(", ")}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const rootArg = args.indexOf("--root");
  const root = rootArg >= 0 && args[rootArg + 1] !== undefined ? args[rootArg + 1] : process.cwd();
  const json = args.includes("--json");
  const list = args.includes("--list");

  const loaded = loadLedger(root);
  if (loaded.error) {
    if (json) console.log(JSON.stringify({ ok: false, errors: [loaded.error] }, null, 2));
    else console.error(`✗ [${loaded.error.code}] ${loaded.error.detail}`);
    return 2;
  }
  const result = validateLedger(loaded.ledger, { root });
  if (json) {
    console.log(JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2));
  } else if (list) {
    console.log(listLedger(loaded.ledger));
  } else {
    console.log(formatReport(result));
  }
  return result.errors.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && /superseded\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv);
}
