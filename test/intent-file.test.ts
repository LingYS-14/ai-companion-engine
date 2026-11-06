/**
 * 意图表落盘（P2/P1 跨重启）：序列化 / fail-closed 解析 / 活跃口径 / 上限与保留期
 */

import { describe, expect, it } from "vitest";

import {
  activeKindsOf,
  describeIntentionFile,
  INTENT_FILE_VERSION,
  MAX_INTENT_RECORDS,
  openIntentions,
  parseIntentionFile,
  pruneIntentions,
  serializeIntentionFile,
  trimIntentions,
  upsertIntention,
} from "../src/orchestrator/intent/intent-file.js";
import type { IntentionRecord } from "../src/orchestrator/intent/types.js";

const NOW = Date.UTC(2026, 9, 31, 2, 0, 0);

function rec(overrides: Partial<IntentionRecord> = {}): IntentionRecord {
  return {
    id: "itn-1",
    created_at: new Date(NOW).toISOString(),
    kind: "reach_out",
    goal: "想找用户说句话",
    why: "因为想有人陪",
    trigger: null,
    deadline: null,
    status: "pending",
    blocked_by: null,
    attempts: [],
    superseded_by: null,
    survival: 0,
    source_ids: [],
    ...overrides,
  };
}

function rawWith(records: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: INTENT_FILE_VERSION, savedAtMs: NOW, records, ...extra });
}

describe("意图表：序列化与往返", () => {
  it("往返不丢字段；按 created_at 新→旧排序", () => {
    const older = rec({ id: "old", created_at: new Date(NOW - 3_600_000).toISOString() });
    const newer = rec({ id: "new", created_at: new Date(NOW).toISOString() });
    const parsed = parseIntentionFile(serializeIntentionFile([older, newer], NOW));
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.records.map((r) => r.id)).toEqual(["new", "old"]);
    expect(parsed.file?.records[1]).toEqual(older);
  });

  it("同一份记录两次序列化逐字节相同", () => {
    const a = serializeIntentionFile([rec(), rec({ id: "itn-2" })], NOW);
    const b = serializeIntentionFile([rec(), rec({ id: "itn-2" })], NOW);
    expect(a).toBe(b);
  });

  it("非法 savedAtMs 抛 RangeError", () => {
    expect(() => serializeIntentionFile([], Number.NaN)).toThrow(RangeError);
    expect(() => serializeIntentionFile([], -1)).toThrow(RangeError);
  });
});

describe("意图表：fail-closed 解析", () => {
  it("坏 JSON / 顶层不是对象 / 版本不符 / 未知字段 都整体拒绝", () => {
    expect(parseIntentionFile("{not json").file).toBeNull();
    expect(parseIntentionFile("[]").file).toBeNull();
    expect(parseIntentionFile(rawWith([], { version: 999 })).errors.join()).toContain("版本不符");
    expect(parseIntentionFile(rawWith([], { extra: true })).errors.join()).toContain("未知字段");
  });

  it("单条坏记录 / 重复 id 都让整张表拒绝（不给半份表）", () => {
    const badKind = parseIntentionFile(rawWith([rec({ kind: "fly" as never })]));
    expect(badKind.file).toBeNull();
    expect(badKind.errors.join()).toContain("kind 非法");

    const badStatus = parseIntentionFile(rawWith([rec({ status: "zombie" as never })]));
    expect(badStatus.file).toBeNull();

    const emptyGoal = parseIntentionFile(rawWith([rec({ goal: "  " })]));
    expect(emptyGoal.errors.join()).toContain("goal 为空");

    const dup = parseIntentionFile(rawWith([rec(), rec()]));
    expect(dup.file).toBeNull();
    expect(dup.errors.join()).toContain("重复 id");

    const badSurvival = parseIntentionFile(rawWith([rec({ survival: -1 })]));
    expect(badSurvival.errors.join()).toContain("survival");
  });

  it("trigger/deadline 可缺省（读回 null），blocked_by 缺省为 null", () => {
    const parsed = parseIntentionFile(
      rawWith([{ ...rec(), trigger: undefined, deadline: undefined, blocked_by: undefined }]),
    );
    expect(parsed.file?.records[0]?.trigger).toBeNull();
    expect(parsed.file?.records[0]?.deadline).toBeNull();
    expect(parsed.file?.records[0]?.blocked_by).toBeNull();
  });
});

