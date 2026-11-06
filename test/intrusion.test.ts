/**
 * §6.8 自动执念闯入（`memory/obsession.ts` 的 pickIntrusion + runtime.autoIntrude）。
 *
 * 这里验三件事：挑得对（只挑够阈值的、平手挑更高概率、忘掉的不闯）、
 * 冷却真的挡得住（不然一条记忆能把 pressure 反复推高）、真闯进来时状态确实变了。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { DEFAULT_CONFIG_URL, loadConfig } from "../src/engine/config.js";
import { pickIntrusion } from "../src/memory/obsession.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);

/** 一条"够格闯入"的记忆：线索能对上、编码时情绪很重、还有没解开的结。 */
function obsessionSeed(id: string, tags: string[]): MemoryRecord {
  return {
    ...makeMemory({ id, content: `${id} 的那件事`, source: "player", created_at: NOW - 86_400_000, tags }),
    unresolved_score: 0.9,
    encode_state: { valence: 0.95, arousal: 0.8 },
  };
}

describe("pickIntrusion：从一屋子记忆里挑最该闯进来的", () => {
  it("线索对不上就不闯（哪怕它 unresolved 很高）", () => {
    const pick = pickIntrusion(
      [obsessionSeed("a", ["书"])],
      { tags: ["花"], now: NOW },
      { valence: 1, rumination: 0.5 },
      cfg,
    );
    expect(pick).toBeNull();
  });

  it("线索对上且够阈值 → 选中，概率要大于阈值", () => {
    const pick = pickIntrusion(
      [obsessionSeed("a", ["花"])],
      { tags: ["花"], now: NOW },
      { valence: 1, rumination: 0.5 },
      cfg,
    );
    expect(pick?.memory.id).toBe("a");
    expect(pick?.check.prob ?? 0).toBeGreaterThan(pick?.check.threshold ?? 1);
  });

  it("多条都能闯时选概率最高的那条", () => {
    const weak = { ...obsessionSeed("weak", ["花"]), unresolved_score: 0.2 } as MemoryRecord;
    const strong = obsessionSeed("strong", ["花"]);
    const pick = pickIntrusion([weak, strong], { tags: ["花"], now: NOW }, { valence: 1, rumination: 0.9 }, cfg);
    expect(pick?.memory.id).toBe("strong");
  });

  it("已经忘掉的记忆不闯（归档了就不该再被绊住）", () => {
    const gone = { ...obsessionSeed("gone", ["花"]), forgotten: true } as MemoryRecord;
    expect(pickIntrusion([gone], { tags: ["花"], now: NOW }, { valence: 1, rumination: 1 }, cfg)).toBeNull();
  });
});

describe("SoulRuntime.autoIntrude：真对话路径上的自动闯入", () => {
  let dir: string;
  let clock: FakeClock;
  let conf: SoulConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soul-intrude-"));
    clock = new FakeClock(NOW, 0);
    conf = { characterId: "test", dataDir: dir, trace: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("命中：状态里的 pressure 真的抬了，返回值给出是谁", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.memoryStore().write(obsessionSeed("m1", ["花"]), clock.now());
    const pressureBefore = rt.state.pressure;

    const hit = rt.autoIntrude("花", clock.now());
    expect(hit?.memoryId).toBe("m1");
    expect(rt.state.pressure).toBeGreaterThan(pressureBefore);
  });

  it("冷却：同一条消息再来一次不会第二次推高 pressure", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.memoryStore().write(obsessionSeed("m1", ["花"]), clock.now());
    expect(rt.autoIntrude("花", clock.now())).not.toBeNull();
    const pressureAfterFirst = rt.state.pressure;
    expect(rt.autoIntrude("花", clock.now() + 60_000)).toBeNull();
    expect(rt.state.pressure).toBe(pressureAfterFirst);
  });

  it("冷却过去后又能闯（不是一次性开关）", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.memoryStore().write(obsessionSeed("m1", ["花"]), clock.now());
    expect(rt.autoIntrude("花", clock.now())).not.toBeNull();
    expect(rt.autoIntrude("花", clock.now() + 31 * 60_000)).not.toBeNull();
  });

  it("空消息不扫库", async () => {
    const rt = await SoulRuntime.open(conf, clock);
    rt.memoryStore().write(obsessionSeed("m1", ["花"]), clock.now());
    expect(rt.autoIntrude("   ", clock.now())).toBeNull();
  });
});
