/**
 * 插件运行时测试：把“工具面”当成被测对象——因为用户看到的就是它。
 *
 * 这里不重复 engine 的数值断言（那些在 state/bonds/appraisal 里），只测三件
 * 插件层才会出错的事：状态有没有真的落盘、写记忆有没有过防火墙、工具层的
 * 输入校验是否会挡住非法参数。
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, renderRecalls, round4, type SoulConfig } from "../src/plugin/runtime.js";
import { buildTools, type BiliFeedLike, type BiliLearnResult, type BiliMeLike } from "../src/plugin/tools.js";
import { EXPRESSION_TABLE } from "../src/dialogue/expression.js";
import { parsePersona } from "../src/dialogue/persona.js";

let dir: string;
let clock: FakeClock;
let conf: SoulConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-plugin-"));
  clock = new FakeClock(Date.UTC(2026, 9, 28, 12, 0, 0), 12);
  conf = { characterId: "test", dataDir: dir, trace: false };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function open(): Promise<SoulRuntime> {
  return SoulRuntime.open(conf, clock);
}

const HAPPY = {
  text: "我升职了！",
  appraisal: { goal_congruence: 0.9, goal_relevance: 0.8, coping_potential: 0.8, novelty: 0.3, legitimacy: 0.9 },
};
const SAD = {
  text: "你根本不在乎我。",
  appraisal: { goal_congruence: -0.8, goal_relevance: 0.9, coping_potential: 0.3, novelty: 0.2, legitimacy: 0.2 },
};

describe("SoulRuntime：一轮对话", () => {
  it("正面输入把 valence 推过 0.5，并把 bond 从 0 推起来", async () => {
    const rt = await open();
    const r = rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    expect(r.state.valence).toBeGreaterThan(0.5);
    expect(r.bondProgress).toBeGreaterThan(0);
    expect(r.mode).toBe("NORMAL");
    expect(r.memory).toEqual({ wrote: 1, rejected: 0 });
  });

  it("负面输入会加压力，但单轮不改变模式", async () => {
    const rt = await open();
    const before = rt.state.pressure;
    const r = rt.turn({ text: SAD.text, appraisal: SAD.appraisal });
    expect(r.state.pressure).toBeGreaterThan(before);
    expect(r.mode).toBe("NORMAL");
  });

  it("写一条记忆后 recall 能命中它", async () => {
    const rt = await open();
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const rows = rt.recall("升职");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.content).toContain("升职");
  });
});

describe("SoulRuntime：持久化", () => {
  it("重新打开后状态与轮数都还在", async () => {
    const rt = await open();
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const before = { valence: rt.state.valence, turns: rt.snapshot()["turns"] };

    const rt2 = await open();
    expect(rt2.state.valence).toBeCloseTo(before.valence, 12);
    expect(rt2.snapshot()["turns"]).toBe(before.turns);
  });

  it("状态文件是原子写：不存在 .tmp 残留", async () => {
    const rt = await open();
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".tmp") || f.includes(".tmp-"))).toBe(false);
    const stateFile = files.find((f) => f.startsWith("state-"));
    expect(stateFile).toBeDefined();
    const body = JSON.parse(readFileSync(join(dir, stateFile as string), "utf8")) as { version: number };
    expect(body.version).toBe(1);
  });

  it("记忆走 NDJSON WAL，重开后可回放", async () => {
    const rt = await open();
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const wal = readdirSync(dir).find((f) => f.startsWith("memory-"));
    expect(wal).toBeDefined();
    const lines = readFileSync(join(dir, wal as string), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const rt2 = await open();
    expect(rt2.recall("升职").length).toBeGreaterThan(0);
  });
});

describe("SoulRuntime：防火墙在写路径上", () => {
  it("不可信来源落盘但打污点", async () => {
    const rt = await open();
    const r = rt.remember({ content: "网上有人说他是假的", source: "web" });
    expect(r.stored).toBe(true);
    const rows = rt.recall("网上");
    expect(rows.some((x) => x.underTaint)).toBe(true);
  });

  it("可信来源不打污点", async () => {
    const rt = await open();
    const r = rt.remember({ content: "他亲口说的", source: "player" });
    expect(r.stored).toBe(true);
    const rows = rt.recall("亲口");
    expect(rows.every((x) => !x.underTaint)).toBe(true);
  });

  it("空内容被拒，且拒绝计数可见", async () => {
    const rt = await open();
    const r = rt.remember({ content: "   ", source: "player" });
    expect(r.stored).toBe(false);
    expect(rt.memoryStats().rejects).toBe(1);
  });
});

describe("SoulRuntime：时间与重置", () => {
  it("advance 用 5 分钟步长，8 小时 = 96 步", async () => {
    const rt = await open();
    rt.turn({ text: SAD.text, appraisal: SAD.appraisal });
    const r = rt.advance(8);
    expect(r.steps).toBe(96);
  });

  it("advance 把压力拉回 baseline", async () => {
    const rt = await open();
    rt.turn({ text: SAD.text, appraisal: SAD.appraisal });
    expect(rt.state.pressure).toBeGreaterThan(0.2);
    rt.advance(24);
    expect(round4(rt.state.pressure)).toBe(0.2);
  });

  it("非法 hours 抛错", async () => {
    const rt = await open();
    expect(() => rt.advance(0)).toThrow(RangeError);
    expect(() => rt.advance(Number.NaN)).toThrow(RangeError);
  });

  it("reset 需要显式 confirm", async () => {
    const rt = await open();
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    expect(() => rt.reset(false)).toThrow(/confirm/);
    rt.reset(true);
    expect(rt.state.valence).toBe(0.5);
    expect(rt.progress).toBe(0);
  });
});

describe("工具面", () => {
  it("注册 27 个工具且名字唯一", async () => {
    const rt = await open();
    const defs = buildTools(rt);
    expect(new Set(defs.map((d) => d.name))).toEqual(
      new Set([
        "soul_turn",
        "soul_state",
        "soul_recall",
        "soul_remember",
        "soul_advance",
        "soul_stats",
        "soul_consolidate",
        "soul_archive",
        "soul_insight",
        "soul_bili_feed",
        "soul_bili_learn",
        "soul_bili_me",
        "soul_curious",
        "soul_conflict",
        "soul_obsess",
        "soul_persona",
        "soul_qq_status",
        "soul_qq_poll",
        "soul_qq_send",
        "soul_qq_proactive",
        "soul_qq_dbprobe",
        "soul_qqlab",
        "soul_reset",
        "soul_desktop",
        "soul_bili_read",
        "soul_web_search",
        "soul_web_fetch",
      ]),
    );
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
  });

  it("每个工具都有 parameters 且是 object schema", async () => {
    const rt = await open();
    for (const d of buildTools(rt)) {
      expect(d.parameters["type"]).toBe("object");
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(10);
    }
  });

  it("soul_turn 拒绝非法数值参数", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    expect(turn).toBeDefined();
    await expect(
      turn?.execute({ text: "x", goal_congruence: "不是数字" }) ?? Promise.resolve(""),
    ).rejects.toThrow(TypeError);
  });

  it("soul_bili_feed 默认拉 5 条、limit 夹到 20，未接时明确报没接", async () => {
    const rt = await open();
    const noBili = buildTools(rt).find((d) => d.name === "soul_bili_feed");
    expect(await noBili?.execute({})).toContain("未接");

    const seen: number[] = [];
    const tool = buildTools(rt, {
      bili: {
        feed: async (limit: number) => {
          seen.push(limit);
          return {
            fetched: 2,
            ingested: 1,
            skipped: 1,
            blocked: 1,
            videos: [
              { bvid: "BV1xx411c7mD", title: "标题", owner: "UP主" },
              { bvid: "BV2xx411c7mE", title: "第二个", owner: "UP2" },
            ],
          };
        },
      },
    }).find((d) => d.name === "soul_bili_feed");
    const out = (await tool?.execute({})) ?? "";
    expect(seen[0]).toBe(5);
    expect(out).toContain("[soul_bili_feed] fetched=2 ingested=1 skipped=1 blocked=1 offTopic=0");
    expect(out).toContain("BV1xx411c7mD 标题（UP主）");
    expect(out).toContain("BV2xx411c7mE 第二个（UP2）");

    await tool?.execute({ limit: 99 });
    expect(seen[1]).toBe(20);
  });

  it("soul_bili_me 无参自检：未接 / 未登录 / 已登录 / nav 取不到", async () => {
    const rt = await open();
    const feedStub = async () => ({ fetched: 0, ingested: 0, skipped: 0, blocked: 0, videos: [] });
    const navTool = (bili: BiliFeedLike | null) =>
      buildTools(rt, { bili }).find((d) => d.name === "soul_bili_me");
    const withMe = (me: () => Promise<BiliMeLike>): BiliFeedLike => ({ feed: feedStub, me });

    expect(await navTool(null)?.execute({})).toContain("未接");

    const noSession = navTool(withMe(async () => ({ session: false, nav: null })));
    expect(await noSession?.execute({})).toBe(
      "[soul_bili_me] 未登录（data/bili-assistant.json 缺失或无 sessdata）",
    );

    const loggedIn = navTool(withMe(async () => ({
      session: true,
      nav: { isLogin: true, uname: "bili_90083128322", mid: 3747576174087043 },
    })));
    expect(await loggedIn?.execute({})).toBe(
      "[soul_bili_me] loggedIn=true uname=bili_90083128322 mid=3747576174087043",
    );

    const loggedOut = navTool(withMe(async () => ({
      session: true,
      nav: { isLogin: false, uname: "", mid: 0 },
    })));
    expect(await loggedOut?.execute({})).toBe("[soul_bili_me] loggedIn=false uname= mid=0");

    const navDown = navTool(withMe(async () => ({ session: true, nav: null })));
    expect(await navDown?.execute({})).toContain("nav 取不到");

    const boom = navTool(withMe(async () => {
      throw new Error("boom");
    }));
    expect(await boom?.execute({})).toBe("[soul_bili_me] 失败：boom");
  });

  it("soul_bili_learn 默认 limit=5/rotation=0，首行给计数、逐条 bvid 标题，未接/失败不抛", async () => {
    const rt = await open();
    const learnTool = (bili: BiliFeedLike | null) =>
      buildTools(rt, { bili }).find((d) => d.name === "soul_bili_learn");

    expect(await learnTool(null)?.execute({})).toContain("未接");

    const seen: { limit?: number; rotation?: number }[] = [];
    const result = (over: Partial<BiliLearnResult> = {}): BiliLearnResult => ({
      topic: "崩坏三",
      keyword: "崩坏3",
      fetched: 2,
      ingested: 1,
      skipped: 1,
      blocked: 1,
      offTopic: 0,
      items: [
        { bvid: "BV1xx411c7mD", title: "标题" },
        { bvid: "BV2xx411c7mE", title: "第二个" },
      ],
      ...over,
    });
    const biliWith = (learn: BiliFeedLike["learn"]): BiliFeedLike => ({
      feed: async () => ({ fetched: 0, ingested: 0, skipped: 0, blocked: 0, videos: [] }),
      me: async () => ({ session: false, nav: null }),
      learn: async (opts) => {
        seen.push(opts);
        return learn(opts);
      },
    });

    const tool = learnTool(biliWith(async () => result()));
    const out = (await tool?.execute({})) ?? "";
    expect(seen[0]).toEqual({ limit: 5, rotation: 0 });
    expect(out.split("\n")).toEqual([
      "[soul_bili_learn] topic=崩坏三 keyword=崩坏3 fetched=2 ingested=1 skipped=1 blocked=1 offTopic=0",
      "BV1xx411c7mD 标题",
      "BV2xx411c7mE 第二个",
    ]);

    // 越界参数被夹到 schema 声明的 1..10 / 0..99
    await tool?.execute({ limit: 99, rotation: 999 });
    expect(seen[1]).toEqual({ limit: 10, rotation: 99 });

    // 离题闸门单独计数：offTopic 原样透出，不与 blocked 混用。
    // 注意：这里的 learnTool 共用上面的 biliWith，每次 execute 都会 push 进 seen，
    // 所以必须放在 seen[1] 断言之后，否则会顶掉「越界参数夹取」那一次记录。
    const offTopicCase = learnTool(biliWith(async () => result({
      fetched: 1,
      ingested: 0,
      skipped: 1,
      blocked: 0,
      offTopic: 1,
      items: [{ bvid: "BV1kid000001", title: "宝宝巴士安全教育" }],
    })));
    expect((await offTopicCase?.execute({ limit: 1 }))?.split("\n")).toEqual([
      "[soul_bili_learn] topic=崩坏三 keyword=崩坏3 fetched=1 ingested=0 skipped=1 blocked=0 offTopic=1",
      "BV1kid000001 宝宝巴士安全教育",
    ]);

    const empty = learnTool(biliWith(async () => result({ fetched: 0, ingested: 0, skipped: 0, blocked: 0, items: [] })));
    expect(await empty?.execute({ limit: 1 })).toBe(
      "[soul_bili_learn] topic=崩坏三 keyword=崩坏3 fetched=0 ingested=0 skipped=0 blocked=0 offTopic=0\n（没有搜到视频）",
    );

    // 网络错/风控：工具层只报告，不把异常抛给宿主
    const boom = learnTool(biliWith(async () => {
      throw new Error("B 站搜索失败");
    }));
    expect(await boom?.execute({})).toBe("[soul_bili_learn] 失败：B 站搜索失败");
  });

  /**
   * 回归护栏：宿主对 `output.render` 是**必需**的，缺了会让 register() 抛错，
   * 而插件看起来仍然"加载成功"（fiber active）、工具列表却是空的。
   * 这个 bug 已实际发生过一次（2026-10-28），所以必须由测试守住。
   */
  it("每个工具都声明 output.schema 与 output.render", async () => {
    const rt = await open();
    for (const d of buildTools(rt)) {
      const out = d.output as { schema?: unknown; render?: unknown } | undefined;
      expect(out, `${d.name} 缺 output`).toBeDefined();
      expect(out?.schema, `${d.name} 缺 output.schema`).toBeDefined();
      expect(typeof out?.render, `${d.name} 缺 output.render`).toBe("function");
      const rendered = (out?.render as (a: unknown, v: unknown) => unknown)({}, "面板文本");
      expect(rendered).toEqual([{ type: "text", text: "面板文本" }]);
    }
  });

  it("soul_turn 缺省 appraisal 时按 0 处理而不是抛错", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const out = await (turn?.execute({ text: "随便聊聊" }) ?? Promise.resolve(""));
    expect(out).toContain("[soul_turn]");
  });

  it("soul_turn 输出 [world]：没方向时 calm，刚学到东西后是 newborn", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const cons = buildTools(rt).find((d) => d.name === "soul_consolidate");
    expect(turn).toBeDefined();
    expect(cons).toBeDefined();
    if (turn === undefined || cons === undefined) return;

    // 初始状态心很静、也没刚学到的东西 → 没有方向可说
    const calm = await turn.execute({ text: "在忙什么" });
    expect(calm).toContain("[world] calm");

    // 攒够 5 条对话巩固出知识 → newKnowledge>0，方向变成 newborn
    for (let i = 0; i < 5; i += 1) await turn.execute({ text: `第${i + 1}次`, event_type: "conversation" });
    await cons.execute({});
    const learned = await turn.execute({ text: "刚刚想到一件事" });
    expect(learned).toContain("[world] newborn");
    expect(learned).toMatch(/\[world\] newborn score=\d/);
  });

  it("soul_reset 未确认时报错（模型必须显式传 true）", async () => {
    const rt = await open();
    const reset = buildTools(rt).find((d) => d.name === "soul_reset");
    await expect(Promise.resolve(reset?.execute({}))).rejects.toThrow(/confirm/);
  });
});

