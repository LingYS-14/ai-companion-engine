import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessPublish,
  collectNewestMtimeMs,
  trackedDirtyLines,
} from "../scripts/autonomy/publish-guard.mjs";

/** 每个用例一个临时目录；用例结束统一清理，避免污染仓库。 */
const tempDirs = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "publish-guard-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
});

describe("发布守卫 · trackedDirtyLines", () => {
  it("只把非 ?? 行算作脏（untracked 产物不阻塞发布）", () => {
    const status = [" M scripts/autonomy/main.mjs", "?? docs/DEVELOPMENT.md", "A  test/new.test.ts", ""].join(
      "\n",
    );
    expect(trackedDirtyLines(status)).toEqual([
      " M scripts/autonomy/main.mjs",
      "A  test/new.test.ts",
    ]);
  });

  it("空输出 / 全 untracked 视为干净", () => {
    expect(trackedDirtyLines("")).toEqual([]);
    expect(trackedDirtyLines("?? a.md\n?? b.md\n")).toEqual([]);
  });
});

describe("发布守卫 · assessPublish", () => {
  const clean = "?? docs/DEVELOPMENT.md\n";

  it("干净树 + dist 不早于 src → 放行", () => {
    const verdict = assessPublish({
      statusPorcelain: clean,
      repoDistNewestMs: 2000,
      repoSrcNewestMs: 1000,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.warnings).toEqual([]);
  });

  it("有 tracked 改动 → 拒绝，并给路径与修复提示", () => {
    const verdict = assessPublish({
      statusPorcelain: " M scripts/autonomy/main.mjs\n?? x.md\n",
      repoDistNewestMs: 2000,
      repoSrcNewestMs: 1000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("scripts/autonomy/main.mjs");
    expect(verdict.reasons.join("\n")).toContain("先 commit");
  });

  it("dist 缺失 → 拒绝并提示先 build", () => {
    const verdict = assessPublish({
      statusPorcelain: clean,
      repoDistNewestMs: null,
      repoSrcNewestMs: 1000,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("npm run build");
  });

  it("src 比 dist 新 → 只警告不拒绝（mtime 不代表内容；锁验证还原会推后 src mtime）", () => {
    const verdict = assessPublish({
      statusPorcelain: clean,
      repoDistNewestMs: 1000,
      repoSrcNewestMs: 2000,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.warnings.join("\n")).toContain("npm run build");
  });

  it("src mtime 读不到（null）时不因新鲜度告警", () => {
    const verdict = assessPublish({
      statusPorcelain: clean,
      repoDistNewestMs: 1000,
      repoSrcNewestMs: null,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings).toEqual([]);
  });

  it("--force-dirty 越过脏树，但必须留下明确警告", () => {
    const verdict = assessPublish({
      statusPorcelain: " M a.ts\n",
      repoDistNewestMs: 2000,
      repoSrcNewestMs: 1000,
      allowDirty: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join("\n")).toContain("--force-dirty");
  });
});

describe("发布守卫 · collectNewestMtimeMs", () => {
  it("递归取子目录里最新 mtime；空目录/不存在返回 null", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "nested"), { recursive: true });
    const older = join(dir, "older.js");
    const newer = join(dir, "nested", "newer.js");
    writeFileSync(older, "a", "utf8");
    writeFileSync(newer, "b", "utf8");
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));

    expect(collectNewestMtimeMs(dir)).toBeGreaterThanOrEqual(2_000_000 - 1_000);
    expect(collectNewestMtimeMs(join(dir, "does-not-exist"))).toBeNull();
    expect(collectNewestMtimeMs(makeTempDir())).toBeNull();
  });
});
