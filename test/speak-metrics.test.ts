import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpeakSnapshot,
  compareTimeClaims,
  extractTimeClaims,
  formatSpeakLog,
  logProactiveTimeClaims,
  type SpeakSnapshot,
} from "../src/orchestrator/intent/speak-metrics.js";
import { buildTemporalSnapshot } from "../src/orchestrator/intent/temporal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 10, 3, 15, 50); // 北京 2026-11-03 23:50
const TZ = 480;

function snap(over: Partial<Parameters<typeof buildSpeakSnapshot>[0]> = {}): SpeakSnapshot {
  return buildSpeakSnapshot({
    nowMs: NOW,
    tzOffsetMinutes: TZ,
    awakeForHours: 2.25,
    sinceLastUserMsgMin: 12.4,
    sinceLastOwnMsgMin: 5,
    lastSleepAtMs: NOW - 8 * 3_600_000,
    presenceActive: true,
    ...over,
  });
}

describe("S3b/M5：说话时刻快照（纯函数，零 IO）", () => {
  it("本地时刻 + 偏移写进 localIso，数值字段原样进入快照", () => {
    const s = snap();
    expect(s.localIso).toBe("2026-11-03T23:50+0800");
    expect(s.localHour).toBe(23);
    expect(s.localMinute).toBe(50);
    expect(s.awakeForHours).toBe(2.25);
    expect(s.sinceLastUserMsgMin).toBe(12.4);
    expect(s.sinceLastOwnMsgMin).toBe(5);
    expect(s.presenceActive).toBe(true);
  });

  it("缺的字段给 null（不猜）；非布尔 presence 也归 null", () => {
    const s = buildSpeakSnapshot({
      nowMs: NOW,
      tzOffsetMinutes: -300,
      awakeForHours: null,
      sinceLastUserMsgMin: undefined,
      presenceActive: null,
    } as never);
    expect(s.localIso).toBe("2026-11-03T10:50-0500");
    expect(s.awakeForHours).toBeNull();
    expect(s.sinceLastUserMsgMin).toBeNull();
    expect(s.sinceLastOwnMsgMin).toBeNull();
    expect(s.presenceActive).toBeNull();
  });

  it("nowMs/tz 非法直接抛（装配层参数错误不该被吞）", () => {
    expect(() => buildSpeakSnapshot({ nowMs: Number.NaN, tzOffsetMinutes: TZ })).toThrow(RangeError);
    expect(() => buildSpeakSnapshot({ nowMs: NOW, tzOffsetMinutes: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("S3b/M5：时间表述提取（只认明确说法）", () => {
  it("「现在是 15 点」「现在 9 点了」都识别成 hour", () => {
    expect(extractTimeClaims("现在是 15 点，天色正好").claims).toEqual([{ kind: "hour", value: 15 }]);
    expect(extractTimeClaims("现在 9 点了，他该醒了吧").claims).toEqual([{ kind: "hour", value: 9 }]);
  });

  it("「3 小时没见了」「2 天没有联系」换算成分钟 elapsed", () => {
    expect(extractTimeClaims("你都 3 小时没见了，忙什么呢").claims).toEqual([{ kind: "elapsed", value: 180 }]);
    expect(extractTimeClaims("我们 2 天没有联系了").claims).toEqual([{ kind: "elapsed", value: 2880 }]);
  });

  it("没有「没/没有」的时间量不猜（不是距上次联系）", () => {
    const result = extractTimeClaims("刚才 3 小时聊了很多，现在 7 点了吧");
    expect(result.claims).toEqual([{ kind: "hour", value: 7 }]);
    expect(result.unverified).toBe(1);
  });

  it("坏表述只记 unverified，不产出 claim", () => {
    expect(extractTimeClaims("现在是 25 点").claims).toEqual([]);
    expect(extractTimeClaims("现在是 25 点").unverified).toBe(1);
    expect(extractTimeClaims("0 分钟没有联系").unverified).toBe(1);
    expect(extractTimeClaims("")).toEqual({ claims: [], unverified: 0 });
  });

  it("同句多个表述全部提取", () => {
    const { claims } = extractTimeClaims("现在是 23 点，你都 1 小时没见了");
    expect(claims).toEqual([
      { kind: "hour", value: 23 },
      { kind: "elapsed", value: 60 },
    ]);
  });
});

describe("S3b/M5：与快照比对（缺基准不冤枉）", () => {
  it("24h 制钟点：±1h 内一致，超过就 mismatch", () => {
    const s = buildSpeakSnapshot({ nowMs: NOW, tzOffsetMinutes: TZ }); // 23:50
    expect(compareTimeClaims([{ kind: "hour", value: 23 }], s)).toEqual({
      claims: 1,
      verifiable: 1,
      mismatch: 0,
      unverified: 0,
    });
    expect(compareTimeClaims([{ kind: "hour", value: 22 }], s).mismatch).toBe(0);
    expect(compareTimeClaims([{ kind: "hour", value: 21 }], s).mismatch).toBe(1);
    expect(compareTimeClaims([{ kind: "hour", value: 0 }], s).mismatch).toBe(0); // 圆环：23:50→00:00 只差 10 分钟
  });

  it("12 小时制歧义（1..12 点）记 unverified，不进分母", () => {
    const s = snap();
    expect(compareTimeClaims([{ kind: "hour", value: 7 }], s)).toEqual({
      claims: 1,
      verifiable: 0,
      mismatch: 0,
      unverified: 1,
    });
  });

  it("elapsed：容差 max(10min, 20%)", () => {
    const s = snap({ sinceLastUserMsgMin: 60 });
    expect(compareTimeClaims([{ kind: "elapsed", value: 65 }], s).mismatch).toBe(0);
    expect(compareTimeClaims([{ kind: "elapsed", value: 80 }], s).mismatch).toBe(1); // 20 > max(10,12)
    const fresh = snap({ sinceLastUserMsgMin: 3 });
    expect(compareTimeClaims([{ kind: "elapsed", value: 20 }], fresh).mismatch).toBe(1); // 17 > 10
    expect(compareTimeClaims([{ kind: "elapsed", value: 12 }], fresh).mismatch).toBe(0); // 9 <= 10
  });

  it("没有 peer 基准时 elapsed 记 unverified（不猜）", () => {
    const s = snap({ sinceLastUserMsgMin: null });
    expect(compareTimeClaims([{ kind: "elapsed", value: 60 }], s)).toEqual({
      claims: 1,
      verifiable: 0,
      mismatch: 0,
      unverified: 1,
    });
  });
});

describe("S3b/M5：日志行（不含原文）", () => {
  it("formatSpeakLog 只给计数/时长大数/本机时刻", () => {
    const s = snap({ awakeForHours: 2.25, sinceLastUserMsgMin: 12.4 });
    const line = formatSpeakLog("autonomy", s, {
      claims: 3,
      verifiable: 2,
      mismatch: 1,
      unverified: 1,
    });
    expect(line).toBe(
      "[time-claim] ch=autonomy claims=3 verifiable=2 mismatch=1 unverified=1 snap=2026-11-03T23:50+0800/awake=2.3/peer=12min",
    );
    expect(line).not.toContain("现在是");
    expect(line).not.toContain("他");
  });
});

describe("S3b/M5：主动开口日志（F352 抽成可单测的编排）", () => {
  const temporal = (over: Partial<Parameters<typeof buildTemporalSnapshot>[0]> = {}) =>
    buildTemporalSnapshot({
      nowMs: NOW,
      tzOffsetMinutes: TZ,
      sinceLastUserMsgMin: 120,
      sinceLastOwnMsgMin: 5,
      awakeSinceMs: NOW - 2 * 3_600_000,
      presence: { atMs: NOW - 60_000, active: true, ttlMs: 600_000 },
      ...over,
    });

  it("有本拍快照且有明确时间表述 → 落一行 ch=autonomy（不含原文）", () => {
    const lines: string[] = [];
    logProactiveTimeClaims({
      reply: "现在是 23 点，你都 2 小时没见了",
      temporal: temporal(),
      tzOffsetMinutes: TZ,
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[time-claim] ch=autonomy");
    expect(lines[0]).toContain("claims=2");
    expect(lines[0]).toContain("snap=2026-11-03T23:50+0800");
    expect(lines[0]).not.toContain("现在是");
  });

  it("没有本拍快照 → 不落（不补造）", () => {
    const lines: string[] = [];
    logProactiveTimeClaims({
      reply: "现在是 23 点",
      temporal: undefined,
      tzOffsetMinutes: TZ,
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([]);
  });

  it("没有明确时间表述 → 不落", () => {
    const lines: string[] = [];
    logProactiveTimeClaims({
      reply: "窗边那道光好像又亮了一点",
      temporal: temporal(),
      tzOffsetMinutes: TZ,
      log: (line) => lines.push(line),
    });
    expect(lines).toEqual([]);
  });

  it("与快照不一致 → mismatch=1", () => {
    const lines: string[] = [];
    logProactiveTimeClaims({
      reply: "现在是 21 点",
      temporal: temporal(),
      tzOffsetMinutes: TZ,
      log: (line) => lines.push(line),
    });
    expect(lines[0]).toContain("mismatch=1");
  });

  it("内部抛错（坏时区）→ 记 failed，不向上抛", () => {
    const lines: string[] = [];
    expect(() =>
      logProactiveTimeClaims({
        reply: "现在是 23 点",
        temporal: temporal(),
        tzOffsetMinutes: Number.NaN,
        log: (line) => lines.push(line),
      }),
    ).not.toThrow();
    expect(lines).toEqual(["[time-claim] failed"]);
  });
});

describe("S3b/M5：接线源码锁", () => {
  const main = readFileSync(join(HERE, "..", "scripts", "autonomy", "main.mjs"), "utf8");
  const qqRunner = readFileSync(join(HERE, "..", "src", "autonomy", "qq-runner.ts"), "utf8");
  const chatTurn = readFileSync(join(HERE, "..", "src", "autonomy", "chat-turn.ts"), "utf8");
  const onebot = readFileSync(join(HERE, "..", "src", "qq", "onebot-bridge.ts"), "utf8");
  const qqWiring = readFileSync(join(HERE, "..", "src", "assembly", "qq-wiring.ts"), "utf8");

  it("主动开口只在自己真的说出口后落日志，且用同一拍快照（F352 作用域修复）", () => {
    // 逻辑在 speak-metrics（可单测），装配层只传本拍快照。
    expect(main).toContain("logProactiveTimeClaims({");
    expect(main).toContain("temporal: beatTemporal,");
    // F352 根因锁：proactiveImpl 里不能再裸引 intentTickImpl 作用域的 `temporal`
    // （两个函数是不同闭包，.mjs 不过 tsc → 线上 ReferenceError）。
    const proactiveStart = main.indexOf("proactiveImpl:");
    const proactiveEnd = main.indexOf("intentNoteImpl", proactiveStart);
    expect(proactiveStart).toBeGreaterThan(0);
    expect(proactiveEnd).toBeGreaterThan(proactiveStart);
    const proactiveBody = main.slice(proactiveStart, proactiveEnd);
    expect(proactiveBody).not.toContain("temporal.");
    expect(proactiveBody).not.toContain("temporal !== undefined");
    // 允许 `temporal: beatTemporal`（读共享变量），但仍要拦住 `temporal: temporal`（裸引）。
    expect(proactiveBody).not.toMatch(/temporal:\s*temporal\b/);
    // 快照必须在 main() 作用域声明、每拍清空、tick 算完再赋给共享变量。
    expect(main).toContain("let beatTemporal;");
    expect(main).toContain("beatTemporal = undefined;");
    expect(main).toContain("beatTemporal = temporal;");
    // 顺序锁：先清空、后赋值（防止实现把两行写反后 proactive 仍可能读到上一拍）。
    const clearedAt = main.indexOf("beatTemporal = undefined;");
    const assignedAt = main.indexOf("beatTemporal = temporal;");
    expect(clearedAt).toBeGreaterThan(0);
    expect(assignedAt).toBeGreaterThan(clearedAt);
  });

  it("AutonomyLoop 有重入闸（F352 B1：上一拍没结束不许下一拍动共享快照）", () => {
    const loopSrc = readFileSync(join(HERE, "..", "src", "autonomy", "loop.ts"), "utf8");
    expect(loopSrc).toContain("if (this.inFlight)");
    expect(loopSrc).toContain("this.inFlight = true;");
    expect(loopSrc).toContain("this.inFlight = false;");
    expect(loopSrc).toContain('reason: "busy"');
  });

  it("QQ 回信在 qq-runner 注入 recordTimeClaims；网页在 main 注入、chat-turn 只调回调", () => {
    expect(qqRunner).toContain("recordTimeClaims:");
    expect(qqRunner).toContain('formatSpeakLog("qq"');
    // R4：spine（chat-turn）不 import 大脑实现，网页日志由装配层注入。
    expect(main).toContain('formatSpeakLog("web"');
    expect(main).toContain("recordTimeClaims: (reply) =>");
    expect(main).toContain("extractTimeClaims(reply)");
    // 装配层注入的闭包必须真的拿到时区（不能留 undefined）。
    const webStart = main.indexOf("recordTimeClaims: (reply) =>");
    const webEnd = main.indexOf("now: () => Date.now()", webStart);
    expect(main.slice(webStart, webEnd)).toContain("tzOffsetMinutes,");
    expect(chatTurn).toContain("deps.recordTimeClaims?.(reply)");
    expect(chatTurn).not.toContain("speak-metrics");
  });

  it("桥只在 commit 之后调用一次 notifyTimeClaims；主动发送包装不调用", () => {
    expect(onebot).toContain("this.commit(inbound, now, reply);");
    expect(onebot).toContain("this.notifyTimeClaims(reply);");
    expect(onebot.split("this.notifyTimeClaims(reply);").length - 1).toBe(1);
    expect(onebot).toContain("private notifyTimeClaims(reply: string)");
    // 主动发送路径的 deps.send 包装里不应出现时间日志调用
    const sendBlock = onebot.slice(onebot.indexOf("send: async"), onebot.indexOf("channelDown"));
    expect(sendBlock).not.toContain("notifyTimeClaims");
  });

  it("qq-wiring 把 tzOffsetMinutes 传给桥（否则回信日志没有本地时区）", () => {
    expect(qqWiring).toContain("tzOffsetMinutes: input.tzOffsetMinutes,");
  });
});