describe("G4 学习与巩固（插件层接线）", () => {
  it("soul_turn 带 reaction 时给【上一轮】的策略记分，并落盘", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    expect(turn).toBeDefined();
    if (turn === undefined) return;

    // 第一轮：没有上一轮，所以 reaction 无处可记，scored=false
    const out1 = await turn.execute({ text: "今天好累", strategy: "安抚", reaction: "安抚" });
    expect(out1).toContain("[bandit] action=安抚");
    expect(out1).toContain("scored=false");

    // 第二轮：给上一轮（安抚）记分
    const out2 = await turn.execute({ text: "谢谢你", strategy: "安抚", reaction: "安抚" });
    expect(out2).toContain("scored=true");
    const stats = rt.memoryStats();
    expect(stats.banditKeys).toBe(1);

    // 重启后策略表仍在（学习不能只活在内存里）
    const reopened = await open();
    expect(reopened.memoryStats().banditKeys).toBe(1);
  });

  it("同语境下负反馈会把策略均值拉低", async () => {
    const rt = await open();
    rt.turn({ text: "a", appraisal: HAPPY.appraisal }, { strategy: "调侃" });
    rt.turn({ text: "b", appraisal: HAPPY.appraisal }, { strategy: "调侃", reaction: "冷战" });
    const snap = rt.snapshot() as { turns: number };
    expect(snap.turns).toBe(2);
    // 均值 = −0.5，UCB 选出来的仍是唯一候选（只有一个键时总分要为负）
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const out = await (turn?.execute({ text: "c" }) ?? Promise.resolve(""));
    expect(out).toContain("[bandit] action=调侃");
  });

  it("soul_consolidate：够 5 条同 tag 的对话才产出知识", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const cons = buildTools(rt).find((d) => d.name === "soul_consolidate");
    expect(turn).toBeDefined();
    expect(cons).toBeDefined();
    if (turn === undefined || cons === undefined) return;

    for (let i = 0; i < 4; i += 1) await turn.execute({ text: `第${i + 1}次聊天`, event_type: "conversation" });
    const early = await cons.execute({});
    expect(early).toContain("written=0");

    await turn.execute({ text: "第5次聊天", event_type: "conversation" });
    const late = await cons.execute({});
    expect(late).toContain("written=1");
    expect(late).toContain("kn_");
    expect(rt.knowledgeRows().length).toBe(1);
  });

  it("soul_insight：模型写的洞见覆盖兜底文本；tag 不存在时报错并提示现有簇", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const cons = buildTools(rt).find((d) => d.name === "soul_consolidate");
    const ins = buildTools(rt).find((d) => d.name === "soul_insight");
    if (turn === undefined || cons === undefined || ins === undefined) throw new Error("工具缺失");

    for (let i = 0; i < 5; i += 1) await turn.execute({ text: `第${i}次`, event_type: "conversation" });
    await cons.execute({});
    const out = await ins.execute({ tag: "conversation", content: "她每次说累的时候，其实是想被留下" });
    expect(out).toContain("stored=true");
    expect(rt.knowledgeRows()[0]?.content).toContain("其实是想被留下");

    // 批次 2b 起写类工具的 execute 是异步的（投递写通道），所以用 rejects 断言
    await expect(Promise.resolve(ins.execute({ tag: "不存在的簇", content: "x" }))).rejects.toThrow(/没有标签为/);
  });

  it("soul_stats 同时报知识与策略表规模", async () => {
    const rt = await open();
    const stats = buildTools(rt).find((d) => d.name === "soul_stats");
    const out = await (stats?.execute({}) ?? Promise.resolve(""));
    expect(out).toContain("knowledge=0");
    expect(out).toContain("bandit_keys=0");
  });
});

