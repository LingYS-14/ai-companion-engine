import { describe, expect, it } from "vitest";
import { composeDialogue, SITUATION_HOLD_TOKEN } from "../src/dialogue/composer.js";
import type { PromptLayers } from "../src/dialogue/prompt.js";

const layers: PromptLayers = {
  persona: null,
  mode: "NORMAL",
  modeStyle: "平稳",
  stageStyle: "还在互相了解",
  expressionStyle: "温和",
  suppressInstruction: "照常表达",
  eventPermission: null,
  eventAvoid: null,
};

describe("composeDialogue：回信", () => {
  it("没有召回时，系统提示就是人格+状态层，不带记忆段", () => {
    const c = composeDialogue({ layers, peerName: "用户", text: "在吗" });
    expect(c.intent).toBe("reply");
    expect(c.recall).toEqual({ memories: 0, knowledge: 0, mandatory: false });
    expect(c.system).toContain("【硬规则】");
    expect(c.system).not.toContain("【你记得的事】");
    expect(c.user).toContain("用户：在吗");
  });

  it("有召回时，记忆段接在系统提示后面，不是替换", () => {
    const c = composeDialogue({
      layers,
      peerName: "用户",
      text: "昨晚学到什么",
      recall: { memories: ["我记得夜里很安静"], knowledge: ["《洞穴》：皮克斯短片（无简介）"], mandatory: false },
    });
    expect(c.recall).toEqual({ memories: 1, knowledge: 1, mandatory: false });
    expect(c.system.indexOf("【硬规则】")).toBeLessThan(c.system.indexOf("【你记得的事】"));
    expect(c.system).toContain("夜里很安静");
    expect(c.system).toContain("洞穴");
  });

  it("mandatory（被问到库存）升级为 learn-report 意图", () => {
    const c = composeDialogue({
      layers,
      peerName: "用户",
      text: "昨晚学到什么",
      recall: { memories: [], knowledge: ["《洞穴》：皮克斯短片"], mandatory: true },
    });
    expect(c.intent).toBe("learn-report");
  });

  it("未读说明拼在这句话后面", () => {
    const c = composeDialogue({ layers, peerName: "用户", text: "看看", unread: "[图片 a.png]" });
    expect(c.user).toContain("看看");
    expect(c.user).toContain("[图片 a.png]");
  });
});

describe("composeDialogue：主动开口", () => {
  it("走 proactive 那套提示词，不出现回信口吻", () => {
    const c = composeDialogue({
      intent: "proactive",
      persona: null,
      mode: "NORMAL",
      topic: "missing",
      peerName: "用户",
      localHour: 14,
      history: ["用户：我出门了"],
    });
    expect(c.intent).toBe("proactive");
    expect(c.system).toContain("【怎么说】");
    expect(c.user).toContain("主动");
    // P1 时间观：时钟事实交给「此刻的处境」，称呼交给人格卡 speech；user prompt 不再写死。
    expect(c.user).not.toContain("14 点");
    expect(c.user).not.toContain("现在是");
    expect(c.user).not.toContain("称呼对方为");
    expect(c.user).not.toContain("对方刚发来");
  });

  it("主动开口也可以带知识；空召回不加段", () => {
    const withRecall = composeDialogue({
      intent: "proactive",
      persona: null,
      mode: "NORMAL",
      topic: "beauty",
      peerName: "用户",
      localHour: 9,
      recall: { memories: [], knowledge: ["《洞穴》：皮克斯短片"], mandatory: false },
    });
    expect(withRecall.system).toContain("【你最近看到的东西】");
    expect(withRecall.recall.knowledge).toBe(1);

    const empty = composeDialogue({
      intent: "proactive",
      persona: null,
      mode: "NORMAL",
      topic: "beauty",
      peerName: "用户",
      localHour: 9,
      recall: { memories: [], knowledge: [], mandatory: false },
    });
    expect(empty.system).not.toContain("【你最近看到的东西】");
    expect(empty.recall).toEqual({ memories: 0, knowledge: 0, mandatory: false });
  });
});

