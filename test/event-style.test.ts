import { describe, expect, it } from "vitest";
import { eventStyleFor, eventStyleLine } from "../src/dialogue/event-style.js";

describe("F31 事件级表达层", () => {
  it("冲突类事件给出「可以不立刻接住情绪」的许可", () => {
    const r = eventStyleFor("争吵");
    expect(r?.key).toBe("conflict");
    expect(r?.permission).toContain("允许短句");
    expect(r?.avoid).toContain("客服式安抚");
  });

  it("英文标签也认（模型可能直接给英文 event_type）", () => {
    expect(eventStyleFor("argue")?.key).toBe("conflict");
    expect(eventStyleFor("praise")?.key).toBe("praise");
  });

  it("认不出的事件返回 null，不猜", () => {
    expect(eventStyleFor("conversation")).toBeNull();
    expect(eventStyleFor("日常")).toBeNull();
    expect(eventStyleFor(undefined)).toBeNull();
    expect(eventStyleFor("   ")).toBeNull();
  });

  it("优先级：冲突先于道歉（「吵完道歉」按冲突处理）", () => {
    expect(eventStyleFor("吵完以后道歉")?.key).toBe("conflict");
  });

  it("BREAK 状态下的亲近场景收掉主动示好", () => {
    const normal = eventStyleFor("想你", "NORMAL");
    const broken = eventStyleFor("想你", "BREAK");
    expect(normal?.key).toBe("intimacy");
    expect(broken?.key).toBe("intimacy");
    expect(broken?.permission).not.toBe(normal?.permission);
    expect(broken?.permission).toContain("不建议主动示好");
  });

  it("BREAK 只改亲近类；冲突类在 BREAK 下文案不变", () => {
    expect(eventStyleFor("争吵", "BREAK")?.permission).toBe(eventStyleFor("争吵", "NORMAL")?.permission);
  });

  it("下发文本是单行、可解析、含 key 与 label", () => {
    const line = eventStyleLine(eventStyleFor("夸奖"));
    expect(line.startsWith("[event] key=")).toBe(true);
    expect(line).toContain("label=夸奖");
    expect(line.includes("\n")).toBe(false);
    expect(eventStyleLine(null)).toBe("[event] none");
  });
});
