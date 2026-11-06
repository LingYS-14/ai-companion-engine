/**
 * P3-2b（task-50 起，task-57 责任反转）：睡眠状态机接线——A/B 通道、睡眠分支分流、落盘恢复。
 *
 * task-57 起职责边界变了：
 *   · runtime.advance = 能量 tick + **醒着分支**（awake/drowsy/waking）的跨睡点巩固；
 *     它不做相位转移、不自己判 asleep；
 *   · runtime.sleepAdvance = **睡着分支**的时间推进：只恢复 + 睡着分支的跨睡点巩固；
 *   · 相位判定/落盘在 sleepState()，装配层（main.mjs）每拍先判相位再分流。
 *
 * 这里只测「接线」这一层：state.ts 的 B 公式与 sleep.ts 的转移表各有单元测试
 * （test/energy.test.ts / test/sleep.test.ts），不在这里重复。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { FakeClock } from "../src/engine/clock.js";
import { energyCostFor, initialSState } from "../src/engine/state.js";
import { sleepHourFor } from "../src/engine/cycles.js";
import { createStandalonePort } from "../src/autonomy/standalone.js";
import { SelftalkJournal } from "../src/maintenance/selftalk-journal.js";
import { SoulRuntime } from "../src/plugin/runtime.js";
import { buildTools } from "../src/plugin/tools.js";

const cfg = loadConfig();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-p3-"));
  dirs.push(dir);
  return dir;
}

/** 2026-10-28 12:00 UTC = 北京 20:00；localHour 固定 12，避免真实时间带进测试 */
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

async function openRuntime(dir = tmp(), clock = new FakeClock(NOW, 12)): Promise<SoulRuntime> {
  return SoulRuntime.open({ characterId: "test", dataDir: dir, trace: false }, clock);
}

/** 脚本/源码只能读字符串：main.mjs 不进 tsc、也不该被 import（会起真进程） */
function source(relPath: string): string {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

/**
 * 把实例推进到 asleep：能量压到 0.1 后连判两次——
 * 第一拍 awake→drowsy，第二拍 drowsy→asleep（没有对方消息 = 静默视为无限长）。
 */
async function enterAsleep(rt: SoulRuntime): Promise<void> {
  rt.state.energy = 0.1;
  rt.sleepState();
  rt.sleepState();
  expect(rt.sleepInfo().phase).toBe("asleep");
}

interface FakeRec {
  id: string;
  forgotten: boolean;
}

function fakeRuntime() {
  const calls = { advance: 0, consolidate: 0 };
  const state = initialSState();
  const runtime = {
    advance: (hours: number) => {
      calls.advance += 1;
      return { steps: Math.round(hours * 12), faded: 0 };
    },
    consolidate: () => {
      calls.consolidate += 1;
      return { clusters: 1, written: 1, accepted: ["t1"], rejected: [] };
    },
    state,
    memoryStore: () => ({
      active: () => [] as FakeRec[],
      get: () => undefined,
      mutate: () => undefined,
      touch: () => undefined,
    }),
  };
  return { runtime: runtime as never, calls };
}

describe("task-57 B2：责任反转——advance 不判睡眠，相位由 sleepState/sleepAdvance 推进", () => {
  it("asleep 时调 advance 不会自己换相位（相位只认 sleepState）", async () => {
    const rt = await openRuntime();
    await enterAsleep(rt);
    const before = rt.sleepInfo().phase;
    const r = rt.advance(0.5);
    expect(before).toBe("asleep");
    // 不判 asleep、也不做 asleep→waking：相位保持；推进仍按真实 tick 走
    expect(rt.sleepInfo().phase).toBe("asleep");
    expect(r.steps).toBe(6);
  });

  it("醒着（awake）跨睡点：advance 仍做一次巩固", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    const sleepHour = sleepHourFor("test", cfg);
    clock.setLocalHour((sleepHour - 0.2 + 24) % 24);
    rt.state.energy = 0.5;
    expect(rt.sleepInfo().phase).toBe("awake");
    const r = rt.advance(0.5, { wakeDrain: false });
    expect(r.sleep?.count).toBe(1);
    expect(r.sleep?.ran).toBe(true);
    expect(rt.sleepInfo().lastSleepAt).not.toBeNull();
  });

  it("drowsy 时跨睡点：同样触发一次巩固（只有 asleep 才走 sleepAdvance）", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    const sleepHour = sleepHourFor("test", cfg);
    // 先在普通时刻睡着，再被消息叫醒、缓冲过后落到 drowsy（能量仍低 → 不是直接 awake）
    await enterAsleep(rt);
    rt.turn({
      text: "我在呢。",
      appraisal: { goal_congruence: 0.6, goal_relevance: 0.7, coping_potential: 0.7, novelty: 0.3, legitimacy: 0.8 },
    });
    clock.advance(5 * 60_000);
    rt.sleepState();
    expect(rt.sleepLogLine()).toContain("phase=drowsy");

    clock.setLocalHour((sleepHour - 0.2 + 24) % 24);
    const r = rt.advance(0.5, { wakeDrain: false });
    expect(r.sleep?.ran).toBe(true);
  });
});

