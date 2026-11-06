import { describe, expect, it } from "vitest";
import {
  KIND_OPENERS,
  STATUS_PHRASES,
  narrateAttribution,
  narrateBlocked,
  narrateCandidate,
  narrateHelp,
  narrateIntention,
  rankCauses,
} from "../src/orchestrator/intent/narrative.js";
import { addAttempt, markBlocked, newIntention } from "../src/orchestrator/intent/bus.js";
import { INTENT_KINDS, type Candidate } from "../src/orchestrator/intent/types.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    kind: "reach_out",
    goal: "问问她昨天那件事怎么样了",
    because: [
      { drive: "connection", gap: 0.62 },
      { drive: "integrity", gap: 0.2 },
    ],
    drive_impact: { connection: 0.3, integrity: -0.1 },
    planSeeds: ["发一句问候"],
    score: 0.4,
    cost: { risk: 1, tokens: 30, socialRisk: 0.2 },
    identityFit: 0.6,
    ...overrides,
  };
}

function record() {
  return newIntention({
    id: "itn-1",
    at: "2026-10-31T03:10:00.000Z",
    kind: "reach_out",
    goal: "问问她昨天那件事怎么样了",
    why: "因为想有人陪（缺口 0.62）",
  });
}

describe("B3 自述层：纯模板、零模型调用、同输入同输出", () => {
  it("七类意图都有中性开场，六态都有状态词（A5 增 held）", () => {
    expect(Object.keys(KIND_OPENERS).sort()).toEqual([...INTENT_KINDS].sort());
    expect(Object.keys(STATUS_PHRASES).sort()).toEqual(["active", "blocked", "done", "dropped", "held", "pending"]);
  });

  it("候选 → 一句话 + 逐维为什么 + 影响句", () => {
    const narrative = narrateCandidate(candidate());
    expect(narrative.line).toBe("我想找人说句话——问问她昨天那件事怎么样了。");
    expect(narrative.whyLine).toBe("因为想有人陪、有点憋着");
    expect(narrative.statusLine).toBe("它会让我想有人陪、有点憋着。");
  });

  it("确定性：同一输入两次得到完全相同的自述", () => {
    expect(narrateCandidate(candidate())).toEqual(narrateCandidate(candidate()));
  });

  it("影响全为 0 时不硬凑影响句；没有 cause 时诚实说「说不出哪一维」", () => {
    const quiet = narrateCandidate(candidate({ drive_impact: {}, because: [] }));
    expect(quiet.statusLine).toBeUndefined();
    expect(quiet.whyLine).toBe("因为说不出具体哪一维在推我");
  });

  it("rankCauses：按缺口降序、同缺口按维度名，且不改输入", () => {
    const causes = [
      { drive: "integrity" as const, gap: 0.2 },
      { drive: "connection" as const, gap: 0.62 },
      { drive: "novelty" as const, gap: 0.2 },
    ];
    const ranked = rankCauses(causes);
    expect(ranked.map((cause) => cause.drive)).toEqual(["connection", "integrity", "novelty"]);
    expect(causes[0]!.drive).toBe("integrity");
  });

  it("意图自述：pending 说清状态，blocked 写明是谁拦的（不许把被拦说成不想）", () => {
    const pending = narrateIntention(record());
    expect(pending.line).toBe("我想找人说句话——问问她昨天那件事怎么样了。");
    expect(pending.whyLine).toBe("因为想有人陪（缺口 0.62）");
    expect(pending.statusLine).toBe("现在还没开始。");

    const blocked = narrateBlocked(record(), "quiet_hours");
    expect(blocked.statusLine).toBe("现在被「quiet_hours」拦住了。");

    const attempted = markBlocked(
      addAttempt(record(), { at: "2026-10-31T03:11:00.000Z", act: "发消息", outcome: "fail", agency: 0.7 }),
      "rate_limited",
    );
    expect(narrateIntention(attempted).statusLine).toBe("现在被「rate_limited」拦住了，已经试过 1 次。");
  });

  it("求助自述必须带「我试过什么」；没试过就诚实说还没找到办法", () => {
    const tried = narrateHelp({ missing: "读取 QQ 图片消息", tried: ["搜工具列表", "试了一次调用"], need: "一个能看图的通道" });
    expect(tried.line).toBe("我试过搜工具列表、试了一次调用，都不行。有件事想请你帮个忙：读取 QQ 图片消息。");
    expect(tried.whyLine).toBe("我缺的是：一个能看图的通道。");

    const untried = narrateHelp({ missing: "读取 QQ 图片消息", tried: [], need: "一个能看图的通道" });
    expect(untried.line.startsWith("我还没找到办法。")).toBe(true);
  });

  it("归因自述四种目标各有说法：不自封也不全甩锅", () => {
    expect(narrateAttribution({ ok: true, target: "self", surprise: 0 })).toBe("这次成了，主要在我。");
    expect(narrateAttribution({ ok: false, target: "other", surprise: 0.8 })).toBe(
      "这次没成，和对方有关（比我预想的意外）。",
    );
    expect(narrateAttribution({ ok: false, target: "world", surprise: 0 })).toBe("这次没成，是环境不配合。");
    expect(narrateAttribution({ ok: true, target: "unclear", surprise: 0.2 })).toBe(
      "这次成了，我一时说不清是谁的原因。",
    );
  });
});
