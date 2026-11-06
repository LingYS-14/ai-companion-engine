/**
 * §8.2 `RETRIEVAL_AFFECTING_VARS`（M8-04 / F157）：**哪些状态量的污点会影响检索**。
 *
 * 这条以前是 engine.json 里一段没人读的截断残片（`kind:"text"`、value 只剩 `["jealousy",`）。
 * 现在有两个层面要验：
 *   1. 纯函数：只认清单里的量，clean 不算、未知量不算、排序稳定；
 *   2. 真实接线：线上目前唯一会产生污点的入口是 `rt.curiosity()`（把 `curiosity` 标脏），
 *      而 curiosity 不在清单里 → **它不该让检索期打标**。这是"声明式检查"真正起作用的地方：
 *      在此之前，curiosity 一脏，所有回忆都会被永久打上 `retrieved_under_taint`，
 *      等于把"我想弄清什么"的污点扩散成"整本日记不可信"。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { dirtyRetrievalVars, hasRetrievalTaint, retrievalAffectingVars } from "../src/memory/taint.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

const TAINTED = { state: "tainted" as const, since: NOW, sources: ["web"] };
const CLEAN = { state: "clean" as const, since: NOW, sources: [] };

describe("retrievalAffectingVars：配置真的被读到了", () => {
  it("规格四个量，顺序与 engine.json 一致", () => {
    expect(retrievalAffectingVars(cfg)).toEqual(["jealousy", "valence", "arousal", "entropy"]);
  });

  it("清单里没有 curiosity —— 这是这条修复的意义所在", () => {
    expect(retrievalAffectingVars(cfg)).not.toContain("curiosity");
  });
});

describe("dirtyRetrievalVars：只数清单内、且仍在污染中的量", () => {
  it("只有 curiosity 脏 → 不影响检索", () => {
    expect(dirtyRetrievalVars({ curiosity: TAINTED }, cfg)).toEqual([]);
    expect(hasRetrievalTaint({ curiosity: TAINTED }, cfg)).toBe(false);
  });

  it("valence 脏 → 影响检索", () => {
    expect(dirtyRetrievalVars({ valence: TAINTED }, cfg)).toEqual(["valence"]);
    expect(hasRetrievalTaint({ valence: TAINTED }, cfg)).toBe(true);
  });

  it("clean 不算脏", () => {
    expect(dirtyRetrievalVars({ valence: CLEAN, jealousy: TAINTED }, cfg)).toEqual(["jealousy"]);
  });

  it("多个量同时脏时排序稳定（便于日志与断言）", () => {
    expect(dirtyRetrievalVars({ entropy: TAINTED, valence: TAINTED, curiosity: TAINTED }, cfg)).toEqual([
      "entropy",
      "valence",
    ]);
  });

  it("空 taintMap → false", () => {
    expect(hasRetrievalTaint({}, cfg)).toBe(false);
  });
});

describe("SoulRuntime 接线：curiosity 的污点不再扩散到检索", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-retrieval-taint-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("curiosity 被标脏后检索，记忆不被打 retrieved_under_taint", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const id = rt.remember({ content: "用户说他今天加班到很晚", tags: ["聊天"] }).id;

    const res = rt.curiosity({ curiosityGap: 0.33, coping: 0.9 });
    expect(res.tainted).toBe(true);
    expect(rt.state.taintMap["curiosity"]?.state).toBe("tainted");

    const rows = rt.recall("用户");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.underTaint !== true)).toBe(true);
    expect(rt.memoryStore().get(id)?.retrieved_under_taint).toBe(false);
  });

  it("对照：影响检索的量（valence）脏着时，同一批记忆会被打标", async () => {
    // 走状态文件把 valence 标脏——线上目前没有产生 valence 污点的入口，
    // 但状态文件是唯一真源，从它加载等价于重启后她带着这个污点。
    writeStateFile(dir, { valence: TAINTED });
    const rt = await SoulRuntime.open(conf, clock);
    const id = rt.remember({ content: "用户说他今天加班到很晚", tags: ["聊天"] }).id;

    const rows = rt.recall("用户");
    expect(rows.some((r) => r.underTaint === true)).toBe(true);
    expect(rt.memoryStore().get(id)?.retrieved_under_taint).toBe(true);
  });
});

function writeStateFile(dir: string, taintMap: Record<string, unknown>): void {
  writeFileSync(
    join(dir, "state-test.json"),
    JSON.stringify({
      version: 1,
      characterId: "test",
      s: { taintMap },
      bondProgress: 0,
      turns: 0,
      updatedAt: NOW,
    }),
  );
}