describe("task-57 B2/B4：sleepAdvance 只恢复，醒来/入睡不由它判", () => {
  it("睡着时 sleepAdvance 只恢复能量，相位保持 asleep", async () => {
    const rt = await openRuntime();
    await enterAsleep(rt);
    const before = rt.state.energy;
    const r = rt.sleepAdvance(0.5);
    expect(r.consolidated).toBe(false);
    expect(rt.state.energy).toBeGreaterThan(before);
    expect(rt.sleepInfo().phase).toBe("asleep");
  });

  it("A 通道只按 wakeDrain 开关扣：非 awake 相位传 false 时能量更高（B4）", async () => {
    const rtA = await openRuntime();
    rtA.state.energy = 0.1;
    rtA.sleepState();
    rtA.advance(0.1, { wakeDrain: false });
    const rtB = await openRuntime();
    rtB.state.energy = 0.1;
    rtB.sleepState();
    rtB.advance(0.1);
    expect(rtA.state.energy).toBeGreaterThan(rtB.state.energy);
  });

  it("睡着跨睡点：sleepAdvance 内巩固一次、lastSleepAt 更新、consolidate 不扣能", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    const sleepHour = sleepHourFor("test", cfg);
    clock.setLocalHour((sleepHour - 0.2 + 24) % 24);
    await enterAsleep(rt);
    const before = rt.state.energy;
    const lastSleepMs = rt.sleepInfo().lastSleepMs;
    const r = rt.sleepAdvance(0.5);
    expect(r.consolidated).toBe(true);
    expect(rt.sleepInfo().lastSleepAt).toBe(NOW);
    // 恢复 tick 只增不减；consolidate 的 spendEnergy 在 asleep 时 no-op
    expect(rt.state.energy).toBeGreaterThan(before);
    // C：夜间巩固不写回入睡/醒来时刻
    expect(rt.sleepInfo().lastSleepMs).toBe(lastSleepMs);
  });

  it("同一睡点只巩固一次：紧接着再推不会双触发，lastSleepAt 不动", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    const sleepHour = sleepHourFor("test", cfg);
    clock.setLocalHour((sleepHour - 0.2 + 24) % 24);
    await enterAsleep(rt);
    expect(rt.sleepAdvance(0.5).consolidated).toBe(true);
    const at = rt.sleepInfo().lastSleepAt;
    const second = rt.sleepAdvance(0.1);
    expect(second.consolidated).toBe(false);
    expect(rt.sleepInfo().lastSleepAt).toBe(at);
  });
});

