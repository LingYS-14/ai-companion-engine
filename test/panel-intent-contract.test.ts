/**
 * 面板意图面的契约锁（F269）：面板是用户唯一直接看到的东西，
 * 所以这里锁三件事——字段确实在、空数据时说实话、整份 payload 能 JSON 序列化（没有函数/Map 混进去）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import { panelPayload } from "../src/assembly/panel-payload.js";
import { readPanelFacts } from "../src/orchestrator/intent/panel-facts.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-intent-"));
  clock = new FakeClock(Date.UTC(2026, 10, 1, 4, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("面板意图面（F269）", () => {
  it("payload 里有 intent 四段，且整份能 JSON 序列化（面板端只读 JSON）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const facts = readPanelFacts({ dataDir: conf.dataDir, characterId: conf.characterId, nowMs: clock.now() });
    const p = panelPayload(rt, conf, facts);
    expect(p.intent).toBeDefined();
    expect(Array.isArray(p.intent.intentions.items)).toBe(true);
    expect(Array.isArray(p.intent.dsh.items)).toBe(true);
    expect(Array.isArray(p.intent.guardian.items)).toBe(true);
    expect(Array.isArray(p.intent.gaps)).toBe(true);
    expect(Array.isArray(p.intent.notes)).toBe(true);
    // 空数据目录：不许把它画成"一切正常"，要有读不到的说明
    expect(p.intent.notes.length).toBeGreaterThan(0);
    const round = JSON.parse(JSON.stringify(p)) as { intent: { notes: string[] } };
    expect(round.intent.notes).toEqual(p.intent?.notes);
  });

  it("装配点没传事实时是 null，而不是伪造一个空待办", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    const p = panelPayload(rt, conf);
    expect(p.intent).toBeNull();
  });
});
