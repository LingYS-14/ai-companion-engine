/**
 * 分层边界 lint（CI 门禁 · Phase 1「边界机器化」）
 *
 * 把 docs/ARCHITECTURE.md §4.1 的四条边规则变成机器能查的东西：
 *
 *   R1  大脑层（brain）不得 import 脊髓层（spine）或工具层（tools）
 *   R2  脊髓层（spine）不得 import 工具层（tools）
 *   R3  工具层（tools）不得 import 大脑的内部实现
 *       —— 但允许 import src/ports/ 下的 Port 公共接口（brainPublicPrefixes）
 *   R4  只有装配点（assembly）可以同时 import 大脑 + 脊髓
 *
 * 设计约束（别违反，否则以后又要靠人记）：
 *   - 层归属 / 装配点例外 / 公共接口前缀全部来自 spec/config/layers.json，
 *     本文件不写第二份目录名；规则逻辑只认配置里的层名、规则 kind 和规则描述。
 *   - 已经存在的违规冻结成棘轮基线 spec/config/edge-baseline.json：
 *     只许减不许增，--update-baseline 时若出现新增项直接退出码 2。
 *   - 判定逻辑是可导出的纯函数 judge(edges, cfg)，main 只在被直接执行时跑，
 *     这样 test/lint-edges.test.ts 既能跑子进程也能直接 import 函数做单测。
 *
 * 用法：
 *   node tools/lint/edges.mjs                    # 检查：有未抑制违规 → 退出码 1
 *   node tools/lint/edges.mjs --json             # 机器可读 {ok,files,edges,violations,suppressed}
 *   node tools/lint/edges.mjs --update-baseline  # 重写基线；新增项 → 退出码 2（基线只许减）
 *   node tools/lint/edges.mjs --init-baseline    # 首次建立基线（仅 Bootstrap 用，别日常跑）
 *   node tools/lint/edges.mjs --root <dir>       # 换项目根（测试夹具用；默认脚本上两级）
 *
 * 关于基线匹配：按「规则 + 文件 + 目标」匹配，行号只记录不参与匹配。
 * 原因是修一个违规会移动后面所有 import 的行号，严格按行号比会把旧条目标成"新增"，
 * 让 --update-baseline 天天误报退出码 2。行号仍写进基线、仍打印，便于逐条对应。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 默认项目根 = tools/lint/ 的上两级 */
const DEFAULT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const BASELINE_REL = "spec/config/edge-baseline.json";
const TEXT_BASELINE_REL = "spec/config/layers-text-baseline.json";
const CONFIG_REL = "spec/config/layers.json";

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/** 统一成 posix 风格、相对项目根、无 "./"、无尾部斜杠 */
function normRel(p) {
  let s = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
  s = posix.normalize(s);
  if (s === ".") return "";
  return s.replace(/\/+$/, "");
}

