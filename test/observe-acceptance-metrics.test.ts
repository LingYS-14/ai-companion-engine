import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "tools", "observe", "acceptance-metrics.mjs");
const FIXTURES = join(HERE, "fixtures", "acceptance-metrics");
const TZ = 480;
const DAY = "2026-11-02";
const TICK_MS = 300_000;

const roots: string[] = [];
const ALLOWED_STATUS = new Set(["ok", "partial", "unavailable"]);

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ase-metrics-"));
  roots.push(root);
  mkdirSync(join(root, "data"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

function emptyRoot(): string {
  return makeRoot({});
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runJson(root: string, day: string, extra: string[] = []) {
  const result = runCli(["--root", root, "--day", day, "--json", "--tz", String(TZ), ...extra]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}

function metricsOf(record: Record<string, unknown>): Record<string, any> {
  return record.metrics as Record<string, any>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sleepLine(atMs: number, energy: number): string {
  return `${iso(atMs)} [sleep] phase=asleep pressure=0.00 energy=${energy.toFixed(3)} window=closed mode=NORMAL reason=hold sleptH=1.00 turns=1`;
}

function wakingLine(atMs: number, energy: number): string {
  return `${iso(atMs)} [sleep] phase=waking pressure=0.00 energy=${energy.toFixed(3)} window=closed mode=NORMAL reason=min-window sleptH=2.00 turns=1`;
}

function awakeLine(atMs: number, energy: number): string {
  return `${iso(atMs)} [sleep] phase=awake pressure=0.10 energy=${energy.toFixed(3)} window=closed mode=NORMAL reason=hold sleptH=0.00 turns=1`;
}

function proactiveLine(atMs: number, reply: string): string {
  return `${iso(atMs)} [autonomy] proactive opened=true reason=spoke intent=outlet:speak kind=continue_thread reply=${reply}`;
}

function proactiveHeldLine(atMs: number): string {
  return `${iso(atMs)} [autonomy] proactive opened=false reason=outlet intent=outlet:idle kind=null`;
}

/** S3a：daemon 每拍的处境计数行（不落行文本）。 */
function situationLine(atMs: number, lines: number, inferred: number): string {
  return `${iso(atMs)} [situation] lines=${lines} inferred=${inferred}`;
}

function shadowLine(at: number, emitted: unknown[], wouldSpeak = false): string {
  return JSON.stringify({
    at,
    localHour: 12,
    drive: { energy: 0.5 },
    candidates: [],
    emitted,
    gate: { allowed: true },
    wouldSpeak,
    outlet: { target: emitted.length > 0 ? "speak" : "idle", kind: null },
    narrative: "fixture",
  });
}

function chatLine(atMs: number, text: string): string {
  return JSON.stringify({ atMs, who: "her", text, channel: "qq" });
}

/** S3c：daemon 落的召回命中日志（只有 id/source，无内容/query）。 */
function recallHitLine(atMs: number, ids: string[], sources = "player:1"): string {
  return `${iso(atMs)} [recall-hit] ch=qq n=${ids.length} ids=${ids.join(",")} src=${sources}`;
}

/** S3b：发言时间一致性摘要行（只有计数与时刻，无原文）。 */
function timeClaimLine(
  atMs: number,
  channel: string,
  counts: { claims: number; verifiable: number; mismatch: number; unverified: number },
): string {
  return `${iso(atMs)} [time-claim] ch=${channel} claims=${counts.claims} verifiable=${counts.verifiable} mismatch=${counts.mismatch} unverified=${counts.unverified} snap=2026-11-03T12:00+0800/awake=2.0/peer=12min`;
}

/** S3c：记忆 WAL 行（`data/memory-<id>.ndjson` 的写模型）。 */
function memoryPut(rec: {
  id: string;
  createdAt: number;
  source?: string;
  encodeKind?: string;
}): string {
  return JSON.stringify({
    op: "put",
    rec: {
      id: rec.id,
      content: "fixture 内容（采集器不读）",
      created_at: rec.createdAt,
      ...(rec.source === undefined ? {} : { source: rec.source }),
      ...(rec.encodeKind === undefined ? {} : { encode_ctx: { kind: rec.encodeKind } }),
    },
  });
}

function joinLines(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function joinJsonLines(rows: string[]): string {
  return `${rows.join("\n")}\n`;
}

function recursiveFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...recursiveFiles(target));
    else out.push(target.slice(dir.length + 1));
  }
  return out.sort();
}

function localDayString(ms: number, tz: number): string {
  return new Date(ms + tz * 60_000).toISOString().slice(0, 10);
}

describe("acceptance-metrics：静态 fixture（不读真实 data）", () => {
  const sampleDir = join(FIXTURES, "sample");

  function sampleRoot(): string {
    const files: Record<string, string> = {};
    for (const name of readdirSync(sampleDir)) {
      const target = name.endsWith(".log.txt") ? name.slice(0, -".txt".length) : name;
      files[`data/${target}`] = readFileSync(join(sampleDir, name), "utf8");
    }
    return makeRoot(files);
  }

  it("sample fixture：M2 覆盖 1.0 → ok/0，boundary 单独计，M4/M7 读数正确", () => {
    const [record] = runJson(sampleRoot(), "2026-11-03");
    const metrics = metricsOf(record);
    expect(metrics.m2).toMatchObject({
      status: "ok",
      value: 0,
      candidates: 0,
      boundaryRows: 1,
      shadowRows: 1,
      sleepTicks: 5,
      expectedTicks: 5,
      coverage: 1,
      sends: 0,
    });
    expect(metrics.m4).toMatchObject({ status: "ok", value: 0.802, min: 0.198, max: 1, samples: 7 });
    expect(metrics.m7).toMatchObject({ status: "partial", samples: 1, truncated: false, distinct: 1, value: 0 });
  });

  it("schema 与 sources：字段齐全、status 合法、m1/m3/m5 unavailable、m6 partial", () => {
    const [record] = runJson(sampleRoot(), "2026-11-03");
    expect(record.v).toBe(1);
    expect(record.generatorVersion).toBe("acceptance-metrics/2");
    expect(record.day).toBe("2026-11-03");
    expect(record.tzOffsetMinutes).toBe(TZ);
    expect(typeof record.generatedAtMs).toBe("number");
    expect(record.sources).toMatchObject({
      log: ["autonomy-assistant.log"],
      shadow: "intent-live-shadow-assistant.ndjson",
      state: "state-assistant.json",
      chat: "chat-assistant.ndjson",
    });
    const metrics = metricsOf(record);
    expect(Object.keys(metrics).sort()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    for (const metric of Object.values(metrics) as Array<{ status: string }>) {
      expect(ALLOWED_STATUS.has(metric.status)).toBe(true);
    }
    expect(metrics.m1.status).toBe("unavailable");
    expect(metrics.m3.status).toBe("unavailable");
    expect(metrics.m5.status).toBe("unavailable");
    expect(metrics.m6.status).toBe("partial");
  });

  it("fixture 不被 .gitignore 忽略（提交后/干净 clone 均可复现）", () => {
    const repo = join(HERE, "..");
    const files = readdirSync(sampleDir).map((name) =>
      join("test", "fixtures", "acceptance-metrics", "sample", name).replace(/\\/g, "/"),
    );
    expect(files.length).toBeGreaterThanOrEqual(5);
    // 文件存在性：干净 clone 里也必须存在（fixture 是提交物，不能靠 .log 被忽略后本地残留）
    for (const file of files) expect(existsSync(join(repo, file))).toBe(true);
    // check-ignore EXIT 1 且无输出 = 没有任何 fixture 被忽略
    const ignored = spawnSync("git", ["check-ignore", "--", ...files], { cwd: repo, encoding: "utf8" });
    expect(ignored.status).toBe(1);
    expect(ignored.stdout.trim()).toBe("");
    // 可被 git 跟踪：已 tracked 或可 add（不依赖当前是否 untracked 的状态）
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", ...files], { cwd: repo, encoding: "utf8" });
    const addable = spawnSync("git", ["add", "--dry-run", "--", ...files], { cwd: repo, encoding: "utf8" });
    expect(tracked.status === 0 || addable.status === 0).toBe(true);
  });
});

describe("acceptance-metrics：时区与本地日切分", () => {
  it("+480：23:58/23:59 归前一日，00:01/00:02 归后一日", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        awakeLine(Date.parse("2026-11-01T15:58:00Z"), 0.2),
        awakeLine(Date.parse("2026-11-01T15:59:00Z"), 0.4),
        awakeLine(Date.parse("2026-11-01T16:01:00Z"), 0.8),
        awakeLine(Date.parse("2026-11-01T16:02:00Z"), 1.0),
      ]),
    });
    const first = metricsOf(runJson(root, "2026-11-01")[0]).m4;
    expect(first).toMatchObject({ status: "ok", samples: 2, min: 0.2, max: 0.4, value: 0.2 });
    const second = metricsOf(runJson(root, "2026-11-02")[0]).m4;
    expect(second).toMatchObject({ status: "ok", samples: 2, min: 0.8, max: 1, value: 0.2 });
  });

  it("-300：默认时区从 web-usage 读取并按该时区切日", () => {
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: -300 }),
      "data/autonomy-assistant.log": joinLines([
        awakeLine(Date.parse("2026-11-02T04:58:00Z"), 0.2),
        awakeLine(Date.parse("2026-11-02T04:59:00Z"), 0.4),
        awakeLine(Date.parse("2026-11-02T05:01:00Z"), 0.8),
        awakeLine(Date.parse("2026-11-02T05:02:00Z"), 1.0),
      ]),
    });
    const result = runCli(["--root", root, "--day", "2026-11-02", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const record = JSON.parse(result.stdout)[0];
    expect(record.tzOffsetMinutes).toBe(-300);
    expect(metricsOf(record).m4).toMatchObject({ status: "ok", samples: 2, min: 0.8, max: 1, value: 0.2 });
  });

  it("日志轮转去重：同一行在 .log 与 .log.1 只计一次", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        awakeLine(Date.parse("2026-11-02T01:00:00Z"), 0.5),
        awakeLine(Date.parse("2026-11-02T01:05:00Z"), 0.7),
      ]),
      "data/autonomy-assistant.log.1": joinLines([
        awakeLine(Date.parse("2026-11-02T01:00:00Z"), 0.5),
        awakeLine(Date.parse("2026-11-02T00:00:00Z"), 0.2),
      ]),
    });
    const [record] = runJson(root, DAY);
    expect(metricsOf(record).m4).toMatchObject({ status: "ok", samples: 3, min: 0.2, max: 0.7, value: 0.5 });
    expect((record.sources as { log: string[] }).log).toEqual(["autonomy-assistant.log", "autonomy-assistant.log.1"]);
  });
});

