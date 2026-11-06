/**
 * 发布守卫（F320）：让「发布时工作树是脏的 / dist 过期」变成发布脚本自己能拦住的错误。
 *
 * 背景：2026-11-01 16:22 用户发布时，`scripts/autonomy/main.mjs` 已被队友改成半成品
 * （调用 `runtime.setNightBudget`），但 `dist/` 还是上一轮验证构建。发布脚本只做
 * 「12 个关键文件在不在」的校验，查不出「版本不配套」，于是运行时启动即 TypeError、
 * 没有 pid，看起来像「发布成功但没起来」。
 *
 * 设计原则：
 * - 只能读、只判断，不触碰 daemon（stop/start 由调用方负责）。
 * - 纯函数（`trackedDirtyLines` / `assessPublish`）可单测；`collectNewestMtimeMs` 只读 fs。
 * - untracked 文件不算脏：`docs/VERIFY-*.md` 这类产物一直存在，不应阻塞发布；
 *   但 tracked 修改/暂存意味着工作副本与上次提交不同，dist 很可能没跟上。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 递归时跳过的大目录：判断「dist 是否早于 src」不需要进入它们。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".tmp"]);

/**
 * 从 `git status --porcelain` 输出里挑出「tracked 的改动」。
 *
 * porcelain 每行格式：`XY path`，`??` 表示未跟踪（不算脏，见文件头说明）。
 * 返回去尾空白后的整行，方便调用方把路径原样展示给用户。
 */
export function trackedDirtyLines(statusPorcelain) {
  return String(statusPorcelain ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.startsWith("??"));
}

/**
 * 收集目录下（含子目录）普通文件的最新 mtime（毫秒）。
 *
 * 用于比较 `src/` 与 `dist/`：`dist` 的最新产物时间应不早于 `src` 的最新改动时间。
 * 读不到时返回 null（调用方按「无法判断 → 不阻塞」处理，避免把权限问题当发布闸）。
 */
export function collectNewestMtimeMs(dir) {
  let newest = null;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const mtimeMs = statSync(full).mtimeMs;
        if (newest === null || mtimeMs > newest) newest = mtimeMs;
      } catch {
        // 单个文件读不到不影响整体判断
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * 判定这次发布是否安全。
 *
 * 硬拒绝（ok=false）只留两条：工作树有 tracked 改动、dist 不存在。
 * 「src 比 dist 新」只做**警告**：verifier 的锁验证会在 build 之后还原文件、把 src 的 mtime
 * 更新到 dist 之后，内容却与构建一致——按 mtime 硬拒会误杀每一次正常发布。
 *
 * @param {object} input
 * @param {string} input.statusPorcelain `git status --porcelain` 的原始输出
 * @param {number|null|undefined} input.repoDistNewestMs `repo/dist` 下最新 mtime（读不到可传 null）
 * @param {number|null|undefined} input.repoSrcNewestMs `repo/src` 下最新 mtime（读不到可传 null）
 * @param {boolean} [input.allowDirty] `--force-dirty` 是否生效
 * @returns {{ok: boolean, reasons: string[], warnings: string[]}}
 */
export function assessPublish({ statusPorcelain, repoDistNewestMs, repoSrcNewestMs, allowDirty = false }) {
  const dirty = trackedDirtyLines(statusPorcelain);
  const reasons = [];
  const warnings = [];
  let ok = true;

  if (dirty.length > 0) {
    const list = dirty.slice(0, 5).join("；");
    const more = dirty.length > 5 ? `…（共 ${dirty.length} 处）` : "";
    if (allowDirty) {
      warnings.push(`--force-dirty：放行 ${dirty.length} 处 tracked 改动（可能发布半成品）：${list}${more}`);
    } else {
      ok = false;
      reasons.push(
        `工作树有 ${dirty.length} 处未提交的 tracked 改动：${list}${more}。` +
          "发布复制的是工作副本，dist 可能没跟上；先 commit 再发布（确需强发加 --force-dirty）。",
      );
    }
  }

  if (repoDistNewestMs === null || repoDistNewestMs === undefined) {
    ok = false;
    reasons.push("repo/dist 不存在或不可读：先 `npm run build` 再发布。");
  } else if (repoSrcNewestMs !== null && repoSrcNewestMs !== undefined && repoSrcNewestMs > repoDistNewestMs) {
    // 只警告：mtime 不代表内容（锁验证还原、编辑器保存都会推后 mtime）。
    warnings.push(
      "repo/dist 的 mtime 早于 repo/src：若刚改过源码请先 `npm run build`；" +
        "若只是锁验证后的还原或编辑器保存，内容未必不同，可忽略（发布后 health 应正常）。",
    );
  }

  return { ok, reasons, warnings };
}