describe("task-57 B4：相位推进（sleepState）与唤醒", () => {
  it("低能量第一次 sleepState 就判 asleep（静默视为无限长），被叫醒后能量仍低则落回 drowsy", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    rt.state.energy = 0.1;
    rt.sleepState();
    // 压力已经高过入睡门 + 静默视为无限长 → 第一次判定直接进 asleep，不经过 drowsy
    expect(rt.sleepInfo().phase).toBe("asleep");
    rt.sleepState();
    expect(rt.sleepInfo().phase).toBe("asleep");
    expect(rt.sleepInfo().asleep).toBe(true);

    // 被消息叫醒（waking → 缓冲过后按压力重新判：能量仍低就落回 drowsy）
    rt.turn({
      text: "我在呢。",
      appraisal: { goal_congruence: 0.6, goal_relevance: 0.7, coping_potential: 0.7, novelty: 0.3, legitimacy: 0.8 },
    });
    expect(rt.sleepInfo().phase).toBe("waking");
    clock.advance(5 * 60_000);
    rt.sleepState();
    expect(rt.sleepInfo().phase).toBe("drowsy");
  });

  it("对方消息可以覆盖最短窗把她叫醒（asleep→waking；缓冲后不再是 waking）", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    await enterAsleep(rt);
    rt.turn({
      text: "我在呢。",
      appraisal: { goal_congruence: 0.6, goal_relevance: 0.7, coping_potential: 0.7, novelty: 0.3, legitimacy: 0.8 },
    });
    expect(rt.sleepInfo().phase).toBe("waking");
    expect(rt.sleepLogLine()).toContain("reason=peer-message");
    clock.advance(5 * 60_000);
    rt.sleepState();
    // 醒来后按当前能量重新判：低能量下是 drowsy，高能量才是 awake；关键是不再停在 waking
    expect(["awake", "drowsy"]).toContain(rt.sleepInfo().phase);
  });

  it("自然醒：逐拍 sleepAdvance+sleepState，日志能认出 min-window/最大窗原因", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    await enterAsleep(rt);
    let sawWake = false;
    for (let i = 0; i < 120 && !sawWake; i += 1) {
      clock.advance(5 * 60_000);
      rt.sleepAdvance(1 / 12);
      sawWake = /phase=waking .*reason=(min-window|max-window)/.test(rt.sleepLogLine());
    }
    expect(sawWake).toBe(true);
    clock.advance(5 * 60_000);
    rt.sleepState();
    expect(rt.sleepInfo().phase).toBe("awake");
  });
});

describe("P3-2b：B 通道与每拍日志", () => {
  it("turn 不再重复扣 A，只扣一次 ENERGY_COST_TURN", async () => {
    const rt = await openRuntime();
    const cost = energyCostFor(rt.config, "turn");
    expect(cost).toBeGreaterThan(0);
    const before = rt.state.energy;
    rt.turn({
      text: "我升职了！",
      appraisal: {
        goal_congruence: 0.9,
        goal_relevance: 0.8,
        coping_potential: 0.8,
        novelty: 0.3,
        legitimacy: 0.9,
      },
    });
    // 如果 turn.ts 的内置 tick 忘了传 wakeDrain:false，这里会多扣掉 1/12 小时的清醒耗散
    expect(rt.state.energy).toBeCloseTo(before - cost, 10);
  });

  it("spendEnergy 记账；asleep 时直接返回不扣", async () => {
    const rt = await openRuntime();
    const before = rt.state.energy;
    rt.spendEnergy(0.05);
    expect(rt.state.energy).toBeCloseTo(before - 0.05, 10);
    expect(() => rt.spendEnergy(-1)).toThrow(RangeError);

    await enterAsleep(rt);
    const asleepEnergy = rt.state.energy;
    rt.spendEnergy(0.2);
    expect(rt.state.energy).toBe(asleepEnergy);
  });

  it("每拍一行 [sleep] 日志：相位/压力/能量/窗口 + mode/reason/sleptH/turns 可回放", async () => {
    const rt = await openRuntime();
    const line = rt.sleepLogLine();
    expect(line).toMatch(
      /^\[sleep\] phase=(awake|drowsy|asleep|waking) pressure=\d+\.\d{2} energy=\d+\.\d{3} window=(open|closed) mode=(NORMAL|DEFENSE|BREAK|OBSESSION|OVERDRIVE|LAZY) reason=(hold|pressure|window|quiet|min-window|peer-message|max-window|wake-buffer) sleptH=\d+\.\d{2} turns=\d+$/,
    );
  });

  it("B6 sleptH：睡着若干分钟后 > 0；没有 lastSleepMs 时是 0.00 不是 NaN", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    expect(rt.sleepInfo().lastSleepMs).toBeNull();
    expect(rt.sleepLogLine()).toContain("sleptH=0.00");
    await enterAsleep(rt);
    clock.advance(30 * 60_000);
    rt.sleepAdvance(0.5);
    const line = rt.sleepLogLine();
    expect(line).toMatch(/sleptH=0\.(5|4\d)/);
    expect(line).not.toContain("NaN");
  });
});