describe("acceptance-metrics：M2 睡眠覆盖与候选", () => {
  const nightRoot = () => {
    const first = Date.parse("2026-11-01T15:00:00Z");
    const second = Date.parse("2026-11-02T10:00:00Z");
    const lines: string[] = [];
    for (let i = 0; i < 24; i += 1) lines.push(sleepLine(first + i * TICK_MS, 0.5 + i * 0.01));
    lines.push(wakingLine(first + 24 * TICK_MS, 0.31));
    for (let i = 0; i < 6; i += 1) lines.push(sleepLine(second + i * TICK_MS, 0.41 + i * 0.02));
    lines.push(wakingLine(second + 6 * TICK_MS, 0.93));
    lines.push(proactiveLine(Date.parse("2026-11-02T10:12:00Z"), "今天也要好好吃饭。"));
    return makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: 480 }),
      "data/autonomy-assistant.log": joinLines(lines),
      "data/intent-live-shadow-assistant.ndjson": joinJsonLines([
        shadowLine(Date.parse("2026-11-02T10:10:00Z"), [{ kind: "idle" }], true),
        shadowLine(Date.parse("2026-11-01T16:30:00Z"), [], false),
        shadowLine(Date.parse("2026-11-01T16:59:59.500Z"), [{ kind: "reach_out" }], true),
      ]),
      "data/chat-assistant.ndjson": joinJsonLines([
        chatLine(Date.parse("2026-11-02T10:12:00Z"), "今天也要好好吃饭。记得早点睡。"),
      ]),
    });
  };

  it("跨午夜区间按本地日取交集；candidates/boundaryRows/sends 分开计数", () => {
    const root = nightRoot();
    const day12 = metricsOf(runJson(root, "2026-11-02")[0]).m2;
    expect(day12).toMatchObject({
      status: "ok",
      value: 1,
      candidates: 1,
      shadowRows: 2,
      boundaryRows: 1,
      sleepTicks: 18,
      expectedTicks: 18,
      coverage: 1,
      sends: 1,
    });
    const day11 = metricsOf(runJson(root, "2026-11-01")[0]).m2;
    expect(day11).toMatchObject({ status: "ok", value: 0, sleepTicks: 12, expectedTicks: 12, boundaryRows: 0 });
  });

  it("覆盖 < 0.8 → partial 且 value=null（不得给 ok/0）", () => {
    const start = Date.parse("2026-11-02T10:00:00Z");
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) lines.push(sleepLine(start + i * 600_000, 0.5));
    lines.push(wakingLine(Date.parse("2026-11-02T12:00:00Z"), 0.5));
    const root = makeRoot({ "data/autonomy-assistant.log": joinLines(lines) });
    const m2 = metricsOf(runJson(root, DAY)[0]).m2;
    expect(m2.status).toBe("partial");
    expect(m2.value).toBeNull();
    expect(m2.sleepTicks).toBe(6);
    expect(m2.expectedTicks).toBe(24);
    expect(m2.coverage).toBeLessThan(0.8);
    expect(String(m2.note)).toContain("覆盖不足");
  });

  it("未闭合区间（无唤醒行）按日末截断并判 partial", () => {
    const start = Date.parse("2026-11-02T10:00:00Z");
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) lines.push(sleepLine(start + i * 600_000, 0.5));
    const root = makeRoot({ "data/autonomy-assistant.log": joinLines(lines) });
    const m2 = metricsOf(runJson(root, DAY)[0]).m2;
    expect(m2.status).toBe("partial");
    expect(m2.value).toBeNull();
    expect(m2.expectedTicks).toBe(72);
    expect(m2.sleepTicks).toBe(6);
  });

  it("当日无睡眠区间 → partial + note，不伪造 0 候选", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([awakeLine(Date.parse("2026-11-02T09:00:00Z"), 0.5)]),
    });
    const m2 = metricsOf(runJson(root, DAY)[0]).m2;
    expect(m2.status).toBe("partial");
    expect(m2.value).toBeNull();
    expect(String(m2.note)).toContain("无睡眠区间");
  });
});

