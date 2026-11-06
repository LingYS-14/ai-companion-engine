/**
 * F199：渠道只用于「线索重排」，不用于「可见性」。
 *
 * 背景：写入侧从 F199 起按来源写真实渠道（player→gui、qq_contact_verified→qq）。
 * 如果召回再按渠道分池，QQ 回合会看不见插件里写的 gui 记忆（反之亦然）——
 * 同一个人格被输入端口切成两半。这两个用例守的就是「不许切」。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const HAPPY = {
  text: "我升职了，晚上想和你一起吃饭。",
  appraisal: { goal_congruence: 0.9, goal_relevance: 0.8, coping_potential: 0.8, novelty: 0.3, legitimacy: 0.9 },
};

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-channel-"));
  clock = new FakeClock(Date.UTC(2026, 9, 31, 2, 0, 0), 12);
  conf = { characterId: "ch", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("F199 渠道不切分记忆可见性", () => {
  it("插件里写的 gui 记忆，在 QQ 渠道的召回复核里仍然看得见（渠道只影响线索重排）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal }, { source: "player" });

    const rows = rt.recall("升职", 10, undefined, "qq");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.content).join("\n")).toContain("升职");
  });

  it("QQ 里写的记忆，无渠道的召回（工具面路径）也看得见", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.turn({ text: "在吗？刚看到你发的消息。", appraisal: HAPPY.appraisal }, { source: "qq_contact_verified" });

    const rows = rt.recall("看到你发的消息");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.content).join("\n")).toContain("消息");
  });
});
