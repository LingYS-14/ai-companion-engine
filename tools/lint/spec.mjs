#!/usr/bin/env node
/**
 * 规格完整性闸门（v5.3.1 形状）。
 *
 * 检查四件事：
 *   1. 注册表结构与计数自洽：93 项、每簇 ≤10、每簇 hot ≤5、per-archetype ≤40；
 *   2. 每个旋钮字段齐备且 kind/heat 合法（valueText 是唯一的"人类可读值"，不许缺）；
 *   3. 代码引用的旋钮必须真实存在、kind 对（knobNumber 只能取 number 等）；
 *   4. 反常量副本：decay_rate / suppression_self_decay 不得出现在 src；Math.exp 必须带 INV7-EXEMPT。
 *
 * 退出码 0 = 全过；否则打印每一条违规并退出 1。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const errs = [];
const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => { errs.push(msg); console.log("  ✗ " + msg); };

const KINDS = new Set(["number", "object", "strings", "text", "literal"]);
const HEATS = new Set(["cold", "warm", "hot"]);
const CLUSTER_RE = /^A\.\d+[a-z]?(?:-[a-z]+)?$/;

const cfg = JSON.parse(readFileSync(join(ROOT, "spec/config/engine.json"), "utf8"));
const knobs = cfg.knobs ?? {};
const names = Object.keys(knobs);

// v5.4-P1：overlay 里的旋钮和 engine.json 里的同等合法（registry 检查合并看，
// 计数约束仍只针对 engine.json 的 93 项——overlay 是增量，不是重排）。
const overlayFile = join(ROOT, "spec/config/v54.overlay.json");
const overlayKnobs = existsSync(overlayFile)
  ? (JSON.parse(readFileSync(overlayFile, "utf8")).knobs ?? {})
  : {};
const knownKnobs = { ...knobs, ...overlayKnobs };

console.log("[1] 注册表结构");
if (cfg.meta?.spec !== "v5.3.1") bad(`meta.spec 应为 v5.3.1，实际 ${String(cfg.meta?.spec)}`); else ok("meta.spec = v5.3.1");
if (!cfg.meta?.modeThresholds) bad("缺 meta.modeThresholds"); else ok("meta.modeThresholds 存在");
for (const key of Object.keys(cfg.meta?.modeThresholds ?? {})) {
  if (typeof cfg.meta.modeThresholds[key] !== "number") bad(`meta.modeThresholds.${key} 不是数字`);
}

console.log("[2] 每个旋钮的字段与 kind");
const perCluster = new Map();
const hotPerCluster = new Map();
let hotCount = 0;
let paCount = 0;
for (const [name, k] of Object.entries(knobs)) {
  if (!CLUSTER_RE.test(String(k.cluster))) bad(`旋钮 ${name} 的 cluster 非法：${String(k.cluster)}`);
  if (!KINDS.has(k.kind)) bad(`旋钮 ${name} 的 kind 非法：${String(k.kind)}`);
  if (!HEATS.has(k.heat)) bad(`旋钮 ${name} 的 heat 非法：${String(k.heat)}`);
  if (typeof k.valueText !== "string" || k.valueText.length === 0) bad(`旋钮 ${name} 缺 valueText`);
  if (typeof k.unit !== "string") bad(`旋钮 ${name} 缺 unit`);
  if (typeof k.timeBase !== "string") bad(`旋钮 ${name} 缺 timeBase`);
  if (typeof k.perArchetype !== "boolean") bad(`旋钮 ${name} 缺 perArchetype`);
  if (k.kind === "number" && typeof k.value !== "number") bad(`旋钮 ${name} kind=number 但 value 不是数字`);
  if (k.kind === "object" && (k.value === null || typeof k.value !== "object")) bad(`旋钮 ${name} kind=object 但 value 不是对象`);
  if (k.kind === "strings" && !Array.isArray(k.value)) bad(`旋钮 ${name} kind=strings 但 value 不是数组`);
  if (k.kind === "literal" && k.value !== null) bad(`旋钮 ${name} kind=literal 但 value 非 null（literal 只有 valueText）`);
  perCluster.set(k.cluster, (perCluster.get(k.cluster) ?? 0) + 1);
  if (k.heat === "hot") { hotCount++; hotPerCluster.set(k.cluster, (hotPerCluster.get(k.cluster) ?? 0) + 1); }
  if (k.perArchetype) paCount++;
}
ok(`${names.length} 个旋钮，字段检查完成`);

console.log("[3] 计数约束");
const limits = cfg.meta?.limits ?? {};
if (names.length !== cfg.meta?.counts?.total) bad(`counts.total=${cfg.meta?.counts?.total} 与实际 ${names.length} 不符`);
if (hotCount !== cfg.meta?.counts?.hot) bad(`counts.hot=${cfg.meta?.counts?.hot} 与实际 ${hotCount} 不符`);
if (paCount !== cfg.meta?.counts?.perArchetype) bad(`counts.perArchetype=${cfg.meta?.counts?.perArchetype} 与实际 ${paCount} 不符`);
if (paCount > (limits.archetypeMax ?? 40)) bad(`per-archetype ${paCount} 超过上限 ${limits.archetypeMax}`);
if (hotCount > (limits.hotMax ?? 20)) bad(`hot ${hotCount} 超过上限 ${limits.hotMax}`);
for (const [c, n] of perCluster) if (n > (limits.clusterMax ?? 10)) bad(`簇 ${c} 有 ${n} 项，超过 ${limits.clusterMax}`);
for (const [c, n] of hotPerCluster) if (n > (limits.clusterHotMax ?? 5)) bad(`簇 ${c} 有 ${n} 个 hot，超过 ${limits.clusterHotMax}`);
if (cfg.meta?.selfCheck?.ok !== true) bad(`meta.selfCheck.ok=${String(cfg.meta?.selfCheck?.ok)}`);
ok(`计数：总 ${names.length} / hot ${hotCount} / per-archetype ${paCount} / 簇 ${perCluster.size}`);

console.log("[4] 代码引用与 schema");
const src = join(ROOT, "src");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const ts = walk(src).filter((f) => f.endsWith(".ts"));
const kindFor = { knobNumber: "number", knobObject: "object", knobStrings: "strings" };
const supplemental = new Set((cfg.meta?.supplemental ?? []).map((s) => s.name));
let refs = 0;
for (const file of ts) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(ROOT.length + 1);
  for (const m of text.matchAll(/knob(Number|Object|Strings|Text)<[^>]*>?\(\s*(?:this\.)?(?:cfg|config)\s*,\s*"([A-Z0-9_]+)"/g)) {
    const fn = "knob" + m[1];
    const name = m[2];
    refs++;
    const k = knownKnobs[name];
    if (!k) { bad(`${rel} 引用了未注册旋钮 ${name}`); continue; }
    const want = kindFor[fn];
    if (want && k.kind !== want) bad(`${rel}：${fn} 取 ${name}，但 kind 是 ${k.kind}`);
  }
  for (const m of text.matchAll(/supplementalNumber\(\s*(?:this\.)?(?:cfg|config)\s*,\s*"([A-Z0-9_]+)"/g)) {
    refs++;
    if (!supplemental.has(m[1])) bad(`${rel} 引用了 meta.supplemental 里没有的 ${m[1]}`);
  }
  // 反常量副本：只在"删掉注释与字符串之后仍然出现"时才算违规。
  // 注释里写公式、knobNumber(cfg, "DECAY_RATE") 里引用旋钮名都合法；
  // 真正要拦的是 `const DECAY_RATE = 0.7` 这种副本。
  // 反常量副本：先按"注释 / 字符串"状态机剥掉它们，再看是否还有裸标识符。
  // 注释里写公式、knobNumber(cfg, "DECAY_RATE") 里引用旋钮名都合法；
  // 真正要拦的是 `const DECAY_RATE = 0.7` 这种副本。
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  const DQ = String.fromCharCode(34);
  const SQ = String.fromCharCode(39);
  const BT = String.fromCharCode(96);
  let codeOnly = "";
  let k = 0;
  while (k < text.length) {
    const ch = text[k];
    const nx = text[k + 1];
    if (ch === "/" && nx === "/") {
      while (k < text.length && text[k] !== NL) k += 1;
      continue;
    }
    if (ch === "/" && nx === "*") {
      k += 2;
      while (k < text.length && !(text[k] === "*" && text[k + 1] === "/")) k += 1;
      k += 2;
      continue;
    }
    if (ch === DQ || ch === SQ || ch === BT) {
      const q = ch;
      k += 1;
      while (k < text.length) {
        if (text[k] === BS) { k += 2; continue; }
        if (text[k] === q) { k += 1; break; }
        k += 1;
      }
      codeOnly += DQ + DQ;
      continue;
    }
    codeOnly += ch;
    k += 1;
  }
  if (/decay_rate|suppression_self_decay/i.test(codeOnly)) bad(`${rel} 出现被 INV-7 禁止的常量副本`);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.includes("Math.exp(")) return;
    const near = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
    if (!near.includes("INV7-EXEMPT")) bad(`${rel}:${i + 1} Math.exp 缺 INV7-EXEMPT 标记`);
  });
}
ok(`${refs} 处代码引用已核对`);

for (const f of readdirSync(join(ROOT, "spec/schema")).filter((x) => x.endsWith(".json"))) {
  const sch = JSON.parse(readFileSync(join(ROOT, "spec/schema", f), "utf8"));
  if (sch.required) {
    const props = Object.keys(sch.properties ?? {});
    for (const r of sch.required) if (!props.includes(r)) bad(`${f}: required ${r} 不在 properties`);
    if (sch.additionalProperties !== false) bad(`${f}: 必须 additionalProperties=false`);
  }
}
ok("schema 结构检查完成");

if (errs.length) { console.error(`\n${errs.length} 项不通过`); process.exit(1); }
console.log("\nALL PASS");
