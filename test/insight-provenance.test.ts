/**
 * §8.2 `derive_insight` 的三条污点路径（F154）。
 *
 * 规格把"一条洞察能不能当信念用"分成三道判据，按序短路：
 *   1. 血统链带 web / parasocial（外部内容）→ tainted
 *   2. 成员在污染下被检索 / 再巩固过 → tainted
 *   3. 候选依赖的状态量**此刻**还脏着 → tainted
 *
 * 这里既验纯函数（顺序、短路、reason 文案），也验两处真实接线：
 * `clusterEpisodic` 打簇（路径 1/2）与 `SoulRuntime` 在检索期补打标（路径 2 的另一半）
 * + `submitInsight` 用当前 taintMap 合成第三条路径。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { deriveInsightProvenance, derivedStateVarsOf } from "../src/firewall/insight.js";
import { clusterEpisodic } from "../src/memory/consolidate.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

function rec(id: string, extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord {
  return makeMemory({
    id,
    content: `事件-${id}`,
    source: "player",
    created_at: NOW,
    tags: ["聊天"],
    ...extra,
  });
}

describe("deriveInsightProvenance：三条路径与顺序", () => {
  it("干净的血统与状态 → trusted", () => {
    const out = deriveInsightProvenance({ members: [rec("m1"), rec("m2")] });
    expect(out.stateProvenance).toBe("trusted");
    expect(out.reason).toBeNull();
  });

  it("路径 1：血统链带 web: 前缀 → source_chain", () => {
    const out = deriveInsightProvenance({
      members: [rec("m1"), rec("m2", { source_chain: ["player", "web:bilibili:BV1xx"] })],
    });
    expect(out.stateProvenance).toBe("tainted");
    expect(out.reason).toBe("source_chain(web:bilibili:BV1xx)");
  });

  it("路径 1：裸来源名 web / parasocial 也认（仓库实际写法）", () => {
    expect(deriveInsightProvenance({ members: [rec("m1", { source_chain: ["web"] })] }).reason).toBe("source_chain(web)");
    expect(deriveInsightProvenance({ members: [rec("m1", { source: "parasocial" })] }).reason).toBe(
      "source_chain(parasocial)",
    );
  });

  it("路径 1 短路路径 2：同时有外部血统与检索污点时报血统", () => {
    const out = deriveInsightProvenance({
      members: [rec("m1", { source_chain: ["web:x"], retrieved_under_taint: true })],
    });
    expect(out.reason).toBe("source_chain(web:x)");
  });

  it("路径 2：retrieved_under_taint → memory_taint", () => {
    const out = deriveInsightProvenance({ members: [rec("m1"), rec("m2", { retrieved_under_taint: true })] });
    expect(out.reason).toBe("memory_taint(retrieved_under_taint)");
  });

  it("路径 2：reconsolidated_under_taint 也算", () => {
    const flagged: MemoryRecord = { ...rec("m1"), reconsolidated_under_taint: true };
    const out = deriveInsightProvenance({ members: [flagged] });
    expect(out.reason).toBe("memory_taint(reconsolidated_under_taint)");
  });

  it("路径 3：依赖的状态量此刻还脏 → state_taint", () => {
    const out = deriveInsightProvenance({
      members: [rec("m1", { encode_state: { valence: 0.4, curiosity: 0.2 } })],
      taintMap: { curiosity: { state: "tainted" } },
    });
    expect(out.reason).toBe("state_taint(curiosity)");
  });

  it("路径 3：显式 derivedFromStateVars 覆盖 encode_state 推断", () => {
    const out = deriveInsightProvenance({
      members: [rec("m1", { encode_state: { valence: 0.4 } })],
      derivedFromStateVars: ["valence"],
      taintMap: { valence: { state: "tainted" } },
    });
    expect(out.reason).toBe("state_taint(valence)");
  });

  it("taintMap 里 state 不是 tainted（例如 clean）不算", () => {
    const out = deriveInsightProvenance({
      members: [rec("m1", { encode_state: { curiosity: 0.1 } })],
      taintMap: { curiosity: { state: "clean" } },
    });
    expect(out.stateProvenance).toBe("trusted");
  });

  it("derivedStateVarsOf 去重并排序", () => {
    const vars = derivedStateVarsOf([
      rec("m1", { encode_state: { valence: 0.1, arousal: 0.2 } }),
      rec("m2", { encode_state: { valence: 0.3 } }),
    ]);
    expect(vars).toEqual(["arousal", "valence"]);
  });
});

describe("clusterEpisodic：把三条路径里的前两条打进簇", () => {
  it("干净成员 → trusted 且 taintReason 为 null", () => {
    const clusters = clusterEpisodic([rec("m1"), rec("m2"), rec("m3")], { cfg, minSize: 2 });
    const c = clusters.find((x) => x.tag === "聊天");
    expect(c?.stateProvenance).toBe("trusted");
    expect(c?.taintReason).toBeNull();
  });

  it("成员带 retrieved_under_taint → tainted + memory_taint 原因", () => {
    const clusters = clusterEpisodic(
      [rec("m1"), rec("m2", { retrieved_under_taint: true }), rec("m3")],
      { cfg, minSize: 2 },
    );
    const c = clusters.find((x) => x.tag === "聊天");
    expect(c?.stateProvenance).toBe("tainted");
    expect(c?.taintReason).toBe("memory_taint(retrieved_under_taint)");
  });

  it("成员血统链带 web: → tainted + source_chain 原因（以前完全没判）", () => {
    const clusters = clusterEpisodic([rec("m1", { source_chain: ["web:zhihu:1"] }), rec("m2")], { cfg, minSize: 2 });
    const c = clusters.find((x) => x.tag === "聊天");
    expect(c?.stateProvenance).toBe("tainted");
    expect(c?.taintReason).toBe("source_chain(web:zhihu:1)");
  });
});

describe("SoulRuntime：检索期补打标 + 提交期合成第三条路径", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-insight-prov-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 把 `valence` 标脏后再开 runtime。
   *
   * 为什么不用 `rt.curiosity()`：F157（M8-04）之后，检索期打标只认
   * `RETRIEVAL_AFFECTING_VARS`（jealousy/valence/arousal/entropy），
   * 而 curiosity 不在其中——它只影响洞见血统的第三条路径，不该扩散到检索。
   * 状态文件是唯一真源，从它加载等价于"重启后她带着这个污点"。
   */
  function taintValence(): void {
    writeFileSync(
      join(dir, "state-test.json"),
      JSON.stringify({
        version: 1,
        characterId: "test",
        s: { taintMap: { valence: { state: "tainted", since: NOW, sources: ["web"] } } },
        bondProgress: 0,
        turns: 0,
        updatedAt: NOW,
      }),
    );
  }

  it("脏状态下检索到的记忆被永久打标，行的 underTaint 也变 true", async () => {
    taintValence();
    const rt = await SoulRuntime.open(conf, clock);
    expect(rt.state.taintMap["valence"]?.state).toBe("tainted");
    const ids = [
      rt.remember({ content: "用户说他今天加班到很晚", tags: ["聊天"] }).id,
      rt.remember({ content: "用户说他喜欢下雨天", tags: ["聊天"] }).id,
    ];

    const rows = rt.recall("用户");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.underTaint === true)).toBe(true);
    for (const id of ids) {
      expect(rt.memoryStore().get(id)?.retrieved_under_taint).toBe(true);
    }
  });

  it("状态干净时检索不打标", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const id = rt.remember({ content: "用户说他喜欢下雨天", tags: ["聊天"] }).id;
    rt.recall("用户");
    expect(rt.memoryStore().get(id)?.retrieved_under_taint).toBe(false);
  });

  it("submitInsight 对已被打标的簇回 REJECTED_TAINTED_STATE", async () => {
    taintValence();
    const rt = await SoulRuntime.open(conf, clock);
    for (let i = 0; i < 6; i += 1) {
      rt.remember({ content: `用户今天聊到第 ${i} 件小事`, tags: ["聊天"] });
    }
    rt.recall("用户");

    const out = rt.submitInsight({ tag: "聊天", content: "用户愿意跟我说细碎的事，就是把我当自己人。" });
    expect(out.stored).toBe(false);
    expect(out.verdict).toBe("REJECTED_TAINTED_STATE");
    expect(out.reason).toContain("memory_taint");
  });
});