describe("acceptance-metrics：M4 精力差值", () => {
  it("恒为 1 → value=0（ok）", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        awakeLine(Date.parse("2026-11-02T01:00:00Z"), 1),
        awakeLine(Date.parse("2026-11-02T02:00:00Z"), 1),
        awakeLine(Date.parse("2026-11-02T03:00:00Z"), 1),
      ]),
    });
    expect(metricsOf(runJson(root, DAY)[0]).m4).toMatchObject({ status: "ok", value: 0, min: 1, max: 1, samples: 3 });
  });

  it("单样本 → partial 且 value=null", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([awakeLine(Date.parse("2026-11-02T01:00:00Z"), 0.5)]),
    });
    const m4 = metricsOf(runJson(root, DAY)[0]).m4;
    expect(m4.status).toBe("partial");
    expect(m4.value).toBeNull();
    expect(m4.samples).toBe(1);
  });

  it("无法解析的 energy 行被忽略并写入 note", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        awakeLine(Date.parse("2026-11-02T01:00:00Z"), 0.2),
        "2026-11-02T01:30:00Z [sleep] phase=awake pressure=0.10 energy=abc",
        "not-a-timestamp [sleep] phase=awake energy=0.9",
        awakeLine(Date.parse("2026-11-02T02:00:00Z"), 0.6),
      ]),
    });
    const m4 = metricsOf(runJson(root, DAY)[0]).m4;
    expect(m4).toMatchObject({ status: "ok", samples: 2, min: 0.2, max: 0.6, value: 0.4 });
    expect(String(m4.note)).toContain("忽略 1 条");
  });
});

