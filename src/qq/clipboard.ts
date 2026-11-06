import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClipKind } from "./send.js";

/**
 * 剪贴板这一步必须借 PowerShell：Node 没有系统剪贴板 API，而 QQ 的「输入」
 * 本质是 Ctrl+V，所以内容要先落到剪贴板上。
 *
 * 为什么不把文本直接拼进 `-Command "Set-Clipboard -Value '…'"`：
 * 命令行编码、引号转义、中文与换行都会互相打架（上一轮就因为 GBK 出过事）。
 * 统一做法是**写 UTF-8 文件**、让脚本自己读，脚本只接收 kind 与路径。
 */
export interface ClipboardOptions {
  readonly scriptPath: string;
  readonly tmpDir: string;
  readonly powershell?: string;
  readonly timeoutMs?: number;
}

export interface ClipboardSetter {
  (kind: ClipKind, payload: string): Promise<void>;
}

let textSeq = 0;

export function makeClipboardSetter(opts: ClipboardOptions): ClipboardSetter {
  const ps = opts.powershell ?? "powershell.exe";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return (kind: ClipKind, payload: string): Promise<void> => {
    let target = payload;
    if (kind === "text") {
      mkdirSync(opts.tmpDir, { recursive: true });
      textSeq += 1;
      target = join(opts.tmpDir, `clip-${textSeq}-${Math.floor(Math.random() * 1e9).toString(36)}.txt`);
      writeFileSync(target, payload, "utf8");
    }
    return new Promise((resolve, reject) => {
      execFile(
        ps,
        [
          "-NoProfile",
          "-Sta",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          opts.scriptPath,
          "-Kind",
          kind,
          "-Payload",
          target,
        ],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || "").trim() || err.message;
            reject(new Error(detail));
            return;
          }
          if (!String(stdout).includes("ok")) {
            reject(new Error(`剪贴板脚本没有返回 ok：${String(stdout).slice(0, 120)}`));
            return;
          }
          resolve();
        },
      );
    });
  };
}
