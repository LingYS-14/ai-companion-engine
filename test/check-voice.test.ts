import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(__dirname, "..");
const checker = join(repo, "tools", "audit", "check-voice.mjs");

interface Run {
  status: number;
  report: { passed: boolean; facts: { entries: number }; suppressed: number; problems: { kind: string }[] };
}

function run(journal: { at?: number; text: string; spoken?: boolean }[], baseline?: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  writeFileSync(join(dir, "selftalk-assistant.json"), JSON.stringify(journal), "utf8");
  const baselinePath = join(dir, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baseline ?? []), "utf8");
  const r = spawnSync(process.execPath, [checker, "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ACE_DATA_DIR: dir, ACE_VOICE_BASELINE: baselinePath },
  });
  return { status: r.status ?? -1, report: JSON.parse(r.stdout) as Run["report"] };
}

describe("表达质量检查", () => {
  it("干净日记通过", () => {
    const r = run([{ at: Date.now(), text: "今晚的风挺软的，坐一会儿再回去。" }]);
    expect(r.status).toBe(0);
    expect(r.report.passed).toBe(true);
    expect(r.report.facts.entries).toBe(1);
  });

  it("说漏内部机制会失败", () => {
    const r = run([{ at: Date.now(), text: "我翻了翻知识库，想起那条检索结果。" }]);
    expect(r.status).toBe(1);
    expect(r.report.problems.map((p) => p.kind)).toContain("meta");
  });

  it("内心叙述框架会失败", () => {
    const r = run([{ at: Date.now(), text: "我刚在心里念了一句：窗台的花精神多了。" }]);
    expect(r.status).toBe(1);
    expect(r.report.problems.map((p) => p.kind)).toContain("think-aloud");
  });

  it("同句复读会失败", () => {
    const now = Date.now();
    const r = run([
      { at: now, text: "又绕回刚才那件小事上了。" },
      { at: now + 1, text: "又绕回刚才那件小事上了。" },
    ]);
    expect(r.status).toBe(1);
    expect(r.report.problems.map((p) => p.kind)).toContain("repeat");
  });

  it("基线里的历史问题被忽略", () => {
    const now = Date.now();
    const text = "又绕回刚才那件小事上了。";
    const r = run([{ at: now, text }, { at: now + 1, text }], ["repeat|又绕回刚才那件小事上了"]);
    expect(r.status).toBe(0);
    expect(r.report.suppressed).toBeGreaterThan(0);
  });
});

describe("做不到的承诺", () => {
  it("说出口的「这张图给你」会失败（常驻进程只能发文字）", () => {
    const r = run([{ at: Date.now(), spoken: true, text: "用户，我今天拍的花，你看像不像你？这张图给你，你认得吗？" }]);
    expect(r.status).toBe(1);
    expect(r.report.problems.map((p) => p.kind)).toContain("promise");
  });

  it("说出口的「稍后发你照片」也会失败", () => {
    const r = run([{ at: Date.now(), spoken: true, text: "等下我拍张照，稍后发你照片看。" }]);
    expect(r.status).toBe(1);
    expect(r.report.problems.map((p) => p.kind)).toContain("promise");
  });

  it("只写在日记里（没说出口）不算问题：运行时已经拦在出口", () => {
    const r = run([{ at: Date.now(), text: "用户，我今天拍的花，你看像不像你？这张图给你，你认得吗？" }]);
    expect(r.status).toBe(0);
    expect(r.report.problems).toHaveLength(0);
  });

  it("「给你看看」这种不含交付承诺的说法不误伤", () => {
    const r = run([{ at: Date.now(), text: "窗台那枝花又开了，给你看看也好，不过也就那样。" }]);
    expect(r.status).toBe(0);
  });
});
