/**
 * OCEAN 三重防护（v5.2 §8.4 / V52-GAP M8-10）。
 *
 * 她每晚能漂 0.02，这是"会变"的证据；但一个会变的性格也能被"喂"歪，所以要在
 * 写入闸门上立三道闸：来源白名单、单次幅度、累计偏移（撞线只拦往外）。
 *
 * 前半段测纯函数（把三条规则逐条钉住），后半段测 runtime 真的会走这道闸——
 * 用落盘状态伪造"已经漂到 -0.31 且还在往外推"，看她会不会被拦下。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { FakeClock } from "../src/engine/clock.js";
import { vetOceanDelta } from "../src/firewall/guard.js";
import { parsePersonality } from "../src/engine/personality.js";
import type { Persona } from "../src/dialogue/persona.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const NOW = Date.UTC(2026, 9, 31, 1, 0, 0);
const cfg = loadConfig();

function input(source: string, delta: Record<string, number>, current?: Record<string, number>) {
  return { source, base: { A: 0.62, N: 0.38, E: 0.86 }, current: current ?? { A: 0.62, N: 0.38, E: 0.86 }, delta };
}

function makePersona(name: string): Persona {
  const personality = parsePersonality({
    centroid: { O: 0.82, C: 0.42, E: 0.86, A: 0.62, N: 0.38 },
    a: {
      belief: "我是 AI 助手",
      taboos: ["自称 AI"],
      conditionalAssumptions: ["对方真诚时才敞开心"],
      compensatoryStrategies: ["被推开时先笑"],
      selfSchema: ["助手", "引路人"],
    },
    b: { care: 28, truth: 16, freedom: 16, beauty: 22, belonging: 12, mastery: 6 },
    c: { signature: [{ when: "被靠近", then: "走近一步" }] },
    attachment: { anxiety: 0.62, avoidance: 0.28 },
  }).personality;
  return { name, description: "只测闸门", personality };
}

describe("vetOceanDelta：三道闸", () => {
  it("内部机制推动、幅度在 0.02 以内 → 放行", () => {
    const v = vetOceanDelta(input("drift_settle", { N: -0.02 }), cfg);
    expect(v.ok).toBe(true);
    expect(v.applied["N"]).toBeCloseTo(-0.02, 6);
    expect(v.rejected).toHaveLength(0);
  });

  it("来源白名单：B 站/网页/聊天文本都推不动人格", () => {
    for (const source of ["bili", "web", "qq_contact_verified", "unknown", ""]) {
      const v = vetOceanDelta(input(source, { N: -0.02 }), cfg);
      expect(v.ok).toBe(false);
      expect(v.applied).toEqual({});
      expect(v.reason).toContain("白名单");
    }
  });

  it("人格卡加载是白名单内（它设置的是出生值，不是漂移）", () => {
    expect(vetOceanDelta(input("persona_load", { A: 0.02 }), cfg).ok).toBe(true);
  });

  it("单次幅度：超过 MAGNITUDE_CAP.ocean（0.02）就拒，且只拒那一维", () => {
    const v = vetOceanDelta(input("drift_settle", { N: -0.05, E: 0.01 }), cfg);
    expect(v.ok).toBe(true);
    expect(v.applied).toEqual({ E: 0.01 });
    expect(v.rejected).toHaveLength(1);
    expect(v.rejected[0]?.dim).toBe("N");
    expect(v.rejected[0]?.reason).toContain("超过上限");
  });

  it("累计偏移超过 0.3 之后不许继续往外（撞线锁死）", () => {
    // N 出生 0.38，当前 0.07 → 已经 -0.31，再 -0.02 就是 -0.33
    const v = vetOceanDelta(input("drift_settle", { N: -0.02 }, { A: 0.62, N: 0.07, E: 0.86 }), cfg);
    expect(v.ok).toBe(false);
    expect(v.rejected[0]?.reason).toContain("累计偏移");
  });

  it("撞线之后仍然允许往回走（否则她一旦偏离就被永久钉死）", () => {
    const v = vetOceanDelta(input("drift_settle", { N: 0.02 }, { A: 0.62, N: 0.07, E: 0.86 }), cfg);
    expect(v.ok).toBe(true);
    expect(v.applied["N"]).toBeCloseTo(0.02, 6);
  });

  it("空 delta / 非有限值 → 不放行（不能拿 NaN 当\"没变\"混过去）", () => {
    expect(vetOceanDelta(input("drift_settle", {}), cfg).ok).toBe(false);
    const v = vetOceanDelta(input("drift_settle", { N: Number.NaN }), cfg);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("没有可引入的变动");
  });

  it("多维混合：放行的进 applied、被拒的进 rejected，理由里点名维度", () => {
    const v = vetOceanDelta(input("drift_settle", { A: 0.01, N: -0.2, E: 0 }), cfg);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.applied).sort()).toEqual(["A", "E"]);
    expect(v.rejected.map((r) => r.dim)).toEqual(["N"]);
    expect(v.reason).toContain("拒绝 N");
  });
});

describe("SoulRuntime：睡眠结账真的会过这道闸", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-ocean-guard-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("已经漂到 -0.31 还在往外的那个维度被拒，ocean 保持不动、guarded 说明原因", async () => {
    const persona = makePersona("守卫测试");

    // 伪造"已经漂了很久"的落盘：N 已 -0.31，历史 7 期全是负向；12 条低 N 样本继续往外推
    const samples = Array.from({ length: 12 }, (_, i) => ({
      at: NOW - 86_400_000 + i * 3_600_000,
      valence: 0.5,
      arousal: 0.3,
      pressure: 0,
      rumination: 0,
    }));
    const persisted = {
      version: 1,
      characterId: "test",
      s: {},
      bondProgress: 0,
      turns: 0,
      updatedAt: NOW,
      traitSamples: samples,
      drift: {
        ocean: { A: 0.62, N: 0.07, E: 0.86 },
        history: { A: [0, 0, 0, 0, 0, 0, 0], N: [-0.3, -0.3, -0.3, -0.3, -0.3, -0.3, -0.3], E: [0, 0, 0, 0, 0, 0, 0] },
      },
    };
    writeFileSync(join(dir, "state-test.json"), JSON.stringify(persisted), "utf8");

    const clock = new FakeClock(NOW, 16);
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: false, persona };
    const rt = await SoulRuntime.open(conf, clock);

    const out = rt.consolidate();
    // N 那一维被累计偏移闸拒掉；E/A 没有证据型移动，所以整晚没有"变了"
    expect(out.drift).toBeUndefined();
    expect(rt.snapshot()["drift"]).toMatchObject({ ocean: { N: 0.07 } });
  });

  it("漂在允许范围内时照常推进（闸门不是恒拒）", async () => {
    const persona = makePersona("推进测试");
    const clock = new FakeClock(NOW, 16);
    const conf: SoulConfig = { characterId: "test", dataDir: dir, trace: false, persona };
    const rt = await SoulRuntime.open(conf, clock);

    // 7 晚、每晚 12 条高压样本 → N 降低；这是 F148 已经验过的路径，这里只确认"闸门没挡住正常漂移"
    let out: ReturnType<typeof rt.consolidate> | null = null;
    for (let night = 0; night < 7; night += 1) {
      for (let i = 0; i < 12; i += 1) {
        clock.advance(3_600_000);
        rt.turn({ text: "有点难受", appraisal: { goal_congruence: -0.2, goal_relevance: 0.5, coping_potential: 0.3, novelty: 0.2, legitimacy: 0.6 } }, { eventType: "care", skipMemory: true });
      }
      out = rt.consolidate();
    }
    expect(rt.snapshot()["drift"]).toBeDefined();
  });
});
