import { describe, it, expect } from "vitest";
import { classifyJunk, isJunkMemory, isSelfCheck, planMemoryPurge, SELF_CHECK_MARK } from "../src/maintenance/memory-hygiene.js";

function rec(id: string, content: string, created_at = 0) {
  return { id, content, created_at };
}

describe("记忆卫生：什么算测试/工程垃圾", () => {
  it("自检消息一律清除（带标记前缀）", () => {
    const text = `${SELF_CHECK_MARK}，别慌）在吗？我想确认我们还能正常说话。`;
    expect(classifyJunk(text)?.reason).toBe("self-check");
    expect(isJunkMemory(text)).toBe(true);
    // 桥用它决定「只生成、不发送」：必须认得出自检注入，又不能把正常聊天误判
    expect(isSelfCheck(text)).toBe(true);
    expect(isSelfCheck("在吗？今天有点累")).toBe(false);
    expect(isSelfCheck("（对方发来一张图片）")).toBe(false);
  });

  it("工程对话被认出：前缀/方括号、npm、日志报错、改好了", () => {
    expect(classifyJunk("前缀去掉了吗？我刚看到你那几条都带方括号。")?.reason).toBe("engineering");
    expect(classifyJunk("我这边跑 npm run gate 全绿了")?.reason).toBe("engineering");
    expect(classifyJunk("日志里那条报错修好了")?.reason).toBe("engineering");
    expect(classifyJunk("已经上线了，重载一下")?.reason).toBe("engineering");
  });

  it("图片占位句不算对话，清除", () => {
    expect(classifyJunk("（对方发来一张图片）")?.reason).toBe("placeholder");
  });

  it("正常聊天必须保留（宁可漏，不误删）", () => {
    const keep = [
      "在吗",
      "在吗？今天有点累，想跟你说说话。",
      "我回来了，刚才去楼下走了走。",
      "你看我今天拍的花 像不像你？",
      "今天也想跟你多聊一会儿，有你在真好",
      "你就是AI助手？听说你是第二位。",
    ];
    for (const text of keep) {
      expect(classifyJunk(text), text).toBeNull();
    }
  });

  it("空内容单独归类", () => {
    expect(classifyJunk("   ")?.reason).toBe("empty");
  });
});

describe("记忆卫生：清洗计划", () => {
  it("同一 id 的多行合并，保留最后一次写入", () => {
    const plan = planMemoryPurge([
      rec("a", "第一版", 1),
      rec("a", "第二版", 2),
      rec("b", "在吗", 3),
    ]);
    expect(plan.duplicateLines).toBe(1);
    expect(plan.keep).toHaveLength(2);
    expect(plan.keep.find((r) => r.id === "a")?.content).toBe("第二版");
  });

  it("清除项带原因与命中片段，且按时间排序", () => {
    const plan = planMemoryPurge([
      rec("x", "日志里那条报错修好了", 30),
      rec("y", `${SELF_CHECK_MARK}）在吗`, 10),
      rec("z", "在吗", 20),
    ]);
    expect(plan.drop.map((d) => d.id)).toEqual(["y", "x"]);
    expect(plan.drop[0]?.reason).toBe("self-check");
    expect(plan.drop[0]?.matched.length).toBeGreaterThan(0);
    expect(plan.keep.map((k) => k.id)).toEqual(["z"]);
  });

  it("全干净时 drop 为空（幂等：再跑一次什么都不删）", () => {
    const once = planMemoryPurge([rec("a", "在吗", 1), rec("b", "今天也想跟你多聊一会儿", 2)]);
    expect(once.drop).toHaveLength(0);
    const twice = planMemoryPurge(once.keep);
    expect(twice.drop).toHaveLength(0);
    expect(twice.keep).toHaveLength(2);
  });
});
