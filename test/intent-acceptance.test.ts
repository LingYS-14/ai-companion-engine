import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { evaluateAcceptance, renderAcceptance } from "../src/orchestrator/intent/acceptance.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist", "orchestrator", "intent", "acceptance.js");
const NOW = 1_793_450_000_000;

const base = (over: Record<string, unknown> = {}) => ({
  generatedAtMs: NOW,
  days: [
    { day: "10-30", ticks: 40, emittedTicks: 3 },
    { day: "10-31", ticks: 60, emittedTicks: 12 },
  ],
  sends: { total: 5, byIntent: 2, withKind: 2, byNonSpeakOutlet: 0, byGateOnly: 0, byLegacy: 0 },
  nightSends: 0,
  presenceObserved: true,
  dshRoundTripObserved: true,
  engineOnPathObserved: true,
  gateGreen: true,
  ...over,
});

const item = (report: ReturnType<typeof evaluateAcceptance>, id: string) => {
  const found = report.items.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`没有这条：${id}`);
  return found;
};

describe("验收卡：六条标准的三态判定", () => {
  it("全绿：两天都有 emitted、发送全部可回溯 kind、夜间零条、引擎路径在走、桥跑通", () => {
    const report = evaluateAcceptance(base() as never);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.pending).toBe(0);
    expect(report.counts.met).toBe(6);
    expect(report.conclusion).toContain("六条验收标准都有证据支撑");
  });

  it("只有一天样本 → 意图可达是 pending（不是 met）", () => {
    const report = evaluateAcceptance(base({ days: [{ day: "10-31", ticks: 60, emittedTicks: 12 }] }) as never);
    expect(item(report, "reachable").status).toBe("pending");
    expect(item(report, "reachable").evidence).toContain("需要 ≥2 天");
  });

  it("两天里有一天一次都没到阈值 → fail", () => {
    const report = evaluateAcceptance(
      base({
        days: [
          { day: "10-30", ticks: 40, emittedTicks: 0 },
          { day: "10-31", ticks: 60, emittedTicks: 12 },
        ],
      }) as never,
    );
    expect(item(report, "reachable").status).toBe("fail");
  });

  it("还没有由意图决定的消息 → 出口有因果 pending（不能算通过）", () => {
    const report = evaluateAcceptance(
      base({ sends: { total: 3, byIntent: 0, withKind: 0, byNonSpeakOutlet: 0, byGateOnly: 3, byLegacy: 0 } }) as never,
    );
    expect(item(report, "causal").status).toBe("pending");
  });

  it("仍有非 speak 出口或旧路径 → 出口有因果 fail", () => {
    const report = evaluateAcceptance(
      base({ sends: { total: 5, byIntent: 2, withKind: 2, byNonSpeakOutlet: 1, byGateOnly: 0, byLegacy: 2 } }) as never,
    );
    expect(item(report, "causal").status).toBe("fail");
    expect(item(report, "causal").evidence).toContain("非 speak 出口 1");
  });

  it("由意图决定但缺 kind（F252 之前发的）→ pending 而不是 met", () => {
    const report = evaluateAcceptance(
      base({ sends: { total: 2, byIntent: 2, withKind: 0, byNonSpeakOutlet: 0, byGateOnly: 0, byLegacy: 0 } }) as never,
    );
    expect(item(report, "causal").status).toBe("pending");
    expect(item(report, "causal").evidence).toContain("带 kind 的只有 0 条");
  });

  it("没有夜间样本 → 分寸 pending；夜间有发送 → fail", () => {
    const pending = evaluateAcceptance(base({ nightSends: null }) as never);
    expect(item(pending, "restraint").status).toBe("pending");
    const failed = evaluateAcceptance(base({ nightSends: 2 }) as never);
    expect(item(failed, "restraint").status).toBe("fail");
  });

  it("还没跑门禁 → 不退化是 pending（不能替它说通过）", () => {
    const report = evaluateAcceptance(base({ gateGreen: null }) as never);
    expect(item(report, "no-regression").status).toBe("pending");
    const failed = evaluateAcceptance(base({ gateGreen: false }) as never);
    expect(item(failed, "no-regression").status).toBe("fail");
  });

  it("没有引擎节拍 → 旧门 pending（无法确认走哪条路径）", () => {
    const report = evaluateAcceptance(base({ engineOnPathObserved: false }) as never);
    expect(item(report, "old-gate").status).toBe("pending");
  });

  it("DSH 桥只跑通一半 → pending，并指出缺哪半", () => {
    const onlyPresence = evaluateAcceptance(base({ dshRoundTripObserved: false }) as never);
    expect(item(onlyPresence, "dsh-bridge").status).toBe("pending");
    expect(item(onlyPresence, "dsh-bridge").evidence).toContain("回程");
    const onlyFacts = evaluateAcceptance(base({ presenceObserved: false }) as never);
    expect(item(onlyFacts, "dsh-bridge").evidence).toContain("presence");
  });

  it("有一半项 pending 时，结论明说「还不能算通过」", () => {
    const report = evaluateAcceptance(base({ nightSends: null }) as never);
    expect(report.conclusion).toContain("还不能算通过");
  });

  it("渲染：✓/…/✗ 三态各一行 + 结论", () => {
    const text = renderAcceptance(evaluateAcceptance(base({ nightSends: null }) as never));
    expect(text).toContain("✓ [met]");
    expect(text).toContain("… [pending]");
    expect(text).toContain("结论：");
  });
});

describe.skipIf(!existsSync(DIST))("验收卡 CLI（依赖 dist）", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, "tools", "intent", "acceptance.mjs"), ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });

  it("--help 打用法、退出 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("验收");
  });

  it("真实 data 目录：输出六条 + 结论，退出 0", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("验收卡");
    expect(r.stdout).toContain("结论：");
  });

  it("空数据目录：仍然打印六条（都是 pending），不崩", () => {
    const dir = mkdtempSync(join(tmpdir(), "accept-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "autonomy-assistant.log"), "", "utf8");
    const r = run(["--root", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[pending]");
    expect(r.stdout).toContain("结论：");
  });
});
