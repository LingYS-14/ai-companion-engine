/**
 * v5.4-P1 §4.2 回归：**检索必须抬高 ACT-R 激活**。
 *
 * 曾经的真实 bug：`runtime.recall()` 自己手写 `access_count + 1 / last_accessed`，
 * 绕过了 `MemoryStore.touch()`，于是 `base_activation` 永远停在 0——所有记忆都会在约 4 天后变冷、
 * 从候选池里消失（只剩特赦能救）。这条测试盯的就是"想起来 = 激活上升"。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { loadConfig } from "../src/engine/config.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig();
const HOUR = 3_600_000;

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-recall-"));
  clock = new FakeClock(Date.UTC(2026, 9, 29, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 从 WAL 里读某条 id 最新的 put 记录 */
function latestPut(id: string): Record<string, unknown> {
  const text = readFileSync(join(dir, "memory-test.ndjson"), "utf8");
  let out: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const op = JSON.parse(line) as { op?: string; rec?: Record<string, unknown> };
    if (op.op === "put" && op.rec?.["id"] === id) out = op.rec;
  }
  return out;
}

describe("v5.4-P1 §4.2：retrieve → touch 抬高 base_activation", () => {
  it("想起来一次，激活从 0 抬到 ln(2) 量级，last_accessed 跟着走", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const m = rt.remember({ content: "月亮照在快干的花上，很好看。", source: "player", tags: ["月亮"], vividness: 0.6 });
    clock.advance(2 * HOUR);

    const rows = rt.recall("月亮");
    expect(rows.length).toBeGreaterThan(0);

    const rec = latestPut(m.id);
    expect(rec["access_count"]).toBe(1);
    expect(rec["last_accessed"]).toBe(clock.now());
    expect(rec["base_activation"] as number).toBeGreaterThan(0.5);
  });

  it("隔很久再想起来，激活会先跌后升（不是单调加一）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const m = rt.remember({ content: "海边的风很大。", source: "player", tags: ["海"], vividness: 0.6 });
    clock.advance(48 * HOUR); // 48h × 0.25/天 = −0.5
    rt.recall("海");
    const first = latestPut(m.id)["base_activation"] as number;
    clock.advance(48 * HOUR);
    rt.recall("海");
    const second = latestPut(m.id)["base_activation"] as number;
    // 第一次 ≈ ln(exp(−0.5)+1) ≈ 0.474，第二次 ≈ ln(exp(0.474−0.5)+1) ≈ 0.685
    expect(first).toBeCloseTo(0.474, 2);
    expect(second).toBeCloseTo(0.685, 2);
    expect(second).toBeGreaterThan(first);
  });

  it("140 小时没想起、又不特赦的记忆不参与检索（INV-7 可见性门）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "厨房里的盐罐子。", source: "player", tags: ["厨房"], vividness: 0.1 });
    clock.advance(140 * HOUR);
    expect(rt.recall("完全无关的查询")).toHaveLength(0);
  });

  it("task-169 A：召回行透出 source（主动开口靠它区分自述与真实互动）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({
      content: "我主动开口说：「窗台的花开了」",
      source: "proactive",
      tags: ["花", "窗台"],
      vividness: 0.7,
    });
    const rows = rt.recall("窗台的花");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.source).toBe("proactive");
  });

  it("自述记忆不会在召回时被抬成「没聊完的事」：unresolved_score 保持 0", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const own = rt.remember({
      content: "我主动开口说：「连续睡四个钟头会把人睡成半块石头」",
      source: "proactive",
      tags: ["睡觉"],
      vividness: 0.7,
      selfRelevance: 0.6,
    });
    const theirs = rt.remember({ content: "他说今天要早点睡。", source: "player", tags: ["睡觉"], vividness: 0.7 });

    const rows = rt.recall("睡觉");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    expect(latestPut(own.id)["unresolved_score"]).toBe(0);
    expect(latestPut(theirs.id)["unresolved_score"] as number).toBeGreaterThan(0);
  });
});
