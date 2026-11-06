/**
 * 桌面工具层：让她（或用户）能看见这台电脑的屏幕、也能动手操作。
 *
 * 边界（PLAN-3LAYER Phase 4 / 大脑与脊髓.txt）：
 * - 这里**只是工具层**：不判断"该不该动"，不读状态、不写记忆。决策在大脑，编排在脊髓。
 * - 真正碰操作系统的活全在 `tools/desktop/desktop.ps1`（PowerShell + user32），
 *   这个文件负责**校验、授权、记账**——不是"能做什么"，是"允许做什么"。
 * - 输入（点击/打字/按键）默认**关着**：`DesktopPolicy.allowInput=false` 时一律拒绝。
 *   授权只给显式开闸的调用方（用户 H6 已授权，但闸门仍留在代码里，见 PLAN 的"工具层授权"）。
 * - 屏幕截图是只读观察，不需要额外授权，但文件落 `data/screens/`，只留最近若干张。
 *
 * 为什么把 PowerShell 当执行器而不是装原生模块：她跑在计划任务里，装机依赖越少越不容易
 * 在重启后失效；PowerShell + System.Drawing 是 Windows 自带的，没有额外安装面。
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  appendAudit,
  authorizeLease,
  readLease,
  writeLease,
  type DesktopAuditEntry,
  type DesktopLeaseFile,
} from "./lease.js";

export type DesktopAction = "screen" | "windows" | "click" | "type" | "key";

export interface DesktopRequest {
  readonly action: DesktopAction;
  readonly x?: number;
  readonly y?: number;
  readonly text?: string;
  readonly keys?: string;
}

export interface DesktopPolicy {
  /** 输入授权：false 时点击/打字/按键一律拒绝（截图和列窗口不受影响）。 */
  readonly allowInput: boolean;
  /** 单次打字最多多少字符（防手滑把整段文档打进别人窗口）。 */
  readonly maxTextChars?: number;
}

export interface DesktopDeps {
  readonly powershellExe: string;
  readonly scriptPath: string;
  readonly outDir: string;
  readonly now: () => number;
  readonly log?: (msg: string) => void;
  /**
   * 租约文件路径（可选）：给了之后，输入动作除了 `allowInput` 还必须有一张有效租约。
   * 租约记录"谁授权、允许哪几类、几次、何时过期"，每次成功消耗一次并原子写回。
   * 不给 = 不做租约判定（测试用；真实 CLI / 装配点都会给）。
   */
  readonly leasePath?: string;
  /** 审计日志路径（可选）：每一次动作（含被拒）都追加一行 NDJSON。 */
  readonly auditPath?: string;
  /** 注入执行器：测试里替换掉真实 spawn，不碰用户的鼠标键盘。 */
  readonly exec?: (cmd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface DesktopResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly path?: string;
  readonly data?: unknown;
}

const DEFAULT_MAX_TEXT_CHARS = 500;
/** 屏幕坐标上限：8K 分辨率也就 7680 宽，留足余量但不给离谱值。 */
const MAX_COORD = 20_000;

/** 允许的按键名单（SendKeys 只认这些，别的拼错会静默乱按）。 */
const KEY_NAMES: ReadonlySet<string> = new Set([
  "ENTER", "TAB", "ESC", "SPACE", "BACKSPACE", "DELETE",
  "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PGUP", "PGDN",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  ..."0123456789".split(""),
]);

/**
 * "CTRL+S" → SendKeys 的 "^s"。纯函数，方便测。
 * 允许的修饰键只有 CTRL/SHIFT/ALT，主键必须在 `KEY_NAMES` 里；其余一律 null（调用方拒绝）。
 */
export function toSendKeys(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed.length > 40) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.length > 4) return null;
  const main = parts[parts.length - 1]?.toUpperCase() ?? "";
  if (!KEY_NAMES.has(main)) return null;
  let prefix = "";
  for (const mod of parts.slice(0, -1)) {
    const m = mod.toUpperCase();
    if (m === "CTRL" || m === "CONTROL") prefix += "^";
    else if (m === "SHIFT") prefix += "+";
    else if (m === "ALT") prefix += "%";
    else return null;
  }
  const key = main.length === 1 ? main.toLowerCase() : `{${main}}`;
  return prefix + key;
}

/** 把任意文本转成 SendKeys 能安全发送的形式（特殊字符加花括号转义）。 */
export function escapeSendKeys(text: string): string {
  let out = "";
  for (const ch of text) {
    out += "{}()+^%~[]".includes(ch) ? `{${ch}}` : ch;
  }
  return out;
}

/** 参数校验：返回 null 表示可以执行，否则是拒绝原因（人类可读）。 */
export function validateRequest(req: DesktopRequest, policy: DesktopPolicy): string | null {
  const needsInput = req.action === "click" || req.action === "type" || req.action === "key";
  if (needsInput && !policy.allowInput) return "desktop: 输入未授权（DesktopPolicy.allowInput=false）";
  switch (req.action) {
    case "screen":
    case "windows":
      return null;
    case "click": {
      const { x, y } = req;
      if (x === undefined || y === undefined) return "desktop: click 需要 x 和 y";
      if (!Number.isInteger(x) || !Number.isInteger(y)) return "desktop: 坐标必须是整数";
      if (x < 0 || y < 0 || x > MAX_COORD || y > MAX_COORD) return `desktop: 坐标越界（0..${MAX_COORD}）`;
      return null;
    }
    case "type": {
      const text = req.text ?? "";
      const max = policy.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
      if (text === "") return "desktop: type 的文本为空";
      if (text.length > max) return `desktop: 文本过长（${text.length} > ${max}）`;
      return null;
    }
    case "key":
      return toSendKeys(req.keys ?? "") === null ? "desktop: 按键写法不认识（例如 CTRL+S / ENTER）" : null;
    default:
      return "desktop: 不认识的动作";
  }
}

