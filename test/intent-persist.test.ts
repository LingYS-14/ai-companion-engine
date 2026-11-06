import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendGuardianRequest,
  capabilityLedgerPath,
  guardianInboxPath,
  guardianReplyDir,
  promoteDueRecords,
  pruneAskHistory,
  readAskHistory,
  readCapabilityLedgerFile,
  readGuardianReplies,
  readGuardianRequests,
  removeGuardianReply,
  resolveGuardianRequests,
  writeAskHistory,
  writeCapabilityLedgerFile,
  writeGuardianReply,
} from "../src/orchestrator/intent/persist.js";
import { guardianReplyFileName, type GuardianReply, type GuardianRequest } from "../src/orchestrator/intent/guardian.js";
import type { CapabilityRecord } from "../src/orchestrator/intent/types.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ase-persist-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    capId: "cap-1",
    kind: "tool",
    tool: "qq.send_text",
    sourceIntentionId: "itn-1",
    effectivityBefore: 0,
    effectivityAfter: 1,
    tests: [{ name: "冒烟", passed: true }],
    riskCeiling: 1,
    status: "quarantined",
    createdAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<GuardianRequest> = {}): GuardianRequest {
  return {
    requestId: "grd-itn-1-29566080",
    at: "2026-10-31T00:00:00.000Z",
    intentionId: "itn-1",
    what: "想让 QQ 里发一张图",
    tried: ["查了工具表", "试了 send_text"],
    need: "permission",
    ask: "能不能让我用发图那条路",
    timeoutMs: 7_200_000,
    ...overrides,
  };
}

describe("能力账本落盘", () => {
  it("文件不存在时给空账本 + existed=false，不报错", () => {
    const read = readCapabilityLedgerFile(capabilityLedgerPath(dir, "assistant"));
    expect(read.records).toEqual([]);
    expect(read.errors).toEqual([]);
    expect(read.existed).toBe(false);
  });

  it("写进去再读回来逐字段一致（并且按 capId 排序）", () => {
    const path = capabilityLedgerPath(dir, "assistant");
    writeCapabilityLedgerFile(path, [record({ capId: "cap-b" }), record({ capId: "cap-a" })], 1_793_400_000_000);
    const read = readCapabilityLedgerFile(path);
    expect(read.errors).toEqual([]);
    expect(read.existed).toBe(true);
    expect(read.records?.map((item) => item.capId)).toEqual(["cap-a", "cap-b"]);
    expect(read.records?.[0]?.effectivityAfter).toBe(1);
  });

  it("坏 JSON 返回 null + 错误，不伪装成空账本", () => {
    const path = capabilityLedgerPath(dir, "assistant");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(path, "这不是 JSON\n", "utf8");
    const read = readCapabilityLedgerFile(path);
    expect(read.records).toBeNull();
    expect(read.errors.length).toBeGreaterThan(0);
  });

  it("记录本身不合法（riskCeiling 越界）也要报错", () => {
    const path = capabilityLedgerPath(dir, "assistant");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, savedAtMs: 1, records: [{ ...record(), riskCeiling: 9 }] }),
      "utf8",
    );
    const read = readCapabilityLedgerFile(path);
    expect(read.records).toBeNull();
    expect(read.errors.join("；")).toContain("riskCeiling");
  });

  it("写盘不留临时文件", () => {
    const path = capabilityLedgerPath(dir, "assistant");
    writeCapabilityLedgerFile(path, [record()], 1_793_400_000_000);
    const leftovers = readdirSync(join(dir, "data")).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("非法 savedAtMs 直接抛（不写一个时间坏掉的文件）", () => {
    expect(() => writeCapabilityLedgerFile(capabilityLedgerPath(dir, "assistant"), [record()], Number.NaN)).toThrow(RangeError);
  });
});

describe("能力转正", () => {
  const now = Date.parse("2026-11-01T00:00:00.000Z");

  it("观察满 24h 且效力变好 → 转正并记下 capId", () => {
    const result = promoteDueRecords([record({ createdAt: "2026-10-30T00:00:00.000Z" })], now);
    expect(result.promoted).toEqual(["cap-1"]);
    expect(result.records[0]?.status).toBe("active");
  });

  it("没满 24h / 效力没变好 / 已经 active 都不动", () => {
    const result = promoteDueRecords(
      [
        record({ capId: "too-new", createdAt: "2026-10-31T20:00:00.000Z" }),
        record({ capId: "flat", effectivityBefore: 0.5, effectivityAfter: 0.5 }),
        record({ capId: "already", status: "active" }),
      ],
      now,
    );
    expect(result.promoted).toEqual([]);
    expect(result.records.map((item) => item.status)).toEqual(["quarantined", "quarantined", "active"]);
  });

  it("幂等：转正过的记录再跑一次不会被算成第二次", () => {
    const first = promoteDueRecords([record({ createdAt: "2026-10-30T00:00:00.000Z" })], now);
    const second = promoteDueRecords(first.records, now);
    expect(second.promoted).toEqual([]);
  });
});