describe("P3-2b：相位落盘、旧存档与 reset", () => {
  it("睡着后相位写进 state-<char>.json，重开实例仍接着睡", async () => {
    const dir = tmp();
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(dir, clock);
    await enterAsleep(rt);

    const saved = JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as {
      sleep?: { phase?: string; lastSleepMs?: number | null };
    };
    expect(saved.sleep?.phase).toBe("asleep");
    expect(typeof saved.sleep?.lastSleepMs).toBe("number");

    const rt2 = await openRuntime(dir, clock);
    expect(rt2.sleepInfo().phase).toBe("asleep");
    expect(rt2.sleepInfo().lastSleepMs).toBe(saved.sleep?.lastSleepMs ?? null);
  });

  it("旧存档（没有 sleep 字段）照常读：awake 起步，不抛", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "state-test.json"),
      JSON.stringify({
        version: 1,
        characterId: "test",
        s: initialSState(),
        bondProgress: 0,
        turns: 0,
        updatedAt: NOW,
      }),
    );
    const rt = await openRuntime(dir);
    expect(rt.sleepInfo().phase).toBe("awake");
    expect(rt.sleepInfo().lastSleepMs).toBeNull();
  });

  it("B5 reset 把睡眠清回 awake，不会 reset 完还卡在 asleep", async () => {
    const rt = await openRuntime();
    await enterAsleep(rt);
    rt.reset(true);
    expect(rt.sleepInfo().phase).toBe("awake");
    expect(rt.sleepInfo().asleep).toBe(false);
    expect(rt.sleepInfo().lastSleepMs).toBeNull();
  });
});

describe("task-57 B3/C：consolidate 的 B 支付与字段隔离", () => {
  it("B3：energyCostFor(consolidate)>0；awake 巩固扣能、asleep 巩固不扣", async () => {
    const cost = energyCostFor(cfg, "consolidate");
    expect(cost).toBeGreaterThan(0);

    const awakeRt = await openRuntime();
    awakeRt.state.energy = 0.5;
    awakeRt.consolidate();
    expect(awakeRt.state.energy).toBeCloseTo(0.5 - cost, 10);

    const sleepRt = await openRuntime();
    await enterAsleep(sleepRt);
    const before = sleepRt.state.energy;
    sleepRt.consolidate();
    expect(sleepRt.state.energy).toBe(before);
  });

  it("C：consolidate 只动 lastSleepAt，不动 sleep.lastSleepMs/wokeAtMs；相位与 sleptH 不受影响", async () => {
    const clock = new FakeClock(NOW, 12);
    const rt = await openRuntime(tmp(), clock);
    await enterAsleep(rt);
    clock.advance(2 * 3_600_000);
    rt.sleepAdvance(1);
    const beforeMs = rt.sleepInfo().lastSleepMs;
    const beforeWoke = rt.sleepInfo().wokeAtMs;
    const sleptHBefore = rt.sleepLogLine().match(/sleptH=(\d+\.\d{2})/)?.[1];
    expect(sleptHBefore).toBe("2.00");

    rt.consolidate();

    expect(rt.sleepInfo().lastSleepMs).toBe(beforeMs);
    expect(rt.sleepInfo().wokeAtMs).toBe(beforeWoke);
    expect(rt.sleepInfo().phase).toBe("asleep");
    // 若 lastSleepAt 被误当成入睡时刻，sleptH 会归零
    expect(rt.sleepLogLine()).toContain("sleptH=2.00");
  });
});

describe("task-57 A：soul_advance 的睡眠门", () => {
  it("睡着时 soul_advance 拒绝推进：不改 energy、不换相位、文本明说", async () => {
    const rt = await openRuntime();
    await enterAsleep(rt);
    const tool = buildTools(rt).find((d) => d.name === "soul_advance");
    const before = rt.state.energy;
    const out = String(await (tool?.execute({ hours: 2 }) ?? Promise.resolve("")));
    expect(out).toContain("她正在睡觉");
    expect(out).toContain("phase=asleep");
    expect(rt.state.energy).toBe(before);
    expect(rt.sleepInfo().phase).toBe("asleep");
  });
});

