#!/usr/bin/env node
/**
 * vitest 包装器 —— 两个目的：
 *
 * 1. 把临时目录指到工作区内。本机工具进程是 Low 完整性，`%LOCALAPPDATA%\Temp` 不可写，
 *    vitest 建临时目录会 EPERM（症状：`mkdir ... EPERM`，随后 `no tests`）。
 * 2. **把真实退出码透出去**。早先版本用 `startVitest()` API + `getCountOfFailedTests()`
 *    自己算退出码，但这个 API 在若干版本里返回 undefined，`?? 0` 会把"有失败"变成"全绿"——
 *    曾实测到 `Tests 1 failed | 359 passed` 却 exit 0。宁可多一层子进程，也不要假绿。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmp = fileURLToPath(new URL("../.tmp", import.meta.url));
mkdirSync(tmp, { recursive: true });

const bin = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [bin, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
});

if (result.error !== undefined) {
  console.error(`run-vitest: 无法启动 vitest：${String(result.error)}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