describe("意图表：口径与维护", () => {
  it("openIntentions 只算 pending/active/blocked", () => {
    const records = [
      rec({ id: "a", status: "pending" }),
      rec({ id: "b", status: "active" }),
      rec({ id: "c", status: "blocked" }),
      rec({ id: "d", status: "done" }),
      rec({ id: "e", status: "dropped" }),
    ];
    expect(openIntentions(records).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("activeKindsOf 只认 active 且去重", () => {
    const records = [
      rec({ id: "a", kind: "reach_out", status: "active" }),
      rec({ id: "b", kind: "reach_out", status: "active" }),
      rec({ id: "c", kind: "explore", status: "pending" }),
      rec({ id: "d", kind: "create", status: "blocked" }),
    ];
    expect(activeKindsOf(records)).toEqual(["reach_out"]);
  });

  it("upsert 同 id 覆盖、新 id 追加；超上限丢最旧", () => {
    const base = [rec({ id: "a", created_at: new Date(NOW - 5000).toISOString() })];
    const replaced = upsertIntention(base, rec({ id: "a", goal: "新目标" }));
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.goal).toBe("新目标");

    const many = Array.from({ length: MAX_INTENT_RECORDS + 5 }, (_, index) =>
      rec({ id: `itn-${String(index)}`, created_at: new Date(NOW - index * 1000).toISOString() }),
    );
    const capped = upsertIntention(many, rec({ id: "newest", created_at: new Date(NOW + 1000).toISOString() }));
    expect(capped.length).toBe(MAX_INTENT_RECORDS);
    expect(capped.some((r) => r.id === "itn-44")).toBe(false);
    expect(capped.some((r) => r.id === "itn-0")).toBe(true);
    expect(capped.some((r) => r.id === "newest")).toBe(true);
  });

  it("pruneIntentions 清掉超保留期的，返回被丢的 id", () => {
    const { records, dropped } = pruneIntentions(
      [
        rec({ id: "old", created_at: new Date(NOW - 8 * 86_400_000).toISOString() }),
        rec({ id: "new", created_at: new Date(NOW).toISOString() }),
      ],
      NOW,
    );
    expect(records.map((r) => r.id)).toEqual(["new"]);
    expect(dropped).toEqual(["old"]);
  });

  it("describeIntentionFile 一行说清 open/active/最旧", () => {
    const line = describeIntentionFile(
      [rec({ id: "a", status: "active", created_at: new Date(NOW - 7_200_000).toISOString() })],
      NOW,
    );
    expect(line).toContain("open=1");
    expect(line).toContain("active=1");
    expect(line).toContain("2.0h");
  });
});

describe("A5：held（她判断先不说）仍然算「开着」", () => {
  it("openIntentions 含 held；done/dropped 不含", () => {
    const records = [
      rec({ id: "p", status: "pending" }),
      rec({ id: "a", status: "active" }),
      rec({ id: "b", status: "blocked" }),
      rec({ id: "h", status: "held" }),
      rec({ id: "d", status: "done" }),
      rec({ id: "x", status: "dropped" }),
    ];
    expect(openIntentions(records).map((r) => r.id)).toEqual(["p", "a", "b", "h"]);
  });

  it("activeKindsOf 把 held 也算占用（否则下一拍会重新浮现同一条）", () => {
    const records = [
      rec({ id: "a", kind: "reach_out", status: "active" }),
      rec({ id: "h", kind: "continue_thread", status: "held" }),
      rec({ id: "d", kind: "explore", status: "done" }),
    ];
    expect(activeKindsOf(records).sort()).toEqual(["continue_thread", "reach_out"]);
  });

  it("held 状态能序列化/解析往返（不是非法状态）", () => {
    const raw = serializeIntentionFile([rec({ id: "h", status: "held" })], NOW);
    const parsed = parseIntentionFile(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.records[0]?.status).toBe("held");
  });
});

describe("F312 复核（supervisor）：upsertIntention 与 trimIntentions 共用同一上限规则", () => {
  it("超限时先保开着的记录，再丢最旧终态（不再用「丢最旧」那套）", () => {
    const done = Array.from({ length: MAX_INTENT_RECORDS - 1 }, (_, index) =>
      rec({ id: `done-${String(index)}`, status: "done", created_at: new Date(NOW + index * 1000).toISOString() }),
    );
    const openA = rec({ id: "open-a", status: "pending", created_at: new Date(NOW).toISOString() });
    const openB = rec({ id: "open-b", status: "held", created_at: new Date(NOW - 1000).toISOString() });
    const capped = upsertIntention([...done, openA], openB);
    expect(capped).toHaveLength(MAX_INTENT_RECORDS);
    expect(capped.some((record) => record.id === "open-a")).toBe(true);
    expect(capped.some((record) => record.id === "open-b")).toBe(true);
    // 被挤掉的是最旧的 done，而不是现在还开着的记录
    expect(capped.some((record) => record.id === "done-0")).toBe(false);
  });
});

describe("F312：trimIntentions —— 所有写盘点共用的上限裁剪", () => {
  it("没超上限：原样返回同一个数组（调用方可据此跳过建新对象）", () => {
    const records = [rec()];
    expect(trimIntentions(records)).toBe(records);
  });

  it("超上限：先保开着的，再按 created_at 新→旧补终态", () => {
    const open = [
      rec({ id: "o1", created_at: new Date(NOW - 10 * 60_000).toISOString(), status: "pending" }),
      rec({ id: "o2", created_at: new Date(NOW - 20 * 60_000).toISOString(), status: "active" }),
      rec({ id: "o3", created_at: new Date(NOW - 30 * 60_000).toISOString(), status: "blocked" }),
      rec({ id: "o4", created_at: new Date(NOW - 40 * 60_000).toISOString(), status: "held" }),
      rec({ id: "o5", created_at: new Date(NOW - 50 * 60_000).toISOString(), status: "pending" }),
    ];
    const done = Array.from({ length: 50 }, (_, i) =>
      rec({
        id: `d${i}`,
        created_at: new Date(NOW - (100 + i) * 60_000).toISOString(),
        status: "done",
      }),
    );
    const out = trimIntentions([...open, ...done]);
    expect(out).toHaveLength(MAX_INTENT_RECORDS);
    for (const record of open) expect(out.map((r) => r.id)).toContain(record.id);
    // 终态留最新的 35 条：d0..d34；更旧的 d49 被丢
    expect(out.map((r) => r.id)).toContain("d0");
    expect(out.map((r) => r.id)).toContain("d34");
    expect(out.map((r) => r.id)).not.toContain("d35");
    // 输出保持输入顺序
    expect(out.map((r) => r.id)).toEqual([...open, ...done].map((r) => r.id).filter((id) => out.some((r) => r.id === id)));
  });

  it("开着的本身就超上限：只保最新 max 条开着的（不能为了数量丢掉「还在想」）", () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      rec({
        id: `o${String(i)}`,
        created_at: new Date(NOW - i * 60_000).toISOString(),
        status: i % 2 === 0 ? "pending" : "held",
      }),
    );
    const out = trimIntentions(many);
    expect(out).toHaveLength(MAX_INTENT_RECORDS);
    expect(out.every((r) => r.status === "pending" || r.status === "held")).toBe(true);
    expect(out.map((r) => r.id)).toContain("o0");
    expect(out.map((r) => r.id)).not.toContain("o44");
  });

  it("非法上限抛 RangeError", () => {
    expect(() => trimIntentions([rec()], 0)).toThrow(RangeError);
    expect(() => trimIntentions([rec()], 2.5)).toThrow(RangeError);
  });
});

