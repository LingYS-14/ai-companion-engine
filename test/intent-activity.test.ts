import { describe, expect, it } from "vitest";
import { buildActivityReport, describeActivity } from "../src/orchestrator/intent/activity.js";
import { newIntention, markBlocked } from "../src/orchestrator/intent/bus.js";
import type { ActivityTick } from "../src/orchestrator/intent/activity.js";
import type { GapProbe } from "../src/orchestrator/intent/capability-signal.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function tick(overrides: Partial<ActivityTick> = {}): ActivityTick {
  return {
    at: NOW - HOUR,
    gate: "speak",
    outlet: "speak",
    wouldSpeak: true,
    emitted: [],
    top: null,
    replay: 0,
    ...overrides,
  };
}

function intention(kind: "reach_out" | "explore" | "idle" = "reach_out", atMs = NOW - 2 * HOUR) {
  return newIntention({
    id: `itn-${kind}-${String(atMs)}`,
    at: new Date(atMs).toISOString(),
    kind,
    goal: `做点 ${kind} 的事`,
    why: "缺口变大",
  });
}

function probe(overrides: Partial<GapProbe> = {}): GapProbe {
  return {
    kind: "explore",
    missingFamily: "read",
    attempts: 2,
    firstAtMs: NOW - 3 * 86_400_000,
    lastAtMs: NOW - HOUR,
    desire: 0.4,
    ...overrides,
  };
}

function base(overrides: Partial<Parameters<typeof buildActivityReport>[0]> = {}) {
  return buildActivityReport({
    generatedAtMs: NOW,
    ticks: [],
    intentions: [],
    gapProbes: [],
    asks: { asked: 0, lastAtMs: null },
    guardian: { requests: 0, replies: 0 },
    workingSelf: null,
    reconsolidationPatches: 0,
    ...overrides,
  });
}

describe("§9 一昼夜活动一页纸（F211）", () => {
  it("只统计最近 24 小时；窗口外的不算但文件里留着", () => {
    const report = buildActivityReport({
      ...{
        generatedAtMs: NOW,
        ticks: [tick({ at: NOW - 30 * HOUR }), tick({ at: NOW - HOUR }), tick({ at: NOW + HOUR })],
        intentions: [],
        gapProbes: [],
        asks: { asked: 0, lastAtMs: null },
        guardian: { requests: 0, replies: 0 },
        workingSelf: null,
        reconsolidationPatches: 0,
      },
    });
    expect(report.windowTicks).toBe(1);
  });

  it("没有拍样本时明说没有，不填 0", () => {
    const report = base();
    expect(report.lines.join("\n")).toContain("最近 24 小时没有真实拍样本");
  });

  it("统计闸/出口/想开口比例/浮现类别/回放条数", () => {
    const report = base({
      ticks: [
        tick({ gate: "quota", outlet: "journal", wouldSpeak: false, emitted: [], replay: 1 }),
        tick({ gate: "quota", outlet: "journal", wouldSpeak: false, emitted: [] }),
        tick({ gate: "speak", outlet: "speak", wouldSpeak: true, emitted: ["explore"], replay: 2 }),
      ],
    });
    const text = report.lines.join("\n");
    expect(text).toContain("3 拍");
    expect(text).toContain("想开口 1 次（33%）");
    expect(text).toContain("journal×2 / speak×1");
    expect(text).toContain("quota×2 / speak×1");
    expect(text).toContain("explore×1");
    expect(text).toContain("回放线程共 3 条");
  });

  it("额度闸占一半以上时提醒「不是不想说，是额度用完」", () => {
    const report = base({
      ticks: [tick({ gate: "quota", wouldSpeak: false }), tick({ gate: "quota", wouldSpeak: false })],
    });
    expect(report.warnings.some((warning) => warning.includes("额度"))).toBe(true);
  });

  it("一整窗都没有想开口时给出提示（样本足够才提示）", () => {
    const quiet = Array.from({ length: 12 }, () => tick({ wouldSpeak: false }));
    const report = base({ ticks: quiet });
    expect(report.warnings.some((warning) => warning.includes("该开口"))).toBe(true);
    const few = base({ ticks: quiet.slice(0, 3) });
    expect(few.warnings.some((warning) => warning.includes("该开口"))).toBe(false);
  });

  it("意图表：开着的条数、被谁拦下、最旧一条多久", () => {
    const blocked = markBlocked(intention("reach_out", NOW - 5 * HOUR), "quota");
    const report = base({ intentions: [blocked, intention("explore", NOW - HOUR)] });
    const text = report.lines.join("\n");
    expect(text).toContain("2 条开着");
    expect(text).toContain("被拦 1 条");
    expect(text).toContain("quota×1");
    expect(text).toContain("最旧一条 5.0 小时");
  });

  it("没有意图表记录时明说，不假装 0 条开着", () => {
    expect(base().lines.join("\n")).toContain("还没有记录");
  });

  it("有够格缺口但一次都没求助时提醒发射端可能没接上", () => {
    const report = base({ gapProbes: [probe({ attempts: 2 })] });
    expect(report.warnings.some((warning) => warning.includes("发射端"))).toBe(true);
    const asked = base({ gapProbes: [probe()], asks: { asked: 1, lastAtMs: NOW - HOUR } });
    expect(asked.warnings.some((warning) => warning.includes("发射端"))).toBe(false);
  });

  it("缺口按天排：最久的写出来", () => {
    const report = base({
      gapProbes: [probe({ attempts: 4 }), probe({ kind: "create", missingFamily: "write", attempts: 2 })],
    });
    expect(report.lines.join("\n")).toContain("explore/read×4天");
  });

  it("求助历史与收件箱；有请求没应答时提醒去看 guardian list", () => {
    const report = base({
      asks: { asked: 2, lastAtMs: NOW - 2 * HOUR },
      guardian: { requests: 2, replies: 0 },
    });
    const text = report.lines.join("\n");
    expect(text).toContain("问过 2 次");
    expect(text).toContain("收件箱 2 条，已回 0 条");
    expect(report.warnings.some((warning) => warning.includes("intent:guardian list"))).toBe(true);
  });

  it("working self 状态：没有文件说没有文件，有就报 streak 与放宽倍数", () => {
    expect(base().lines.join("\n")).toContain("还没有状态文件");
    const report = base({ workingSelf: { lowConcretenessStreak: 7, relaxFactor: 1.2 } });
    expect(report.lines.join("\n")).toContain("连续 7 次，门槛放宽 ×1.2");
  });

  it("再巩固补丁条数照实报", () => {
    expect(base({ reconsolidationPatches: 3 }).lines.join("\n")).toContain("已写 3 条解释补丁");
  });

  it("非法时间戳抛错，不静默算成 1970", () => {
    expect(() => buildActivityReport({
      generatedAtMs: Number.NaN,
      ticks: [],
      intentions: [],
      gapProbes: [],
      asks: { asked: 0, lastAtMs: null },
      guardian: { requests: 0, replies: 0 },
      workingSelf: null,
      reconsolidationPatches: 0,
    })).toThrow(RangeError);
  });

  it("一行摘要取 tick 那行（给早报/日志复用）", () => {
    const report = base({ ticks: [tick()] });
    expect(describeActivity(report)).toContain("[tick] 1 拍");
  });
});

