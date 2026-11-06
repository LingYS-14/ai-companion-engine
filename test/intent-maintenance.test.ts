/**
 * P4 落盘接线：`runNightlyMaintenance`（能力转正 / 求助窗口裁剪 / 监护人事实落盘）
 *
 * 这一层最容易犯的错是"看起来在维护，实际什么都没做"：
 * 账本没转正、窗口没裁、超时的"问过，暂无回音"永远落不了库。所以每条都测到"文件真的变了"。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { runNightlyMaintenance, guardianFactsPath, ASK_HISTORY_WINDOW_MS } from "../src/orchestrator/intent/maintenance.js";
import {
  askHistoryPath,
  capabilityLedgerPath,
  guardianInboxPath,
  guardianReplyDir,
  writeGuardianReply,
  writeCapabilityLedgerFile,
} from "../src/orchestrator/intent/persist.js";
import type { CapabilityRecord } from "../src/orchestrator/intent/types.js";

let root: string;
const NOW = Date.UTC(2026, 9, 31, 1, 0, 0);

function cap(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    capId: "cap-1",
    kind: "integration",
    tool: null,
    sourceIntentionId: "itn-1",
    effectivityBefore: 0.3,
    effectivityAfter: 0.8,
    tests: [{ name: "smoke", passed: true }],
    riskCeiling: 1,
    status: "quarantined",
    createdAt: new Date(NOW - 48 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

function writeRequest(lines: readonly Record<string, unknown>[]): void {
  const path = guardianInboxPath(root, "assistant");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

function oldRequest(): Record<string, unknown> {
  return {
    requestId: "grd-itn-1-100",
    at: new Date(NOW - 3 * 3600 * 1000).toISOString(),
    intentionId: "itn-1",
    what: "想用桌面控制点一下按钮",
    tried: ["看了工具清单", "试过一次"],
    need: "permission",
    ask: "允许我用桌面控制吗",
    timeoutMs: 7_200_000,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "intent-maint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("夜间维护：能力账本转正", () => {
  it("观察满 24 小时且效力真的提升 → 转正并写回文件", () => {
    writeCapabilityLedgerFile(capabilityLedgerPath(root, "assistant"), [cap()], NOW);
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.promoted).toEqual(["cap-1"]);
    const raw = JSON.parse(readFileSync(capabilityLedgerPath(root, "assistant"), "utf8")) as {
      records: readonly CapabilityRecord[];
    };
    expect(raw.records[0]?.status).toBe("active");
  });

  it("刚创建不到 24 小时：不转正，也不改文件", () => {
    writeCapabilityLedgerFile(capabilityLedgerPath(root, "assistant"), [cap({ createdAt: new Date(NOW - 3600 * 1000).toISOString() })], NOW);
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.promoted).toEqual([]);
  });
});

describe("夜间维护：求助窗口裁剪", () => {
  it("只留窗口内的记录（同缺口不会永久封口）", () => {
    const path = askHistoryPath(root, "assistant");
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { requestId: "old", intentionId: "itn-old", askedAtMs: NOW - ASK_HISTORY_WINDOW_MS - 60_000 },
          { requestId: "new", intentionId: "itn-new", askedAtMs: NOW - 60_000 },
        ],
      }),
      "utf8",
    );
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.ask.dropped).toBe(1);
    expect(result.ask.kept).toBe(1);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: readonly { requestId: string }[] };
    expect(raw.entries.map((entry) => entry.requestId)).toEqual(["new"]);
  });
});

describe("夜间维护：监护人事实只落一次", () => {
  it("超时请求写成「问过，暂无回音」，第二次跑不重复写", () => {
    writeRequest([oldRequest()]);
    const first = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(first.guardian.timedOut).toBe(1);
    expect(first.guardian.facts.length).toBe(1);
    expect(first.guardian.facts[0]?.fact).toContain("暂无回音");

    const factsPath = guardianFactsPath(root, "assistant");
    expect(existsSync(factsPath)).toBe(true);
    const lines = readFileSync(factsPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);

    const second = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW + 60_000 });
    expect(second.guardian.facts.length).toBe(0);
    expect(readFileSync(factsPath, "utf8").trim().split("\n").length).toBe(1);
  });

  it("已经应答过的请求不写超时事实", () => {
    writeRequest([oldRequest()]);
    writeGuardianReply(guardianReplyDir(root), {
      requestId: "grd-itn-1-100",
      at: new Date(NOW - 2 * 3600 * 1000).toISOString(),
      from: "lead",
      verdict: "help",
      note: "我在，说吧。",
    });
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.guardian.answered).toBe(1);
    expect(result.guardian.facts.length).toBe(0);
  });
});

describe("夜间维护：坏文件不弄崩溃，也不假装没事", () => {
  it("账本坏 JSON：notes 里说出来，其余维护照常", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(capabilityLedgerPath(root, "assistant"), "{not json", "utf8");
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.promoted).toEqual([]);
    expect(result.notes.join("\n")).toContain("能力账本");
    // 有故障时不冒充「没事可做」：只有干净的空气跑才说这句话
    expect(result.notes.join("\n")).not.toContain("没有需要维护的事");
  });

  it("空目录：明确说没有需要维护的事", () => {
    const result = runNightlyMaintenance({ root, characterId: "assistant", nowMs: NOW });
    expect(result.notes.join("\n")).toContain("没有需要维护的事");
    expect(result.ask.dropped).toBe(0);
    expect(result.guardian.requests).toBe(0);
  });
});