describe("P3-2b：asleep 时 autonomy 动作硬跳", () => {
  it("睡着：learn/proactive/selftalk 不跑、不调模型、不扣能；巩固仍跑", async () => {
    const calls: Record<string, number> = {};
    const spent: string[] = [];
    const { runtime } = fakeRuntime();
    const port = createStandalonePort({
      runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "journal.json")),
      now: () => NOW,
      localHour: () => 3,
      sleepState: () => ({ asleep: true, phase: "asleep" }),
      spendEnergy: (kind) => spent.push(kind),
      learnImpl: async () => {
        calls.learn = (calls.learn ?? 0) + 1;
        return { topic: "崩坏三", keyword: "AI助手" };
      },
      proactiveImpl: async () => {
        calls.proactive = (calls.proactive ?? 0) + 1;
        return { opened: true, reason: "ok", generated: true };
      },
    });

    expect(await port.learn()).toEqual({ topic: "skipped", keyword: "睡眠中" });
    expect((await port.proactive()).opened).toBe(false);
    expect((await port.selftalk()).kind).toBe("wander");
    expect(calls.learn).toBeUndefined();
    expect(calls.proactive).toBeUndefined();
    expect(spent).toEqual([]);

    // 巩固不早退（睡眠中也要整理），扣能由 runtime.consolidate 自己负责（asleep 时它也会跳过）
    const out = await port.consolidate();
    expect(out.accepted).toBe(1);
  });

  it("醒着：真学了/真生成才扣 B；skipped 与 held 不收费", async () => {
    const charged: string[] = [];
    const active = createStandalonePort({
      runtime: fakeRuntime().runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "journal.json")),
      now: () => NOW,
      localHour: () => 3,
      sleepState: () => ({ asleep: false, phase: "awake" }),
      spendEnergy: (kind) => charged.push(kind),
      learnImpl: async () => ({ topic: "崩坏三", keyword: "AI助手" }),
      proactiveImpl: async () => ({ opened: true, reason: "ok", generated: true }),
    });
    const learned: unknown = await active.learn();
    expect(learned).toMatchObject({ topic: "崩坏三" });
    expect((await active.proactive()).opened).toBe(true);
    expect(charged).toEqual(["learn", "proactive"]);

    const silent: string[] = [];
    const quiet = createStandalonePort({
      runtime: fakeRuntime().runtime,
      cfg,
      journal: SelftalkJournal.open(join(tmp(), "journal.json")),
      now: () => NOW,
      localHour: () => 3,
      sleepState: () => ({ asleep: false, phase: "awake" }),
      spendEnergy: (kind) => silent.push(kind),
      learnImpl: async () => ({ topic: "skipped", keyword: "今天没素材" }),
      proactiveImpl: async () => ({ opened: false, reason: "held", generated: false }),
    });
    expect(await quiet.learn()).toEqual({
      topic: "skipped",
      keyword: "今天没素材",
      // W1（spec v2.3 §5.3）：full 档脊髓无条件附 webPlan（plan 只回答「该不该查」，
      // 发网络/判 URL/额度都在装配层；allowSearch=false 时也照带，装配层据此零网络）。
      webPlan: { allowSearch: false, querySource: "hot-topic", keyword: "今天没素材" },
    });
    expect((await quiet.proactive()).opened).toBe(false);
    expect(silent).toEqual([]);
  });
});

