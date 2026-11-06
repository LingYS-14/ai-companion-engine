#!/usr/bin/env node
/**
 * 把「她」的运行时发布到独立目录：DSH 插件只观察，她在自己的目录里跑。
 *
 *   node scripts/autonomy/publish-runtime.mjs              # 停 → 复制 → 起（默认，安全）
 *   node scripts/autonomy/publish-runtime.mjs --no-restart  # 只复制（她当时必须已停）
 *   node scripts/autonomy/publish-runtime.mjs --check       # 只比对时间戳
 *   node scripts/autonomy/publish-runtime.mjs --guard-only  # 只跑发布守卫（不 stop/不复制/不启动）
 *   node scripts/autonomy/publish-runtime.mjs --force-dirty # 紧急出口：脏树也照发（会警告，慎用）
 *   node scripts/autonomy/publish-runtime.mjs --dir D:\ase-runtime
 *
 * F320 发布守卫：工作树有 tracked 改动、或 repo/dist 缺失 → 拒绝发布（复制的是工作副本，
 * 半成品会像 2026-11-01 16:22 那样启动失败）；src mtime 比 dist 新只警告（锁验证还原会推后 mtime）。
 *
 * 为什么默认「停 → 复制 → 起」：Windows 上 node 进程占着 main.mjs/ dist 文件，
 * 运行中删除/覆盖会 EPERM（实测 2026-10-30）。所以发布是维护动作，不是热更新。
 *
 * 复制：dist、spec、scripts、tools/report、tools/audit、tools/voice、cordis.patch.yml
 * 链接：data / docs / assets / .pylibs 用 junction 指回仓库——状态只有一份，
 *       观察端口（DSH 插件）与她看的是同一批文件，避免双写分裂。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// F320 发布守卫：纯函数在 publish-guard.mjs，单测见 test/publish-guard.test.ts。
import { assessPublish, collectNewestMtimeMs } from "./publish-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..");
const argDir = process.argv.indexOf("--dir");
const dest = resolve(argDir >= 0 ? process.argv[argDir + 1] : process.env.ACE_RUNTIME_DIR ?? "C:\\AI\\ai-companion-runtime");
const checkOnly = process.argv.includes("--check");
const noRestart = process.argv.includes("--no-restart");
// F320：脏树/过期 dist 的守卫；--force-dirty 是紧急出口，--guard-only 是只检查不发布的干跑。
const forceDirty = process.argv.includes("--force-dirty");
const guardOnly = process.argv.includes("--guard-only");
const taskName = "ASE-Autonomy";
const characterId = process.env.ACE_CHARACTER_ID ?? "assistant";

const COPY = ["dist", "spec", "scripts", "cordis.patch.yml", "tools/report", "tools/audit", "tools/voice", "tools/intent", "tools/presence"];
const LINK = ["data", "docs", "assets", ".pylibs"];

function ps(command) {
  // windowsHide: 发布脚本自己也可能被从没有控制台的父进程调起（如计划任务/编辑器任务），
  // 不隐藏就会闪一个 PowerShell 黑框（2026-10-31 用户反馈：不时弹 cmd 窗口）。
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
  return { status: r.status, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") };
}

// 复制完必须验证"运行时真的拿得到"的文件：漏一个 = 线上某个功能静默失效
// （2026-10-31 F143：COPY 漏了 tools/voice，SAPI 兜底在线上会直接找不到脚本）。
const REQUIRED = [
  "dist/plugin/runtime.js",
  "dist/qq/voice.js",
  "dist/autonomy/qq-runner.js",
  "scripts/autonomy/main.mjs",
  "scripts/autonomy/health.mjs",
  "tools/voice/asr.py",
  "tools/voice/tts.ps1",
  // F237：早报/状态/DSH 桥的只读 CLI 都在 tools/intent；漏了它们，runtime 里的早报只能报「跑不起来」
  "tools/intent/dashboard.mjs",
  "tools/intent/activity.mjs",
  // F247：在场信号探针；漏了它主进程每拍都会探测失败 → 她永远"不知道他在不在"
  "tools/presence/activity.ps1",
  "cordis.patch.yml",
];

if (checkOnly) {
  for (const rel of ["dist", "spec", "scripts"]) {
    const pick = (base) => {
      try {
        return new Date(readFileSync(join(base, rel, rel === "scripts" ? "autonomy/main.mjs" : rel === "dist" ? "plugin/runtime.js" : "config/engine.json"))).toISOString();
      } catch {
        return "缺失";
      }
    };
    console.log(`${rel}: 源 ${pick(src)} / 运行时 ${pick(dest)}`);
  }
  process.exit(0);
}

// F320 发布守卫：复制的是工作副本，脏树/过期 dist 会让运行时不配套。
// 事故来源：2026-11-01 16:22 main.mjs 已是半成品、dist 还是旧构建，启动即 TypeError。
// 只做检查，不碰 daemon；--guard-only 可用于发布前干跑。
{
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: src, encoding: "utf8" });
  if (status.status !== 0) {
    console.warn("发布守卫：读不到 git status，跳过脏树检查（dist 新鲜度仍会检查）。");
  }
  const verdict = assessPublish({
    statusPorcelain: status.status === 0 ? String(status.stdout ?? "") : "",
    repoDistNewestMs: collectNewestMtimeMs(join(src, "dist")),
    repoSrcNewestMs: collectNewestMtimeMs(join(src, "src")),
    allowDirty: forceDirty,
  });
  if (!verdict.ok) {
    console.error("发布守卫拒绝发布：");
    for (const reason of verdict.reasons) console.error(`  - ${reason}`);
    console.error("修：先 commit（工作树只应剩 ?? 文件）；或先 npm run build。确需强发加 --force-dirty。");
    process.exit(1);
  }
  for (const warning of verdict.warnings) console.warn(`发布守卫（警告）：${warning}`);
  if (verdict.reasons.length === 0 && verdict.warnings.length === 0) {
    console.log("发布守卫：工作树干净、dist 不早于 src。");
  } else if (verdict.reasons.length === 0) {
    console.log("发布守卫：检查通过（有警告，见上）。");
  }
  if (guardOnly) {
    console.log("发布守卫：--guard-only 检查通过，未停进程、未复制、未启动。");
    process.exit(0);
  }
}

if (!noRestart) {
  const stopScript = join(dest, "scripts", "autonomy", "stop.ps1");
  if (existsSync(stopScript)) {
    const r = ps(`& '${stopScript.replaceAll("'", "''")}' -TimeoutSeconds 30`);
    console.log(r.status === 0 ? "已停：她的进程" : `停止时有问题（继续发布）：${r.err.slice(-200)}`);
  }
}

mkdirSync(dest, { recursive: true });
for (const rel of COPY) {
  const from = join(src, rel);
  if (!existsSync(from)) {
    console.log(`跳过（源里没有）：${rel}`);
    continue;
  }
  const to = join(dest, rel);
  try {
    // F284：先 rm 再 cp 在 Windows 上会偶发 EPERM（目录被别的进程的资源管理器/扫描器短暂占用），
    // 而且它把「目录本身」当成必须重建的东西。改成尽量删除、删不掉就合并覆盖：
    // 内容用 force 覆盖，残留旧文件由 REQUIRED 校验兜底（漏了会报出来）。
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      // 删不掉就合并（cpSync 会把 from 的内容覆盖进已存在的目录）
    }
    cpSync(from, to, { recursive: true, force: true });
    console.log(`复制：${rel}`);
  } catch (error) {
    console.error(`复制失败：${rel} → ${String(error)}`);
    console.error("她在跑的时候不能覆盖；用默认模式（会先 stop）或先运行 stop.ps1。");
    process.exit(1);
  }
}

const pkgPath = join(dest, "package.json");
if (!existsSync(pkgPath)) {
  writeFileSync(pkgPath, `${JSON.stringify({ name: "ai-companion-runtime", private: true, type: "module" }, null, 2)}\n`, "utf8");
  console.log("生成：package.json");
}

for (const rel of LINK) {
  const target = join(src, rel);
  if (!existsSync(target)) {
    console.log(`跳过链接（仓库里没有）：${rel}`);
    continue;
  }
  const linkPath = join(dest, rel);
  if (existsSync(linkPath)) {
    console.log(`已存在：${rel}`);
    continue;
  }
  const r = ps(`New-Item -ItemType Junction -Path '${linkPath.replaceAll("'", "''")}' -Target '${target.replaceAll("'", "''")}' | Out-Null`);
  if (r.status !== 0) {
    console.error(`junction 失败：${rel} → ${target}\n${r.err}`);
    process.exit(1);
  }
  console.log(`链接：${rel} → ${target}`);
}

// 到位校验：漏文件时**不要**再往下走（宁可不发布，也不要发一个少零件的运行时）。
const missing = REQUIRED.filter((rel) => !existsSync(join(dest, rel)));
if (missing.length > 0) {
  console.error(`运行时缺文件（${String(missing.length)} 个）：${missing.join("、")}`);
  console.error("多半是 COPY 清单漏了一项；补上后重跑 publish-runtime。");
  process.exit(1);
}
console.log(`校验：${String(REQUIRED.length)} 个关键文件都在`);

const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
writeFileSync(
  join(dest, "RUNTIME.json"),
  `${JSON.stringify({ publishedAt: new Date().toISOString(), version: pkg.version, source: src }, null, 2)}\n`,
  "utf8",
);

/**
 * F292：不要相信 `Start-ScheduledTask` 的退出码。
 *
 * 2026-11-01 凌晨的教训：本机计划任务不可用（schtasks/Get-ScheduledTask 全报
 * "系统找不到指定的路径"），但 `Start-ScheduledTask` 失败是 non-terminating error，
 * PowerShell 进程照样 exit 0 —— 发布脚本打印"已起：任务 ASE-Autonomy"，实际上她根本没起来，
 * 而且没有一行报错。那天是靠人肉发现 pid 文件不存在才查出来。
 *
 * 所以这里改成：起完之后**看 pid 文件、看进程**；没起来就用 wscript 直接拉（VBS 无窗口启动器
 * F198），再等一次。两条都不行才报错退出——宁可发布失败，也不要"看起来成功"。
 */
