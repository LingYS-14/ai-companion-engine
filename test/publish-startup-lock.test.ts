import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * F292：发布脚本不能"看起来成功"。
 *
 * 2026-11-01 凌晨的事故：本机 Task Scheduler 不可用（schtasks / Get-ScheduledTask 全报
 * "系统找不到指定的路径"），而 `Start-ScheduledTask` 失败是 non-terminating error，
 * PowerShell 照样 exit 0。发布脚本于是打印「已起：任务 ASE-Autonomy」，实际上她没有起来，
 * 靠人肉发现 pid 文件不存在才查出来。
 *
 * 这里锁住：①起完要看 pid 文件；②计划任务不可用时要退到 wscript 无窗口启动器；
 * ③两条都不行必须非零退出；④不允许再出现只凭任务命令退出码就打印成功。
 */

const ROOT = process.cwd();
const SCRIPT = readFileSync(join(ROOT, "scripts", "autonomy", "publish-runtime.mjs"), "utf8");

describe("发布脚本的启动校验（F292）", () => {
  it("起完之后读 pid 文件并确认进程在（不是只看命令退出码）", () => {
    expect(SCRIPT).toContain("const waitForPid");
    expect(SCRIPT).toContain("readPid()");
    expect(SCRIPT).toContain("processAlive(");
    expect(SCRIPT).toContain("等不到 pid 文件");
  });

  it("计划任务拉不起来时退到 wscript 无窗口启动器，而不是直接宣布成功", () => {
    expect(SCRIPT).toContain("start-hidden.vbs");
    expect(SCRIPT).toContain("计划任务没有把她拉起来");
    expect(SCRIPT).toContain("wscript.exe");
  });

  it("两条路都失败必须报错退出（宁可发布失败，也不要静默假成功）", () => {
    expect(SCRIPT).toContain("启动失败：等不到 pid 文件");
    expect(SCRIPT).toMatch(/启动失败：等不到 pid 文件[\s\S]{0,200}?process\.exit\(1\)/);
  });

  it("不再有「已起：任务」这种凭退出码宣布成功的文案", () => {
    expect(SCRIPT).not.toContain("console.log(`已起：任务");
    expect(SCRIPT).toContain("console.log(`已起：pid");
  });

  it("守夜人循环文件存在且是纯 ASCII + 关窗口（本机任务不可用时的替代）", () => {
    const vbs = readFileSync(join(ROOT, "scripts", "autonomy", "watchdog-loop.vbs"), "utf8");
    // 纯 ASCII：VBScript 宿主按 ANSI 读 .vbs，中文注释会变乱码把脚本弄坏（F198 的教训）
    expect(/^[\x00-\x7F]*$/.test(vbs)).toBe(true);
    expect(vbs).toContain("autonomy-assistant.pid");
    expect(vbs).toContain("start-hidden.vbs");
    expect(vbs).toContain("Win32_Process");
  });
});
