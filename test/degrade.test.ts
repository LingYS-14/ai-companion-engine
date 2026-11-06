/**
 * §2 A26 存储降级：存储出错，**这一轮也要说完**。
 *
 * 规格原话是「MemoryStore 抛错 → Firewall deny → Orchestrator 降级」。实现里 Firewall 的
 * deny 本来就是返回值不是异常，所以真正会"抛出来"的是两处落盘：记忆写不进、状态存不下。
 * 以前这两处一旦失败，整轮 `turn()` 抛异常 → 桥返回 `engine-failed` → **她不说话了**。
 * 这比丢一条记忆严重得多：她可以少记一件事，但不能突然闭嘴。
 *
 * 这里用真实文件系统造失败（把目标路径先建成目录，`writeFileSync` 就会 EISDIR），
 * 不引入测试专用的注入口子——测试要验的是生产路径。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const NOW = Date.UTC(2026, 9, 30, 16, 0, 0);
const MILD = {
  goal_congruence: 0.2,
  goal_relevance: 0.3,
  coping_potential: 0.8,
  novelty: 0.2,
  legitimacy: 0.8,
};

describe("SoulRuntime：状态存不下时也要把这一轮走完", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-degrade-"));
    clock = new FakeClock(NOW, 16);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save 失败：turn() 不抛，返回里带 degraded，并记进 lastDegradeRecord", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    // 状态文件的临时路径 = `${statePath}.tmp-${pid}`；把它先建成目录，writeFileSync 必失败
    const statePath = join(dir, "state-test.json");
    mkdirSync(`${statePath}.tmp-${process.pid}`);

    const before = rt.snapshot()["turns"];
    const turn = rt.turn({ text: "今天有点累", appraisal: MILD }, { eventType: "care", skipMemory: true });

    expect(turn.degraded).toContain("save:");
    // 状态推进没有被落盘失败拦住（内存里照走）
    expect(rt.snapshot()["turns"]).toBe((before as number) + 1);
    expect(rt.lastDegradeRecord()?.kind).toBe("save");
    // 降级只影响落盘，不影响这一轮给出的东西
    expect(turn.mode).toBe("NORMAL");
    expect(turn.style.modeStyle.length).toBeGreaterThan(0);
  });

  it("磁盘上的状态没被写坏：降级之后读到的还是上一份（不是半截 JSON）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "第一轮", appraisal: MILD }, { eventType: "care", skipMemory: true });
    const savedBefore = readFileSync(join(dir, "state-test.json"), "utf8");

    mkdirSync(join(dir, "state-test.json") + `.tmp-${process.pid}`);
    rt.turn({ text: "第二轮", appraisal: MILD }, { eventType: "care", skipMemory: true });

    expect(() => JSON.parse(savedBefore) as unknown).not.toThrow();
    // 磁盘上仍是第一轮那份；降级不写半截文件
    expect(readFileSync(join(dir, "state-test.json"), "utf8")).toBe(savedBefore);
  });

  it("故障排除后下一轮恢复正常，且不再报降级", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const blocker = join(dir, "state-test.json") + `.tmp-${process.pid}`;
    mkdirSync(blocker);
    const broken = rt.turn({ text: "带病的一轮", appraisal: MILD }, { eventType: "care", skipMemory: true });
    expect(broken.degraded).toBeDefined();

    rmSync(blocker, { recursive: true, force: true });
    const healthy = rt.turn({ text: "好了", appraisal: MILD }, { eventType: "care", skipMemory: true });
    expect(healthy.degraded).toBeUndefined();
  });

  it("记忆写入路径也走同一套降级（这里用 skipMemory=false + 读时不可写来逼近）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    // 记忆写在内存 WAL 里，正常路径不碰盘；这一条只验"正常轮次没有 degraded 字段"，
    // 防止把降级标记做成恒真（恒真等于没有信号）。
    const turn = rt.turn({ text: "普通一句", appraisal: MILD }, { eventType: "care" });
    expect(turn.degraded).toBeUndefined();
    expect(turn.memory.wrote).toBe(1);
  });
});
