import { describe, expect, it } from "vitest";

import { isPureInnerProcess, stripThinkAloud } from "../src/dialogue/meta-voice.js";

describe("stripThinkAloud", () => {
  it("去掉「我刚在心里念了一句：」这类旁白框架，保留真正说的话", () => {
    expect(stripThinkAloud("我刚在心里念了一句：窗台那枝花，今天精神多了～")).toBe("窗台那枝花，今天精神多了～");
    expect(stripThinkAloud("嗯……我在心里想了想，还是别说了。")).toBe("还是别说了。");
    expect(stripThinkAloud("刚才脑子里冒出个念头：要不要去晒晒太阳。")).toBe("要不要去晒晒太阳。");
    expect(stripThinkAloud("我默默嘀咕了一句，风好像小了点。")).toBe("风好像小了点。");
  });

  it("叠了两层框架也清得干净", () => {
    expect(stripThinkAloud("我刚刚在心里想着，嗯，我在心里念了一句：今天也还好。")).toBe("今天也还好。");
  });

  it("正常中文里的「心里」不动——那是人话，不是旁白", () => {
    const natural = "这几天想起那件事，心里还是有点在意。";
    expect(stripThinkAloud(natural)).toBe(natural);
    const natural2 = "风一吹，心里就松快了些。";
    expect(stripThinkAloud(natural2)).toBe(natural2);
  });

  it("纯旁白清完是空串，调用方据此拒发", () => {
    expect(stripThinkAloud("")).toBe("");
    expect(stripThinkAloud("我在心里念了一句：")).toBe("");
  });
});

describe("isPureInnerProcess", () => {
  it("只剩过程描述、没有实际内容时判 true", () => {
    expect(isPureInnerProcess("")).toBe(true);
    expect(isPureInnerProcess("我在心里念了一句：")).toBe(true);
  });

  it("有实际内容时判 false", () => {
    expect(isPureInnerProcess("窗台那枝花今天精神多了。")).toBe(false);
  });
});