describe("渲染辅助", () => {
  it("renderRecalls 空结果给中文提示", () => {
    expect(renderRecalls([])).toContain("没有命中记忆");
  });

  it("数据目录不存在时会自动创建", async () => {
    const nested = join(dir, "a", "b");
    const rt = await SoulRuntime.open({ ...conf, dataDir: nested }, clock);
    rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    expect(existsSync(join(nested, "state-test.json"))).toBe(true);
  });
});

describe("睡眠触发巩固（G5-①）", () => {
  /** 把时钟挪到「睡点前一小时」，这样再推进 2 小时必然跨过睡点 */
  function beforeSleep(rt: SoulRuntime): void {
    clock.setLocalHour((rt.sleepInfo().hour + 23) % 24);
  }

  function seed(rt: SoulRuntime, n: number, tag = "conversation"): void {
    for (let i = 0; i < n; i += 1) rt.remember({ content: `第 ${i + 1} 次夜谈`, tags: [tag] });
  }

  /** FakeClock 是模拟时钟，advance 会自己推它；这里只是让断言读起来更短 */
  function pass(rt: SoulRuntime, hours: number): ReturnType<SoulRuntime["advance"]> {
    return rt.advance(hours);
  }

  it("没跨睡点：sleep=null，不巩固", async () => {
    const rt = await open();
    seed(rt, 5);
    clock.setLocalHour((rt.sleepInfo().hour + 1) % 24);
    const r = rt.advance(0.5);
    expect(r.sleep).toBeNull();
    expect(rt.memoryStats().knowledge).toBe(0);
  });

  it("跨睡点且证据够：醒来自动巩固一条知识", async () => {
    const rt = await open();
    seed(rt, 5);
    beforeSleep(rt);
    const r = pass(rt, 2);
    expect(r.sleep?.count).toBe(1);
    expect(r.sleep?.ran).toBe(true);
    expect(r.sleep?.written).toBe(1);
    expect(r.sleep?.accepted.length).toBe(1);
    expect(rt.memoryStats().knowledge).toBe(1);
  });

  it("跨睡点但证据不足：巩固跑了但没写（clusters=0）", async () => {
    const rt = await open();
    seed(rt, 2);
    beforeSleep(rt);
    const r = pass(rt, 2);
    expect(r.sleep?.ran).toBe(true);
    expect(r.sleep?.clusters).toBe(0);
    expect(r.sleep?.written).toBe(0);
    expect(rt.memoryStats().knowledge).toBe(0);
  });

  it("一个睡点只巩固一次：紧接的推进不再跨点", async () => {
    const rt = await open();
    seed(rt, 5);
    beforeSleep(rt);
    pass(rt, 2);
    const again = pass(rt, 1);
    expect(again.sleep).toBeNull();
    expect(rt.memoryStats().knowledge).toBe(1);
  });

  it("lastSleepAt 落盘：重开之后仍然记得睡过", async () => {
    const rt = await open();
    seed(rt, 5);
    beforeSleep(rt);
    pass(rt, 2);
    const at = rt.sleepInfo().lastSleepAt;
    expect(typeof at).toBe("number");
    const rt2 = await open();
    expect(rt2.sleepInfo().lastSleepAt).toBe(at);
  });

  it("soul_advance 工具把 [sleep] 行写进输出", async () => {
    const rt = await open();
    seed(rt, 5);
    beforeSleep(rt);
    const tool = buildTools(rt).find((d) => d.name === "soul_advance");
    const out = String(await (tool?.execute({ hours: 2 }) ?? Promise.resolve("")));
    expect(out).toContain("[sleep]");
    expect(out).toContain("crossed=1");
    expect(out).toContain("ran=true");
  });

  it("soul_stats 报下次睡点与上次巩固", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_stats");
    const out = String(await (tool?.execute({}) ?? Promise.resolve("")));
    expect(out).toMatch(/sleep=\d{2}:00 next_in=[\d.]+h/);
  });
});