describe("acceptance-metrics：M7 首条多样性", () => {
  const base = Date.parse("2026-11-02T00:10:00Z");

  function spokeRoot(texts: string[]): string {
    return makeRoot({
      "data/autonomy-assistant.log": joinLines(texts.map((text, i) => proactiveLine(base + i * 60_000, text))),
    });
  }

  it("20 条全同 → value=0（ok）", () => {
    const root = spokeRoot(Array.from({ length: 20 }, () => "今天天气真好啊"));
    const m7 = metricsOf(runJson(root, DAY)[0]).m7;
    expect(m7).toMatchObject({ status: "ok", samples: 20, distinct: 1, value: 0 });
    expect(m7.windowStartMs).toBeNull();
  });

  it("10A+10B → entropy/log2(20)≈0.2314", () => {
    const texts = [
      ...Array.from({ length: 10 }, () => "今天天气真好啊"),
      ...Array.from({ length: 10 }, () => "明天要不要出去玩"),
    ];
    const m7 = metricsOf(runJson(spokeRoot(texts), DAY)[0]).m7;
    expect(m7.samples).toBe(20);
    expect(m7.distinct).toBe(2);
    expect(m7.value as number).toBeCloseTo(0.2314, 3);
  });

  it("20 条全不同 → value=1", () => {
    const texts = Array.from({ length: 20 }, (_, i) => `第${i}条互不相同的内容`);
    const m7 = metricsOf(runJson(spokeRoot(texts), DAY)[0]).m7;
    expect(m7).toMatchObject({ status: "ok", samples: 20, distinct: 20, value: 1 });
  });

  it("19 条 → partial，仍给 value", () => {
    const m7 = metricsOf(runJson(spokeRoot(Array.from({ length: 19 }, () => "今天天气真好啊")), DAY)[0]).m7;
    expect(m7.status).toBe("partial");
    expect(m7.samples).toBe(19);
    expect(m7.value).toBe(0);
  });

  it("chat 回信（无对应 spoke 日志）不计入主动消息", () => {
    const root = makeRoot({
      "data/chat-assistant.ndjson": joinJsonLines([chatLine(base, "这是回信，不是主动消息。")]),
    });
    expect(metricsOf(runJson(root, DAY)[0]).m7).toMatchObject({ status: "unavailable", samples: 0 });
  });

  it("有 spoke 日志 + chat 全文：取全文且 truncated=false", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([proactiveLine(base, "今天也要好好吃饭。")]),
      "data/chat-assistant.ndjson": joinJsonLines([chatLine(base + 10_000, "今天也要好好吃饭。记得早点睡。")]),
    });
    expect(metricsOf(runJson(root, DAY)[0]).m7).toMatchObject({ status: "partial", samples: 1, truncated: false });
  });

  it("只有日志 reply= 时 truncated=true，held 行不算主动消息", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        proactiveLine(Date.parse("2026-11-02T01:00:00Z"), "今天也要好好吃饭。"),
        proactiveHeldLine(Date.parse("2026-11-02T01:10:00Z")),
        proactiveLine(Date.parse("2026-11-02T02:00:00Z"), "晚点早点睡。"),
      ]),
    });
    expect(metricsOf(runJson(root, DAY)[0]).m7).toMatchObject({ status: "partial", samples: 2, truncated: true });
  });

  it("默认窗口：只统计当前日志最后一条启动标记之后的消息（.log.1 与旧窗口不计）", () => {
    const marker = Date.parse("2026-11-02T00:30:00Z");
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        proactiveLine(base, "窗口前的旧消息。"),
        `${iso(marker)} [autonomy] runtime 已打开`,
        proactiveLine(Date.parse("2026-11-02T01:00:00Z"), "窗口后的新消息。"),
      ]),
      "data/autonomy-assistant.log.1": joinLines([
        proactiveLine(Date.parse("2026-11-02T00:20:00Z"), "轮转里的旧消息。"),
      ]),
    });
    const m7 = metricsOf(runJson(root, DAY)[0]).m7;
    expect(m7.status).toBe("partial");
    expect(m7.samples).toBe(1);
    expect(m7.windowStartMs).toBe(marker);
  });

  it("--since 接受 ISO 与 epoch：起点前不计、当刻计入", () => {
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        proactiveLine(Date.parse("2026-11-02T01:00:00Z"), "第一条。"),
        proactiveLine(Date.parse("2026-11-02T01:05:00Z"), "第二条。"),
        proactiveLine(Date.parse("2026-11-02T01:10:00Z"), "第三条。"),
      ]),
    });
    const isoM7 = metricsOf(runJson(root, DAY, ["--since", "2026-11-02T01:05:00Z"])[0]).m7;
    expect(isoM7.samples).toBe(2);
    const epochM7 = metricsOf(runJson(root, DAY, ["--since", String(Date.parse("2026-11-02T01:05:00Z"))])[0]).m7;
    expect(epochM7.samples).toBe(2);
    const emptyM7 = metricsOf(runJson(root, DAY, ["--since", "2026-11-02T02:00:00Z"])[0]).m7;
    expect(emptyM7).toMatchObject({ status: "unavailable", samples: 0 });
  });

  it("窗口边界：恰在起点当刻计入，早 1s 不计", () => {
    const since = Date.parse("2026-11-02T01:00:00Z");
    const root = makeRoot({
      "data/autonomy-assistant.log": joinLines([
        proactiveLine(since - 1000, "太早了。"),
        proactiveLine(since, "刚好到点。"),
      ]),
    });
    const m7 = metricsOf(runJson(root, DAY, ["--since", iso(since)])[0]).m7;
    expect(m7.samples).toBe(1);
  });

  it("找不到启动标记 → 无窗口（windowStartMs=null）且 note 标注", () => {
    const m7 = metricsOf(runJson(spokeRoot(["只有一条。"]), DAY)[0]).m7;
    expect(m7.samples).toBe(1);
    expect(m7.windowStartMs).toBeNull();
    expect(String(m7.note)).toContain("无窗口");
  });
});

