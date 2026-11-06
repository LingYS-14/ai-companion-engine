/**
 * 模型凭据的落盘（Windows DPAPI），只在自主进程这一侧使用。
 *
 * 为什么要落盘：开机自启的计划任务拿不到会话环境变量，key 若只放环境变量，
 * 重启后她就「没有模型凭据」——这是真实缺口（见 docs/OPERATIONS.md §凭据）。
 *
 * 安全边界：
 * - 用 DPAPI 的 CurrentUser 作用域加密，密文离开这台机器的当前用户就解不开；
 * - 文件在 %LOCALAPPDATA%\ai-companion-engine\llm-key.bin，权限只给当前用户；
 * - 日志与错误信息只报「来源」，永不打印 key 本身；
 * - 环境变量优先：临时换 key 不用覆盖落盘文件。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const KEY_FILE_NAME = "llm-key.bin";

/** %LOCALAPPDATA%\ai-companion-engine\llm-key.bin（Windows）；其它平台返回 null */
export function protectedKeyPath(env: NodeJS.ProcessEnv): string | null {
  // ACE_KEY_DIR 只给测试和离线校验用；正常运行永远走 LOCALAPPDATA。
  const override = env.ACE_KEY_DIR;
  if (override !== undefined && override.trim() !== "") return join(override.trim(), KEY_FILE_NAME);
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") return null;
  return join(localAppData, "ai-companion-engine", KEY_FILE_NAME);
}

/**
 * 用 DPAPI 加密写盘。明文只经 stdin 传给 PowerShell，不落临时文件、不进命令行参数。
 * 非 Windows（或没有 LOCALAPPDATA）抛错，由调用方决定怎么提示。
 */
export function protectToFile(path: string, plaintext: string): void {
  if (plaintext.trim() === "") throw new Error("key 是空的，拒绝写入");
  mkdirSync(dirname(path), { recursive: true });
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$plain=[Console]::In.ReadToEnd()",
    `$path=${psSingle(path)}`,
    "$bytes=[System.Security.Cryptography.ProtectedData]::Protect(",
    "  [System.Text.Encoding]::UTF8.GetBytes($plain), $null,",
    "  [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[System.IO.File]::WriteAllBytes($path, $bytes)",
  ].join("\n");
  execFileSync("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: plaintext,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 30_000,
  });
}

/** 读回并解密；文件不存在或被别的用户加密都返回 null（不抛，调用方降级模板） */
export function unprotectFromFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$path=${psSingle(path)}`,
    "$bytes=[System.IO.File]::ReadAllBytes($path)",
    "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect(",
    "  $bytes, $null,",
    "  [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))",
  ].join("\n");
  try {
    const out = execFileSync("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      encoding: "utf8",
    });
    const key = out.trim();
    return key === "" ? null : key;
  } catch {
    return null;
  }
}

/**
 * 认哪些环境变量名（依次优先）。
 *
 * `DEEPSEEK_API_KEY` 排在前面是有过教训的：用户第一次就用它把 key 放进环境，
 * 脚本只认 AI_COMPANION_LLM_API_KEY，于是"设了 key 却说没有 key"。
 * 别名只影响「从哪读」，写入 DPAPI 之后一律只认文件。
 */
export const KEY_ENV_NAMES = ["DEEPSEEK_API_KEY", "AI_COMPANION_LLM_API_KEY", "ACE_LLM_API_KEY"] as const;

/** 从环境变量里取 key（去空白；空串视为没设），返回命中的变量名方便报错 */
export function readKeyEnv(env: Record<string, string | undefined>): { readonly name: string; readonly key: string } | null {
  for (const name of KEY_ENV_NAMES) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== "") return { name, key: raw.trim() };
  }
  return null;
}

/** 环境变量优先；否则 DPAPI 文件；都没有返回 null。source 只用于日志。 */
export async function resolveApiKey(
  env: NodeJS.ProcessEnv,
): Promise<{ readonly key: string; readonly source: "env" | "dpapi" } | null> {
  const fromEnv = readKeyEnv(env);
  if (fromEnv !== null) return { key: fromEnv.key, source: "env" };
  const path = protectedKeyPath(env);
  if (path === null) return null;
  const fromFile = unprotectFromFile(path);
  return fromFile === null ? null : { key: fromFile, source: "dpapi" };
}

/** PowerShell 单引号字符串（路径里不会有单引号，仍然按规矩转义） */
function psSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 只报路径是否就绪，给自检/文档用；从不返回明文 */
export function keyFileStatus(env: NodeJS.ProcessEnv): { readonly path: string | null; readonly exists: boolean } {
  const path = protectedKeyPath(env);
  return { path, exists: path !== null && existsSync(path) };
}

/** 测试用：把一段字节直接当密文写（验证"解不开就返回 null"） */
export function writeRawForTest(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** 测试用：读文件原始字节 */
export function readRawForTest(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
