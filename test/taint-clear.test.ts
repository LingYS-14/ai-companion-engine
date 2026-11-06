/**
 * §8.2 污点清洗（`memory/taint.ts` 的 shouldClearTaint + runtime.clearTaintIfDue）。
 *
 * 判定四条（2a 仍被不可信来源驱动 → 2b 有未消费的可信候选 → 2c 观察窗未满 → 2d 可清）
 * 早就实现并带着 A11 死锁教训的注释，但**没有一个调用者**（V52-GAP M8-02）：
 * 她的 S 层里 `taintMap` 只会被写脏、永远不会变干净。
 *
 * 这里验"接上以后"：脏了不会立刻清、窗口过了真的清、清完不再出现在状态里；
 * 而"清洗期间又被不可信来源驱动"要能挡住第一轮清洗（2a 优先于 2c）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { makeMemory } from "../src/memory/types.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);
const HOUR = 3_600_000;

describe("SoulRuntime.clearTaintIfDue：污点会不会自己变干净", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-taint-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 让好奇心目标里出现一个不可信来源（web），从而把 curiosity 标脏 */
  function taint(rt: SoulRuntime): void {
    const res = rt.curiosity({ curiosityGap: 0.33, coping: 0.9 });
    expect(res.tainted).toBe(true);
    expect(rt.state.taintMap["curiosity"]?.state).toBe("tainted");
  }

  it("干净的状态下什么都不做", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    expect(Object.keys(rt.state.taintMap)).toHaveLength(0);
    expect(rt.clearTaintIfDue()).toBe(0);
  });

  it("刚脏的一小时内不会被清（观察窗未满，2c）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    taint(rt);
    clock.advance(HOUR);
    expect(rt.clearTaintIfDue()).toBe(0);
    expect(rt.state.taintMap["curiosity"]).toBeDefined();
  });

  it("过了 24 小时清洗窗口就真的清掉（2d），状态里不再有它", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    taint(rt);
    clock.advance(25 * HOUR);
    expect(rt.clearTaintIfDue()).toBe(1);
    expect(rt.state.taintMap["curiosity"]).toBeUndefined();
  });

  it("窗口内又写进来一条带污点的记忆 → 仍算被驱动着，不清（2a 优先）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    taint(rt);
    // created_at 晚于标脏时刻，retrieved_under_taint=true：这正是"又被不可信来源驱动"的现场
    rt.memoryStore().write(
      { ...makeMemory({ id: "t1", content: "网页上看来的", source: "web", created_at: clock.now(), tags: [] }), retrieved_under_taint: true },
      clock.now(),
    );
    clock.advance(25 * HOUR);
    expect(rt.clearTaintIfDue()).toBe(0);
    expect(rt.state.taintMap["curiosity"]).toBeDefined();
  });

  it("advance 那一拍会顺手清：先不算（用推进前时刻），下一拍才清", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    taint(rt);
    // 一次跳 25 小时：清污判定用的是**推进前**的时刻（保守），所以这一拍不清
    const jumped = rt.advance(25);
    expect(jumped.taintCleared).toBe(0);
    expect(rt.state.taintMap["curiosity"]).toBeDefined();
    // 时钟已经过去 25 小时，下一拍窗口就真的满了
    const next = rt.advance(0.08);
    expect(next.taintCleared).toBe(1);
    expect(rt.state.taintMap["curiosity"]).toBeUndefined();
  });
});