describe("task-57：装配层接线（main.mjs / tools.ts 源码锁定）", () => {
  it("main.mjs 每拍先判相位再分流：醒着（awake/drowsy）走 advance(wakeDrain)，睡着走 runSleepTick", () => {
    const main = source("scripts/autonomy/main.mjs");
    expect(main).toContain("const sleepRuntime = {");
    expect(main).toContain("if (runtime.sleepInfo().asleep) return;");
    // task-117 ①：drowsy 是「清醒但困」，也必须扣 A——否则一犯困就回血、睡压永远到不了入睡线。
    expect(main).toContain(
      'return runtime.advance(hours, { wakeDrain: sl.phase === "awake" || sl.phase === "drowsy" });',
    );
    expect(main).toContain("runSleepTick(");
    expect(main).toContain("work = runtime.sleepAdvance(dt, { episodeMs: sl.asleepSince ?? undefined });");
    expect(main).toContain("normalizeNightBudget(nowMs, tzOffsetMinutes, nightBudget)");
    expect(main).not.toContain("const sleepNow = runtime.sleepState();");
  });

  it("main.mjs 把 B1 的醒来时刻/睡眠时长递进时间快照", () => {
    const main = source("scripts/autonomy/main.mjs");
    expect(main).toContain("awakeSinceMs: sleepInfo.wokeAtMs");
    expect(main).toContain("lastSleepAt: sleepInfo.lastSleepMs");
    expect(main).toContain("sleepInfo.wokeAtMs - sleepInfo.lastSleepMs");
    // 回退链最后一级：没有醒来/睡点时刻时按进程启动算，不给 null
    expect(main).toContain("?? processStartedAt");
    expect(main).toContain("const processStartedAt = Date.now();");
  });

  it("tools.ts 的 soul_advance 在 asleep 时拒绝（不进写队列）", () => {
    const tools = source("src/plugin/tools.ts");
    expect(tools).toContain("她正在睡觉");
    expect(tools).toContain('if (si.asleep) {');
  });

  it("runtime 的 sleepAdvance 与 advance 分流都在源码里", () => {
    const runtime = source("src/plugin/runtime.ts");
    expect(runtime).toContain("sleepAdvance(dtHours: number, opts?: { readonly episodeMs?: number })");
    expect(runtime).toContain("wakeDrain: opts.wakeDrain ?? true");
    expect(runtime).toContain("wakeDrain: false, energyRecovery: true");
    expect(runtime).toContain("this.sleep = initialPersistedSleep(null, this.clock.now());");
  });

  it("standalone 的三个硬跳与三处 B 扣费都在", () => {
    const standalone = source("src/autonomy/standalone.ts");
    expect(standalone.match(/sleepState\?\.\(\)\.asleep === true/g) ?? []).toHaveLength(3);
    expect(standalone).toContain('spendEnergy?.("learn")');
    expect(standalone).toContain('spendEnergy?.("proactive")');
    expect(standalone).toContain('spendEnergy?.("selftalk")');
  });

  it("runtime 的 [sleep] 行和 Persisted.sleep 字段存在", () => {
    const runtime = source("src/plugin/runtime.ts");
    expect(runtime).toContain("[sleep] phase=${state.phase}");
    expect(runtime).toContain("mode=${mode}");
    expect(runtime).toContain("lastWakeReason");
    expect(runtime).toContain("reason=${reason}");
    expect(runtime).toContain("sleptH=${state.sleptHours.toFixed(2)}");
    expect(runtime).toContain("turns=${this.turns}");
    expect(runtime).toContain("export interface PersistedSleep");
    expect(runtime).toContain("sleep: this.sleep,");
  });
});

describe("P4-1（task-69）：夜间账本持久化 + 装配层补巩固/观测接线", () => {
  it("setNightBudget 写进 Persisted.sleep，重开实例仍读到同一本账", async () => {
    const dir = tmp();
    const rt = await openRuntime(dir, new FakeClock(NOW, 12));
    rt.setNightBudget({ nightKey: "2026-10-28", used: 3 });
    const body = JSON.parse(readFileSync(join(dir, "state-test.json"), "utf8")) as {
      sleep?: { nightBudget?: unknown };
    };
    expect(body.sleep?.nightBudget).toEqual({ nightKey: "2026-10-28", used: 3 });

    const rt2 = await openRuntime(dir, new FakeClock(NOW, 12));
    expect(rt2.sleepInfo().nightBudget).toEqual({ nightKey: "2026-10-28", used: 3 });
  });

  it("main.mjs 启动时 normalize 账本、补巩固并打 [sleep-backfill]/[fade]/[sleep-work]", () => {
    const main = source("scripts/autonomy/main.mjs");
    // 启动：读持久化账本 → 按当前夜 normalize → 写回
    expect(main).toContain("runtime.sleepInfo().nightBudget");
    expect(main).toContain("normalizeNightBudget(Date.now(), tzOffsetMinutes, persistedBudget ?? undefined)");
    expect(main).toContain("runtime.setNightBudget(nightBudget)");
    expect(main).toContain("[sleep-budget] load night=");
    // F317 启动补巩固 + 三条观测日志
    expect(main).toContain("runtime.backfillSleepWork()");
    expect(main).toContain("[sleep-backfill] missed=");
    expect(main).toContain("[fade] first-anchor=");
    expect(main).toContain("[sleep-work] consolidated=");
    expect(main).toContain("compact=${compactText(");
    // 睡眠分支：账本随切片写回 + 工作日志
    expect(main).toContain("runtime.setNightBudget(nightBudget);");
    expect(main).toContain("if (work !== null) logSleepWork(work);");
    // task-74 B2/B3/B4：补巩固的 [fade] 也要有 error 分支；日志带候选 id；账本注释已更新
    expect(main).toContain("|| backfill.fade.error !== null");
    expect(main).toContain("ids=${purgeableIdsText(");
    expect(main).toContain("账本落盘在 Persisted.sleep.nightBudget（P4-1）");
  });

  it("runtime.ts 有最后一夜工作与补巩固的完整实现（fade/compact/backfill 锚点）", () => {
    const runtime = source("src/plugin/runtime.ts");
    expect(runtime).toContain("sleepAdvance(dtHours: number, opts?: { readonly episodeMs?: number }): SleepAdvanceResult");
    expect(runtime).toContain("backfillSleepWork(): SleepBackfillResult");
    expect(runtime).toContain("private sleepWork(nowMs: number)");
    expect(runtime).toContain("private sleepFade(nowMs: number)");
    expect(runtime).toContain("private sleepCompact()");
    expect(runtime).toContain("Math.max(120, this.store.stats().size * 3)");
    // 锚点回退链 + 首跑只写锚点
    expect(runtime).toContain("this.lastSleepAt ?? this.processStartedAt");
    expect(runtime).toContain("firstAnchor: true");
    expect(runtime).toContain("this.lastSleepAt = null;");
    expect(runtime).toContain("this.lastFadeAt = null;");
    // task-74 B1/B3：锚点按 fade 覆盖量前移（不是 now）；候选 id 与上限
    expect(runtime).toContain("this.lastFadeAt += hours * 3_600_000;");
    expect(runtime).toContain("readonly purgeableIds: readonly string[];");
    expect(runtime).toContain("const PURGEABLE_ID_LIMIT = 20;");
  });
});

