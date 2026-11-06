/**
 * DSH 回程接线的配置锁（F253）。
 *
 * 为什么锁：回程整段包在 try/catch 里（"不影响 tick"是刻意的），所以作用域写错
 * （用了 main() 的 rootDir）不会炸任何测试、不会让她停摆，只会在日志里留一行
 * 「DSH 回程失败（不影响 tick）：rootDir is not defined」，然后**所有回执永远落不成事实**。
 * 这类静默失败只能靠字符串锁 + 一次真机端到端验证，不能靠类型检查。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const main = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");

describe("F253：DSH 回程不能引用 tick 作用域里不存在的 rootDir", () => {
  it("回程里的 guardian 收件箱路径由 dataDir 反推（tick 作用域没有 rootDir）", () => {
    // 只有回程这一段用 resolve(dataDir, "..")；求助发射端那段自己有局部 rootDir，不算错。
    expect(main).toContain('guardianInboxPath(resolve(dataDir, ".."), characterId)');
    expect(main).toContain('const rootDir = resolve(dataDir, "..");');
  });

  it("回程失败仍只记日志（不影响整拍）——这是有意的，不改成抛出", () => {
    expect(main).toContain("DSH 回程失败（不影响 tick）");
  });

  it("事实按 id 去重、升级按 intentionId 去重（两处 Set 都在）", () => {
    expect(main).toContain("recordedDshIds");
    expect(main).toContain("const escalated = new Set");
  });
});
