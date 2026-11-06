import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advanceLearnState, loadLearnState, saveLearnState } from "../src/autonomy/learn-state.js";

const dirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-learn-"));
  dirs.push(dir);
  return join(dir, "autonomy-learn.json");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("学习轮转状态", () => {
  it("文件缺失时从第 0 个关键词开始", () => {
    expect(loadLearnState(tempFile())).toEqual({ rotation: 0 });
  });

  it("文件损坏时回到初始值，不抛错", () => {
    const file = tempFile();
    writeFileSync(file, "{not json", "utf8");
    expect(loadLearnState(file).rotation).toBe(0);
  });

  it("保存后能读回同样的轮转与最近结果", () => {
    const file = tempFile();
    saveLearnState(file, { rotation: 3, lastLearnAt: 111, lastKeyword: "AI助手", lastIngested: 2, idleRounds: 0 }, 111);
    expect(loadLearnState(file)).toEqual({
      rotation: 3,
      lastLearnAt: 111,
      lastKeyword: "AI助手",
      lastIngested: 2,
      idleRounds: 0,
    });
  });

  it("每学一轮 rotation 加一，入库为 0 时累计空转", () => {
    let state = { rotation: 0 } as const;
    const first = advanceLearnState(state, "崩坏3", 0, 1000);
    expect(first.rotation).toBe(1);
    expect(first.lastIngested).toBe(0);
    expect(first.idleRounds).toBe(1);
    const second = advanceLearnState(first, "崩坏三", 0, 2000);
    expect(second.rotation).toBe(2);
    expect(second.idleRounds).toBe(2);
  });

  it("一旦学到东西，空转计数归零", () => {
    const idle = advanceLearnState({ rotation: 1, idleRounds: 4 }, "崩坏三", 0, 1000);
    expect(idle.idleRounds).toBe(5);
    const learned = advanceLearnState(idle, "AI助手", 2, 2000);
    expect(learned.idleRounds).toBe(0);
    expect(learned.lastIngested).toBe(2);
  });

  it("负数/非有限 rotation 读回时夹到 0", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ rotation: -7 }), "utf8");
    expect(loadLearnState(file).rotation).toBe(0);
    writeFileSync(file, JSON.stringify({ rotation: "x" }), "utf8");
    expect(loadLearnState(file).rotation).toBe(0);
  });

  it("A8：每轮入库数按顺序累积，供产出率判断", () => {
    const first = advanceLearnState({ rotation: 0 }, "崩坏3", 0, 1000);
    expect(first.recentIngested).toEqual([0]);
    const second = advanceLearnState(first, "AI助手", 3, 2000);
    expect(second.recentIngested).toEqual([0, 3]);
  });

  it("A8：最近入库超上限时只留最后 12 轮", () => {
    let state = { rotation: 0 } as const;
    for (let i = 0; i < 15; i += 1) {
      state = advanceLearnState(state, "k", i % 2, 1000 + i);
    }
    expect(state.recentIngested).toHaveLength(12);
    expect(state.recentIngested?.[0]).toBe(1); // 第 3 轮的值（前面 0、1、2 被挤掉）
  });

  it("A8：非有限入库数按 0 记，不写 NaN", () => {
    const state = advanceLearnState({ rotation: 0 }, "k", Number.NaN, 1000);
    expect(state.lastIngested).toBe(0);
    expect(state.recentIngested).toEqual([0]);
    expect(Number.isNaN(state.lastIngested)).toBe(false);
  });

  it("A8：recentIngested 落盘后读回一致，坏值被过滤", () => {
    const file = tempFile();
    saveLearnState(file, { rotation: 2, recentIngested: [1, 0, 2] }, 111);
    expect(loadLearnState(file).recentIngested).toEqual([1, 0, 2]);
    writeFileSync(file, JSON.stringify({ rotation: 0, recentIngested: [1, "x", Number.NaN, 2] }), "utf8");
    expect(loadLearnState(file).recentIngested).toEqual([1, 2]);
  });
});