describe("回退策略（G5-②）", () => {
  it("首轮没有历史时，回退动作是 ACTION_TYPES 里的合法动作", async () => {
    const rt = await open();
    const r = rt.turn({ text: "随便聊聊", appraisal: HAPPY.appraisal }, { eventType: "conversation" });
    expect(r.bandit.source).toBe("fallback");
    expect(["care", "ignore", "tease", "praise", "hurt", "promise"]).toContain(r.bandit.actionTag);
  });

  it("冲突情境回退到 care，夸奖情境回退到 praise", async () => {
    const rt = await open();
    const a = rt.turn({ text: "你根本不在乎我。", appraisal: SAD.appraisal }, { eventType: "争吵" });
    expect(a.bandit.actionTag).toBe("care");
    const b = rt.turn({ text: "你今天真好看", appraisal: HAPPY.appraisal }, { eventType: "夸我" });
    expect(b.bandit.actionTag).toBe("praise");
  });

  it("学到历史之后就不再回退（source=bandit）", async () => {
    const rt = await open();
    rt.turn({ text: "你好", appraisal: HAPPY.appraisal }, { eventType: "conversation", strategy: "care" });
    const r = rt.turn({ text: "在吗", appraisal: HAPPY.appraisal }, { eventType: "conversation", reaction: "安抚" });
    expect(r.bandit.source).toBe("bandit");
    expect(r.bandit.scored).toBe(true);
  });
});