describe("跨天趋势（F233）", () => {
  it("按 UTC 天分桶：今天的拍不会把昨天的算进来", () => {
    const report = base({
      ticks: [
        tick({ at: NOW - 30 * HOUR, gate: "quota", wouldSpeak: false }),
        tick({ at: NOW - 29 * HOUR, gate: "quota", wouldSpeak: false }),
        tick({ at: NOW - HOUR, gate: "speak", wouldSpeak: true }),
      ],
    });
    expect(report.trend).toHaveLength(2);
    expect(report.trend[0]).toMatchObject({ ticks: 2, wouldSpeak: 0, quota: 2 });
    expect(report.trend[1]).toMatchObject({ ticks: 1, wouldSpeak: 1, quota: 0 });
    const text = report.lines.join("\n");
    expect(text).toContain("[趋势]");
    expect(text).toContain("只报数，不下结论");
  });

  it("只有一天样本时明说还看不出趋势（不编）", () => {
    const report = base({ ticks: [tick({ at: NOW - HOUR })] });
    expect(report.trend).toHaveLength(1);
    expect(report.lines.join("\n")).toContain("只有一天样本");
  });

  it("窗口外的老样本不会复活（超过 trendDays 的天直接丢）", () => {
    const report = base({
      trendDays: 2,
      ticks: [tick({ at: NOW - 5 * DAY }), tick({ at: NOW - HOUR })],
    });
    expect(report.trend).toHaveLength(1);
  });

  it("trendDays 非法抛 RangeError；未来时间的拍不计入趋势", () => {
    expect(() => base({ trendDays: 0 })).toThrow(RangeError);
    expect(() => base({ trendDays: 2.5 })).toThrow(RangeError);
    expect(() => base({ trendDays: 20 })).toThrow(RangeError);
    const report = base({ ticks: [tick({ at: NOW + HOUR })] });
    expect(report.trend).toHaveLength(0);
  });

  it("F236：最近 1 小时单独一行——只数这一小时内的拍，且给出闸的分布", () => {
    const report = base({
      ticks: [
        tick({ at: NOW - 10 * 60_000, gate: "speak", outlet: "speak", wouldSpeak: true }),
        tick({ at: NOW - 20 * 60_000, gate: "quota", outlet: "journal", wouldSpeak: false }),
        tick({ at: NOW - 50 * 60_000, gate: "quota", outlet: "journal", wouldSpeak: false }),
        tick({ at: NOW - 3 * HOUR, gate: "quota", outlet: "journal", wouldSpeak: false }),
      ],
    });
    const text = report.lines.join("\n");
    expect(text).toContain("· [最近 1 小时] 3 拍；想开口 1 次；闸：quota×2 / speak×1");
    // 24h 统计不受影响：仍然把窗口外那条 3 小时前的拍算进去
    expect(text).toContain("· [tick] 4 拍");
    expect(report.recentTicks).toBe(3);
  });

  it("F236：最近 1 小时内没有样本时不出现这一行（不写「0 拍」假装有数据）", () => {
    const report = base({ ticks: [tick({ at: NOW - 2 * HOUR })] });
    expect(report.lines.join("\n")).not.toContain("最近 1 小时");
    expect(report.recentTicks).toBe(0);
  });
});