describe("composeDialogue：P1 意图自述（可选参数，向后兼容）", () => {
  const base = {
    intent: "proactive" as const,
    persona: null,
    mode: "NORMAL",
    topic: "missing" as const,
    peerName: "用户",
    localHour: 14,
  };

  it("不传 intentNote 时，系统提示与旧版一字不差", () => {
    const without = composeDialogue(base);
    expect(without.system).not.toContain("【此刻的由头】");
    // 注意：A10 之后 QQ 规则本身就会说"不要提由头/意图/缺口"，
    // 所以这里只能断言"没有由头段"，不能断言"全文不出现由头"。
    expect(without.system).not.toContain("【此刻的处境】");
  });

  it("传了自述：拼在人格提示之后，并明确要求不要复述", () => {
    const c = composeDialogue({
      ...base,
      intentNote: { line: "我想找人说句话", whyLine: "因为想有人陪（缺口 0.62）" },
    });
    expect(c.system).toContain("【此刻的由头】我想找人说句话");
    expect(c.system).toContain("因为想有人陪");
    expect(c.system).toContain("不要复述");
    // 人格层在前、由头在后：语气仍由 persona 决定
    expect(c.system.indexOf("【怎么说】")).toBeLessThan(c.system.indexOf("【此刻的由头】"));
    // 自述不进 user prompt，避免模型把它当"对方说的话"来回应
    expect(c.user).not.toContain("【此刻的由头】");
  });

  it("带状态句时把「卡在哪」也写进去", () => {
    const c = composeDialogue({
      ...base,
      intentNote: {
        line: "我想把上次没说完的事接上",
        whyLine: "因为心里别扭（缺口 0.4）",
        statusLine: "现在被「quiet」拦住了，已经试过 2 次",
      },
    });
    expect(c.system).toContain("已经试过 2 次");
    expect(c.system).toContain("不要解释这段说明");
  });
});

describe("composeDialogue：A5 情境自觉与 HOLD 出口协议", () => {
  const base = {
    intent: "proactive" as const,
    persona: null,
    mode: "NORMAL",
    topic: "missing" as const,
    peerName: "用户",
    localHour: 14,
  };

  it("不传 situation 时，系统提示不含处境段（旧行为一字不差）", () => {
    const c = composeDialogue(base);
    expect(c.system).not.toContain("## 此刻的处境");
    expect(c.system).not.toContain("HOLD");
  });

  it("传了处境：每条事实一行，并给出 HOLD 出口协议", () => {
    const c = composeDialogue({
      ...base,
      situation: { lines: ["现在是凌晨 2 点，他多半已经睡了", "他上一次说话是 5 小时前"] },
    });
    expect(c.system).toContain("## 此刻的处境");
    expect(c.system).toContain("- 现在是凌晨 2 点");
    expect(c.system).toContain("- 他上一次说话是 5 小时前");
    // 出口协议：先说 HOLD 这一条，再要求写话；且明确"由你判断"而不是命令
    expect(c.system).toContain(SITUATION_HOLD_TOKEN);
    expect(c.system).toContain("如果此刻不宜打扰");
    expect(c.system).toContain("值得此刻打扰");
    expect(c.system).not.toContain("必须");
    // 处境不进 user prompt（否则会被当成对方说的话）
    expect(c.user).not.toContain("## 此刻的处境");
  });

  it("由头与处境的顺序：人格 → 由头 → 处境（越靠后越贴近输出）", () => {
    const c = composeDialogue({
      ...base,
      intentNote: { line: "我想找人说句话", whyLine: "因为想有人陪（缺口 0.62）" },
      situation: { lines: ["他 5 小时没出现了"] },
    });
    expect(c.system.indexOf("【此刻的由头】")).toBeLessThan(c.system.indexOf("## 此刻的处境"));
  });

  it("空处境数组不拼空段（没有事实就不占提示词）", () => {
    const c = composeDialogue({ ...base, situation: { lines: [] } });
    expect(c.system).not.toContain("## 此刻的处境");
  });
});
