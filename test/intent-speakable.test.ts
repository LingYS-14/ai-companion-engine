/**
 * F240：从意图表里挑出"还没说出口、值得再说一次"的那条。
 *
 * 为什么钉：A4 之后，主动开口只认 `outlet=speak`；而额度常在"憋不住"的那一拍刚好用完。
 * 被拦住的话复活成 pending 却没有任何一拍会再提它，等于永久烂在表里。
 * 这条挑选是"额度回来时说上次没说完的话"的唯一依据，所以边界要锁住：
 * 只看能开口的类别、只挑 pending/active、试满次数的不再挑、取最新一条。
 */
import { describe, expect, it } from "vitest";

import { markBlocked, newIntention } from "../src/orchestrator/intent/bus.js";
import { pickSpeakableIntention } from "../src/orchestrator/intent/intent-lifecycle.js";

function record(
  id: string,
  kind: "reach_out" | "continue_thread" | "repair" | "explore" | "create" | "withdraw" | "idle" = "reach_out",
  at = "2026-10-31T09:00:00Z",
) {
  return newIntention({ id, at, kind, goal: `说一句 ${id}`, why: "想说话（缺口 0.62）", sourceIds: [] });
}

describe("F240：挑一条值得重新开口的意图", () => {
  it("多类中挑最新的一条（最近的心里话优先）", () => {
    const rows = [
      record("itn-old", "reach_out", "2026-10-31T07:00:00Z"),
      record("itn-new", "continue_thread", "2026-10-31T09:00:00Z"),
      record("itn-mid", "repair", "2026-10-31T08:00:00Z"),
    ];
    expect(pickSpeakableIntention(rows)?.id).toBe("itn-new");
  });

  it("不看 journal/状态类（explore/create/withdraw/idle）", () => {
    const rows = [record("itn-e", "explore"), record("itn-c", "create"), record("itn-w", "withdraw"), record("itn-i", "idle")];
    expect(pickSpeakableIntention(rows)).toBeNull();
  });

  it("不看 blocked（等复活）、done、dropped", () => {
    const blocked = markBlocked(record("itn-b"), "distrust");
    const rows = [
      blocked,
      { ...record("itn-done"), status: "done" as const },
      { ...record("itn-drop"), status: "dropped" as const },
    ];
    expect(pickSpeakableIntention(rows)).toBeNull();
  });

  it("试满次数的（attempts≥5）不再挑", () => {
    const tried = {
      ...record("itn-t"),
      attempts: Array.from({ length: 5 }, (_, i) => ({
        at: "2026-10-31T09:00:00Z",
        act: `a${String(i)}`,
        outcome: "fail" as const,
        agency: 0.5,
      })),
    };
    expect(pickSpeakableIntention([tried])).toBeNull();
    expect(pickSpeakableIntention([{ ...tried, attempts: tried.attempts.slice(0, 4) }])?.id).toBe("itn-t");
  });

  it("active 也挑（正在做的也可以被「接着说」）", () => {
    const rows = [{ ...record("itn-a"), status: "active" as const }];
    expect(pickSpeakableIntention(rows)?.id).toBe("itn-a");
  });

  it("空表 → null；同时间按 id 稳定排序；不改入参", () => {
    expect(pickSpeakableIntention([])).toBeNull();
    const rows = [record("itn-z"), record("itn-a")];
    expect(pickSpeakableIntention(rows)?.id).toBe("itn-a");
    expect(rows[0]?.status).toBe("pending");
  });

  it("kinds 可覆盖（默认只认三类会开口的）", () => {
    const rows = [record("itn-x", "explore")];
    expect(pickSpeakableIntention(rows)).toBeNull();
    expect(pickSpeakableIntention(rows, ["explore"])?.id).toBe("itn-x");
  });
});
