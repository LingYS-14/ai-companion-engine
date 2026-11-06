#!/usr/bin/env node
/**
 * 只读自检：key 文件在不在、能不能解密、解出来多长。
 * 绝不打印 key 本身，连前后缀都不打印（前后缀也够拼？不冒这个险）。
 */
import { keyFileStatus, unprotectFromFile } from "../../dist/autonomy/secret.js";

const status = keyFileStatus(process.env);
if (status.path === null) {
  console.error("✗ 找不到 LOCALAPPDATA：这个脚本只支持 Windows。");
  process.exit(1);
}

if (!status.exists) {
  console.log("✗ 没有 key 文件：" + status.path);
  console.log("  用法：powershell -ExecutionPolicy Bypass -File scripts/autonomy/set-key.ps1");
  process.exit(1);
}

const plaintext = unprotectFromFile(status.path, process.env);
if (plaintext === null) {
  console.log("✗ key 文件存在但解不开（可能换了 Windows 用户，或文件损坏）：" + status.path);
  console.log("  重新写一次即可覆盖：scripts/autonomy/set-key.ps1");
  process.exit(1);
}

console.log("✓ key 已就位，且能解密");
console.log("  路径：" + status.path);
console.log("  长度：" + plaintext.length + " 字符（内容不打印）");
process.exit(0);