function toPosix(p) {
  return p.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// 读配置
// ---------------------------------------------------------------------------

export function loadConfig(root) {
  const path = join(root, CONFIG_REL);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`读不到层配置 ${CONFIG_REL}（\`node tools/lint/edges.mjs\` 必须在项目根跑）`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${CONFIG_REL} 不是合法 JSON：${err.message}`);
  }
  if (!cfg || typeof cfg !== "object") throw new Error(`${CONFIG_REL} 顶层必须是对象`);
  if (!cfg.layers || typeof cfg.layers !== "object") throw new Error(`${CONFIG_REL} 缺 layers 对象`);
  for (const [name, dirs] of Object.entries(cfg.layers)) {
    if (!Array.isArray(dirs) || dirs.length === 0) throw new Error(`layers.${name} 必须是非空目录数组`);
    for (const d of dirs) if (typeof d !== "string" || !d) throw new Error(`layers.${name} 里有非法目录项`);
  }
  if (!Array.isArray(cfg.assembly)) throw new Error(`${CONFIG_REL} 缺 assembly 数组`);
  if (cfg.brainPublicPrefixes !== undefined && !Array.isArray(cfg.brainPublicPrefixes)) {
    throw new Error(`${CONFIG_REL} 的 brainPublicPrefixes 必须是数组`);
  }
  if (!cfg.rules || typeof cfg.rules !== "object" || Object.keys(cfg.rules).length === 0) {
    throw new Error(`${CONFIG_REL} 缺 rules`);
  }
  const knownKinds = new Set(["forbidden-target-layer", "forbidden-multi-layer"]);
  for (const [rid, rule] of Object.entries(cfg.rules)) {
    if (!rule || typeof rule !== "object") throw new Error(`rules.${rid} 必须是对象`);
    if (!knownKinds.has(rule.kind)) throw new Error(`rules.${rid}.kind 未知：${rule.kind}`);
    if (rule.kind === "forbidden-target-layer") {
      if (!cfg.layers[rule.from]) throw new Error(`rules.${rid}.from 指向不存在的层：${rule.from}`);
      if (!Array.isArray(rule.to)) throw new Error(`rules.${rid}.to 必须是数组`);
      for (const t of rule.to) if (!cfg.layers[t]) throw new Error(`rules.${rid}.to 指向不存在的层：${t}`);
    }
    if (rule.kind === "forbidden-multi-layer") {
      if (!Array.isArray(rule.layers) || rule.layers.length < 2) throw new Error(`rules.${rid}.layers 至少两项`);
      for (const l of rule.layers) if (!cfg.layers[l]) throw new Error(`rules.${rid}.layers 指向不存在的层：${l}`);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// 源码解析：找 import / export ... from / 动态 import
// ---------------------------------------------------------------------------

/**
 * 把注释替换成等长空格（保留换行与偏移），避免注释里的 `from "x"` 被当成 import。
 * 粗略但够用：处理 // 行注释、/* *\/ 块注释，以及三种字符串/模板字面量内部。
 */
export function stripComments(text) {
  const out = text.split("");
  const n = text.length;
  let state = null; // null | "line" | "block" | "single" | "double" | "template"
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === null) {
      if (c === "/" && c2 === "/") { out[i] = " "; out[i + 1] = " "; state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { out[i] = " "; out[i + 1] = " "; state = "block"; i += 2; continue; }
      if (c === "'") { state = "single"; i += 1; continue; }
      if (c === '"') { state = "double"; i += 1; continue; }
      if (c === "`") { state = "template"; i += 1; continue; }
      i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = null; i += 1; } else { out[i] = " "; i += 1; }
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { out[i] = " "; out[i + 1] = " "; state = null; i += 2; }
      else { if (c !== "\n") out[i] = " "; i += 1; }
      continue;
    }
    // 字符串 / 模板字面量内部：只找配对的引号，转义跳过
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (c === "\\") { i += 2; continue; }
    if (c === quote) { state = null; i += 1; continue; }
    i += 1;
  }
  return out.join("");
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** 抽出一个文件里的全部模块依赖；返回 [{line, spec, kind}]，按行号排序 */
export function extractImports(text) {
  const stripped = stripComments(text);
  const starts = lineStarts(stripped);
  const out = [];
  const seen = new Set();
  const add = (index, spec, kind) => {
    const line = lineAt(starts, index);
    const key = `${line}|${spec}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, spec, kind });
  };
  // 静态 import ... from "x" / export ... from "x" / export * from "x"
  for (const m of stripped.matchAll(/\bfrom\s*["']([^"'\n]+)["']/g)) add(m.index, m[1], "static");
  // 副作用 import "x"
  for (const m of stripped.matchAll(/(?:^|[\s;{}(])import\s*["']([^"'\n]+)["']/g)) add(m.index, m[1], "side-effect");
  // 动态 import("x")
  for (const m of stripped.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) add(m.index, m[1], "dynamic");
  return out.sort((a, b) => a.line - b.line || a.spec.localeCompare(b.spec));
}

/**
 * 把 import 目标解析成项目内规范路径（相对项目根、posix）。
 * 返回 { kind: "external" } | { kind: "internal", target } | { kind: "unresolved", target }
 * NodeNext 约定源码里写 `./x.js` 实际是 `./x.ts`，这里做回映射。
 */
export function resolveSpec(fromRel, spec, root, cfg = {}) {
  if (!spec.startsWith(".")) return { kind: "external" };
  const dir = posix.dirname(fromRel);
  const joined = posix.normalize(posix.join(dir, spec));
  const srcRoot = normRel(cfg.srcRoot || "src");
  // 脚本 import 的是构建产物（dist/*.js），源在 src/*.ts。
  // 不映射的话，常驻进程入口（scripts/autonomy/main.mjs）的 import 边全都看不见——
  // 而它正是审计 P0-1 说的"主装配点不在规则里"。
  const distSource = /^dist\/(.+)\.js$/.exec(joined);
  const resolvedJoined = distSource === null ? joined : `${srcRoot}/${distSource[1]}.ts`;
  const candidates = [];
  if (resolvedJoined.endsWith(".js")) candidates.push(resolvedJoined.slice(0, -3) + ".ts", resolvedJoined);
  else if (resolvedJoined.endsWith(".mjs")) candidates.push(resolvedJoined.slice(0, -4) + ".mts", resolvedJoined);
  else if (/\.[a-zA-Z0-9]+$/.test(posix.basename(resolvedJoined))) candidates.push(resolvedJoined);
  else candidates.push(resolvedJoined + ".ts", resolvedJoined + "/index.ts");
  for (const c of candidates) {
    if (existsSync(join(root, c))) return { kind: "internal", target: c };
  }
  return { kind: "unresolved", target: joined };
}

// ---------------------------------------------------------------------------
// 判层
// ---------------------------------------------------------------------------

function inPrefix(rel, prefix) {
  const p = normRel(prefix);
  if (!p) return false;
  return rel === p || rel.startsWith(p + "/");
}

function isPublicTarget(rel, cfg) {
  if (!Array.isArray(cfg.brainPublicPrefixes)) return false;
  return cfg.brainPublicPrefixes.some((p) => inPrefix(rel, p));
}

/** 规范路径 → 层名 / "assembly" / null（未归层） */
export function layerOf(relPath, cfg) {
  const rel = normRel(relPath);
  if (!rel) return null;
  for (const a of cfg.assembly || []) if (normRel(a) === rel) return "assembly";
  const srcRoot = normRel(cfg.srcRoot || "src");
  for (const [layer, dirs] of Object.entries(cfg.layers || {})) {
    for (const dir of dirs) {
      // 配置里既可以写目录名（"engine"），也可以写路径（"src/engine"）
      const prefix = normRel(dir.includes("/") ? dir : `${srcRoot}/${dir}`);
      if (inPrefix(rel, prefix)) return layer;
    }
  }
  // src/ports/ 是大脑的公共门面（Port 接口），归 brain 层但允许工具层 import
  if (isPublicTarget(rel, cfg)) return "brain";
  // 额外扫描根（scripts/）：不属于三层任何一层，但不是"未知"——归为 scripts。
  // 这样它们的有向边会被计数（可见），但不会匹配任何跨层规则（不判违规）。
  for (const extra of Array.isArray(cfg.extraRoots) ? cfg.extraRoots : []) {
    if (inPrefix(rel, extra)) return "scripts";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 扫描：src 下全部 .ts → 边
// ---------------------------------------------------------------------------

function walkAny(dir, extensions, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkAny(p, extensions, out);
    } else if (extensions.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function walkTs(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walkTs(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 扫描项目，返回 { files, edges, unresolved, importCount }。
 * edges 只保留「起点层、目标层都能判出来」的边；未归层的文件不参与判层。
 */
export function collectEdges(root, cfg) {
  const srcRoot = normRel(cfg.srcRoot || "src");
  const srcFiles = walkTs(join(root, srcRoot)).map((abs) => toPosix(relative(root, abs))).sort();
  // 额外扫描根（批次 3 · D4）：scripts/ 下是入口与运维脚本，不属于三层，但它们的
  // import 边必须可见——尤其是宿主之外的**主装配点** scripts/autonomy/main.mjs。
  const extraRoots = Array.isArray(cfg.extraRoots) ? cfg.extraRoots.map(normRel) : [];
  const extraFiles = [];
  for (const extraRoot of extraRoots) {
    if (extraRoot === "") continue;
    for (const abs of walkAny(join(root, extraRoot), [".mjs", ".js", ".ts"])) {
      extraFiles.push(toPosix(relative(root, abs)));
    }
  }
  extraFiles.sort();
  const files = [...srcFiles, ...extraFiles];
  const assemblySet = new Set((cfg.assembly || []).map(normRel));
  const edges = [];
  const unresolved = [];
  let importCount = 0;
  const unmapped = [];
  const textCache = new Map();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    textCache.set(file, text);
    if (layerOf(file, cfg) === null) unmapped.push(file);
    const fromLayer = assemblySet.has(file) ? "assembly" : layerOf(file, cfg);
    for (const imp of extractImports(text)) {
      importCount += 1;
      const resolved = resolveSpec(file, imp.spec, root, cfg);
      if (resolved.kind === "external") continue;
      if (resolved.kind === "unresolved") {
        unresolved.push({ file, line: imp.line, spec: imp.spec });
        continue;
      }
      const toLayer = layerOf(resolved.target, cfg);
      if (!fromLayer || !toLayer) continue;
      edges.push({
        file,
        line: imp.line,
        target: resolved.target,
        fromLayer,
        toLayer,
        toPublic: isPublicTarget(resolved.target, cfg),
        kind: imp.kind,
      });
    }
  }
  const textDebt = scanTextDebt(files, (f) => textCache.get(f), cfg, assemblySet);
  return { files, srcFiles, extraFiles, edges, unresolved, importCount, unmappedFiles: unmapped, textDebt };
}

// ---------------------------------------------------------------------------
// 判定（纯函数，单测入口）
// ---------------------------------------------------------------------------

/**
 * R4 文本规则（D8）：装配点可以搬数据，但不能自己长业务。
 * 只查"结构性痕迹"——工具定义、自己起 HTTP 服务、内联 HTML 模板。
 * 为什么不是边规则：这些代码常常一条 import 都不多，import 图上看不见，只能看文本。
 * 返回 [{ rule, file, line, target, pattern }]，target 用 pattern 标签（与边违规同形状，便于基线复用）。
 */
export function scanTextDebt(files, textOf, cfg, assemblySet) {
  const rules = Array.isArray(cfg.textRules) ? cfg.textRules : [];
  if (rules.length === 0) return [];
  const debt = [];
  for (const file of files) {
    if (!assemblySet.has(normRel(file))) continue; // 只约束装配点；工具层/大脑的同类代码由各自层规则管
    const text = textOf(file);
    if (typeof text !== "string" || text === "") continue;
    const lines = text.split(/\r?\n/);
    for (const rule of rules) {
      if (!rule || typeof rule.id !== "string" || !Array.isArray(rule.patterns)) continue;
      for (const pattern of rule.patterns) {
        if (!pattern || typeof pattern.regex !== "string") continue;
        const label = typeof pattern.label === "string" ? pattern.label : rule.id;
        let re;
        try {
          re = new RegExp(pattern.regex);
        } catch (err) {
          throw new Error(`textRules.${rule.id} 的正则不合法（${pattern.regex}）：${err.message}`);
        }
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            debt.push({ rule: rule.id, file, line: i + 1, target: label, fromLayer: "assembly", toLayer: "text" });
          }
        }
      }
    }
  }
  debt.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return debt;
}

/** 基线里的目标前缀白名单：rule.allowTargetPrefixes 写配置键名（如 "brainPublicPrefixes"）或字面量前缀 */
function allowedByPrefix(target, rule, cfg) {
  const refs = rule.allowTargetPrefixes;
  if (!Array.isArray(refs) || refs.length === 0) return false;
  for (const ref of refs) {
    const v = cfg[ref];
    const list = Array.isArray(v) ? v : [ref];
    if (list.some((p) => inPrefix(target, p))) return true;
  }
  return false;
}

/**
 * judge(edges, cfg) → 违规数组。
 * 每条违规：{ rule, file, line, target, fromLayer, toLayer }
 * 纯函数：不读文件、不碰基线、不打印，方便单测与复用。
 */
export function judge(edges, cfg) {
  const assembly = new Set((cfg.assembly || []).map(normRel));
  const rules = Object.entries(cfg.rules || {});
  const violations = [];

  // 单边规则：某层不得 import 若干层
  for (const [rid, rule] of rules) {
    if (rule.kind !== "forbidden-target-layer") continue;
    for (const e of edges) {
      if (assembly.has(normRel(e.file))) continue;
      if (e.fromLayer !== rule.from) continue;
      if (!rule.to.includes(e.toLayer)) continue;
      if (allowedByPrefix(e.target, rule, cfg)) continue;
      violations.push({
        rule: rid,
        file: e.file,
        line: e.line,
        target: e.target,
        fromLayer: e.fromLayer,
        toLayer: e.toLayer,
      });
    }
  }

  // 多层级规则：非装配点不得同时 import 两个（或多个）层
  for (const [rid, rule] of rules) {
    if (rule.kind !== "forbidden-multi-layer") continue;
    const layers = rule.layers;
    const byFile = new Map();
    for (const e of edges) {
      if (!layers.includes(e.toLayer)) continue;
      if (e.toPublic) continue; // Port 公共接口不算"摸了大脑实现"
      const list = byFile.get(e.file);
      if (list) list.push(e); else byFile.set(e.file, [e]);
    }
    for (const [file, list] of byFile) {
      if (assembly.has(normRel(file))) continue;
      list.sort((a, b) => a.line - b.line);
      const seenLayers = new Set(list.map((e) => e.toLayer));
      if (!layers.every((l) => seenLayers.has(l))) continue; // 没有同时摸到全部层，不算违反
      // 证据挑「外来的那一层」：同层 import 不算越界，跨进来的那条才是要改的
      const ownLayer = list[0].fromLayer;
      const evidence = list.find((e) => e.toLayer !== ownLayer) ?? list[0];
      violations.push({
        rule: rid,
        file,
        line: evidence.line,
        target: evidence.target,
        fromLayer: evidence.fromLayer,
        toLayer: evidence.toLayer,
      });
    }
  }

  // 稳定排序：配置里的规则顺序 → 文件 → 行号
  const ruleOrder = new Map(rules.map(([rid], i) => [rid, i]));
  violations.sort((a, b) => {
    const ra = ruleOrder.get(a.rule) ?? 99;
    const rb = ruleOrder.get(b.rule) ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  return violations;
}

// ---------------------------------------------------------------------------
// 基线（棘轮）
// ---------------------------------------------------------------------------

function baselineKey(v) {
  return `${v.rule}|${normRel(v.file)}|${normRel(v.target)}`;
}

function loadBaseline(path) {
  if (!existsSync(path)) return { exists: false, entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`基线文件不是合法 JSON：${path}（${err.message}）`);
  }
  const raw = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(raw)) throw new Error(`基线文件缺 entries 数组：${path}`);
  const entries = raw.map((e, i) => {
    if (!e || typeof e.rule !== "string" || typeof e.file !== "string" || typeof e.target !== "string") {
      throw new Error(`基线第 ${i + 1} 条缺少 rule/file/target 字段`);
    }
    return { rule: e.rule, file: normRel(e.file), line: Number(e.line) || 0, target: normRel(e.target) };
  });
  return { exists: true, entries };
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
}

function writeBaseline(path, entries, comment) {
  const sorted = sortEntries(entries);
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    $comment:
      comment ??
      "棘轮基线：这里冻结的是入场时已经存在的跨层 import，只许减不许增。" +
        "修完违规后用 `node tools/lint/edges.mjs --update-baseline` 重写；" +
        "若出现新增项，脚本会以退出码 2 拒绝写入。匹配按「规则+文件+目标」，行号仅作记录。",
    count: sorted.length,
    entries: sorted,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
}

/** 多重集差：entries 里有、pool 里没有（或已被消费完）的条目 */
function diffEntries(entries, poolEntries) {
  const pool = new Map();
  for (const e of poolEntries) {
    const k = baselineKey(e);
    pool.set(k, (pool.get(k) || 0) + 1);
  }
  const missing = [];
  for (const e of entries) {
    const k = baselineKey(e);
    const left = pool.get(k) || 0;
    if (left > 0) pool.set(k, left - 1);
    else missing.push(e);
  }
  return missing;
}

/** 用基线把违规分成「未抑制」与「已冻结」两部分 */
export function applyBaseline(violations, entries) {
  const pool = new Map();
  for (const e of entries) {
    const k = baselineKey(e);
    const arr = pool.get(k);
    if (arr) arr.push(e); else pool.set(k, [e]);
  }
  const kept = [];
  const suppressed = [];
  for (const v of violations) {
    const arr = pool.get(baselineKey(v));
    if (arr && arr.length > 0) {
      arr.shift();
      suppressed.push(v);
    } else {
      kept.push(v);
    }
  }
  return { kept, suppressed };
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    json: false,
    updateBaseline: false,
    initBaseline: false,
    updateTextBaseline: false,
    initTextBaseline: false,
    root: DEFAULT_ROOT,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--update-baseline") opts.updateBaseline = true;
    else if (a === "--init-baseline") opts.initBaseline = true;
    else if (a === "--update-text-baseline") opts.updateTextBaseline = true;
    else if (a === "--init-text-baseline") opts.initTextBaseline = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (!v) throw new Error("--root 需要一个目录参数");
      opts.root = v;
    } else if (a.startsWith("--root=")) opts.root = a.slice("--root=".length);
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function usage() {
  return [
    "用法：node tools/lint/edges.mjs [--json] [--update-baseline | --init-baseline] [--root <dir>]",
    "  --json                JSON 输出 {ok,files,edges,violations,suppressed,textDebt}",
    "  --update-baseline     重写跨层 import 基线（只许减；有新增项则退出码 2）",
    "  --init-baseline       首次建立跨层 import 基线（Bootstrap 用）",
    "  --update-text-baseline 重写 R4 文本债务基线（只许减；有新增项则退出码 2）",
    "  --init-text-baseline   首次建立 R4 文本债务基线（Bootstrap 用）",
    "  --root <dir>        换项目根（默认脚本上两级，测试夹具用）",
  ].join("\n");
}

function relOf(root, abs) {
  return toPosix(relative(root, abs));
}

/**
 * 装配点必须真的存在。
 *
 * spec/config/layers.json 里的 assembly 是「可以同时 import 大脑与脊髓」的特权名单；
 * 名单里写一个不存在的文件，等于给一个幽灵发特权——lint 却在数「6 个装配点」。
 * 这里只校验存在性，不改层级判定。
 */
export function missingAssemblyEntries(root, cfg) {
  return (cfg.assembly || []).map((a) => normRel(a)).filter((rel) => !existsSync(join(root, rel)));
}

function summarizeConfig(cfg) {
  const parts = Object.entries(cfg.layers).map(([name, dirs]) => `${name} ${dirs.length} 目录`);
  return `${parts.join(" / ")} / assembly ${cfg.assembly.length} 个装配点`;
}

function formatViolation(v) {
  return `${v.rule} ${v.file}:${v.line} → ${v.target}（${v.fromLayer} → ${v.toLayer}）`;
}

function runUpdateBaseline({ root, cfg, violations, files, crossLayer, init, json, baselineRel = BASELINE_REL, label = "跨层 import", comment }) {
  const baselinePath = join(root, baselineRel);
  let old;
  try {
    old = loadBaseline(baselinePath);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
  if (!old.exists && !init) {
    console.error(`✗ 基线文件不存在：${baselineRel}`);
    console.error("  首次建立基线请显式传 --init-baseline；之后只能用 --update-baseline 减少条目。");
    return 2;
  }
  const oldEntries = old.entries;
  // Bootstrap（首次建基线）没有可比对象，允许一次写入；已存在基线时即使 --init-baseline
  // 也必须守「只许减」的棘轮，避免有人靠删文件/换参数绕过门禁。
  const bootstrap = init && !old.exists;
  const added = bootstrap ? [] : diffEntries(violations, oldEntries);
  const removed = bootstrap ? [] : diffEntries(oldEntries, violations);
  if (added.length > 0) {
    console.error(`✗ 基线只许减不许增：检测到 ${added.length} 条新增违规，拒绝写入基线（退出码 2）。`);
    console.error("  先把这些修掉，或确认它们本来就该被拦住（那是门禁在干活，不是基线的活）：");
    for (const v of added) console.error(`  + ${formatViolation(v)}`);
    return 2;
  }
  const entries = violations.map((v) => ({ rule: v.rule, file: normRel(v.file), line: v.line, target: normRel(v.target) }));
  try {
    writeBaseline(baselinePath, entries, comment);
  } catch (err) {
    console.error(`✗ 写基线失败：${err.message}`);
    return 1;
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          files: files.length,
          edges: crossLayer,
          violations: [],
          suppressed: [],
          baseline: {
            before: oldEntries.length,
            after: entries.length,
            removed: removed.length,
            written: relOf(root, baselinePath),
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`✓ ${label}基线已更新：${oldEntries.length} → ${entries.length} 条（减少 ${removed.length} 条）`);
    for (const v of removed) console.log(`  - ${formatViolation(v)}`);
    if (init) console.log("  （本次是 --init-baseline 初始化；日常只许用 --update-baseline 收紧）");
  }
  return 0;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`✗ ${err.message}\n${usage()}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const root = resolvePath(opts.root || DEFAULT_ROOT);

  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }

  const missingAssembly = missingAssemblyEntries(root, cfg);
  if (missingAssembly.length > 0) {
    console.error(`✗ 装配点不存在：${missingAssembly.join("、")}（spec/config/layers.json 的 assembly）`);
    console.error("  装配点是「可以同时 import 大脑与脊髓」的特权名单，写不存在的文件等于给幽灵发特权。");
    return 1;
  }

  let scan;
  try {
    scan = collectEdges(root, cfg);
  } catch (err) {
    console.error(`✗ 扫描 src 失败：${err.message}`);
    return 1;
  }
  const violations = judge(scan.edges, cfg);
  const crossLayerEdges = scan.edges.filter((e) => e.fromLayer !== e.toLayer);

  if (opts.updateBaseline || opts.initBaseline) {
    return runUpdateBaseline({
      root,
      cfg,
      violations,
      files: scan.files,
      crossLayer: crossLayerEdges.length,
      init: opts.initBaseline,
      json: opts.json,
    });
  }
  if (opts.updateTextBaseline || opts.initTextBaseline) {
    return runUpdateBaseline({
      root,
      cfg,
      violations: scan.textDebt ?? [],
      files: scan.files,
      crossLayer: crossLayerEdges.length,
      init: opts.initTextBaseline,
      json: opts.json,
      baselineRel: TEXT_BASELINE_REL,
      label: "R4 文本债务",
      comment:
        "棘轮基线：装配点里已经存在、但还没搬走的业务痕迹（工具定义 / HTTP 服务 / HTML）。" +
        "只许减不许增；新代码再往装配点里塞这些，`node tools/lint/edges.mjs --update-text-baseline` 会以退出码 2 拒绝。" +
        "匹配按「规则+文件+标签」，行号仅作记录。",
    });
  }

  let baseline;
  try {
    baseline = loadBaseline(join(root, BASELINE_REL));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
  const { kept, suppressed } = applyBaseline(violations, baseline.entries);

  let textBaseline;
  try {
    textBaseline = loadBaseline(join(root, TEXT_BASELINE_REL));
  } catch (err) {
    console.error(`✗ R4 文本基线：${err.message}`);
    return 1;
  }
  const textDebtAll = scan.textDebt ?? [];
  const textApplied = applyBaseline(textDebtAll, textBaseline.entries);
  const textKept = textApplied.kept;
  const textSuppressed = textApplied.suppressed;
  const ok = kept.length === 0 && textKept.length === 0 && scan.unmappedFiles.length === 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: kept.length === 0,
          files: scan.files.length,
          srcFiles: scan.srcFiles.length,
          extraFiles: scan.extraFiles.length,
          unmappedFiles: scan.unmappedFiles,
          edges: crossLayerEdges.length,
          violations: kept,
          suppressed,
          textDebt: { kept: textKept, suppressed: textSuppressed },
        },
        null,
        2,
      ),
    );
    return ok ? 0 : 1;
  }

  // ---- 人读输出（与 tools/lint/writers.mjs 同一风格：✓ / ✗ / · 前缀） ----
  console.log(`✓ 层配置：${summarizeConfig(cfg)}`);
  if (scan.unmappedFiles.length > 0) {
    console.log(`✗ 未归层文件 ${scan.unmappedFiles.length} 个（不在三层也不在 extraRoots：它们的有向边不计入判定）：`);
    for (const u of scan.unmappedFiles.slice(0, 10)) console.log(`    ${u}`);
    if (scan.unmappedFiles.length > 10) console.log(`    ……（还有 ${scan.unmappedFiles.length - 10} 个）`);
  }
  for (const v of kept) console.log(`✗ ${formatViolation(v)}`);
  for (const v of suppressed) console.log(`(基线) ${formatViolation(v)}`);
  if (textDebtAll.length > 0) {
    console.log(
      `· R4 文本债务 ${textDebtAll.length} 条（装配点里的工具定义/HTTP/HTML；` +
        `已冻结 ${textSuppressed.length}，未冻结 ${textKept.length}）：`,
    );
    for (const v of textDebtAll.slice(0, 20)) {
      const mark = textKept.includes(v) ? "✗" : "(基线)";
      console.log(`    ${mark} ${v.file}:${v.line} ${v.target}`);
    }
    if (textDebtAll.length > 20) console.log(`    ……（还有 ${textDebtAll.length - 20} 条）`);
  }
  if (scan.unresolved.length > 0) {
    console.log(`· 未解析的相对 import ${scan.unresolved.length} 条（目标文件不存在，不计入判层）：`);
    for (const u of scan.unresolved.slice(0, 10)) console.log(`    ${u.file}:${u.line} → ${u.spec}`);
    if (scan.unresolved.length > 10) console.log(`    ……（还有 ${scan.unresolved.length - 10} 条）`);
  }

  const staleEntries = baseline.exists ? diffEntries(baseline.entries, violations) : [];
  console.log(
    `edges: 扫描 ${scan.files.length} 文件（src ${scan.srcFiles.length} + 额外根 ${scan.extraFiles.length}）/ ` +
      `${crossLayerEdges.length} 条跨层边 / ${violations.length} 条违规（基线抑制 ${suppressed.length} 条）/ ` +
      `R4 文本债务 ${textDebtAll.length} 条（未冻结 ${textKept.length}）/ 未归层 ${scan.unmappedFiles.length} 个`,
  );
  if (staleEntries.length > 0) {
    console.log(
      `· 基线里有 ${staleEntries.length} 条已经对不上现状（大概率是修好后没重写基线）：` +
        `\`node tools/lint/edges.mjs --update-baseline\` 可以收紧`,
    );
  }

  if (ok) {
    console.log(`\n✓ edges 通过（基线冻结 ${baseline.entries.length} 条，待清偿 ${suppressed.length} 条；R4 文本债务 ${textSuppressed.length} 条已冻结）`);
    return 0;
  }
  if (scan.unmappedFiles.length > 0) {
    console.log(`\n✗ 分层门禁失败：${scan.unmappedFiles.length} 个文件归不了层——它们既不在 brain/spine/tools 目录下，也不在 extraRoots 里。`);
    console.log("  归不了层 = 它的 import 边不会被任何规则检查，等于在门禁之外。要么放进三层、要么进 extraRoots、要么把它的作用说清楚。");
  }
  if (textKept.length > 0) {
    console.log(`\n✗ R4 文本规则未通过：${textKept.length} 条新增业务痕迹出现在装配点（基线里另有 ${textSuppressed.length} 条已冻结的旧账）`);
    console.log("  装配点该做的是把 Port 和数据搬在一起；工具定义进工具层、HTTP/HTML 进 plugin/http|web。");
  }
  console.log(`\n✗ edges 失败：${kept.length} 条未抑制违规（基线里另有 ${suppressed.length} 条已冻结的旧账）`);
  console.log("  跨层 import 是设计约束，不是风格问题：大脑不该摸外部世界，工具不该摸大脑内部实现。");
  return 1;
}

// 只在被直接执行时跑 main；被 import 做单测时导出的函数不触发扫描
const entryArg = process.argv[1];
const invokedDirectly = Boolean(entryArg) && pathToFileURL(resolvePath(entryArg)).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