describe("task-193：trigger 落盘往返与旧表兼容", () => {
  const trigger = { type: "time" as const, spec: "2026-10-31T08:00:00.000Z" };

  it("trigger 往返不丢；旧表没有 trigger 字段 → null", () => {
    const withTrigger = rec({ id: "itn-trigger", trigger });
    const parsed = parseIntentionFile(serializeIntentionFile([withTrigger], NOW));
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.records[0]?.trigger).toEqual(trigger);

    // 旧版本没有 trigger 字段：解析成 null，不报错
    const legacy = rawWith([
      {
        id: "itn-legacy",
        created_at: new Date(NOW).toISOString(),
        kind: "reach_out",
        goal: "旧表里的一句话",
        why: "旧表",
        status: "pending",
        attempts: [],
        survival: 0,
        source_ids: [],
      },
    ]);
    const oldParsed = parseIntentionFile(legacy);
    expect(oldParsed.errors).toEqual([]);
    expect(oldParsed.file?.records[0]?.trigger).toBeNull();
  });

  it("坏 trigger spec 不让整张表被拒绝（隔离交给 dueIntentionsSafe）", () => {
    const bad = rec({ id: "itn-bad-trigger", trigger: { type: "time", spec: "不是时间" } });
    const parsed = parseIntentionFile(serializeIntentionFile([bad, rec({ id: "itn-ok" })], NOW));
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.records.map((r) => r.id).sort()).toEqual(["itn-bad-trigger", "itn-ok"]);
    expect(parsed.file?.records.find((r) => r.id === "itn-bad-trigger")?.trigger).toEqual({
      type: "time",
      spec: "不是时间",
    });
  });
});