describe("acceptance-metrics：缺文件与空日", () => {
  it("data 为空目录：M2 partial、M4/M7 unavailable，不抛错", () => {
    const root = emptyRoot();
    const metrics = metricsOf(runJson(root, DAY)[0]);
    expect(metrics.m2.status).toBe("partial");
    expect(metrics.m4.status).toBe("unavailable");
    expect(metrics.m7.status).toBe("unavailable");
  });

  it("--days 3：连续本地日，末位为今天", () => {
    const root = emptyRoot();
    const result = runCli(["--root", root, "--days", "3", "--json", "--tz", String(TZ)]);
    expect(result.code, result.stderr).toBe(0);
    const records = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(3);
    const expected = [2, 1, 0].map((offset) => localDayString(Date.now() - offset * 86_400_000, TZ));
    expect(records.map((record) => record.day)).toEqual(expected);
  });

  it("--day 与 --days 互斥：exit 2", () => {
    const root = emptyRoot();
    const result = runCli(["--root", root, "--day", DAY, "--days", "3", "--json"]);
    expect(result.code).toBe(2);
  });

  it("--help 自解释并 exit 0", () => {
    const result = runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("用法");
    expect(result.stdout).toContain("acceptance-metrics");
  });
});

describe("acceptance-metrics：--out 幂等与显式写入", () => {
  it("按 day 幂等：同日重跑不重复、异日保留、旧 generatorVersion 被替换", () => {
    const root = emptyRoot();
    const out = join(root, "data", "metrics-daily.ndjson");
    expect(runCli(["--root", root, "--day", "2026-11-02", "--json", "--tz", String(TZ), "--out", out]).code).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
    expect(runCli(["--root", root, "--day", "2026-11-02", "--json", "--tz", String(TZ), "--out", out]).code).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
    expect(runCli(["--root", root, "--day", "2026-11-03", "--json", "--tz", String(TZ), "--out", out]).code).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(2);
    const seeded = [
      { v: 1, generatorVersion: "old-generator", day: "2026-11-02", tzOffsetMinutes: TZ, metrics: {} },
      { v: 1, generatorVersion: "old-generator", day: "2026-11-03", tzOffsetMinutes: TZ, metrics: {} },
    ];
    writeFileSync(out, `${seeded.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    expect(runCli(["--root", root, "--day", "2026-11-02", "--json", "--tz", String(TZ), "--out", out]).code).toBe(0);
    const rows = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    const replaced = rows.find((row) => row.day === "2026-11-02");
    expect(replaced.generatorVersion).toBe("acceptance-metrics/2");
    expect(replaced.metrics.m4).toBeDefined();
  });

  it("不传 --out 不写任何文件", () => {
    const root = emptyRoot();
    const before = recursiveFiles(root);
    const result = runCli(["--root", root, "--day", DAY, "--json", "--tz", String(TZ)]);
    expect(result.code, result.stderr).toBe(0);
    expect(recursiveFiles(root)).toEqual(before);
  });

  it("--out 越出 data/ → exit 2，且不落盘", () => {
    const root = emptyRoot();
    const outside = join(root, "metrics.ndjson");
    const result = runCli(["--root", root, "--day", DAY, "--json", "--tz", String(TZ), "--out", outside]);
    expect(result.code).toBe(2);
    expect(String(result.stderr)).toContain("--out 只允许写到");
    expect(recursiveFiles(root)).toEqual([]);
  });
});

describe("acceptance-metrics：S3a M1 处境行事实率", () => {
  it("按本地日聚合 Σinferred/Σlines；<50 行给 partial、>=50 行给 ok", () => {
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
      "data/autonomy-assistant.log": joinLines([
        situationLine(Date.parse("2026-11-02T02:00:00Z"), 14, 1),
        situationLine(Date.parse("2026-11-03T02:00:00Z"), 50, 0),
      ]),
    });
    const day2 = metricsOf(runJson(root, "2026-11-02")[0]).m1;
    expect(day2).toMatchObject({
      status: "partial",
      value: 0.0714,
      inputs: { lines: 14, inferred: 1 },
      unit: "inferred/line",
    });
    expect(String(day2.note)).toContain("14");
    expect(String(day2.note)).toContain("<50");

    const day3 = metricsOf(runJson(root, "2026-11-03")[0]).m1;
    expect(day3).toMatchObject({
      status: "ok",
      value: 0,
      inputs: { lines: 50, inferred: 0 },
      unit: "inferred/line",
    });
  });

  it("无 situation 行 → unavailable，inputs 0/0，保留缺接口 note", () => {
    const root = emptyRoot();
    const m1 = metricsOf(runJson(root, DAY)[0]).m1;
    expect(m1).toMatchObject({ status: "unavailable", value: null, inputs: { lines: 0, inferred: 0 } });
    expect(String(m1.note)).toContain("无 situation 落盘");
  });

  it("坏行被忽略（不把 NaN 带进 value）；跨日不串", () => {
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
      "data/autonomy-assistant.log": joinLines([
        `${iso(Date.parse("2026-11-02T02:00:00Z"))} [situation] lines=x inferred=y`,
        situationLine(Date.parse("2026-11-02T03:00:00Z"), 60, 3),
      ]),
    });
    const day2 = metricsOf(runJson(root, "2026-11-02")[0]).m1;
    expect(day2).toMatchObject({ status: "ok", value: 0.05, inputs: { lines: 60, inferred: 3 } });
    const day3 = metricsOf(runJson(root, "2026-11-03")[0]).m1;
    expect(day3).toMatchObject({ status: "unavailable", inputs: { lines: 0, inferred: 0 } });
  });
});

describe("acceptance-metrics：S3c M3 睡眠产出采纳率", () => {
  it("72h 窗口内 2 条 dream 记忆 + 1 条命中 → 50%", () => {
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
      "data/memory-assistant.ndjson": joinJsonLines([
        memoryPut({ id: "dm_a", createdAt: Date.parse("2026-11-02T02:00:00Z"), source: "dream" }),
        memoryPut({
          id: "dm_b",
          createdAt: Date.parse("2026-11-02T03:00:00Z"),
          source: "learning",
          encodeKind: "dream",
        }),
      ]),
      "data/autonomy-assistant.log": joinLines([
        recallHitLine(Date.parse("2026-11-02T05:00:00Z"), ["dm_a", "mm_other"]),
      ]),
    });
    const m3 = metricsOf(runJson(root, "2026-11-02")[0]).m3;
    expect(m3).toMatchObject({
      status: "ok",
      value: 0.5,
      inputs: { cohort: 2, hits: 1, windowHours: 72 },
      unit: "adopted/cohort",
    });
  });

  it("cohort=0 → unavailable，保留 P4 dream 落库 note", () => {
    const root = emptyRoot();
    const m3 = metricsOf(runJson(root, DAY)[0]).m3;
    expect(m3).toMatchObject({ status: "unavailable", value: null, inputs: { cohort: 0, hits: 0, windowHours: 72 } });
    expect(String(m3.note)).toContain("P4 dream 落库");
  });

  it("命中窗口 72h 边界：恰好 72h 计、72h+1ms 不计", () => {
    const created = Date.parse("2026-11-01T00:00:00Z");
    const base = {
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
    };
    const exact = makeRoot({
      ...base,
      "data/memory-assistant.ndjson": joinJsonLines([memoryPut({ id: "dm_a", createdAt: created, source: "dream" })]),
      "data/autonomy-assistant.log": joinLines([
        recallHitLine(created + 72 * 3_600_000, ["dm_a"]),
      ]),
    });
    const exactM3 = metricsOf(runJson(exact, "2026-11-02")[0]).m3;
    expect(exactM3).toMatchObject({ status: "ok", value: 1, inputs: { cohort: 1, hits: 1 } });

    const late = makeRoot({
      ...base,
      "data/memory-assistant.ndjson": joinJsonLines([memoryPut({ id: "dm_a", createdAt: created, source: "dream" })]),
      "data/autonomy-assistant.log": joinLines([
        `${iso(created + 72 * 3_600_000)} [recall-hit] ch=qq n=1 ids=dm_a src=player:1`.replace(
          /Z \[recall/,
          ".001Z [recall",
        ),
      ]),
    });
    const lateM3 = metricsOf(runJson(late, "2026-11-02")[0]).m3;
    expect(lateM3).toMatchObject({ status: "partial", value: 0, inputs: { cohort: 1, hits: 0 } });
  });

  it("cohort 窗口边界：日末-72h 恰好在窗内，再早 1ms 被排除", () => {
    const dayEnd = Date.parse("2026-11-02T16:00:00Z");
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
      "data/memory-assistant.ndjson": joinJsonLines([
        memoryPut({ id: "dm_edge", createdAt: dayEnd - 72 * 3_600_000, source: "dream" }),
        memoryPut({ id: "dm_out", createdAt: dayEnd - 72 * 3_600_000 - 1, source: "dream" }),
      ]),
      "data/autonomy-assistant.log": joinLines([
        recallHitLine(dayEnd - 3_600_000, ["dm_edge"]),
        recallHitLine(dayEnd - 3_600_000, ["dm_out"]),
      ]),
    });
    const m3 = metricsOf(runJson(root, "2026-11-02")[0]).m3;
    expect(m3).toMatchObject({ status: "ok", value: 1, inputs: { cohort: 1, hits: 1 } });
  });

  it("同一 id 多条 put 只算 1 条 cohort（WAL 去重，最后一条为准）", () => {
    const root = makeRoot({
      "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }),
      "data/memory-assistant.ndjson": joinJsonLines([
        memoryPut({ id: "dm_dup", createdAt: Date.parse("2026-11-02T01:00:00Z"), source: "learning" }),
        memoryPut({ id: "dm_dup", createdAt: Date.parse("2026-11-02T02:00:00Z"), source: "dream" }),
        memoryPut({ id: "dm_dup", createdAt: Date.parse("2026-11-02T03:00:00Z"), source: "dream" }),
      ]),
      "data/autonomy-assistant.log": joinLines([
        recallHitLine(Date.parse("2026-11-02T05:00:00Z"), ["dm_dup"]),
      ]),
    });
    const m3 = metricsOf(runJson(root, "2026-11-02")[0]).m3;
    expect(m3).toMatchObject({ status: "ok", value: 1, inputs: { cohort: 1, hits: 1 } });
  });
});

describe("acceptance-metrics：S3b M5 时间一致性", () => {
  const base = { "data/web-usage-assistant.json": JSON.stringify({ v: 1, tzOffsetMinutes: TZ }) };

  it("verifiable>=5 → ok，value=mismatch/verifiable，channels 去重排序", () => {
    const root = makeRoot({
      ...base,
      "data/autonomy-assistant.log": joinLines([
        timeClaimLine(Date.parse("2026-11-02T01:00:00Z"), "qq", { claims: 3, verifiable: 3, mismatch: 1, unverified: 0 }),
        timeClaimLine(Date.parse("2026-11-02T02:00:00Z"), "autonomy", { claims: 2, verifiable: 2, mismatch: 0, unverified: 0 }),
      ]),
    });
    const m5 = metricsOf(runJson(root, "2026-11-02")[0]).m5;
    expect(m5).toMatchObject({
      status: "ok",
      value: 0.2,
      unit: "mismatch/verifiable",
      inputs: { claims: 5, verifiable: 5, mismatch: 1, unverified: 0, channels: ["autonomy", "qq"] },
    });
  });

  it("1..4 条可验 → partial（报值但样本不够）", () => {
    const root = makeRoot({
      ...base,
      "data/autonomy-assistant.log": joinLines([
        timeClaimLine(Date.parse("2026-11-02T01:00:00Z"), "web", { claims: 2, verifiable: 2, mismatch: 1, unverified: 0 }),
      ]),
    });
    const m5 = metricsOf(runJson(root, "2026-11-02")[0]).m5;
    expect(m5).toMatchObject({ status: "partial", value: 0.5, inputs: { claims: 2, verifiable: 2, mismatch: 1 } });
    expect(String(m5.note)).toContain("可验时间表述 2 条");
  });

  it("有提及但都不可验 → unavailable；没有任何 time-claim → unavailable + 缺接口 note", () => {
    const onlyUnverified = makeRoot({
      ...base,
      "data/autonomy-assistant.log": joinLines([
        timeClaimLine(Date.parse("2026-11-02T01:00:00Z"), "qq", { claims: 2, verifiable: 0, mismatch: 0, unverified: 2 }),
      ]),
    });
    const m5a = metricsOf(runJson(onlyUnverified, "2026-11-02")[0]).m5;
    expect(m5a).toMatchObject({ status: "unavailable", value: null, inputs: { claims: 2, verifiable: 0 } });
    expect(String(m5a.note)).toContain("都不可验");

    const empty = metricsOf(runJson(emptyRoot(), "2026-11-02")[0]).m5;
    expect(empty).toMatchObject({ status: "unavailable", value: null });
    expect(String(empty.note)).toContain("S3b 接口未接线");
  });

  it("只统计本地日窗口内的行（前一天/后一天不串）", () => {
    const root = makeRoot({
      ...base,
      "data/autonomy-assistant.log": joinLines([
        timeClaimLine(Date.parse("2026-11-01T10:00:00Z"), "qq", { claims: 9, verifiable: 9, mismatch: 9, unverified: 0 }),
        timeClaimLine(Date.parse("2026-11-02T10:00:00Z"), "qq", { claims: 5, verifiable: 5, mismatch: 0, unverified: 0 }),
        timeClaimLine(Date.parse("2026-11-03T10:00:00Z"), "qq", { claims: 7, verifiable: 7, mismatch: 7, unverified: 0 }),
      ]),
    });
    const m5 = metricsOf(runJson(root, "2026-11-02")[0]).m5;
    expect(m5).toMatchObject({ status: "ok", value: 0, inputs: { claims: 5, verifiable: 5, mismatch: 0 } });
  });
});
