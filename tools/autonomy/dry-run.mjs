#!/usr/bin/env node
/**
 * 自主运行器 dry-run：跑一轮，只报告会做什么。
 *
 * 用法：
 *   node tools/autonomy/dry-run.mjs            # 用当前时间
 *   node tools/autonomy/dry-run.mjs --hour 3   # 假装现在是 3 点（验证睡眠巩固）
 *
 * 它不写状态、不发消息、不碰她的记忆；锁只临时创建在 data/.autonomy-dryrun.lock 并立即释放。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDryTick } from "../../dist/autonomy/dryrun.js";

const args = process.argv.slice(2);
const hourArg = args.indexOf("--hour");
const now = Date.now();
const localHour = hourArg >= 0 ? Number(args[hourArg + 1]) : new Date(now).getHours();
if (!Number.isFinite(localHour) || localHour < 0 || localHour > 23) {
  console.error("--hour 需要 0–23 的整数");
  process.exit(2);
}
const dataDir = join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const result = await runDryTick({
  now,
  localHour,
  lockPath: join(dataDir, ".autonomy-dryrun.lock"),
  tzOffsetMinutes: -new Date().getTimezoneOffset(),
});
console.log(JSON.stringify({
  kind: "autonomy-dry-run",
  at: new Date(now).toISOString(),
  localHour,
  plan: result.plan,
  log: result.log,
  lockLeft: result.lockLeft,
}, null, 2));