describe("F247 重提旧话：和 tick 自己的判定分开统计", () => {
  it("重提的拍单独说明，不然「想开口 0 次」会和真实的开口对不上", () => {
    const report = base({
      ticks: [
        tick({ wouldSpeak: false, reRaised: true }),
        tick({ wouldSpeak: false, reRaised: true }),
        tick({ wouldSpeak: false }),
      ],
    });
    const text = report.lines.join("\n");
    expect(text).toContain("想开口 0 次");
    expect(text).toContain("其中重提旧话 2 次");
  });

  it("只有重提、没有 tick 自己的 wouldSpeak 时，不报「一次也没到该开口」", () => {
    const report = base({
      ticks: Array.from({ length: 12 }, () => tick({ wouldSpeak: false, reRaised: true })),
    });
    expect(report.warnings.join("\n")).not.toContain("一次也没到");
  });
});

describe("真发出的消息（F251：日志口径，与 tick 判定分开）", () => {
  const base = (sends: unknown) => ({
    generatedAtMs: NOW,
    ticks: [tick()],
    intentions: [],
    gapProbes: [],
    asks: { asked: 0, lastAtMs: null },
    guardian: { requests: 0, replies: 0 },
    workingSelf: null,
    reconsolidationPatches: 0,
    sends,
  });

  it("分桶写进一页纸：由意图决定/非 speak 类/闸放行即发/旧路径", () => {
    const report = buildActivityReport(
      base({ total: 22, byIntent: 2, byNonSpeakOutlet: 5, byGateOnly: 11, byLegacy: 4 }) as never,
    );
    const line = report.lines.find((l) => l.startsWith("· [发送]"));
    expect(line).toBeDefined();
    expect(line).toContain("真发出 22 条");
    expect(line).toContain("由意图决定 2");
    expect(line).toContain("意图非 speak 类 5");
    expect(line).toContain("闸放行即发 11");
    expect(line).toContain("旧路径 4");
  });

  it("一条也不是意图决定的 → 警告接线可能退化", () => {
    const report = buildActivityReport(
      base({ total: 8, byIntent: 0, byNonSpeakOutlet: 0, byGateOnly: 8, byLegacy: 0 }) as never,
    );
    expect(report.warnings.some((w) => w.includes("speak 出口"))).toBe(true);
  });

  it("旧路径太多 → 警告 A4 守卫可能失效", () => {
    const report = buildActivityReport(
      base({ total: 6, byIntent: 1, byNonSpeakOutlet: 0, byGateOnly: 0, byLegacy: 5 }) as never,
    );
    expect(report.warnings.some((w) => w.includes("旧主动路径"))).toBe(true);
  });

  it("没有发出任何消息时明说，不给零分桶", () => {
    const report = buildActivityReport(
      base({ total: 0, byIntent: 0, byNonSpeakOutlet: 0, byGateOnly: 0, byLegacy: 0 }) as never,
    );
    const line = report.lines.find((l) => l.startsWith("· [发送]"));
    expect(line).toContain("没有真发出任何消息");
    expect(report.warnings.some((w) => w.includes("speak 出口"))).toBe(false);
  });

  it("不传 sends 时不出这一行（旧调用方零变化）", () => {
    const report = buildActivityReport(base(undefined) as never);
    expect(report.lines.some((l) => l.startsWith("· [发送]"))).toBe(false);
  });

  it("F252：由意图决定的几条能按 kind 回溯（验收 §7.2）", () => {
    const report = buildActivityReport(
      base({
        total: 3,
        byIntent: 2,
        byNonSpeakOutlet: 0,
        byGateOnly: 1,
        byLegacy: 0,
        byKind: { reach_out: 1, continue_thread: 1 },
      }) as never,
    );
    const line = report.lines.find((l) => l.startsWith("· [发送·kind]"));
    expect(line).toBeDefined();
    expect(line).toContain("reach_out 1");
    expect(line).toContain("continue_thread 1");
  });

  it("F252：由意图决定但日志没有 kind → 警告接线退化", () => {
    const report = buildActivityReport(
      base({ total: 2, byIntent: 2, byNonSpeakOutlet: 0, byGateOnly: 0, byLegacy: 0 }) as never,
    );
    expect(report.warnings.some((w) => w.includes("没有 kind"))).toBe(true);
    expect(report.lines.some((l) => l.startsWith("· [发送·kind]"))).toBe(false);
  });
});

