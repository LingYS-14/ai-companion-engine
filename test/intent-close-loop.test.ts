/**
 * 闭环（recordSpokenAttempt）：开口成功后把意图标成 done
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHAT_REPLY_MEMORY_SOURCE,
  FAILED_SPEAK_VERDICTS,
  NEUTRAL_AGENCY,
  SPOKEN_MEMORY_SOURCE,
  chatReplyMemorySeed,
  ensureSpokenRecord,
  findRecentRepeat,
  isFailedSpeakVerdict,
  recordHeldAttempt,
  recordSpeakFailure,
  recordSpokenAttempt,
  sourcesForOutlet,
  spokenMemorySeed,
} from "../src/orchestrator/intent/close-loop.js";
import { formatUtc } from "../src/orchestrator/intent/episode.js";
import { dropExhaustedIntentions } from "../src/orchestrator/intent/intent-lifecycle.js";
import type { Candidate, IntentionRecord } from "../src/orchestrator/intent/types.js";

const NOW = Date.UTC(2026, 9, 31, 3, 30, 0);

function rec(overrides: Partial<IntentionRecord> = {}): IntentionRecord {
  return {
    id: "itn-reach_out-1",
    created_at: new Date(NOW - 60_000).toISOString(),
    kind: "reach_out",
    goal: "想找用户说句话",
    why: "想有人陪",
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

describe("recordSpokenAttempt：真的做了", () => {
  it("pending → 记一笔 ok，状态变 done、survival 增加、attempt 形状正确", () => {
    const result = recordSpokenAttempt({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    expect(result.closed).not.toBeNull();
    const closed = result.closed as IntentionRecord;
    expect(closed.status).toBe("done");
    expect(closed.survival).toBe(2);
    expect(closed.attempts).toHaveLength(1);
    expect(closed.attempts[0]).toEqual({
      at: formatUtc(NOW),
      act: "proactive_speak",
      outcome: "ok",
      agency: NEUTRAL_AGENCY,
    });
    expect(result.note).toContain("成功");
    expect(result.records[0]).toBe(closed);
  });

  it("只改目标那条，其余原样保留（顺序不变）", () => {
    const other = rec({ id: "itn-explore-2", kind: "explore" });
    const result = recordSpokenAttempt({ records: [other, rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toBe(other);
    expect(result.records[1]?.status).toBe("done");
  });

  it("blocked 的意图也能记成功（它在被拦后仍可能通过别的时机做成）", () => {
    const blocked = rec({ status: "blocked", blocked_by: "quota" });
    const result = recordSpokenAttempt({ records: [blocked], intentionId: blocked.id, nowMs: NOW });
    expect(result.closed?.status).toBe("done");
    expect(result.closed?.blocked_by).toBeNull();
  });

  it("可指定 act 与 agency（归因接上后写真值而不是中性值）", () => {
    const result = recordSpokenAttempt({
      records: [rec()],
      intentionId: "itn-reach_out-1",
      nowMs: NOW,
      act: "reply",
      agency: 0.9,
    });
    expect(result.closed?.attempts[0]?.act).toBe("reply");
    expect(result.closed?.attempts[0]?.agency).toBe(0.9);
  });
});

describe("recordSpokenAttempt：不该记的时候不记", () => {
  it("没给意图 id → 原样返回并说明原因", () => {
    const records = [rec()];
    const result = recordSpokenAttempt({ records, intentionId: null, nowMs: NOW });
    expect(result.records).toBe(records);
    expect(result.closed).toBeNull();
    expect(result.note).toContain("不追记");
  });

  it("id 不在表里 → 原样返回", () => {
    const records = [rec()];
    const result = recordSpokenAttempt({ records, intentionId: "itn-nope", nowMs: NOW });
    expect(result.records).toBe(records);
    expect(result.closed).toBeNull();
    expect(result.note).toContain("没有");
  });

  it("已 done/dropped → 不重复记", () => {
    for (const status of ["done", "dropped"] as const) {
      const records = [rec({ status })];
      const result = recordSpokenAttempt({ records, intentionId: records[0]?.id, nowMs: NOW });
      expect(result.records).toBe(records);
      expect(result.closed).toBeNull();
      expect(result.note).toContain("已了结");
    }
  });

  it("非法 nowMs / agency 抛 RangeError", () => {
    expect(() => recordSpokenAttempt({ records: [], intentionId: null, nowMs: Number.NaN })).toThrow(RangeError);
    expect(() =>
      recordSpokenAttempt({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW, agency: 1.5 }),
    ).toThrow(RangeError);
  });
});

describe("recordHeldAttempt：她决定先不说", () => {
  it("pending → held，记一笔 noop（不是失败、不当作 done）", () => {
    const result = recordHeldAttempt({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    expect(result.held).not.toBeNull();
    const held = result.held as IntentionRecord;
    expect(held.status).toBe("held");
    expect(held.attempts).toHaveLength(1);
    expect(held.attempts[0]?.outcome).toBe("noop");
    expect(held.attempts[0]?.act).toBe("proactive_hold");
    expect(held.attempts[0]?.at).toBe(formatUtc(NOW));
    // 先不说不是"做成了"，但确实被推进过一次（survival 是"跨拍被推进次数"，不是成功次数）
    expect(held.survival).toBe(1);
    expect(result.note).toContain("先不说");
  });

  it("D11-2：held 记录会带下一次到点 trigger；无时间语义的 kind 为 null", () => {
    const reach = recordHeldAttempt({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    const held = reach.held as IntentionRecord;
    expect(held.trigger).toEqual({ type: "time", spec: new Date(NOW + 6 * 60 * 60 * 1000).toISOString() });
    const idle = recordHeldAttempt({
      records: [rec({ kind: "idle" })],
      intentionId: "itn-reach_out-1",
      nowMs: NOW,
    });
    expect((idle.held as IntentionRecord).trigger).toBeNull();
  });

  it("held 可以再 held（下一拍又看过一次）", () => {
    const first = recordHeldAttempt({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW });
    const second = recordHeldAttempt({
      records: first.records,
      intentionId: "itn-reach_out-1",
      nowMs: NOW + 300_000,
    });
    expect(second.held?.status).toBe("held");
    expect(second.held?.attempts).toHaveLength(2);
  });

  it("blocked 也能记 held（被闸拦下时她仍然做了判断）", () => {
    const result = recordHeldAttempt({
      records: [rec({ status: "blocked", blocked_by: "quiet" })],
      intentionId: "itn-reach_out-1",
      nowMs: NOW,
    });
    expect(result.held?.status).toBe("held");
    expect(result.held?.blocked_by).toBe("quiet");
  });

  it("done/dropped/找不到/没给 id → 原样返回，不凭空记", () => {
    for (const status of ["done", "dropped"] as const) {
      const records = [rec({ status })];
      const result = recordHeldAttempt({ records, intentionId: records[0]?.id, nowMs: NOW });
      expect(result.records).toBe(records);
      expect(result.held).toBeNull();
    }
    const unknown = recordHeldAttempt({ records: [], intentionId: "nope", nowMs: NOW });
    expect(unknown.held).toBeNull();
    const noId = recordHeldAttempt({ records: [rec()], intentionId: null, nowMs: NOW });
    expect(noId.held).toBeNull();
  });

  it("非法 nowMs / agency 抛 RangeError", () => {
    expect(() => recordHeldAttempt({ records: [], intentionId: null, nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => recordHeldAttempt({ records: [rec()], intentionId: "x", nowMs: NOW, agency: -0.1 })).toThrow(
      RangeError,
    );
  });
});

describe("D11-2：普通开口失败也补 held + 下次到点 trigger（recordSpeakFailure）", () => {
  it("reach_out / continue_thread / repair 三种 kind：held、attempts+1、trigger 为 +6/12/24h", () => {
    for (const [kind, hours] of [
      ["reach_out", 6],
      ["continue_thread", 12],
      ["repair", 24],
    ] as const) {
      const result = recordSpeakFailure({
        records: [rec({ kind })],
        intentionId: "itn-reach_out-1",
        nowMs: NOW,
      });
      const failed = result.failed as IntentionRecord;
      expect(failed.status).toBe("held");
      expect(failed.attempts).toHaveLength(1);
      expect(failed.attempts[0]?.act).toBe("proactive_speak_failed");
      expect(failed.attempts[0]?.outcome).toBe("noop");
      expect(failed.trigger).toEqual({ type: "time", spec: new Date(NOW + hours * 60 * 60 * 1000).toISOString() });
    }
  });

  it("idle 等无时间语义的 kind → trigger null（照样 held、不丢记录）", () => {
    const result = recordSpeakFailure({ records: [rec({ kind: "idle" })], intentionId: "itn-reach_out-1", nowMs: NOW });
    const failed = result.failed as IntentionRecord;
    expect(failed.status).toBe("held");
    expect(failed.trigger).toBeNull();
  });

  it("done/dropped 不记；找不到/没给 id 返回 null 且原数组不动", () => {
    for (const status of ["done", "dropped"] as const) {
      const records = [rec({ status })];
      const result = recordSpeakFailure({ records, intentionId: records[0]?.id, nowMs: NOW });
      expect(result.failed).toBeNull();
      expect(result.records).toBe(records);
    }
    for (const id of [null, undefined, "", "nope"]) {
      const records = [rec()];
      const result = recordSpeakFailure({ records, intentionId: id, nowMs: NOW });
      expect(result.failed).toBeNull();
      expect(result.records).toBe(records);
    }
  });

  it("非法 nowMs / agency 抛 RangeError", () => {
    expect(() => recordSpeakFailure({ records: [], intentionId: null, nowMs: Number.NaN })).toThrow(RangeError);
    expect(() =>
      recordSpeakFailure({ records: [rec()], intentionId: "itn-reach_out-1", nowMs: NOW, agency: 1.2 }),
    ).toThrow(RangeError);
  });

  it("isFailedSpeakVerdict：只认 llm-failed / empty-reply / send-failed 三种", () => {
    expect([...FAILED_SPEAK_VERDICTS]).toEqual(["llm-failed", "empty-reply", "send-failed"]);
    for (const verdict of ["llm-failed", "empty-reply", "send-failed"]) {
      expect(isFailedSpeakVerdict(verdict)).toBe(true);
    }
    for (const verdict of ["held", "dry-run", "calm", "gap", "daily", "disabled", "quiet", ""]) {
      expect(isFailedSpeakVerdict(verdict)).toBe(false);
    }
  });
});

describe("ensureSpokenRecord：开口前没有 open 记录就补一条", () => {
  it("空表 → 补一条 pending（id 带 kind 与时间，goal/why 照传）", () => {
    const result = ensureSpokenRecord({
      records: [],
      kind: "reach_out",
      nowMs: NOW,
      goal: "想找用户说句话",
      why: "想有人陪",
    });
    expect(result.created).toBe(true);
    expect(result.reopened).toBe(false);
    const record = result.record as IntentionRecord;
    expect(record.id).toBe(`itn-reach_out-${String(NOW)}`);
    expect(record.status).toBe("pending");
    expect(record.kind).toBe("reach_out");
    expect(record.goal).toBe("想找用户说句话");
    expect(record.why).toBe("想有人陪");
    expect(record.created_at).toBe(formatUtc(NOW));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toBe(record);
    expect(result.note).toContain("补了一条");
  });

  it("已有 open（pending/active/blocked）→ 原样返回那条，不新建、不改数组", () => {
    for (const status of ["pending", "active", "blocked"] as const) {
      const records = [rec({ status })];
      const result = ensureSpokenRecord({ records, kind: "reach_out", nowMs: NOW });
      expect(result.created).toBe(false);
      expect(result.reopened).toBe(false);
      expect(result.record).toBe(records[0]);
      expect(result.records).toBe(records);
    }
  });

  it("只有 held → 放回 pending，attempts 保留，且清掉旧的到点 trigger（D11-2）", () => {
    const held = rec({
      status: "held",
      trigger: { type: "time", spec: new Date(NOW + 6 * 60 * 60 * 1000).toISOString() },
      attempts: [{ at: formatUtc(NOW - 1000), act: "proactive_hold", outcome: "noop" as const, agency: NEUTRAL_AGENCY }],
      survival: 1,
    });
    const result = ensureSpokenRecord({ records: [held], kind: "reach_out", nowMs: NOW });
    expect(result.created).toBe(false);
    expect(result.reopened).toBe(true);
    expect(result.record?.status).toBe("pending");
    expect(result.record?.blocked_by).toBeNull();
    expect(result.record?.id).toBe(held.id);
    expect(result.record?.attempts).toHaveLength(1);
    // 重开 = 现在就说；旧 trigger 不清会被 due 立刻再次浮现
    expect(result.record?.trigger).toBeNull();
    expect(held.status).toBe("held"); // 纯函数：入参不被改写
  });

  it("只有 done/dropped → 补一条新 pending，旧的终态一个字不动", () => {
    for (const status of ["done", "dropped"] as const) {
      const old = rec({ status });
      const result = ensureSpokenRecord({ records: [old], kind: "reach_out", nowMs: NOW });
      expect(result.created).toBe(true);
      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toBe(old);
      expect(old.status).toBe(status);
      expect(result.record?.id).not.toBe(old.id);
    }
  });

  it("别的类别开着不算数（按 kind 各记各的）", () => {
    const other = rec({ id: "itn-explore-1", kind: "explore" });
    const result = ensureSpokenRecord({ records: [other], kind: "reach_out", nowMs: NOW });
    expect(result.created).toBe(true);
    expect(result.records).toHaveLength(2);
  });

  it("补出来的记录能被 recordSpokenAttempt 正常闭环（落到 done）", () => {
    const ensured = ensureSpokenRecord({ records: [], kind: "reach_out", nowMs: NOW });
    const closed = recordSpokenAttempt({
      records: ensured.records,
      intentionId: ensured.record?.id,
      nowMs: NOW + 1000,
    });
    expect(closed.closed?.status).toBe("done");
    expect(closed.closed?.attempts).toHaveLength(1);
  });

  it("补建 id 与 emitted 落表撞了才加后缀", () => {
    const taken = rec({ id: `itn-reach_out-${String(NOW)}`, status: "done" });
    const result = ensureSpokenRecord({ records: [taken], kind: "reach_out", nowMs: NOW });
    expect(result.record?.id).toBe(`itn-reach_out-${String(NOW)}-2`);
  });

  it("没有类别 → 不补；非法 nowMs 抛 RangeError", () => {
    const records = [rec()];
    for (const kind of [null, undefined] as const) {
      const result = ensureSpokenRecord({ records, kind, nowMs: NOW });
      expect(result.record).toBeNull();
      expect(result.created).toBe(false);
      expect(result.records).toBe(records);
    }
    expect(() => ensureSpokenRecord({ records: [], kind: "reach_out", nowMs: Number.NaN })).toThrow(RangeError);
  });
});

describe("F350 I1：同题 24h 去重（findRecentRepeat）", () => {
  const HOUR = 60 * 60 * 1000;
  const WINDOW = 24 * HOUR;
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it("窗口内同 goal（trim 后相等）→ 命中刚 done 的那条", () => {
    const done = rec({ id: "itn-done-1", status: "done", goal: "  想问她昨天那件事  ", created_at: ago(2 * HOUR) });
    expect(findRecentRepeat({ records: [done], goal: "想问她昨天那件事", nowMs: NOW, windowMs: WINDOW })).toBe(done);
  });

  it("同 sourceId、不同 goal → 也命中（spec 默认 goal 或 source 二选一）", () => {
    const done = rec({ id: "itn-done-1", status: "done", goal: "另一句话", source_ids: ["mem-1"], created_at: ago(HOUR) });
    expect(
      findRecentRepeat({ records: [done], goal: "完全不同", sourceIds: ["mem-1"], nowMs: NOW, windowMs: WINDOW }),
    ).toBe(done);
  });

  it("窗口外 → null；未来 created_at / 非法 created_at 跳过", () => {
    const old = rec({ id: "itn-done-old", status: "done", goal: "同一句", created_at: ago(25 * HOUR) });
    const future = rec({ id: "itn-done-future", status: "done", goal: "同一句", created_at: ago(-HOUR) });
    const bad = rec({ id: "itn-done-bad", status: "done", goal: "同一句", created_at: "not-a-date" });
    expect(findRecentRepeat({ records: [old, future, bad], goal: "同一句", nowMs: NOW, windowMs: WINDOW })).toBeNull();
    expect(findRecentRepeat({ records: [old], goal: "同一句", nowMs: NOW, windowMs: WINDOW })).toBeNull();
    expect(findRecentRepeat({ records: [bad], goal: "同一句", nowMs: NOW, windowMs: WINDOW })).toBeNull();
  });

  it("非 done 不算（pending/active/blocked/held/dropped 都不行）", () => {
    const records = (["pending", "active", "blocked", "held", "dropped"] as const).map((status, i) =>
      rec({ id: `itn-${status}-${String(i)}`, status, goal: "同一句", created_at: ago(HOUR) }),
    );
    expect(findRecentRepeat({ records, goal: "同一句", nowMs: NOW, windowMs: WINDOW })).toBeNull();
  });

  it("goal 与 sourceIds 都空 → null（不猜）；只有 goal 空但来源有交集仍命中", () => {
    const done = rec({ id: "itn-done-1", status: "done", goal: "同一句", source_ids: ["mem-1"], created_at: ago(HOUR) });
    expect(findRecentRepeat({ records: [done], goal: null, nowMs: NOW, windowMs: WINDOW })).toBeNull();
    expect(findRecentRepeat({ records: [done], goal: "   ", sourceIds: [""], nowMs: NOW, windowMs: WINDOW })).toBeNull();
    expect(findRecentRepeat({ records: [done], goal: null, sourceIds: ["mem-1"], nowMs: NOW, windowMs: WINDOW })).toBe(done);
  });

  it("多条命中取最新；同一时刻按 id 字典序稳定", () => {
    const older = rec({ id: "itn-done-a", status: "done", goal: "同一句", created_at: ago(3 * HOUR) });
    const latest = rec({ id: "itn-done-b", status: "done", goal: "同一句", created_at: ago(HOUR) });
    expect(findRecentRepeat({ records: [older, latest], goal: "同一句", nowMs: NOW, windowMs: WINDOW })).toBe(latest);
    const sameTimeB = rec({ id: "itn-done-b2", status: "done", goal: "同一句", created_at: ago(HOUR) });
    expect(
      findRecentRepeat({ records: [latest, sameTimeB], goal: "同一句", nowMs: NOW, windowMs: WINDOW })?.id,
    ).toBe("itn-done-b");
  });

  it("goal 不同且来源无交集 → null；非法 nowMs/windowMs 抛 RangeError", () => {
    const done = rec({ id: "itn-done-1", status: "done", goal: "另一句", source_ids: ["mem-1"], created_at: ago(HOUR) });
    expect(
      findRecentRepeat({ records: [done], goal: "这一句", sourceIds: ["mem-2"], nowMs: NOW, windowMs: WINDOW }),
    ).toBeNull();
    expect(() => findRecentRepeat({ records: [done], goal: "同一句", nowMs: Number.NaN, windowMs: WINDOW })).toThrow(
      RangeError,
    );
    expect(() => findRecentRepeat({ records: [done], goal: "同一句", nowMs: NOW, windowMs: -1 })).toThrow(RangeError);
  });
});

describe("F349 I3：ensure 记录按实际出口补 source_ids", () => {
  function candidate(overrides: Partial<Candidate> = {}): Candidate {
    return {
      kind: "reach_out",
      goal: "想找用户说句话",
      because: [{ drive: "connection", gap: 0.5, memoryId: "mem-top-1" }],
      drive_impact: {},
      planSeeds: [],
      score: 0.5,
      cost: { risk: "low", tokens: 100, socialRisk: 0.1 },
      identityFit: 0.5,
      ...overrides,
    };
  }

  it("due 优先：有到点的旧意图时只用它的 source_ids", () => {
    const dueHit = rec({ id: "itn-due-1", source_ids: ["mem-due-1", "mem-due-2"] });
    const speakable = rec({ id: "itn-speak-1", source_ids: ["mem-speak-1"] });
    const top = candidate();
    expect(sourcesForOutlet({ dueHit, speakable, top })).toEqual(["mem-due-1", "mem-due-2"]);
  });

  it("speakable 次之：没有 due 时用重提那条的来源", () => {
    const speakable = rec({ id: "itn-speak-1", source_ids: ["mem-speak-1", "mem-speak-2"] });
    expect(sourcesForOutlet({ dueHit: null, speakable, top: candidate() })).toEqual([
      "mem-speak-1",
      "mem-speak-2",
    ]);
  });

  it("基础 outlet：用 top.because 的 memoryId，去空/去重/截 3", () => {
    const top = candidate({
      because: [
        { drive: "connection", gap: 0.5, memoryId: "mem-1" },
        { drive: "connection", gap: 0.4, memoryId: "mem-1" },
        { drive: "connection", gap: 0.3, memoryId: "   " },
        { drive: "connection", gap: 0.2 },
        { drive: "novelty", gap: 0.1, memoryId: "mem-2" },
        { drive: "novelty", gap: 0.1, memoryId: "mem-3" },
        { drive: "novelty", gap: 0.1, memoryId: "mem-4" },
      ],
    });
    expect(sourcesForOutlet({ dueHit: null, speakable: null, top })).toEqual(["mem-1", "mem-2", "mem-3"]);
  });

  it("没有来源时返回空数组；due 存在但来源为空也不回落到 speakable（出口一致优先）", () => {
    expect(sourcesForOutlet({ dueHit: null, speakable: null, top: null })).toEqual([]);
    expect(
      sourcesForOutlet({
        dueHit: rec({ id: "itn-due-empty", source_ids: [] }),
        speakable: rec({ id: "itn-speak-1", source_ids: ["mem-speak-1"] }),
        top: candidate(),
      }),
    ).toEqual([]);
  });

  it("ensureSpokenRecord 传入来源时落到新记录的 source_ids", () => {
    const result = ensureSpokenRecord({
      records: [],
      kind: "reach_out",
      nowMs: NOW,
      sourceIds: ["mem-1", "mem-2"],
    });
    expect(result.created).toBe(true);
    expect(result.record?.source_ids).toEqual(["mem-1", "mem-2"]);
  });

  it("不传来源时 source_ids 为空（旧行为）；reopened 保留旧来源不追加", () => {
    const bare = ensureSpokenRecord({ records: [], kind: "reach_out", nowMs: NOW });
    expect(bare.record?.source_ids).toEqual([]);
    const held = rec({ status: "held", source_ids: ["mem-old"] });
    const reopened = ensureSpokenRecord({
      records: [held],
      kind: "reach_out",
      nowMs: NOW,
      sourceIds: ["mem-new"],
    });
    expect(reopened.reopened).toBe(true);
    expect(reopened.record?.source_ids).toEqual(["mem-old"]);
  });
});

describe("spokenMemorySeed：她说出口的话进记忆", () => {
  it("包成第一人称、来源 clean、带 proactive 标签", () => {
    const seed = spokenMemorySeed({ reply: "  用户，今天的光很好看  ", kind: "create" });
    expect(seed.content).toBe("我主动开口说：「用户，今天的光很好看」");
    expect(seed.source).toBe(SPOKEN_MEMORY_SOURCE);
    expect(seed.source).toBe("proactive");
    // 防火墙名单（spec/config/engine.json 的 UNTRUSTED_SOURCES = web/parasocial/unknown）
    expect(["web", "parasocial", "unknown"]).not.toContain(seed.source);
    expect(seed.tags).toEqual(["proactive", "create"]);
    expect(seed.vividness).toBeGreaterThan(0);
    expect(seed.vividness).toBeLessThanOrEqual(1);
    expect(seed.selfRelevance).toBeGreaterThan(0);
    expect(seed.selfRelevance).toBeLessThanOrEqual(1);
    // P2a：她主动说出的话方向固定 outbound（main.mjs 把 seed 原样交给 runtime.remember）
    expect(seed.direction).toBe("outbound");
  });

  it("没有 kind 也仍是 outbound（方向不依赖意图类别）", () => {
    expect(spokenMemorySeed({ reply: "嗯。" }).direction).toBe("outbound");
  });

  it("没有 kind → 只打 proactive 标签", () => {
    expect(spokenMemorySeed({ reply: "嗯。", kind: null }).tags).toEqual(["proactive"]);
    expect(spokenMemorySeed({ reply: "嗯。" }).tags).toEqual(["proactive"]);
  });

  it("空回复抛 RangeError（只有真的发出去才写）", () => {
    expect(() => spokenMemorySeed({ reply: "   " })).toThrow(RangeError);
  });

  it("批次1B/T2：传 goalAtTime/goalId 就 trim 后带出；不传或空串不伪造键", () => {
    const seed = spokenMemorySeed({ reply: "嗯。", goalAtTime: "  等她忙完  ", goalId: " itn-reach-1 " });
    expect(seed.goalAtTime).toBe("等她忙完");
    expect(seed.goalId).toBe("itn-reach-1");
    // 只加字段，不改内容/标签/来源
    expect(seed.content).toBe("我主动开口说：「嗯。」");
    expect(seed.tags).toEqual(["proactive"]);
    expect(seed.source).toBe("proactive");

    const bare = spokenMemorySeed({ reply: "嗯。" });
    expect("goalAtTime" in bare).toBe(false);
    expect("goalId" in bare).toBe(false);

    const blank = spokenMemorySeed({ reply: "嗯。", goalAtTime: "   ", goalId: "" });
    expect("goalAtTime" in blank).toBe(false);
    expect("goalId" in blank).toBe(false);
  });
});

describe("P0-F chatReplyMemorySeed：QQ 回信也进记忆", () => {
  it("不传 tags：与旧行为逐位一致（只打 chat 标签）", () => {
    const seed = chatReplyMemorySeed({ reply: "好呀♪" });
    expect(seed.content).toBe("我说：「好呀♪」");
    expect(seed.source).toBe(CHAT_REPLY_MEMORY_SOURCE);
    expect(seed.source).toBe("chat_reply");
    expect(seed.tags).toEqual(["chat"]);
    expect(seed.direction).toBe("outbound");
    expect(seed.vividness).toBeGreaterThan(0);
    expect(seed.selfRelevance).toBeGreaterThan(0);
  });

  it("传 tags：按通道打标签（QQ = chat + qq），顺序原样保留", () => {
    const seed = chatReplyMemorySeed({ reply: "好呀♪", tags: ["chat", "qq"] });
    expect(seed.tags).toEqual(["chat", "qq"]);
    expect(seed.source).toBe("chat_reply");
    expect(seed.direction).toBe("outbound");
  });
});

describe("装配点接线（批次1B）：判断留在脑内，main.mjs 只调用", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const main = readFileSync(join(root, "scripts", "autonomy", "main.mjs"), "utf8");

  it("tick 里对 speak 出口调用 ensureSpokenRecord，并把补出来的记录写回意图表", () => {
    expect(main).toContain('effectiveOutlet.target === "speak"');
    expect(main).toContain("ensureSpokenRecord({");
    expect(main).toContain("writeIntentionsFile(speakRecords)");
    expect(main).toContain("ensuredSpoken ??");
  });

  it("发送成功后调用 spokenMemorySeed + runtime.remember（成功才写、只写一次）", () => {
    expect(main).toContain("spokenMemorySeed({");
    expect(main).toContain("runtime.remember(seed)");
    // 写记忆的守卫必须是"真的发出去了"，而不是"生成了台词"
    expect(main).toMatch(/if \(r\.acted && r\.reply !== undefined\) \{/);
  });

  it("批次1B/T2：意图上下文经 intentContextOf 汇聚，goalAtTime/goalId 从 topRecord 带出", () => {
    expect(main).toContain("intentContextOf({");
    expect(main).toContain("topRecord,");
    expect(main).toContain("...(intentCtx?.goalAtTime === undefined ? {} : { goalAtTime: intentCtx.goalAtTime })");
    expect(main).toContain("...(intentCtx?.goalId === undefined ? {} : { goalId: intentCtx.goalId })");
  });

  it("批次1B/T2：每拍入口先重置 lastIntentContext（早退也不继承上一拍）", () => {
    const resetAt = main.indexOf("lastIntentContext = undefined;");
    const asleepAt = main.indexOf("if (runtime.sleepInfo().asleep) return;");
    expect(resetAt).toBeGreaterThan(0);
    expect(asleepAt).toBeGreaterThan(resetAt);
  });

  it("F349 I3：ensure 前按出口取来源，且只给 speak 的 ensure 传 sourceIds（空则省略）", () => {
    expect(main).toContain("sourcesForOutlet({ dueHit, speakable, top })");
    expect(main).toContain("...(outletSources.length === 0 ? {} : { sourceIds: outletSources })");
    const outletAt = main.indexOf("const outletSources = sourcesForOutlet(");
    const ensureAt = main.indexOf("ensureSpokenRecord({");
    // F350 I1 之后 outletSources 也会喂给重复判定（2 处：repeat 参数 + ensure spread）；
    // ensure 的 spread 仍在 ensureSpokenRecord 调用内部。
    const sourceIdsAfterEnsure = main.indexOf("sourceIds: outletSources", ensureAt);
    expect(outletAt).toBeGreaterThan(0);
    expect(ensureAt).toBeGreaterThan(outletAt);
    expect(sourceIdsAfterEnsure).toBeGreaterThan(ensureAt);
    expect(main.split("sourceIds: outletSources").length - 1).toBe(2);
  });

  it("D11-2：失败两路都走 isFailedSpeakVerdict allowlist，普通开口失败记账在 lookahead 之后", () => {
    expect(main).toContain("isFailedSpeakVerdict,");
    // 两路各一次：lookahead 分支内 allowlist + 普通开口 else-if 条件
    expect(main.split("isFailedSpeakVerdict(r.verdict)").length - 1).toBe(2);
    const successAt = main.indexOf("if (r.acted && r.reply !== undefined && intentCtx?.intentionId !== undefined)");
    const surfacedAt = main.indexOf("recordSurfacedFailure({");
    const speakFailedAt = main.indexOf("recordSpeakFailure({");
    expect(successAt).toBeGreaterThan(0);
    expect(surfacedAt).toBeGreaterThan(successAt);
    expect(speakFailedAt).toBeGreaterThan(surfacedAt);
    expect(main).toContain("`[intent] 开口失败：${failed.note}");
  });
});

describe("F312：跨多拍的 held 也会攒到 5 次并放弃", () => {
  it("连续 6 拍 held → attempts=6；dropExhausted 放弃这条（此前 held 被排除）", () => {
    let records: readonly IntentionRecord[] = [rec()];
    for (let tick = 0; tick < 6; tick += 1) {
      const result = recordHeldAttempt({
        records,
        intentionId: "itn-reach_out-1",
        nowMs: NOW + tick * 300_000,
      });
      records = result.records;
    }
    const held = records[0] as IntentionRecord;
    expect(held.status).toBe("held");
    expect(held.attempts).toHaveLength(6);
    const dropped = dropExhaustedIntentions(records);
    expect(dropped.dropped).toEqual(["itn-reach_out-1"]);
    expect(dropped.records[0]?.status).toBe("dropped");
  });

  it("同一条 held 第 5 次就够（不用等第 6 次）", () => {
    let records: readonly IntentionRecord[] = [rec()];
    for (let tick = 0; tick < 5; tick += 1) {
      records = recordHeldAttempt({
        records,
        intentionId: "itn-reach_out-1",
        nowMs: NOW + tick * 300_000,
      }).records;
    }
    expect(dropExhaustedIntentions(records).dropped).toEqual(["itn-reach_out-1"]);
  });
});
