#!/usr/bin/env node
/**
 * 配置 diff CLI（v5.2 §12 收口判据：「10 秒 config-diff」）。
 *
 * 用法（在仓库根跑）：
 *   node tools/config/diff.mjs                       # 工作区 vs HEAD
 *   node tools/config/diff.mjs --base HEAD~3         # 三个提交前 vs 现在
 *   node tools/config/diff.mjs --base C:/snap/old     # 目录快照 vs 工作区
 *   node tools/config/diff.mjs --json                # 机器可读（给脚本/面板用）
 *   node tools/config/diff.mjs --strict              # 有问题（未登记/死旋钮）就 exit 1
 *
 * 它读什么：两侧各取 spec/config/engine.json 与 spec/config/v54.overlay.json，
 * 按旋钮名对齐后报「新增/删除/修改 + 归属 owner/readers + 风险标记」。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { diffConfig } from "../../dist/engine/config-diff.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const baseArg = arg("--base", "HEAD");
const headArg = arg("--head", "WORKTREE");
const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

/** 读一侧的文件内容：WORKTREE 读工作区，目录读目录，其余当 git ref。 */
function readSide(spec, rel) {
  if (spec === "WORKTREE") {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch {
      return null;
    }
  }
  const asDir = join(spec, rel);
  if (existsSync(asDir)) return readFileSync(asDir, "utf8");
  try {
    return execFileSync("git", ["show", `${spec}:${rel}`], { cwd: root, encoding: "utf8" });
  } catch {
    return null;
  }
}

function loadSide(spec) {
  const parse = (text, label) => {
    if (text === null) {
      console.error(`[config-diff] 读不到 ${label}，按空配置处理`);
      return {};
    }
    try {
      return JSON.parse(text).knobs ?? {};
    } catch {
      console.error(`[config-diff] ${label} 不是合法 JSON，按空配置处理`);
      return {};
    }
  };
  return {
    engine: parse(readSide(spec, "spec/config/engine.json"), `${spec}:engine.json`),
    overlay: parse(readSide(spec, "spec/config/v54.overlay.json"), `${spec}:v54.overlay.json`),
  };
}

const result = diffConfig(loadSide(baseArg), loadSide(headArg));

if (json) {
  console.log(JSON.stringify({ base: baseArg, head: headArg, ...result }, null, 2));
} else {
  console.log(`配置 diff：${baseArg} → ${headArg}`);
  console.log(result.summary);
  if (result.entries.length > 0) {
    console.log("");
    for (const e of result.entries) console.log(`  ${e.line}`);
  }
  if (result.problems.length > 0) {
    console.log("");
    for (const p of result.problems) console.log(`  ⚠ ${p}`);
  }
}

process.exit(strict && result.problems.length > 0 ? 1 : 0);
