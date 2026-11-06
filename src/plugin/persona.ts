/**
 * 人格卡的文件加载壳。
 *
 * Persona 的**类型与纯逻辑**（parse / render / 预算）都在 `src/dialogue/persona.ts`
 * ——它们属于大脑层（决定"她是谁、怎么说"），不应该长在工具层里。
 * 这里只留「从磁盘读一个 JSON」这一件工具层该做的事。
 *
 * ## 为什么解析器要当参数传进来
 *
 * `parsePersona` 是大脑实现。这个文件在 `tools` 层（`src/plugin/` 里只有
 * `index.ts` / `runtime.ts` / `tools.ts` 三个装配点，本文件不在其中），
 * 直接 import 会算一条 R3 边。于是改成注入：
 *
 *   loadPersonaFile(path, parsePersona)   // 装配点负责把 parsePersona 递进来
 *
 * 这样这个文件彻底不依赖大脑，`src/plugin/persona.ts` 也就不再是从前那个
 * 「把大脑整块转出去」的兼容壳（那两条转出 import 正是被清掉的存量违规）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Persona } from "../ports/index.js";

/**
 * 从文件读人格卡；`path` 为空时返回 null（F326 方案 A：卡已删除，装配层不再调用）。
 * 读不到或解析失败仍抛错（由调用方决定降级策略；回退 B 方案时行为不变）。
 */
export function loadPersonaFile(
  path: string | null | undefined,
  parse: (raw: unknown) => Persona,
): Persona | null {
  if (path === null || path === undefined) return null;
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`人格卡不是合法 JSON（${path}）：${String(err)}`);
  }
  return parse(raw);
}

/**
 * 人格卡到底在哪个路径（F155）。
 *
 * F326 方案 A 起仓库里不再随包人格卡，本函数只在回退 B（手动放回卡并接线）时使用：
 *   - 常驻进程：`data/persona-<id>.json` 覆盖优先；
 *   - 运行时目录：`persona/<id>.json`（回退 B 时才由 publish 复制）。
 *
 * 以前常驻进程只找 `data/persona-<id>.json`，而那个文件**从来没有人生成**——
 * 于是她自己的进程里 `persona()` 永远是 null，A 层否决、人格漂移、六层人格在线上全是
 * 死代码（F155 修的就是这个）。这里按"数据目录覆盖 > 运行时自带"的顺序找，
 * 纯函数（`exists` 注入），不碰文件系统就能测。
 */
export function resolvePersonaPath(opts: {
  readonly dataDir: string;
  readonly repoRoot: string;
  readonly characterId: string;
  readonly exists: (path: string) => boolean;
}): string | null {
  const candidates = [
    join(opts.dataDir, `persona-${opts.characterId}.json`),
    join(opts.repoRoot, "persona", `${opts.characterId}.json`),
  ];
  for (const path of candidates) if (opts.exists(path)) return path;
  return null;
}

/**
 * 只读校验壳：把 JSON 读出来交给大脑层的校验器，自己不解释结果
 * （校验规则在 `engine/personality.ts`，那是大脑的活；这里只负责"读文件"）。
 */
export function validatePersonaFile<T>(path: string, validate: (raw: unknown) => T): T {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`人格卡不是合法 JSON（${path}）：${String(err)}`);
  }
  return validate(raw);
}
