#!/usr/bin/env node
/**
 * 桌面工具层的命令行入口（给用户/给调试用的那双手）。
 *
 * 用法（在仓库根跑）：
 *   node tools/desktop/cli.mjs windows                    # 列出现在开着的窗口（只读）
 *   node tools/desktop/cli.mjs screen                     # 截一张全屏图 → data/screens/
 *   node tools/desktop/cli.mjs lease                      # 看输入授权还剩多少（只读）
 *   node tools/desktop/cli.mjs grant --minutes 5 --max-actions 3 --granted-by "用户"
 *                                                        # 显式授权：5 分钟内最多 3 次输入
 *   node tools/desktop/cli.mjs click 800 600              # 消耗一次授权
 *   node tools/desktop/cli.mjs type "你好"
 *   node tools/desktop/cli.mjs key "CTRL+S"
 *
 * 授权模型（F159）：
 * - 输入动作**不再**靠 `--allow-input` 一个开关，而是要一张「租约」：谁授权、允许哪几类、
 *   几次、何时过期；每次成功消耗一次，用完/过期即拒绝。
 * - `--allow-input` 保留为「当场授权一次」的便捷写法：临时写一张 1 次 / 1 分钟的租约。
 * - 每一次动作（含被拒）都追加一行到 data/desktop-actions.ndjson，事后能回答"谁在什么时候动了电脑"。
 */

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDesktop } from "../../dist/desktop/desktop.js";
import {
  createLease,
  defaultAuditPath,
  defaultLeasePath,
  leaseStatus,
  readLease,
  writeLease,
} from "../../dist/desktop/lease.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const dataDir = process.env.ACE_DATA_DIR ?? join(repo, "data");
const leasePath = defaultLeasePath(dataDir);
const auditPath = defaultAuditPath(dataDir);

const argv = process.argv.slice(2);
const allowInput = argv.includes("--allow-input");
const args = argv.filter((a) => a !== "--allow-input");
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? fallback;
};

const action = args[0];
const known = new Set(["screen", "windows", "lease", "grant", "click", "type", "key"]);
if (action === undefined || !known.has(action)) {
  console.error(
    "用法：node tools/desktop/cli.mjs <screen|windows|lease|grant|click|type|key> [参数]\n"
      + "      grant --minutes 5 --max-actions 3 --granted-by \"用户\"\n"
      + "      click x y | type \"文本\" | key \"CTRL+S\"   （需要有效租约；--allow-input = 当场授权一次）",
  );
  process.exit(2);
}

if (action === "lease") {
  const status = leaseStatus(readLease(leasePath), Date.now());
  console.log(JSON.stringify({ ...status, leasePath }, null, 2));
  process.exit(0);
}

if (action === "grant") {
  const minutes = Number(flag("--minutes", "5"));
  const maxActions = Number(flag("--max-actions", "3"));
  const grantedBy = String(flag("--granted-by", "用户"));
  const lease = createLease({ now: Date.now(), minutes, maxActions, grantedBy });
  if (!writeLease(leasePath, lease)) {
    console.error(`写租约失败：${leasePath}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ granted: lease, leasePath }, null, 2));
  process.exit(0);
}

// 输入动作：先确保有一张可用租约。--allow-input = 当场造一张 1 次 / 1 分钟的租约。
if (action === "click" || action === "type" || action === "key") {
  if (allowInput) {
    writeLease(leasePath, createLease({ now: Date.now(), minutes: 1, maxActions: 1, grantedBy: "cli --allow-input" }));
  }
  const status = leaseStatus(readLease(leasePath), Date.now());
  if (status.state !== "active") {
    console.error(`[desktop] 输入被拒绝：${status.detail}\n先运行 grant（或在命令行加 --allow-input 授权一次）。`);
    process.exit(1);
  }
}

const req = { action };
if (action === "click") {
  req.x = Number(args[1]);
  req.y = Number(args[2]);
}
if (action === "type") req.text = args[1] ?? "";
if (action === "key") req.keys = args[1] ?? "";

const result = await runDesktop(
  req,
  {
    powershellExe: process.env.ACE_POWERSHELL ?? "powershell",
    scriptPath: join(repo, "tools", "desktop", "desktop.ps1"),
    outDir: join(repo, "data", "screens"),
    now: () => Date.now(),
    log: (m) => console.error(m),
    leasePath,
    auditPath,
  },
  { allowInput: true, maxTextChars: 2000 },
);

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
