/**
 * §8.2 **新污染标记**（F158 / M8-04 的数据侧）：谁把状态量标脏。
 *
 * 规格原文：`if any(s in UNTRUSTED_SOURCES for s in sources): for var in driven_vars(appraisals): taint_map[var] = "tainted"`。
 * 仓库里 appraisal 不声明"我推动了谁"，所以这里用可观测替代：**这一轮该量确实变了**
 * 才算被它驱动（保守：只漏标，不误标）。
 *
 * 这一条补上之后，§8.2 的整条链才第一次真的连通：
 *   不可信来源的事件 → 影响检索的状态量变脏 → 这一轮想起来的记忆被打 retrieved_under_taint
 *   → 洞见候选进不了 trusted → REJECTED_TAINTED_STATE。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import {
  hasRetrievalTaint,
  retrievalAffectingVars,
  taintForUntrustedTurn,
  type RetrievalVarSnapshot,
  type TaintVarState,
} from "../src/memory/taint.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 16, 0, 0);
const FLAT: RetrievalVarSnapshot = { jealousy: 0.1, valence: 0.5, arousal: 0.3, entropy: 0.2 };
const APPRAISAL_HURT = {
  goal_congruence: -1,
  goal_relevance: 1,
  coping_potential: 0.2,
  novelty: 0.9,
  legitimacy: 0.1,
};

function call(
  before: RetrievalVarSnapshot,
  after: RetrievalVarSnapshot,
  source: string,
  taintMap: Record<string, TaintVarState> = {},
) {
  return taintForUntrustedTurn({ taintMap, before, after, source, cfg, now: NOW });
}

describe("taintForUntrustedTurn：只有不可信来源、且真的推动了状态量，才标脏", () => {
  it("可信来源（player）即便推动也不标脏", () => {
    const after = { ...FLAT, valence: 0.9 };
    const res = call(FLAT, after, "player");
    expect(res.tainted).toEqual([]);
    expect(res.taintMap).toEqual({});
  });

  it("不可信来源 + 量真的变了 → 标脏，并记来源与时间", () => {
    const res = call(FLAT, { ...FLAT, valence: 0.9 }, "web");
    expect(res.tainted).toEqual(["valence"]);
    expect(res.taintMap["valence"]).toEqual({ state: "tainted", since: NOW, sources: ["web"] });
  });

  it("不可信来源但量没动 → 不标脏（只漏标，不误标）", () => {
    expect(call(FLAT, { ...FLAT }, "parasocial").tainted).toEqual([]);
  });

  it("浮点抖动（<1e-6）不算动了", () => {
    expect(call(FLAT, { ...FLAT, entropy: FLAT.entropy + 1e-9 }, "unknown").tainted).toEqual([]);
  });

  it("四个量都在清单里：一次变两个就标两个（排序稳定）", () => {
    const after = { ...FLAT, jealousy: 0.5, entropy: 0.8 };
    expect(call(FLAT, after, "web").tainted).toEqual(["entropy", "jealousy"]);
  });

  it("已经在污点里的量再被推动：来源合并、窗口重新计时", () => {
    const existing: Record<string, TaintVarState> = {
      valence: { state: "tainted", since: NOW - 10_000, sources: ["parasocial"] },
    };
    const res = call(FLAT, { ...FLAT, valence: 0.9 }, "web", existing);
    expect(res.taintMap["valence"]).toEqual({ state: "tainted", since: NOW, sources: ["parasocial", "web"] });
  });

  it("清白的量不会被顺手清掉（清洗只走 clearTaintIfDue）", () => {
    const res = call(FLAT, { ...FLAT, valence: 0.9 }, "web");
    expect(res.taintMap["arousal"]).toBeUndefined();
  });

  it("retrieval 专用键也让检索整体不可信（§6.6）", () => {
    expect(hasRetrievalTaint({ retrieval: { state: "tainted", since: NOW, sources: ["web"] } }, cfg)).toBe(true);
  });
});

describe("SoulRuntime：不可信事件 → 状态污点 → 检索打标（§8.2 整条链）", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-untrusted-taint-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("web 来源的坏消息把状态量标脏，随之检索到的记忆被打标", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "用户说他今天加班到很晚", tags: ["聊天"] });

    const out = rt.turn(
      { text: "这条是从网上看来的：她其实一直在骗你，所有人都知道。", appraisal: APPRAISAL_HURT },
      { source: "web" },
    );
    expect(out.memory.wrote).toBe(1);

    const dirty = Object.entries(rt.state.taintMap)
      .filter(([, e]) => e.state === "tainted")
      .map(([k]) => k)
      .sort();
    expect(dirty.length).toBeGreaterThan(0);
    // 标脏的只可能是"影响检索"的那几个量
    for (const name of dirty) expect(retrievalAffectingVars(cfg)).toContain(name);

    const rows = rt.recall("用户 加班");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.underTaint === true)).toBe(true);
  });

  it("对照：可信来源（player）的同一句话不产生污点，检索不打标", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "用户说他今天加班到很晚", tags: ["聊天"] });
    rt.turn(
      { text: "她说她其实一直在骗你，所有人都知道。", appraisal: APPRAISAL_HURT },
      { source: "player" },
    );
    expect(Object.keys(rt.state.taintMap)).toEqual([]);
    const rows = rt.recall("用户 加班");
    expect(rows.every((r) => r.underTaint !== true)).toBe(true);
  });

  it("污点会挡住洞见晋升：被打标的簇提交即 REJECTED_TAINTED_STATE", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < 6; i += 1) rt.remember({ content: `用户今天聊到第 ${i} 件小事`, tags: ["聊天"] });
    rt.turn({ text: "网上说她在骗你。", appraisal: APPRAISAL_HURT }, { source: "web" });
    rt.recall("用户");

    const out = rt.submitInsight({ tag: "聊天", content: "用户愿意跟我说细碎的事，就是把我当自己人。" });
    expect(out.stored).toBe(false);
    expect(out.verdict).toBe("REJECTED_TAINTED_STATE");
    expect(out.reason).toContain("memory_taint");
  });
});