describe("表达层（G5-③）：依恋 × 阶段 → 说话方式", () => {
  it("默认配置落 secure 象限，soul_turn 输出带 [expr] 行", async () => {
    const rt = await open();
    const r = rt.turn({ text: "你好", appraisal: HAPPY.appraisal });
    expect(r.expression.quadrant).toBe("secure");
    expect(r.expression.stage).toBe("stranger");
    expect(r.expression.source).toBe("table");
    const tools = buildTools(rt);
    const turnTool = tools.find((t) => t.name === "soul_turn");
    const out = String(await turnTool?.execute({ text: "你好" }));
    expect(out).toContain("[expr] quadrant=secure stage=stranger source=table");
    // F31：认不出的事件类型下发了 none 行（不是缺行，也不是瞎猜一个 key）
    expect(out).toContain("[event] none");
    expect(out).toMatch(/tone=.+move=.+avoid=/);
  });

  it("改依恋配置会换成另一象限的语气（配置驱动，不是写死）", async () => {
    conf = { ...conf, attachment: { anxiety: 0.7, avoidance: 0.7 } };
    const rt = await open();
    const r = rt.turn({ text: "你好", appraisal: HAPPY.appraisal });
    expect(r.expression.quadrant).toBe("fearful");
    expect(r.style.expressionStyle).toMatch(/tone=/);
    expect(r.expression.tone).not.toBe(EXPRESSION_TABLE.secure.stranger.tone);
  });

  it("soul_state 会显示象限，便于排查『为什么她这样说话』", async () => {
    const rt = await open();
    const tools = buildTools(rt);
    const stateTool = tools.find((t) => t.name === "soul_state");
    const out = String(await stateTool?.execute({}));
    expect(out).toContain("quadrant=secure");
  });

  it("表达提示与关系阶段一致：beloved 给亲密语气，stranger 给距离语气", async () => {
    const rt = await open();
    const near = { ...EXPRESSION_TABLE.secure.beloved.tone };
    const far = { ...EXPRESSION_TABLE.secure.stranger.tone };
    expect(near).not.toBe(far);
    expect(EXPRESSION_TABLE.secure.beloved.tone).toMatch(/坦率|脆弱/);
    expect(EXPRESSION_TABLE.secure.stranger.tone).toMatch(/稳|不急/);
    expect(rt.turn({ text: "在", appraisal: HAPPY.appraisal }).expression.stage).toBe("stranger");
  });
});