const pidPath = join(dest, "data", `autonomy-${characterId}.pid`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 在 Windows 上常是 PID 被别的（系统）进程复用；发布检查只认"读得到 pid 且能探到"，
    // 宁可比锁更保守——反正随后的 health 会给出权威判断。
    return err.code !== "ESRCH";
  }
};
const readPid = () => {
  try {
    const raw = JSON.parse(readFileSync(pidPath, "utf8"));
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
};
const waitForPid = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid !== null && processAlive(pid)) return pid;
    await sleep(500);
  }
  return null;
};

if (!noRestart) {
  const r = ps(`Start-ScheduledTask -TaskName '${taskName}'; Start-Sleep -Seconds 3`);
  if (r.status !== 0) console.warn(`计划任务启动命令报错（继续尝试直接拉起）：${r.err.trim()}`);
  let pid = await waitForPid(15_000);
  if (pid === null) {
    console.warn("计划任务没有把她拉起来（本机任务可能不可用）。改用 wscript 无窗口启动器直接拉…");
    const launcher = join(dest, "scripts", "autonomy", "start-hidden.vbs");
    if (!existsSync(launcher)) {
      console.error(`启动失败：计划任务没起来，且没有无窗口启动器 ${launcher}`);
      console.error("修：确认本机计划任务可用，或先手工运行 scripts/autonomy/start.ps1。");
      process.exit(1);
    }
    const fallback = ps(`Start-Process -FilePath 'wscript.exe' -ArgumentList '"${launcher}"' -WindowStyle Hidden`);
    if (fallback.status !== 0) console.warn(`wscript 启动器报错（继续看 pid）：${fallback.err.trim()}`);
    pid = await waitForPid(25_000);
  }
  if (pid === null) {
    console.error("启动失败：等不到 pid 文件（她的进程没起来）。");
    console.error("排查：看 data/autonomy-<id>.log 最后几行，或手工 scripts/autonomy/start.ps1。");
    process.exit(1);
  }
  console.log(`已起：pid ${pid}（计划任务不可用时自动改用无窗口启动器）`);
} else {
  console.log("只复制，没有重启她的进程。");
}

console.log(`\n运行时：${dest}`);
