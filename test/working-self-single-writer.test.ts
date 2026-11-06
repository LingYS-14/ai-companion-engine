import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** 仓库根（与其它配置锁测试同一写法：从 test/ 上两级） */
const ROOT = join(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("具体性 streak 只有一个写者（F285，批次 2c）", () => {
  it("宿主插件只读 working-self 状态，不写", () => {
    const src = read("src/plugin/index.ts");
    expect(src).toContain("readWorkingSelfState");
    expect(src).not.toContain("writeWorkingSelfState");
    expect(src).not.toContain("advanceWorkingSelfState");
    expect(src).toContain("F285");
  });

  it("自主进程（qq-runner）仍然是写者", () => {
    const src = read("src/autonomy/qq-runner.ts");
    expect(src).toContain("writeWorkingSelfState");
    expect(src).toContain("advanceWorkingSelfState");
  });

  it("整个插件目录里没有其它 streak 写入口", () => {
    for (const rel of [
      "src/plugin/tools.ts",
      "src/assembly/panel-payload.ts",
      "src/plugin/write-client.ts",
      "src/plugin/channel-turn.ts",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toContain("writeWorkingSelfState");
    }
  });
});