describe("F340（task-179）：入睡首拍 + episode 去重 + backfill at-most-once（源码锁）", () => {
  it("Persisted.sleep 四处同步 lastSleepWorkEpisode（initial/parse/applySleep/reset）", () => {
    const runtime = source("src/plugin/runtime.ts");
    expect(runtime).toContain("readonly lastSleepWorkEpisode?: number | null;");
    // initial：老存档 → null
    expect(runtime).toContain("lastSleepWorkEpisode: null,");
    // parse：坏值/缺失 → null
    expect(runtime).toContain("const lastSleepWorkEpisode = numOrNull(o.lastSleepWorkEpisode);");
    // applySleep：相位迁移重建对象时显式搬（否则每醒一次丢 key）
    expect(runtime).toContain("lastSleepWorkEpisode: this.sleep.lastSleepWorkEpisode ?? null,");
    // reset 走 initialPersistedSleep → 自动清空
    expect(runtime).toContain("this.sleep = initialPersistedSleep(null, this.clock.now());");
  });

  it("runEpisodeWork 顺序：先 key+lastSleepAt+save，再 consolidate+sleepWork；consolidated=error===null", () => {
    const runtime = source("src/plugin/runtime.ts");
    expect(runtime).toContain("consolidated: work.error === null,");
    expect(runtime).toContain('this.runEpisodeWork(episodeMs, now, "onset")');
    expect(runtime).toContain('this.runEpisodeWork(episode, now, "crossing")');
    const start = runtime.indexOf("private runEpisodeWork(");
    const end = runtime.indexOf("backfillSleepWork(): SleepBackfillResult", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = runtime.slice(start, end);
    const keyIndex = body.indexOf("lastSleepWorkEpisode: episodeMs");
    const saveIndex = body.indexOf("this.save();");
    const workIndex = body.indexOf("const res = this.consolidate();");
    expect(keyIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeGreaterThan(keyIndex);
    expect(workIndex).toBeGreaterThan(saveIndex);
    // crossing/onset 都走 helper；backfill 用同一顺序并检查 already-worked
    expect(runtime).toContain('this.runEpisodeWork(episode, now, "crossing")');
    expect(runtime).toContain('reason: "already-worked"');
    expect(runtime).toContain('reason: "no-episode"');
  });

  it("main.mjs 传 episodeMs，且只在 trigger=onset 时打 [sleep-work-onset]", () => {
    const main = source("scripts/autonomy/main.mjs");
    expect(main).toContain("work = runtime.sleepAdvance(dt, { episodeMs: sl.asleepSince ?? undefined });");
    expect(main).toContain('work.trigger === "onset"');
    expect(main).toContain("[sleep-work-onset] episode=");
    // dream 仍只由 consolidated 驱动（语义已收窄为 error===null）
    expect(main).toContain("if (work !== null && work.consolidated) scheduleDreamShadow(r.nightKey);");
  });
});
