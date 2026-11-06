import { describe, expect, it } from "vitest";
import {
  DRIVE_KEYS,
  DRIVE_LABELS,
  HELP_NEEDS,
  IDLE_KIND,
  INTENTION_STATUSES,
  INTENT_KINDS,
  MAX_CANDIDATES,
  RISK_LEVELS,
  isDriveKey,
  isIntentKind,
  type Attribution,
  type Candidate,
  type HelpRequest,
  type IntentionRecord,
} from "../src/orchestrator/intent/types.js";

describe("VISION §4.2 数据类型（P0 结构锁）", () => {
  it("IntentKind 恰好 7 类，含 idle 且不重复", () => {
    expect(INTENT_KINDS).toHaveLength(7);
    expect(new Set(INTENT_KINDS).size).toBe(7);
    expect(INTENT_KINDS).toEqual([
      "reach_out",
      "continue_thread",
      "explore",
      "create",
      "repair",
      "withdraw",
      "idle",
    ]);
    expect(IDLE_KIND).toBe("idle");
  });

  it("DriveVector 恰好 6 维，DRIVE_KEYS 与 DRIVE_LABELS 一一对应", () => {
    expect(DRIVE_KEYS).toHaveLength(6);
    expect(DRIVE_KEYS).toEqual(["energy", "integrity", "connection", "competence", "novelty", "coherence"]);
    for (const key of DRIVE_KEYS) {
      expect(DRIVE_LABELS[key], `${key} 必须有中文名`).toBeTruthy();
    }
    expect(Object.keys(DRIVE_LABELS).sort()).toEqual([...DRIVE_KEYS].sort());
  });

  it("候选上限是 8（§4.2），风险四级是 0..3", () => {
    expect(MAX_CANDIDATES).toBe(8);
    expect(RISK_LEVELS).toEqual([0, 1, 2, 3]);
  });

  it("意图状态机 6 态齐全（A5 增 held）；求助 need 5 类齐全", () => {
    expect(INTENTION_STATUSES).toEqual(["pending", "active", "blocked", "held", "done", "dropped"]);
    expect(HELP_NEEDS).toEqual(["knowledge", "permission", "plugin", "review", "unknown"]);
  });

  it("isIntentKind / isDriveKey 都按白名单判定，不把任意字符串当类型", () => {
    expect(isIntentKind("reach_out")).toBe(true);
    expect(isIntentKind("intent")).toBe(false); // 执行层叫 Intent，心理层不认
    expect(isIntentKind(42)).toBe(false);
    expect(isIntentKind(null)).toBe(false);
    expect(isDriveKey("connection")).toBe(true);
    expect(isDriveKey("mood")).toBe(false);
  });

  it("IntentionRecord 的字段形状能承载 B2 的全部语义（id/why/trigger/deadline/attempts/survival/source_ids）", () => {
    const record: IntentionRecord = {
      id: "it-1",
      created_at: "2026-10-31T02:00:00.000Z",
      kind: "reach_out",
      goal: "想问她昨天那件事怎么样了",
      why: "连接缺口高，且上次话题没聊完",
      trigger: { type: "time", spec: ">= 20:00" },
      deadline: "2026-10-31T23:00:00.000Z",
      status: "active",
      attempts: [{ at: "2026-10-31T02:05:00.000Z", act: "qq.send_text", outcome: "ok", agency: 0.7 }],
      superseded_by: null,
      survival: 3,
      source_ids: ["m-12", "m-30"],
    };
    expect(record.attempts[0]?.outcome).toBe("ok");
    expect(record.status).toBe("active");
  });

  it("Candidate 的 because/drive_impact 允许逐维有正有负（硬着头皮社交 = connection +，integrity −）", () => {
    const candidate: Candidate = {
      kind: "reach_out",
      goal: "想找用户说句话",
      because: [
        { drive: "connection", gap: 0.7 },
        { drive: "integrity", gap: 0.4, memoryId: "m-7" },
      ],
      drive_impact: { connection: 0.3, integrity: -0.2 },
      planSeeds: ["发一条 QQ", "翻上次的话题", "什么都不做"],
      score: 0.62,
      cost: { risk: 1, tokens: 120, socialRisk: 0.2 },
      identityFit: 0.8,
    };
    expect(candidate.drive_impact.integrity).toBeLessThan(0);
    expect(candidate.planSeeds).toHaveLength(3);
  });

  it("Attribution 允许 driveDelta 只写变化的维度；attributedTo 四类齐全", () => {
    const attribution: Attribution = {
      intent_id: "it-1",
      predicted: "她会回我",
      observed: "没回",
      predError: 0.8,
      agency: 0.3,
      attributedTo: "unclear",
      driveDelta: { connection: 0.2 },
    };
    expect(Object.keys(attribution.driveDelta)).toEqual(["connection"]);
    expect(["self", "other", "world", "unclear"]).toContain(attribution.attributedTo);
  });

  it("HelpRequest 必须能带齐『我试过什么』（没有 tried 的求助 = 撒娇，§11.6.2）", () => {
    const help: HelpRequest = {
      blockedIntentionId: "it-2",
      what: "想把截图发出去，但手上没有能发图的工具",
      tried: ["qq.send_text 只能发字", "翻过 affordance 表，没有 image 权限"],
      need: "permission",
      ask: "能不能给我一个发图的能力",
    };
    expect(help.tried.length).toBeGreaterThanOrEqual(1);
    expect(help.need).toBe("permission");
  });
});