describe("好奇心（G5-④）：想弄清什么 + 污点", () => {
  it("压力高时她想知道你还在不在乎；输出带 [soul_curious] 头", async () => {
    const rt = await open();
    // 先压出压力：连续负面输入
    for (let i = 0; i < 3; i += 1) rt.turn({ text: SAD.text, appraisal: SAD.appraisal });
    const tool = buildTools(rt).find((d) => d.name === "soul_curious");
    const out = String(await tool?.execute({}));
    expect(out).toContain("[soul_curious] targets=");
    if (rt.state.pressure > 0.5) {
      expect(out).toContain("relationship_confirmation");
      expect(out).toMatch(/tainted=(true|false)/);
    }
    // D13：boredom 已废弃，缺 curiosity_gap 时必须写明跳过了哪条判据
    expect(out).toContain("[skipped]");
    expect(out).toMatch(/curiosity_gap 未提供/);
  });

  it("web 来源的目标（找乐子/随机探索）会把 curiosity 标脏并跨重启保留", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_curious");
    // 默认 energy=1 > 0.7 ⇒ funny_memes（来源 web）；gap=1/3 命中倒 U 峰值
    const out = String(await tool?.execute({ curiosity_gap: 1 / 3 }));
    expect(out).toContain("funny_memes");
    expect(out).toContain("tainted=true");

    const again = await open();
    expect(again.state.taintMap["curiosity"]?.state).toBe("tainted");
    expect(again.state.taintMap["curiosity"]?.sources).toEqual(["web"]);
  });

  it("contacts.pending_topic 生成 common_topic:<id>", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_curious");
    const out = String(await tool?.execute({ contacts: [{ id: "u1", pending_topic: true }, { id: "u2" }] }));
    expect(out).toContain("common_topic:u1");
    expect(out).not.toContain("common_topic:u2");
  });
});

