#!/usr/bin/env node
/**
 * 执行层 H1 门禁：直连发送点棘轮。
 *
 * 规则（对应 PLAN-SPINE H1 / AUDIT-EXECUTION-LAYER E8）：
 * - `src/execution/` 之外，不允许随意出现发送函数直连；
 * - 已有的直连登记在 `spec/config/execution-bypass.json`，**每文件只给行数上限**；
 * - 超限 = FAIL（新增旁路必须显式加豁免并在评审里看见）；
 * - 实际数小于上限 = WARN（说明有人改走了 gateway，记得把上限减回去，否则棘轮会松）。
 *
 * 用法：node tools/audit/check_execution.mjs [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const bypassPath = join(repo, "spec", "config", "execution-bypass.json");
const asJson = process.argv.includes("--json");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "execution" && dir.endsWith(join("src"))) continue; // 执行层自己不算旁路
      out.push(...walk(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const bypass = JSON.parse(readFileSync(bypassPath, "utf8"));
const symbols = bypass.symbols ?? [];
const allowed = new Map();
for (const entry of bypass.files ?? []) allowed.set(entry.file.replaceAll("\\", "/"), entry);

const problems = [];
const warnings = [];
const passed = [];

/**
 * H2：执行层是「窄而硬」的适配器层——它只能 import Node 标准库和执行层内部文件。
 * 一旦 import 了 memory/engine/plugin/qq/bili，就等于把业务判断藏进了"脊髓"，
 * 后面所有「谁写状态」的边界声明都会失效。
 */
function checkH2() {
  // 允许测试指向临时目录，好做「越界 import 必须 FAIL」的反向验证
  const dir = process.env.ACE_H2_DIR ?? join(repo, "src", "execution");
  const internal = new Set();
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  for (const name of files) internal.add(`./${name.replace(/\.ts$/, ".js")}`);
  const offenders = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = match[1];
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") && internal.has(spec)) continue;
      offenders.push(`执行层文件 ${name} 越界 import：${spec}`);
    }
  }
  if (offenders.length === 0) {
    passed.push(`H2 边界：执行层 ${String(files.length)} 个文件只依赖标准库与自身`);
  } else {
    problems.push(...offenders);
  }
}
const files = walk(join(repo, "src"));
const seen = new Map();

for (const file of files) {
  const rel = relative(repo, file).replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
    const hit = symbols.find((symbol) => line.includes(symbol));
    if (hit === undefined) continue;
    seen.set(rel, (seen.get(rel) ?? 0) + 1);
  }
}

for (const [file, count] of seen) {
  const entry = allowed.get(file);
  const max = entry?.max ?? 0;
  if (count > max) {
    problems.push(`${file}：直连发送点 ${String(count)} 处，超过豁免上限 ${String(max)}（改走 gateway，或在 execution-bypass.json 里写明理由后加一）`);
  } else if (count < max) {
    warnings.push(`${file}：直连发送点只剩 ${String(count)} 处（上限 ${String(max)}），记得把上限减到 ${String(count)}，别让棘轮松掉`);
  }
}

for (const entry of bypass.files ?? []) {
  if (!seen.has(entry.file)) {
    problems.push(`${entry.file}：豁免里登记了 ${String(entry.max)} 处，但文件里一处都没找到（条目过期或文件改名）`);
  }
}
/**
 * H11：出站函数只许被"已知的嘴"引入。
 *
 * 为什么需要独立一条：H1 只数「出现了几次直连」，数不出"新文件也能悄悄 import 一个发送函数"。
 * 这里按模块收口：`qq/send.ts` 与 `qq/onebot.ts` 的发送函数只允许出现在白名单文件里
 * （宿主装配层、常驻进程的桥、窗口发送实现自身），新增引入点必须改这里并过评审。
 */
const SEND_MODULES = ["qq/send.ts", "qq/onebot.ts"];
const SEND_SYMBOLS = ["sendContent", "sendPrivateText", "sendPrivateRecord"];
const SEND_IMPORTER_ALLOW = new Set(["plugin/index.ts", "autonomy/qq-runner.ts", "qq/host.ts"]);

function checkH11() {
  const dir = process.env.ACE_H11_SRC ?? join(repo, "src");
  const targets = new Set(SEND_MODULES.map((m) => join(dir, m).replaceAll("\\", "/")));
  const offenders = [];
  const walkSrc = (root) => {
    const out = [];
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      if (statSync(full).isDirectory()) out.push(...walkSrc(full));
      else if (name.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  for (const file of walkSrc(dir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
      const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, "").trim());
      if (!names.some((n) => SEND_SYMBOLS.includes(n))) continue;
      const spec = match[2];
      if (!spec.startsWith(".")) continue;
      const resolved = join(dirname(file), spec).replace(/\.js$/, ".ts").replaceAll("\\", "/");
      if (!targets.has(resolved)) continue;
      const rel = relative(dir, file).replaceAll("\\", "/");
      if (!SEND_IMPORTER_ALLOW.has(rel)) {
        offenders.push(`${rel} 引入了出站函数（${spec}）：出站必须经 dispatch/gateway，或把文件加进 SEND_IMPORTER_ALLOW 并说明理由`);
      }
    }
  }
  if (offenders.length === 0) {
    passed.push(`H11 出站收口：${String(SEND_IMPORTER_ALLOW.size)} 个白名单文件之外没有新增发送函数引入`);
  } else {
    problems.push(...offenders);
  }
}


