#!/usr/bin/env node
/**
 * v5.4-P1 的注册表检查（S7 完整版）。
 *
 * fail-closed：
 *   1. overlay 键不得与 engine.json（v5.3.1 附录 A）冲突（text 占位→结构化 是唯一例外）；
 *   2. 每个新键必须有 kind / value / unit / timeBase / owner / readers，且 owner ∈ readers；
 *   3. RETRIEVAL_WEIGHTS 七键和 = 1.00（INV：乘性 boost 不进权重表）；
 *   4. overlay 新键必须在 src/ 里被真的读过（防「注册了但没接线」）；
 *   5. timeBase（per-hour / per-round / per-day）必须与消费它的函数里的时间单位一致（TS AST）；
 *   6. derived_from 必须指向存在的键，且派生键与源键在同一文件里一起被消费；
 *   7. A19：per_archetype 键数 ≤ 40。
 *
 * 每次运行重写 spec/config/registry-diff.md（双栏 diff：engine vs overlay）。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const enginePath = join(root, "spec", "config", "engine.json");
const overlayPath = join(root, "spec", "config", "v54.overlay.json");
const diffPath = join(root, "spec", "config", "registry-diff.md");
const srcRoot = join(root, "src");

const KINDS = new Set(["number", "object", "strings", "text", "literal"]);
const TIME_BASES = new Set(["per-hour", "per-round", "per-day", "per-event", "none", "—"]);
const HEATS = new Set(["cold", "warm", "hot"]);

const problems = [];
const fail = (msg) => problems.push(msg);

const engine = JSON.parse(readFileSync(enginePath, "utf8"));
const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
const baseKnobs = engine.knobs ?? {};
const overKnobs = overlay.knobs ?? {};

for (const [name, k] of Object.entries(overKnobs)) {
  const where = `overlay.${name}`;
  const existing = baseKnobs[name];
  if (existing !== undefined) {
    // 唯一允许的"替换"：v5.3 只给了文本占位（如 EMOTION_DYNAMICS="见 §4.3"），
    // v5.4-P1 用它补成结构化表。非 text 键一律不许覆盖。
    if (existing.kind !== "text") fail(`${where}：与 engine.json 已有键冲突（overlay 只加不覆盖，text 占位除外）`);
  }
  if (!KINDS.has(k.kind)) fail(`${where}：kind=${String(k.kind)} 不在 ${[...KINDS].join("/")}`);
  if (k.value === undefined || k.value === null) fail(`${where}：缺 value`);
  if (k.kind === "number" && typeof k.value !== "number") fail(`${where}：kind=number 但 value 不是数字`);
  if (k.kind === "object" && (typeof k.value !== "object" || Array.isArray(k.value))) fail(`${where}：kind=object 但 value 不是对象`);
  if (k.kind === "strings" && !Array.isArray(k.value)) fail(`${where}：kind=strings 但 value 不是数组`);
  if (typeof k.unit !== "string" || k.unit.length === 0) fail(`${where}：缺 unit`);
  if (!TIME_BASES.has(k.timeBase)) fail(`${where}：timeBase=${String(k.timeBase)} 不在 ${[...TIME_BASES].join("/")}`);
  if (!HEATS.has(k.heat)) fail(`${where}：heat=${String(k.heat)} 不在 cold/warm/hot`);
  if (typeof k.owner !== "string" || k.owner.length === 0) fail(`${where}：缺 owner`);
  if (!Array.isArray(k.readers) || k.readers.length === 0) fail(`${where}：readers 必须是非空数组`);
  else if (!k.readers.includes(k.owner)) fail(`${where}：readers 必须包含 owner（${k.owner}）`);
  if (Array.isArray(k.range)) {
    if (k.range.length !== 2 || !k.range.every((x) => typeof x === "number")) fail(`${where}：range 必须是 [min,max]`);
    else if (!(k.range[0] <= k.range[1])) fail(`${where}：range 下限大于上限`);
    else if (typeof k.value === "number" && (k.value < k.range[0] || k.value > k.range[1])) {
      fail(`${where}：value=${k.value} 超出 range [${k.range[0]}, ${k.range[1]}]`);
    }
  }
  if (k.derived_from !== undefined && baseKnobs[k.derived_from] === undefined) {
    fail(`${where}：derived_from 指向不存在的键 ${k.derived_from}`);
  }
}

// RETRIEVAL_WEIGHTS 七键和 = 1.00（INV：loci / unresolved 都不进权重表）
const rw = baseKnobs.RETRIEVAL_WEIGHTS?.value;
if (rw === undefined || typeof rw !== "object") fail("RETRIEVAL_WEIGHTS 缺失或不是对象");
else {
  const sum = Object.values(rw).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) fail(`RETRIEVAL_WEIGHTS 之和 = ${sum}，必须 = 1.00`);
  if (Object.keys(rw).length !== 7) fail(`RETRIEVAL_WEIGHTS 应为七键，实际 ${Object.keys(rw).length}`);
}

// A19：per_archetype 计数 ≤ 40
const perArch = Object.entries(overKnobs).filter(([, k]) => k.perArchetype === true).length;
const basePerArch = Object.values(baseKnobs).filter((k) => k.perArchetype === true).length;
const totalPerArch = perArch + basePerArch;
if (totalPerArch > 40) fail(`A19：per_archetype 键数 = ${totalPerArch}，上限 40`);

// ---------- src 扫描（TS AST，不用正则去猜代码） ----------

const files = [];
(function walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
  }
})(srcRoot);
files.sort();

/** 每个常量名出现的位置 + 它所在函数的函数体文本 */
const usages = new Map();
function addUsage(knob, file, line, body) {
  const list = usages.get(knob) ?? [];
  list.push({ file: relative(root, file).split(sep).join("/"), line, body });
  usages.set(knob, list);
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const name = node.text;
      if (baseKnobs[name] !== undefined || overKnobs[name] !== undefined) {
        let p = node.parent;
        let body = null;
        while (p !== undefined) {
          if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
            body = p.body === undefined ? null : p.body.getText(sf);
            break;
          }
          p = p.parent;
        }
        if (body === null) body = sf.getFullText();
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        addUsage(name, file, line, body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 4) overlay 新键必须被消费
for (const name of Object.keys(overKnobs)) {
  if ((usages.get(name) ?? []).length === 0) fail(`overlay.${name}：注册了但 src/ 里没有任何消费点（死旋钮）`);
}

// 5) timeBase 与消费它的函数里的时间单位一致
const UNIT_MARK = {
  "per-hour": /hour/i,
  "per-round": /turn|round|tick|step/i,
  "per-day": /day/i,
};
let timeBaseChecked = 0;
for (const [name, k] of Object.entries({ ...baseKnobs, ...overKnobs })) {
  const mark = UNIT_MARK[k.timeBase];
  if (mark === undefined) continue;
  timeBaseChecked += 1;
  const sites = usages.get(name) ?? [];
  if (sites.length === 0) {
    fail(`${name}：timeBase=${k.timeBase} 但没有任何消费点`);
    continue;
  }
  if (!sites.some((s) => mark.test(s.body))) {
    const where = sites.map((s) => `${s.file}:${s.line}`).slice(0, 4).join("、");
    fail(`${name}：timeBase=${k.timeBase}，但消费它的函数里没有对应时间单位（${where}）`);
  }
}

// 6) derived_from：派生键与源键要在同一文件里一起被消费
for (const [name, k] of Object.entries(overKnobs)) {
  if (k.derived_from === undefined) continue;
  if (overKnobs[k.derived_from] === undefined && baseKnobs[k.derived_from] === undefined) continue; // 上面已报
  const filesA = new Set((usages.get(name) ?? []).map((s) => s.file));
  const filesB = new Set((usages.get(k.derived_from) ?? []).map((s) => s.file));
  if (![...filesA].some((f) => filesB.has(f))) {
    fail(`${name}：derived_from=${k.derived_from}，但两者没有在同一文件里一起被消费`);
  }
}

// 双栏 diff（每次重写，可审）
const rows = Object.entries(overKnobs).map(([name, k]) => {
  const before = baseKnobs[name];
  const left = before === undefined ? "—" : `${before.valueText ?? JSON.stringify(before.value)}（${before.unit}）`;
  return `| ${name} | ${left} | ${JSON.stringify(k.value)}（${k.unit}） | ${before === undefined ? "＋新增" : "text 占位→结构化"} |`;
});
const diffText = [
  "# 注册表 diff（engine.json vs v54.overlay.json）",
  "",
  `> 由 tools/audit/check_registry.mjs 自动生成；engine ${Object.keys(baseKnobs).length} 键 + overlay ${Object.keys(overKnobs).length} 键。`,
  "",
  "| 键 | engine.json | v54.overlay.json | 变化 |",
  "| --- | --- | --- | --- |",
  ...rows,
  "",
].join("\n");
// F279：内容没变就不写盘。原先每次跑门禁都无条件重写，工作区永远多一条改动，
// 真实改动和门禁噪声混在一起（独立审计 §2.3）。写盘只在内容变化时发生。
let diffWritten = false;
try {
  const existing = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : null;
  if (existing !== diffText) {
    writeFileSync(diffPath, diffText, "utf8");
    diffWritten = true;
  }
} catch {
  // 读不到/写不了都不影响校验本身；门禁判据是 problems，不是这个文件
}

const total = Object.keys(baseKnobs).length + Object.keys(overKnobs).length;
if (problems.length === 0) {
  console.log(`PASS  注册表检查：engine.json ${Object.keys(baseKnobs).length} 键 + overlay ${Object.keys(overKnobs).length} 键 = ${total}；per_archetype ${totalPerArch}；RETRIEVAL_WEIGHTS 七键和 1.00；timeBase 数据流 ${timeBaseChecked} 键一致；diff ${diffWritten ? "已写" : "无变化"} spec/config/registry-diff.md`);
} else {
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error(`\n结果：${problems.length} 条违规`);
  process.exit(1);
}