describe("褪色与遗忘（G6-①）", () => {
  it("推进一天后鲜明度下降（0.5 → 0.5·2^-0.7）", async () => {
    const rt = await open();
    rt.remember({ content: "她记得那天很安静", source: "player", vividness: 0.5 });
    expect(rt.memoryStats().vividness).toBeCloseTo(0.5, 4);
    const r = rt.advance(24);
    expect(r.faded).toBe(1);
    expect(rt.memoryStats().vividness).toBeCloseTo(0.5 * Math.pow(2, -0.7), 3);
  });

  it("跌破阈值后标 forgotten：active 下降、total 不变、不再被召回", async () => {
    const rt = await open();
    rt.remember({ content: "一件很快会忘的小事", source: "player", vividness: 0.12 });
    expect(rt.memoryStats().active).toBe(1);
    const r = rt.advance(24);
    expect(r.forgotten).toBe(1);
    const after = rt.memoryStats();
    expect(after.active).toBe(0);
    expect(after.forgotten).toBe(1);
    expect(after.total).toBe(1);
    expect(rt.recall("小事")).toHaveLength(0);
  });

  it("召回会加强鲜明度并累加 access_count（§6.5 on_retrieve）", async () => {
    const rt = await open();
    rt.remember({ content: "关于安静的下午", source: "player", vividness: 0.4 });
    rt.recall("安静");
    expect(rt.memoryStats().vividness).toBeCloseTo(0.45, 4);
    rt.recall("安静");
    expect(rt.memoryStats().vividness).toBeCloseTo(0.5, 4);
  });

  it("advance(0) 或负值不衰减；faded 为 0", async () => {
    const rt = await open();
    rt.remember({ content: "刚刚发生的事", source: "player", vividness: 0.5 });
    expect(() => rt.advance(0)).toThrow(RangeError);
    expect(rt.memoryStats().vividness).toBeCloseTo(0.5, 4);
  });
});

describe("§6.7 冲突判定（soul_conflict）", () => {
  it("对已存在的记忆给出 INSIST/DOUBT，并标出权重来源与缺失字段", async () => {
    const rt = await open();
    const id = rt.remember({ content: "那天下午她说会等我。", source: "player" }).id;
    const tool = buildTools(rt).find((d) => d.name === "soul_conflict");
    const out = String(await tool?.execute({ memory_id: id }));
    expect(out).toContain("[soul_conflict]");
    expect(out).toMatch(/verdict=(INSIST|DOUBT)/);
    expect(out).toContain("weights=fallback");
    expect(out).toContain("missing=taboo_hit");
  });

  it("id 不存在时报错，而不是返回兜底判定", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_conflict");
    expect(() => tool?.execute({ memory_id: "nope" })).toThrow(/没有 id 为「nope」的记忆/);
  });
});

describe("§6.8 执念闯入（soul_obsess）", () => {
  it("线索不相关时 kind=none；高唤醒+高反刍+线索命中时可闯入", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_obsess");
    // 先把她推到高唤醒：正面输入几轮
    for (let i = 0; i < 4; i += 1) rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const id = rt.remember({ content: "那天下午她说会一直在窗边等我。", source: "player", tags: ["窗边"] }).id;

    const unrelated = String(await tool?.execute({ memory_id: id, query: "股票 报表" }));
    expect(unrelated).toContain("kind=none");
    expect(unrelated).toContain("applied=false");

    const related = String(await tool?.execute({ memory_id: id, query: "窗边 下午" }));
    expect(related).toMatch(/kind=(none|INTRUDE|MILD_REMIND)/);
    expect(related).toContain("missing=");
  });

  it("闯入时立即抬高 pressure 与 rumination（immediate 白名单）", async () => {
    const rt = await open();
    // 直接把反刍与情绪推高：连续强正面输入
    for (let i = 0; i < 6; i += 1) rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const id = rt.remember({ content: "她说会一直在窗边等我。", source: "player", tags: ["窗边"] }).id;
    const tool = buildTools(rt).find((d) => d.name === "soul_obsess");
    const before = { p: rt.state.pressure, r: rt.state.rumination };
    const out = String(await tool?.execute({ memory_id: id, query: "窗边" }));
    if (out.includes("kind=INTRUDE")) {
      expect(rt.state.pressure).toBeGreaterThan(before.p);
      expect(rt.state.rumination).toBeGreaterThan(before.r);
      expect(out).toContain("applied=true");
    } else {
      // 未触发是合法结果，但不能是"报错或崩溃"
      expect(out).toContain("[soul_obsess]");
    }
  });

  it("id 不存在时报错", async () => {
    const rt = await open();
    const tool = buildTools(rt).find((d) => d.name === "soul_obsess");
    expect(() => tool?.execute({ memory_id: "nope", query: "窗边" })).toThrow(/没有 id 为「nope」的记忆/);
  });
});

describe("§6.5 蔡格尼克：反复想起会累积 unresolved_score", () => {
  it("情绪同向的回忆每次 +UNRESOLVED_GAIN，并封顶 1", async () => {
    const rt = await open();
    // 把她推到正价（encode_state.valence > 0.5），这样同向判定成立
    for (let i = 0; i < 4; i += 1) rt.turn({ text: HAPPY.text, appraisal: HAPPY.appraisal });
    const id = rt.remember({ content: "她说会一直在窗边等我。", source: "player", tags: ["窗边"] }).id;

    const before = rt.memoryById(id).unresolved_score;
    for (let i = 0; i < 3; i += 1) rt.recall("窗边");
    const after = rt.memoryById(id).unresolved_score;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1);

    for (let i = 0; i < 15; i += 1) rt.recall("窗边");
    expect(rt.memoryById(id).unresolved_score).toBe(1);
  });
});