/**
 * H12：队列恢复必须真的接上。
 *
 * `PendingQueue.open` 把崩溃时 running 的条目退回 pending，这是 at-least-once 的兜底；
 * 但如果没人调用它，恢复能力只存在于测试里。H12 检查三件事：
 *   ①`src/execution/executor.ts` 用 claim/ack 跑条目（不是自己造状态机）；
 *   ②常驻进程 `scripts/autonomy/main.mjs` 引了 PendingQueue 与 drainPending，并且 drainQueue
 *     真的被**消费**：直接调用（`void/await drainQueue(`），或作为依赖交给每拍副作用执行器
 *     （`runTickHooks(..., { drainQueue })` 或 `wrapActions({ tickHooks: { drainQueue } })`——
 *     F275/F301 把"每拍副作用"和"动作包装"从入口下沉之后，入口只递依赖）。只是定义了它不算——
 *     审计 B.4 就是这么假绿的；
 *   ③执行层没有绕过队列直接写回执文件。
 */
const H12_DAEMON = process.env.ACE_H12_DAEMON ?? join(repo, "scripts", "autonomy", "main.mjs");
const H12_EXECUTOR = process.env.ACE_H12_EXECUTOR ?? join(repo, "src", "execution", "executor.ts");

function checkH12() {
  const executor = existsSync(H12_EXECUTOR) ? readFileSync(H12_EXECUTOR, "utf8") : "";
  const daemon = existsSync(H12_DAEMON) ? readFileSync(H12_DAEMON, "utf8") : "";
  const issues = [];
  if (executor === "") issues.push(`H12：找不到 ${H12_EXECUTOR}`);
  else {
    if (!executor.includes("queue.claim(")) issues.push("H12：executor.ts 没有 claim 条目（崩溃恢复语义会丢）");
    if (!executor.includes("queue.ack(")) issues.push("H12：executor.ts 没有 ack 条目（成功也留在队列里）");
  }
  if (daemon === "") issues.push(`H12：找不到 ${H12_DAEMON}`);
  else {
    if (!daemon.includes("PendingQueue.open(")) issues.push("H12：常驻进程没有 PendingQueue.open（启动不恢复）");
    if (!daemon.includes("drainPending(")) issues.push("H12：常驻进程没有 drainPending（队列没人跑）");
    // 光"出现过 drainQueue"不够：审计 B.4 的现场就是定义了 drainQueue 却没人调用，字符串判据假绿。
    // 现在有两种合法消费形态：①直接调用；②作为依赖交给每拍副作用执行器（F275 下沉）。
    const callsQueue = /(?:void|await)\s+drainQueue\s*\(/.test(daemon);
    // 消费方可能在装配层：入口把 drainQueue 作为依赖递进去（F275 tick-hooks / F301 wrapActions）。
    const handsQueueToHooks =
      daemon.includes("drainQueue") &&
      (daemon.includes("runTickHooks(") ||
        (daemon.includes("wrapActions(") && daemon.includes("tickHooks:")));
    if (!callsQueue && !handsQueueToHooks) {
      issues.push("H12：常驻进程定义了 drainQueue 却没人消费（队列永远不会被跑）");
    }
  }
  if (issues.length === 0) passed.push("H12 队列恢复接线：executor 用 claim/ack、常驻进程 open+drain 都在");
  else problems.push(...issues);
}

/**
 * H3：重试纪律。可重试只能由 `failure.ts` 的 `retryableFor()` 判定；
 * 其他模块硬写 `retryable: true` 就是绕过分类的后门（发消息类错误分类一次就重复打扰）。
 */
function checkH3() {
  const dir = join(repo, "src", "execution");
  const issues = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    if (name === "failure.ts" || name === "types.ts") continue;
    const text = readFileSync(join(dir, name), "utf8");
    if (/retryable:\s*true/.test(text)) issues.push(`H3：src/execution/${name} 硬写 retryable=true（应由 failure.ts 判定）`);
  }
  const failure = readFileSync(join(dir, "failure.ts"), "utf8");
  if (!failure.includes("retryableFor")) issues.push("H3：failure.ts 缺 retryableFor");
  if (!failure.includes("RETRYABLE_CLASSES")) issues.push("H3：failure.ts 缺 RETRYABLE_CLASSES 白名单");
  if (issues.length === 0) passed.push("H3 重试纪律：只有 TRANSIENT 可重试，其他模块没有硬写 retryable=true");
  else problems.push(...issues);
}

/** H4：每次尝试都要有起点与终点，否则重放看不出成功还是失败。 */
function checkH4() {
  const gateway = readFileSync(join(repo, "src", "execution", "gateway.ts"), "utf8");
  const issues = [];
  if (!/status:\s*"start"/.test(gateway)) issues.push('H4：gateway 没有 status: "start" 事件');
  if (!/status:\s*"succeeded"/.test(gateway)) issues.push('H4：gateway 没有 status: "succeeded" 事件');
  if (!/status:\s*"failed"/.test(gateway)) issues.push('H4：gateway 没有 status: "failed" 事件');
  if (issues.length === 0) passed.push("H4 尝试事件：gateway 同时落 start 与 succeeded/failed");
  else problems.push(...issues);
}

checkH2();
checkH3();
checkH4();
checkH11();
checkH12();

if (asJson) {
  process.stdout.write(`${JSON.stringify({ problems, warnings, passed, seen: Object.fromEntries(seen) }, null, 2)}\n`);
} else {
  for (const line of warnings) process.stdout.write(`WARN ${line}\n`);
  if (problems.length === 0) {
    for (const line of passed) process.stdout.write(`PASS ${line}\n`);
    process.stdout.write(`PASS 执行层门禁：${String(seen.size)} 个文件出现直连发送点，均未超过豁免上限\n`);
  } else {
    for (const line of problems) process.stdout.write(`FAIL ${line}\n`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
