/**
 * F239：被暂时性硬闸（quota）拦下的意图，闸放开后要重新排队。
 *
 * 线上现场：额度吃完的那几个小时里，意图表攒了 3 条 `[被拦住了]（quota）`。
 * 额度恢复后它们既不会重试（没有同类空位检测以外的东西推动），也不会被替换
 * （同 kind 的 open 记录会挡住新建），于是"想说的话"被永久关在表里。
 *
 * 这里钉住边界：只复活 quota 这类会自愈的拦截；distrust / single_writer 各有恢复路径，
 * 不在这一层替它们决定；复活不增加 attempts（它不是一次尝试）。
 */
import { describe, expect, it } from "vitest";

import { markBlocked, newIntention } from "../src/orchestrator/intent/bus.js";
import {
  RETRYABLE_BLOCKERS,
  reviveBlockedIntentions,
} from "../src/orchestrator/intent/intent-lifecycle.js";

const NOW = "2026-10-31T09:00:00Z";

function record(id: string, kind: "reach_out" | "continue_thread" = "reach_out") {
  return newIntention({
    id,
    at: NOW,
    kind,
    goal: `说一句 ${id}`,
    why: "想说话（缺口 0.62）",
    sourceIds: [],
  });
}

describe("F239：被 quota 拦下的意图在闸放开后重新排队", () => {
  it("blocked_by=quota + 闸放开 → pending、清空 blocked_by、attempts 不变", () => {
    const blocked = markBlocked(record("itn-a"), "quota");
    const { records, revived } = reviveBlockedIntentions([blocked], { gateAllowed: true });
    expect(revived).toEqual(["itn-a"]);
    expect(records[0]?.status).toBe("pending");
    expect(records[0]?.blocked_by).toBeNull();
    expect(records[0]?.attempts.length).toBe(0);
    expect(records[0]?.survival).toBe(blocked.survival);
  });

  it("闸仍关着 → 原样返回（同一个数组，调用方据此判断不必写盘）", () => {
    const blocked = markBlocked(record("itn-a"), "quota");
    const out = reviveBlockedIntentions([blocked], { gateAllowed: false });
    expect(out.revived).toEqual([]);
    expect(out.records).toBe(out.records);
    expect(out.records[0]?.status).toBe("blocked");
  });

  it("distrust / single_writer 不归这里复活（各有恢复路径）", () => {
    const rows = [markBlocked(record("itn-a"), "distrust"), markBlocked(record("itn-b"), "single_writer")];
    const out = reviveBlockedIntentions(rows, { gateAllowed: true });
    expect(out.revived).toEqual([]);
    expect(out.records.map((r) => r.status)).toEqual(["blocked", "blocked"]);
  });

  it("只动被拦的 quota 记录，pending/active 原样保留且顺序不变", () => {
    const rows = [record("itn-pending"), markBlocked(record("itn-quota"), "quota"), record("itn-active", "continue_thread")];
    const out = reviveBlockedIntentions(rows, { gateAllowed: true });
    expect(out.revived).toEqual(["itn-quota"]);
    expect(out.records.map((r) => r.id)).toEqual(["itn-pending", "itn-quota", "itn-active"]);
    expect(out.records.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("不改入参对象（表是历史，不能被就地改写）", () => {
    const blocked = markBlocked(record("itn-a"), "quota");
    reviveBlockedIntentions([blocked], { gateAllowed: true });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by).toBe("quota");
  });

  it("blocked_by 为空或以未知值出现 → 不动", () => {
    const weird = { ...record("itn-a"), status: "blocked" as const, blocked_by: null };
    const unknown = { ...record("itn-b"), status: "blocked" as const, blocked_by: "mystery" };
    const out = reviveBlockedIntentions([weird, unknown], { gateAllowed: true });
    expect(out.revived).toEqual([]);
  });

  it("retryable 可覆盖（空列表 = 什么都不复活）", () => {
    const blocked = markBlocked(record("itn-a"), "quota");
    const none = reviveBlockedIntentions([blocked], { gateAllowed: true, retryable: [] });
    expect(none.revived).toEqual([]);
    const custom = reviveBlockedIntentions([blocked], { gateAllowed: true, retryable: ["distrust"] });
    expect(custom.revived).toEqual([]);
  });

  it("默认可复活集合就是 quota 一类", () => {
    expect([...RETRYABLE_BLOCKERS]).toEqual(["quota"]);
  });
});