describe("G6-⑤ §6.5 压制：更强的记忆会把同标签的弱记忆压下去", () => {
  it("写入更强的一条后，旧的那条被标 suppressed、不再出现在 active 里", async () => {
    const rt = await open();
    const weak = rt.remember({ content: "她说下午会来。", source: "player", tags: ["下午"], vividness: 0.3 });
    const weakBefore = rt.memoryById(weak.id);
    expect(weakBefore.suppressed_by_stronger).toBe(false);

    const strong = rt.remember({ content: "她下午一直站在窗边等我，风很冷也没走。", source: "player", tags: ["下午"], vividness: 0.95 });
    const weakAfter = rt.memoryById(weak.id);
    expect(weakAfter.suppressed_by_stronger).toBe(true);
    expect(weakAfter.suppression_strength).toBeGreaterThan(0);
    // 被压制的不是删除：记录还在，只是不参与检索
    expect(rt.memoryById(strong.id).suppressed_by_stronger).toBe(false);
    expect(rt.snapshot()).toBeDefined();

    const stats = rt.memoryStats();
    expect(stats.total).toBe(2);
    expect(stats.suppressed).toBe(1);

    // active 名单里没有它 ⇒ 召回也召不到
    const hits = rt.recall("下午", 5).map((r) => r.id);
    expect(hits).not.toContain(weak.id);
  });

  it("平手的重复写入不压制任何一方（两条都留着）", async () => {
    const rt = await open();
    const a = rt.remember({ content: "她下午会来。", source: "player", tags: ["下午"], vividness: 0.5 });
    const b = rt.remember({ content: "她下午可能会来。", source: "player", tags: ["下午"], vividness: 0.5 });
    expect(rt.memoryById(a.id).suppressed_by_stronger).toBe(false);
    expect(rt.memoryById(b.id).suppressed_by_stronger).toBe(false);
    expect(rt.memoryStats().suppressed).toBe(0);
  });

  it("不同标签的记忆互不影响", async () => {
    const rt = await open();
    const weak = rt.remember({ content: "晚饭吃了面。", source: "player", tags: ["晚饭"], vividness: 0.2 });
    rt.remember({ content: "窗边那天风很大，她站了很久。", source: "player", tags: ["窗边"], vividness: 0.95 });
    expect(rt.memoryById(weak.id).suppressed_by_stronger).toBe(false);
  });
});

describe("G6-⑥ §6.6 预筛：召回先分区再截断", () => {
  it("prefilterInfo 报告池大小与截断数（记忆少时 dropped=0）", async () => {
    const rt = await open();
    rt.remember({ content: "窗边 下午", source: "player", tags: ["窗边"] });
    const info = rt.prefilterInfo("窗边");
    expect(info.poolSize).toBe(1);
    expect(info.candidates).toBe(1);
    expect(info.dropped).toBe(0);
  });

  it("候选池 = 本渠道可见记忆（分区的运行时侧一致性）", async () => {
    const rt = await open();
    rt.remember({ content: "窗边 下午", source: "player", tags: ["窗边"] });
    rt.remember({ content: "晚饭吃了面。", source: "player", tags: ["晚饭"] });
    // 插件写记忆时固定 encode_ctx.channel="gui"，所以池大小应等于 active 数
    const info = rt.prefilterInfo("窗边");
    expect(info.poolSize).toBe(rt.memoryStats().active);
    expect(info.candidates).toBe(info.poolSize);
  });
});

describe("记忆 id 唯一性（回归：同毫秒连写会丢记忆）", () => {
  it("冻结时钟下连写 50 条，id 全不相同且一条不少", async () => {
    const rt = await open();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const r = rt.remember({ content: `同一毫秒里的第 ${i + 1} 条`, tags: ["burst"] });
      expect(r.stored).toBe(true);
      ids.add(r.id);
    }
    // 原来的 id 只有 1296 种取值，冻结时钟下 50 条几乎必然撞 id → 覆盖 → 条数变少
    expect(ids.size).toBe(50);
    expect(rt.memoryStats().total).toBe(50);
  });
});

describe("人格卡的阶段语气接进工具输出（F37）", () => {
  it("配置了 stageStyle 后，[stage-style] 用的是人格卡的文案而不是内置梯度", async () => {
    const persona = parsePersona({
      name: "AI助手",
      description: "测试用卡",
      stageStyle: { stranger: "热情但不越界：主动搭话，称呼用「你」" },
    });
    const rt = await SoulRuntime.open({ ...conf, persona }, clock);
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const text = await turn!.execute({ text: "你好呀", goal_congruence: 0.5, goal_relevance: 0.5 });
    expect(text).toContain("[stage-style] 热情但不越界");
    expect(text).not.toContain("客气、保持距离、用敬称");
  });

  it("没配置人格卡时保持内置梯度（默认角色不受影响）", async () => {
    const rt = await open();
    const turn = buildTools(rt).find((d) => d.name === "soul_turn");
    const text = await turn!.execute({ text: "你好", goal_congruence: 0.5, goal_relevance: 0.5 });
    expect(text).toContain("[stage-style] 客气、保持距离、用敬称");
  });
});
