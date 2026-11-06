/**
 * F247 配置锁：在场信号必须真的接在装配点上。
 *
 * 这一层很脆——纯函数写得再对，装配点忘了调 / 发布时漏了脚本，线上就永远是
 * "不知道他在不在"，而日志会照常打得很好看。线上已经吃过一次同类的亏
 * （F143：`tools/voice` 没进 publish COPY → 线上找不到脚本而静默退化）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("F247 装配点锁：main.mjs 真的探测并用上了在场信号", () => {
  const main = read("scripts/autonomy/main.mjs");
  // F291：收集外部事实搬到 src/assembly/situation-signals.ts；入口只负责传目录与时钟。
  const signals = read("src/assembly/situation-signals.ts");

  it("import 了纯映射模块（不是自己手写阈值）", () => {
    expect(signals).toContain("autonomy/input-activity.js");
    expect(signals).toContain("presenceFromActivity");
    expect(signals).toContain("parseInputActivity");
  });

  it("探测用 windowsHide + 超时，失败不抛（探针坏了不能把她拍停）", () => {
    expect(signals).toContain("function probeInputActivity");
    expect(signals).toContain('activity.ps1');
    expect(signals).toContain("windowsHide: true");
    expect(signals).toMatch(/timeout: 8_?000/u);
  });

  it("presence 只在手工信号缺失时用 OS 事实补位（人这一侧优先）", () => {
    expect(signals).toContain("if (presence === null && inputActivity !== null) presence = presenceFromActivity(inputActivity, deps.nowMs);");
  });

  it("每拍把在场单独记一行，事后能对账", () => {
    expect(main).toContain("[intent] 在场：");
    expect(main).toContain("不知道（不猜）");
    // 把原始 idle 秒数一并记下：出现"不知道"时能区分"探针坏了"和"确实在中间地带"
    expect(main).toContain("describeInputActivity(situationSignals.inputActivity)");
  });

  it("观测行标出 「重提旧话」，不把装配层的开口算成 tick 判定（F248）", () => {
    expect(main).toContain("reRaised: speakable === null ? null : { id: speakable.id, kind: speakable.kind }");
  });
});

describe("F247 发布锁：运行时真的拿得到探针脚本", () => {
  const publish = read("scripts/autonomy/publish-runtime.mjs");

  it("COPY 包含 tools/presence，REQUIRED 校验 activity.ps1", () => {
    expect(publish).toContain("\"tools/presence\"");
    expect(publish).toContain("tools/presence/activity.ps1");
  });
});

describe("F247 阈值锁：三态边界不能写反", () => {
  const src = read("src/autonomy/input-activity.ts");

  it("活跃上限 2 分钟、离开下限 10 分钟、信号最大年龄 5 分钟", () => {
    expect(src).toMatch(/PRESENCE_ACTIVE_MAX_IDLE_MS = 2 \* 60_000/u);
    expect(src).toMatch(/PRESENCE_AWAY_MIN_IDLE_MS = 10 \* 60_000/u);
    expect(src).toMatch(/PRESENCE_MAX_AGE_MS = 5 \* 60_000/u);
  });

  it("中间地带返回 null（说不准就不说），不是硬猜一个 false", () => {
    // presenceFromActivity 里至少有两个 null 出口：信号太旧、2–10 分钟中间地带
    expect((src.match(/return null;/gu) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
