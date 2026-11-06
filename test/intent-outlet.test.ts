/**
 * P1：出口分流（被硬闸挡下的"想说话"流向内部言语，而不是凭空消失）。
 */

import { describe, expect, it } from "vitest";
import { chooseIntentOutlet, journalSeed } from "../src/orchestrator/intent/outlet.js";
import type { Candidate } from "../src/orchestrator/intent/types.js";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    kind: "reach_out",
    goal: "想找用户说句话",
    because: [{ drive: "connection", gap: 0.81 }],
    drive_impact: { connection: 0.3, integrity: -0.1 },
    planSeeds: ["发一条问候"],
    score: 0.48,
    cost: { risk: 1, tokens: 120, socialRisk: 0.2 },
    identityFit: 0.7,
    ...over,
  };
}

const narrative = { line: "我想找人说句话——想找用户说句话。", whyLine: "因为想有人陪（缺口 0.81）" };

describe("P1 出口分流", () => {
  it("没有候选 → idle（不编）", () => {
    const out = chooseIntentOutlet({ top: null, gate: { allowed: true, verdict: "speak", note: "" }, wouldSpeak: false, narrative: null });
    expect(out.target).toBe("idle");
    expect(out.kind).toBeNull();
    expect(out.line).toBeNull();
  });

  it("硬闸放行 = speak，带上自述与理由", () => {
    const out = chooseIntentOutlet({
      top: candidate(),
      gate: { allowed: true, verdict: "speak", note: "可以开口" },
      wouldSpeak: true,
      narrative,
    });
    expect(out.target).toBe("speak");
    expect(out.kind).toBe("reach_out");
    expect(out.line).toBe(narrative.line);
    expect(out.whyLine).toBe(narrative.whyLine);
  });

  it("被硬闸拦下 = journal（想说话但被规则挡住，不丢）", () => {
    const out = chooseIntentOutlet({
      top: candidate(),
      gate: { allowed: false, verdict: "quiet", note: "静默时段，不主动开口" },
      wouldSpeak: false,
      narrative,
    });
    expect(out.target).toBe("journal");
    expect(out.note).toContain("quiet");
    expect(out.note).toContain("静默时段");
  });

  it("有候选但还没越阈 = journal（记一笔，不打扰）", () => {
    const out = chooseIntentOutlet({
      top: candidate({ score: 0.2 }),
      gate: { allowed: true, verdict: "speak", note: "" },
      wouldSpeak: false,
      narrative,
    });
    expect(out.target).toBe("journal");
    expect(out.note).toContain("还没到非说不可");
  });

  it("只有 journal 能生成种子句；speak/idle 返回 null", () => {
    const j = chooseIntentOutlet({
      top: candidate(),
      gate: { allowed: false, verdict: "quota", note: "额度用完" },
      wouldSpeak: false,
      narrative,
    });
    const seed = journalSeed(j);
    expect(seed).not.toBeNull();
    expect(seed).toContain("想找用户说句话");
    expect(seed).toContain("因为想有人陪");
    expect(seed).toContain("额度用完");
    expect(
      journalSeed({ target: "speak", kind: "reach_out", line: "x", whyLine: null, note: "" }),
    ).toBeNull();
    expect(journalSeed({ target: "idle", kind: null, line: null, whyLine: null, note: "" })).toBeNull();
  });

  it("自述缺失时 journal 不给种子（宁可不写，不编一句话）", () => {
    const out = chooseIntentOutlet({
      top: candidate(),
      gate: { allowed: false, verdict: "distrust", note: "信任不够" },
      wouldSpeak: false,
      narrative: null,
    });
    expect(out.target).toBe("journal");
    expect(out.line).toBeNull();
    expect(journalSeed(out)).toBeNull();
  });

  it("纯函数：同一输入重复调用结果一致", () => {
    const args = {
      top: candidate(),
      gate: { allowed: false, verdict: "quiet", note: "静默" },
      wouldSpeak: false,
      narrative,
    } as const;
    expect(chooseIntentOutlet(args)).toEqual(chooseIntentOutlet(args));
  });

  // A4（审计 §2 P0-1）：出口要认意图的**类别**，不能"闸放行 + 有候选"就算想说话。
  it("explore / create 是做事，不走主动开口 → journal（等执行器）", () => {
    for (const kind of ["explore", "create"] as const) {
      const out = chooseIntentOutlet({
        top: candidate({ kind }),
        gate: { allowed: true, verdict: "speak", note: "" },
        wouldSpeak: false, // tick 已经按类别算过；这里给 false 与真实结果一致
        narrative,
      });
      expect(out.target).toBe("journal");
      expect(out.kind).toBe(kind);
      expect(out.note).toContain("不走主动开口");
    }
  });

  it("withdraw / idle 是状态，不开口也不写日记 → idle", () => {
    for (const kind of ["withdraw", "idle"] as const) {
      const out = chooseIntentOutlet({
        top: candidate({ kind }),
        gate: { allowed: true, verdict: "speak", note: "" },
        wouldSpeak: false,
        narrative,
      });
      expect(out.target).toBe("idle");
      expect(out.kind).toBe(kind);
      expect(out.note).toContain("不开口也不写日记");
    }
  });

  it("社会性出口（reach_out / continue_thread / repair）才可能 speak", () => {
    for (const kind of ["reach_out", "continue_thread", "repair"] as const) {
      const out = chooseIntentOutlet({
        top: candidate({ kind }),
        gate: { allowed: true, verdict: "speak", note: "放行" },
        wouldSpeak: true,
        narrative,
      });
      expect(out.target).toBe("speak");
      expect(out.kind).toBe(kind);
    }
  });
});