/** 组装 PowerShell 参数（纯函数，测试里直接断言，不真的跑）。 */
export function buildArgs(deps: DesktopDeps, req: DesktopRequest, outPath: string): string[] {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    deps.scriptPath,
    "-Action",
    req.action,
    "-OutPath",
    outPath,
  ];
  if (req.action === "click") args.push("-X", String(req.x), "-Y", String(req.y));
  if (req.action === "type") args.push("-Text", escapeSendKeys(req.text ?? ""));
  if (req.action === "key") args.push("-Keys", toSendKeys(req.keys ?? "") ?? "");
  return args;
}

function defaultExec(cmd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 从 PowerShell 的输出里抠最后一行 JSON（前面可能有警告/加载噪音）。 */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * 执行一次桌面动作。永不 reject：失败也是 `{ok:false, detail}`，
 * 因为工具层失败要能被脊髓分类成"可重试/不可重试"，而不是把整拍炸掉。
 */
/**
 * 截图只留最近 N 张（默认 20）。
 *
 * 一张全屏 PNG 两兆上下，每拍都截会把磁盘吃满——工具层自己管自己的垃圾，
 * 不指望别人来清。删不掉就算了（文件可能正被别的进程打开），不抛。
 */
export function pruneScreens(dir: string, keep = 20): number {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("screen-") && n.endsWith(".png"));
  } catch {
    return 0;
  }
  if (names.length <= keep) return 0;
  const byAge = names
    .map((name) => {
      const full = join(dir, name);
      let at = 0;
      try {
        at = statSync(full).mtimeMs;
      } catch {
        at = 0;
      }
      return { name, at };
    })
    .sort((a, b) => b.at - a.at);
  let removed = 0;
  for (const entry of byAge.slice(keep)) {
    try {
      unlinkSync(join(dir, entry.name));
      removed += 1;
    } catch {
      /* 删不掉不影响本次截图 */
    }
  }
  return removed;
}

const INPUT_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "key"]);

function audit(deps: DesktopDeps, entry: DesktopAuditEntry): void {
  if (deps.auditPath !== undefined) appendAudit(deps.auditPath, entry);
}

export async function runDesktop(req: DesktopRequest, deps: DesktopDeps, policy: DesktopPolicy): Promise<DesktopResult> {
  const refused = validateRequest(req, policy);
  if (refused !== null) {
    deps.log?.(`[desktop] 拒绝：${refused}`);
    audit(deps, { at: deps.now(), action: req.action, ok: false, detail: refused });
    return { ok: false, detail: refused };
  }

  // 租约：只对输入动作、且只在调用方给了 leasePath 时判定。
  const needsInput = INPUT_ACTIONS.has(req.action);
  let leaseAfter: DesktopLeaseFile | null = null;
  if (needsInput && deps.leasePath !== undefined) {
    const decision = authorizeLease(readLease(deps.leasePath), deps.now(), req.action as "click" | "type" | "key");
    if (!decision.ok) {
      const detail = `desktop: 输入被租约拒绝（${decision.reason}）`;
      deps.log?.(`[desktop] 拒绝：${detail}`);
      audit(deps, { at: deps.now(), action: req.action, ok: false, detail });
      return { ok: false, detail };
    }
    leaseAfter = decision.lease;
  }

  const at = deps.now();
  const stamp = at.toString(36);
  const outPath = req.action === "screen" ? join(deps.outDir, `screen-${stamp}.png`) : join(deps.outDir, `noop-${stamp}.txt`);
  if (req.action === "screen") mkdirSync(deps.outDir, { recursive: true });
  const exec = deps.exec ?? defaultExec;
  const args = buildArgs(deps, req, outPath);
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await exec(deps.powershellExe, args);
  } catch (err) {
    deps.log?.(`[desktop] 执行抛错：${String(err)}`);
    return { ok: false, detail: `desktop: 执行失败（${String(err)}）` };
  }
  const payload = lastJsonLine(result.stdout);
  const ok = result.code === 0 && payload !== null && (payload as { ok?: unknown }).ok !== false;
  if (!ok) {
    const errText = (payload as { error?: unknown } | null)?.error;
    const detail = typeof errText === "string" ? errText : result.stderr.trim() || `退出码 ${result.code}`;
    deps.log?.(`[desktop] 失败 action=${req.action}：${detail}`);
    audit(deps, { at, action: req.action, ok: false, detail: `desktop: ${detail}` });
    return { ok: false, detail: `desktop: ${detail}` };
  }
  if (req.action === "screen") {
    const pruned = pruneScreens(deps.outDir);
    if (pruned > 0) deps.log?.(`[desktop] 清掉 ${pruned} 张旧截图`);
  }
  if (leaseAfter !== null && deps.leasePath !== undefined) {
    // 只有真的执行成功才消耗次数：失败不该扣掉一次授权。
    if (!writeLease(deps.leasePath, leaseAfter)) deps.log?.("[desktop] 租约写回失败（动作已执行）");
  }
  audit(deps, {
    at,
    action: req.action,
    ok: true,
    detail: `desktop: ${req.action} 完成`,
    ...(leaseAfter === null
      ? {}
      : { lease: { grantedBy: leaseAfter.grantedBy, used: leaseAfter.used, maxActions: leaseAfter.maxActions } }),
    ...(req.action === "screen" ? { path: outPath } : {}),
  });
  deps.log?.(`[desktop] 完成 action=${req.action}${req.action === "screen" ? ` path=${outPath}` : ""}`);
  return {
    ok: true,
    detail: `desktop: ${req.action} 完成`,
    ...(req.action === "screen" ? { path: outPath } : {}),
    data: payload,
  };
}
