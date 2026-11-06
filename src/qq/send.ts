import type { OpsResult } from "./ops.js";

/**
 * 发消息的「手」。
 *
 * 通道的本质是：把内容放进剪贴板 → 点 QQ 输入框 → Ctrl+V → Enter。
 * 以前这条链路由 `qq.sh` 拼 3 个 bash 完成（每个 300–500ms，还依赖 PATH 里
 * 恰好有 coreutils）。现在鼠标键盘全部走宿主输入桥的文件队列（`opsCall`），
 * 只剩「设剪贴板」这一步必须借用一次 PowerShell（Node 没有剪贴板 API）。
 *
 * 三种内容共用同一条链路，只有剪贴板那一步不同：
 *   - `text`  → 纯文本（UTF-8 文件交给 PowerShell 读，避免命令行编码问题）
 *   - `image` → 位图（`Clipboard::SetImage`，QQ 收到后按图片发）
 *   - `file`  → 文件列表（`Set-Clipboard -Path`，QQ 收到后按文件发）
 */

export type ClipKind = "text" | "image" | "file";

export interface SendTarget {
  readonly kind: ClipKind;
  /** text → 正文；image / file → 绝对路径 */
  readonly payload: string;
}

export interface SendDeps {
  readonly call: (cmd: Record<string, unknown>) => Promise<OpsResult>;
  readonly setClipboard: (kind: ClipKind, payload: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly hwnd: () => number;
  readonly log?: (line: string) => void;
  /** 窗口最小化时还原后等它真正显示出来 */
  readonly restoreDelayMs?: number;
  /** 粘贴前等输入框取得焦点 */
  readonly focusDelayMs?: number;
  /** 粘贴后等 QQ 处理完内容 */
  readonly pasteDelayMs?: number;
}

export interface SendOutcome {
  readonly ok: boolean;
  readonly kind: ClipKind;
  readonly ms: number;
  readonly error?: string;
  readonly point?: { readonly x: number; readonly y: number };
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 输入框在 QQ 主窗里的相对位置——与 `qq.sh send` 保持同一组比例。 */
export const INPUT_X_RATIO = 0.6;
export const INPUT_Y_RATIO = 0.91;

export function inputPoint(rect: Rect): { x: number; y: number } {
  const x = Math.round(rect.left + (rect.right - rect.left) * INPUT_X_RATIO);
  const y = Math.round(rect.top + (rect.bottom - rect.top) * INPUT_Y_RATIO);
  return { x, y };
}

function rectOf(result: OpsResult | undefined): Rect | null {
  const r = result?.result;
  if (r === undefined) return null;
  const nums = [r["left"], r["top"], r["right"], r["bottom"]];
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [left, top, right, bottom] = nums as [number, number, number, number];
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

export async function sendNow(deps: SendDeps, target: SendTarget): Promise<SendOutcome> {
  // 量延迟用单调时钟（本层不读墙钟：CI 的 writers 闸会拦）
  const started = performance.now();
  const fail = (error: string): SendOutcome => ({
    ok: false,
    kind: target.kind,
    ms: Math.round(performance.now() - started),
    error,
  });

  const hwnd = deps.hwnd();

  // 最小化时 `rect` 仍在、但坐标是 -32000 那种屏外值。上一版直接照着点，
  // 焦点落在别的窗口、正文粘到不该粘的地方，而返回值还是 ok=true。
  // 现在先看窗口状态：最小化就先还原；坐标不可信就报错，不硬发。
  const visible = await deps.call({ op: "visible", hwnd });
  if (visible.ok && visible.result?.["iconic"] === true) {
    const restored = await deps.call({ op: "focus", hwnd });
    if (!restored.ok) return fail(`窗口最小化且还原失败：${restored.error ?? "未知"}`);
    await deps.sleep(deps.restoreDelayMs ?? 600);
  }

  const rectRes = await deps.call({ op: "rect", hwnd });
  if (!rectRes.ok) return fail(`rect 失败：${rectRes.error ?? "未知"}`);
  const rect = rectOf(rectRes);
  if (rect === null) return fail("取不到窗口矩形（QQ 可能已关闭）");
  if (rect.left < -10_000 || rect.top < -10_000) {
    return fail(`窗口坐标不可用（left=${rect.left}, top=${rect.top}），没有发送`);
  }

  const point = inputPoint(rect);

  try {
    await deps.setClipboard(target.kind, target.payload);
  } catch (err) {
    return fail(`设剪贴板失败：${(err as Error).message}`);
  }

  const focus = await deps.call({ op: "focus", hwnd });
  if (!focus.ok) return fail(`focus 失败：${focus.error ?? "未知"}`);
  const click = await deps.call({ op: "click", x: point.x, y: point.y });
  if (!click.ok) return fail(`点击输入框失败：${click.error ?? "未知"}`);

  await deps.sleep(deps.focusDelayMs ?? 250);
  const paste = await deps.call({ op: "paste" });
  if (!paste.ok) return fail(`粘贴失败：${paste.error ?? "未知"}`);

  await deps.sleep(deps.pasteDelayMs ?? 700);
  const enter = await deps.call({ op: "enter" });
  if (!enter.ok) return fail(`回车失败：${enter.error ?? "未知"}`);

  const elapsed = Math.round(performance.now() - started);
  deps.log?.(`[qq-send] ${target.kind} sent in ${elapsed}ms at ${point.x},${point.y}`);
  return { ok: true, kind: target.kind, ms: elapsed, point };
}