describe("求助历史落盘", () => {
  it("文件不存在 → 空历史", () => {
    const read = readAskHistory(join(dir, "nope.json"));
    expect(read.entries).toEqual([]);
    expect(read.existed).toBe(false);
  });

  it("写进去再读回来一致；坏条目被拒并报错", () => {
    const path = join(dir, "ask.json");
    writeAskHistory(path, [{ requestId: "grd-1", intentionId: "itn-1", askedAtMs: 1000 }]);
    const read = readAskHistory(path);
    expect(read.entries).toHaveLength(1);
    expect(read.errors).toEqual([]);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, entries: [{ requestId: "grd-2", intentionId: "itn-2", askedAtMs: 2000 }, { requestId: "" }] }),
      "utf8",
    );
    const withBad = readAskHistory(path);
    expect(withBad.entries).toHaveLength(1);
    expect(withBad.errors.join("；")).toContain("第 2 条");
  });

  it(" pruneAskHistory 只保留窗口内记录（老的必须掉出去，否则永久封口）", () => {
    const now = 100 * 86_400_000;
    const kept = pruneAskHistory(
      [
        { requestId: "old", intentionId: "itn-1", askedAtMs: now - 2 * 86_400_000 },
        { requestId: "new", intentionId: "itn-2", askedAtMs: now - 3_600_000 },
      ],
      now,
      86_400_000,
    );
    expect(kept.map((entry) => entry.requestId)).toEqual(["new"]);
  });

  it("顶层不是数组/entries 时明确报错", () => {
    const path = join(dir, "ask-bad.json");
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8");
    expect(readAskHistory(path).errors.join("；")).toContain("entries");
  });
});

describe("监护人请求/应答落盘", () => {
  it("追加写两条请求，坏行计入 errors 但仍能读出好的", () => {
    const path = guardianInboxPath(dir, "assistant");
    appendGuardianRequest(path, request());
    appendGuardianRequest(path, request({ requestId: "grd-itn-2-29566080", intentionId: "itn-2" }));
    writeFileSync(path, "坏行不是 JSON\n", { encoding: "utf8", flag: "a" });
    const read = readGuardianRequests(path);
    expect(read.requests).toHaveLength(2);
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]).toContain("第 3 行");
  });

  it("应答按 requestId 写成文件并可读回", () => {
    const replyDir = guardianReplyDir(dir);
    const reply: GuardianReply = {
      requestId: "grd-itn-1-29566080",
      at: "2026-10-31T01:00:00.000Z",
      from: "lead",
      verdict: "help",
      note: "我来处理",
    };
    const path = writeGuardianReply(replyDir, reply);
    expect(path.endsWith(`${guardianReplyFileName("grd-itn-1-29566080")}.json`)).toBe(true);
    const read = readGuardianReplies(replyDir);
    expect(read.replies).toHaveLength(1);
    expect(read.replies[0]?.from).toBe("lead");
  });

  it("坏应答文件被列出但不混进 replies", () => {
    const replyDir = guardianReplyDir(dir);
    writeGuardianReply(replyDir, {
      requestId: "grd-ok",
      at: "2026-10-31T01:00:00.000Z",
      from: "owner",
      verdict: "later",
      note: "晚点",
      retryAfterMs: 600_000,
    });
    writeFileSync(join(replyDir, "grd-bad.json"), JSON.stringify({ requestId: "grd-bad", verdict: "maybe" }), "utf8");
    const read = readGuardianReplies(replyDir);
    expect(read.replies.map((item) => item.requestId)).toEqual(["grd-ok"]);
    expect(read.errors).toHaveLength(1);
  });

  it("resolveGuardianRequests：有应答→answered；没到点→pending；过了超时→timed-out", () => {
    const at = "2026-10-31T00:00:00.000Z";
    const base = Date.parse(at);
    const requests = [
      request({ requestId: "grd-a", at }),
      request({ requestId: "grd-b", at }),
      request({ requestId: "grd-c", at }),
    ];
    const replies: GuardianReply[] = [
      { requestId: "grd-a", at, from: "lead", verdict: "help", note: "我来" },
    ];
    const pending = resolveGuardianRequests(requests, replies, base + 60_000);
    expect(pending.map((item) => item.state)).toEqual(["answered", "pending", "pending"]);
    const timedOut = resolveGuardianRequests(requests, replies, base + 8 * 3_600_000);
    expect(timedOut.map((item) => item.state)).toEqual(["answered", "timed-out", "timed-out"]);
    expect(timedOut[1]?.fact ?? "").toContain("回音");
  });

  it("处理完的应答可以删掉（不重复消费）", () => {
    const replyDir = guardianReplyDir(dir);
    writeGuardianReply(replyDir, {
      requestId: "grd-gone",
      at: "2026-10-31T01:00:00.000Z",
      from: "lead",
      verdict: "help",
      note: "好",
    });
    removeGuardianReply(replyDir, "grd-gone");
    expect(readGuardianReplies(replyDir).replies).toHaveLength(0);
  });
});
