/**
 * §1.2 INV-2 trace 管线：攒批、落盘、反查，以及"写坏了不许把她弄崩"。
 *
 * V52-GAP M1-03 记的是整套管线不存在（`trace` 布尔只控制一条 bond 日志），
 * M12-01 记的是 §12.1 硬指标 2（1 分钟反查"这句台词为何如此"）无法成立。
 * 这里验的是最小可用的那一层：说得出"当时什么模式/什么状态/召回了什么/走了哪条策略"。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { readTrace, TraceLog, type TraceRecord } from "../src/trace/trace.js";

const NOW = Date.UTC(2026, 9, 30, 16, 0, 0);

const WARM = {
  goal_congruence: 0.6,
  goal_relevance: 0.8,
  coping_potential: 0.8,
  novelty: 0.2,
  legitimacy: 0.8,
};

describe("TraceLog：攒批与落盘", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-trace-"));
    path = join(dir, "trace-test.ndjson");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const rec = (n: number): TraceRecord => ({ at: NOW + n, traceId: `tr-${String(n)}`, kind: "turn", n });

  it("攒够容量才落盘（未到容量时文件不存在）", () => {
    const log = new TraceLog({ path, capacity: 3, flushIntervalMs: 60_000 });
    log.record(rec(1));
    log.record(rec(2));
    expect(existsSync(path)).toBe(false);
    log.record(rec(3));
    expect(readTrace(path)).toHaveLength(3);
    expect(log.stats()).toMatchObject({ pending: 0, flushed: 3, errors: 0 });
  });

  it("flush() 把不足容量的尾巴也写掉，且可以反复 flush", () => {
    const log = new TraceLog({ path, capacity: 10, flushIntervalMs: 60_000 });
    log.record(rec(1));
    expect(log.flush()).toBe(1);
    expect(log.flush()).toBe(0);
    log.record(rec(2));
    log.flush();
    expect(readTrace(path).map((r) => r["n"])).toEqual([1, 2]);
  });

  it("按 id / kind / last 反查", () => {
    const log = new TraceLog({ path, capacity: 10, flushIntervalMs: 60_000 });
    for (let i = 0; i < 5; i += 1) log.record(rec(i));
    log.record({ at: NOW, traceId: "tr-other", kind: "advance" });
    log.flush();
    expect(readTrace(path, { id: "tr-3" })).toHaveLength(1);
    expect(readTrace(path, { kind: "advance" })).toHaveLength(1);
    expect(readTrace(path, { last: 2 })).toHaveLength(2);
  });

  it("坏行只跳过，不让反查也失败", () => {
    const log = new TraceLog({ path, capacity: 10, flushIntervalMs: 60_000 });
    log.record(rec(1));
    log.flush();
    writeFileSync(path, `${readFileSync(path, "utf8")}{半行\n`, "utf8");
    expect(readTrace(path)).toHaveLength(1);
  });

  it("目录不可写时只计错误、不抛（trace 坏了不该让她崩）", () => {
    const errors: unknown[] = [];
    const log = new TraceLog({
      path: join(dir, "不存在的子目录", "x.ndjson"),
      capacity: 1,
      flushIntervalMs: 60_000,
      onError: (e) => errors.push(e),
    });
    expect(() => log.record(rec(1))).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(log.stats().errors).toBe(1);
  });
});

describe("SoulRuntime：一次回合留下一条可反查的 trace", () => {
  let dir: string;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-trace-rt-"));
    clock = new FakeClock(NOW, 0);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("trace:true 时回合带 traceId，flush 后能在文件里查到整条链路", async () => {
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: true };
    const rt = await SoulRuntime.open(conf, clock);
    const r = rt.turn({ text: "今天有点累", appraisal: WARM }, { eventType: "care", skipMemory: true });
    expect(r.traceId).toBeDefined();
    rt.flush();

    const rows = readTrace(join(dir, "trace-test.ndjson"), { id: r.traceId });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("turn");
    expect(row.eventType).toBe("care");
    expect(typeof row.mode).toBe("string");
    expect(typeof row.strategy).toBe("string");
    // 「为什么这么回」要看得到当时的数：状态、强度、预期
    expect(typeof row.valence).toBe("number");
    expect(typeof row.pressure).toBe("number");
    expect(row.intensity).toBeCloseTo(0.8, 6);
  });

  it("trace:false 时不写文件、也不给 traceId（测试与只读面不付这份 I/O）", async () => {
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: false };
    const rt = await SoulRuntime.open(conf, clock);
    const r = rt.turn({ text: "嗯", appraisal: WARM }, { eventType: "care", skipMemory: true });
    expect(r.traceId).toBeUndefined();
    expect(existsSync(join(dir, "trace-test.ndjson"))).toBe(false);
  });

  it("traceLast 能直接读到最近几条（面板/工具面的读口）", async () => {
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: true };
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "一", appraisal: WARM }, { eventType: "care", skipMemory: true });
    rt.flush();
    rt.turn({ text: "二", appraisal: WARM }, { eventType: "care", skipMemory: true });
    rt.flush();
    const tail = rt.traceLast(2);
    expect(tail).toHaveLength(2);
    expect(String(tail[1]!["traceId"])).toMatch(/^tr-/);
  });
});
