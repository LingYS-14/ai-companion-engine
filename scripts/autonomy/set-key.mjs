#!/usr/bin/env node
/**
 * 把 DeepSeek API key 加密落到本机（Windows DPAPI，当前用户作用域）。
 *
 * 用法（不要写进命令行参数，免得进 PowerShell history）：
 *   1) $env:DEEPSEEK_API_KEY="sk-xxxx"; node scripts/autonomy/set-key.mjs
 *      （也认 AI_COMPANION_LLM_API_KEY / ACE_LLM_API_KEY，按这个顺序取第一个非空的）
 *   2) 或者：Get-Content key.txt | node scripts/autonomy/set-key.mjs --stdin
 * 写完可以：Remove-Item Env:AI_COMPANION_LLM_API_KEY
 *
 * 为什么是 DPAPI：开机自启的计划任务没有会话环境变量，key 必须落盘；
 * DPAPI 绑定当前 Windows 用户，文件被拷走也解不开。明文从不落盘中转。
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { KEY_ENV_NAMES, keyFileStatus, protectToFile, readKeyEnv, unprotectFromFile } from "../../dist/autonomy/secret.js";

const useStdin = process.argv.includes("--stdin");
const status = keyFileStatus(process.env);
if (status.path === null) {
  console.error("找不到 LOCALAPPDATA：这个脚本只支持 Windows。");
  process.exit(1);
}

async function readKey() {
  const fromEnv = readKeyEnv(process.env);
  if (!useStdin && fromEnv !== null) return fromEnv.key;
  if (!useStdin) {
    console.error(
      `没有读到 key（认这些环境变量：${KEY_ENV_NAMES.join(" / ")}）。`,
      'PowerShell 请用：$env:DEEPSEEK_API_KEY="sk-…"; node scripts/autonomy/set-key.mjs',
      '（PowerShell 里的 set 只会建一个 PowerShell 变量，子进程看不到——这是最常见的坑。）',
      '不想让 key 进 history 的话：Get-Clipboard | node scripts/autonomy/set-key.mjs --stdin',
    );
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin });
  let text = "";
  for await (const line of rl) text += line;
  rl.close();
  return text.trim();
}

const key = await readKey();
if (key === "" || key === undefined) {
  console.error("读到的是空 key，没有写入。");
  process.exit(3);
}
if (existsSync(status.path)) console.log(`覆盖已有的 key 文件：${status.path}`);
try {
  protectToFile(status.path, key);
} catch (error) {
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EPERM" || code === "EACCES") {
    console.error(`写不进去：${status.path}`);
    console.error("这个目录需要以你自己的 Windows 用户运行（不要通过被降权的 agent 进程写）。");
    console.error("请在你自己的 PowerShell 里跑：powershell -ExecutionPolicy Bypass -File scripts/autonomy/set-key.ps1");
  } else {
    console.error(`写入失败：${String(error)}`);
  }
  process.exit(5);
}
const back = unprotectFromFile(status.path);
if (back !== key) {
  console.error("写入后校验失败（解出来的值不一致），请重试。");
  process.exit(4);
}
console.log(`已写入并校验：${status.path}`);
console.log("现在可以删掉环境变量：Remove-Item Env:DEEPSEEK_API_KEY");
console.log("如果自主进程正在跑，不用重启：下一拍（≤5 分钟）会自动切到真模型。");