describe("日志口径解析（tools/intent/activity.mjs 的 summarizeSendsFromLog）", () => {
  it("按 intent= 分四桶，并只数 reason=spoke 且 24 小时内的行", async () => {
    const { summarizeSendsFromLog } = (await import("../tools/intent/activity.mjs")) as {
      summarizeSendsFromLog: (text: string, nowMs: number) => {
        total: number;
        byIntent: number;
        byNonSpeakOutlet: number;
        byGateOnly: number;
        byLegacy: number;
      };
    };
    const iso = new Date(NOW - HOUR).toISOString();
    const old = new Date(NOW - 30 * HOUR).toISOString();
    const lines = [
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=reach_out reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:journal reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:idle reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke intent=gate:true reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke reply=…`,
      `${iso} [autonomy] proactive opened=false reason=outlet（不是发送）`,
      `${iso} [autonomy] selftalk 说了一句 reason=spoke`,
      `${old} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=reach_out reply=…`,
    ].join("\n");
    const buckets = summarizeSendsFromLog(lines, NOW);
    expect(buckets.total).toBe(5);
    expect(buckets.byIntent).toBe(1);
    expect(buckets.byNonSpeakOutlet).toBe(2);
    expect(buckets.byGateOnly).toBe(1);
    expect(buckets.byLegacy).toBe(1);
  });

  it("F252：由 speak 出口决定的发送带 kind 时，按 kind 分桶（旧行 kind=none 不算）", async () => {
    const { summarizeSendsFromLog } = (await import("../tools/intent/activity.mjs")) as {
      summarizeSendsFromLog: (
        text: string,
        nowMs: number,
      ) => { byIntent: number; byKind: Record<string, number> };
    };
    const iso = new Date(NOW - HOUR).toISOString();
    const lines = [
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=reach_out reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=continue_thread reply=…`,
      `${iso} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=none reply=…`,
    ].join("\n");
    const buckets = summarizeSendsFromLog(lines, NOW);
    expect(buckets.byIntent).toBe(3);
    expect(buckets.byKind).toEqual({ reach_out: 1, continue_thread: 1 });
  });

  it("R8：F278 起的秒级时间戳行也要计入（旧 slice(0, 24) 会把它漏掉）", async () => {
    const { summarizeSendsFromLog } = (await import("../tools/intent/activity.mjs")) as {
      summarizeSendsFromLog: (text: string, nowMs: number) => { total: number; byIntent: number; byGateOnly: number };
    };
    // 毫秒 ISO → 秒级 ISO：2026-10-31T18:14:12.345Z 去掉 .345（F278 之后日志就是这种形态）
    const sec = new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    const lines = [
      `${sec} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=reach_out reply=…`,
      `${sec} [autonomy] proactive opened=true reason=spoke intent=gate:true reply=…`,
    ].join("\n");
    const buckets = summarizeSendsFromLog(lines, NOW);
    expect(buckets.total).toBe(2);
    expect(buckets.byIntent).toBe(1);
    expect(buckets.byGateOnly).toBe(1);
  });

  it("R8：intent=none 单列进 byNoIntent，只有行里没有 intent= 才算旧路径", async () => {
    const { summarizeSendsFromLog } = (await import("../tools/intent/activity.mjs")) as {
      summarizeSendsFromLog: (
        text: string,
        nowMs: number,
      ) => { total: number; byNoIntent: number; byLegacy: number; byGateOnly: number };
    };
    const sec = new Date(NOW - HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    const lines = [
      `${sec} [autonomy] proactive opened=true reason=spoke intent=none reply=…`,
      `${sec} [autonomy] proactive opened=true reason=spoke reply=…`,
      `${sec} [autonomy] proactive opened=true reason=spoke intent=gate:true reply=…`,
    ].join("\n");
    const buckets = summarizeSendsFromLog(lines, NOW);
    expect(buckets.total).toBe(3);
    expect(buckets.byNoIntent).toBe(1);
    expect(buckets.byLegacy).toBe(1);
    expect(buckets.byGateOnly).toBe(1);
  });
});
