#!/usr/bin/env node
/**
 * 写入点 lint（CI 第二道门）—— 把 src/contracts/modules.ts 开头那三条契约变成机器能查的东西。
 *
 *   规则 1（单一写入点）：S 层字段的赋值只允许出现在 src/engine/state.ts。
 *   规则 2（时钟唯一）：Date.now() / new Date( 只允许出现在 src/engine/clock.ts。
 *   规则 3（模块边界）：src/engine/** 不得 import src/plugin/**（内核不许反向依赖宿主）。
 *   规则 4（契约完整性）：modules.ts 里每个模块必须同时声明 reads / writes / invariants / failureMode。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const errors = [];
const record = (m) => errors.push(m);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(name)) continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const S_FIELDS = [
  "valence", "arousal", "pressure", "energy", "dissonance", "entropy",
  "affection", "trust", "jealousy", "maskIntegrity", "suppressionLoad", "rumination", "taintMap",
];

const files = walk(join(ROOT, "src")).map((p) => ({ path: p, rel: relative(ROOT, p).split(sep).join("/"), text: readFileSync(p, "utf8") }));

// ---- 规则 1 ---------------------------------------------------------------
const stateOwner = "src/engine/state.ts";
for (const f of files) {
  if (f.rel === stateOwner) continue;
  for (const field of S_FIELDS) {
    // 只抓「对象属性赋值」：.field = 或 .field += / -=，跳过 == / === / =>
    const re = new RegExp(`\\.${field}\\s*(?:\\+|-|\\*|/)?=(?!=)`, "g");
    if (re.test(f.text)) record(`${f.rel} 直接写了 S 层字段 ${field}（唯一写入点是 ${stateOwner}）`);
  }
}

// ---- 规则 2 ---------------------------------------------------------------
const clockOwner = "src/engine/clock.ts";
for (const f of files) {
  if (f.rel === clockOwner) continue;
  if (/Date\.now\(\)/.test(f.text)) record(`${f.rel} 调用了 Date.now()（只允许 ${clockOwner}）`);
  if (/new Date\(/.test(f.text)) record(`${f.rel} 调用了 new Date()（只允许 ${clockOwner}）`);
}

// ---- 规则 3 ---------------------------------------------------------------
for (const f of files) {
  if (!f.rel.startsWith("src/engine/")) continue;
  const imports = [...f.text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const spec of imports) {
    if (spec.includes("/plugin/") || spec.startsWith("../plugin")) {
      record(`${f.rel} 反向依赖宿主层：${spec}`);
    }
  }
}

// ---- 规则 4 ---------------------------------------------------------------
const contractsPath = join(ROOT, "src", "contracts", "modules.ts");
const contracts = readFileSync(contractsPath, "utf8");
const expected = ["orchestrator", "state", "psychology", "memory", "learning", "firewall", "dialogue", "render"];
const count = (hay, needle) => hay.split(needle).length - 1;
if (!contracts.includes("export interface ModuleContract")) record("modules.ts 缺 ModuleContract 基契约");
for (const field of ["reads", "writes", "invariants", "failureMode"]) {
  if (!contracts.includes(`readonly ${field}:`)) record(`ModuleContract 未声明 ${field}`);
}
for (const name of expected) {
  const ifaceHits = count(contracts, `readonly id: "${name}"`);
  const regHits = count(contracts, `id: "${name}",`);
  if (ifaceHits !== 1) record(`modules.ts 的接口 id "${name}" 出现 ${ifaceHits} 次（应为 1）`);
  if (regHits < 1) record(`modules.ts 的注册表缺 id: "${name}"`);
}

// ---- 汇总 ----------------------------------------------------------------
console.log(JSON.stringify({ files: files.length, sFields: S_FIELDS.length, modules: expected.length, errors }, null, 2));
if (errors.length) {
  console.error(`\n✗ lint:writers 失败，${errors.length} 处：`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\n✓ lint:writers 通过");
