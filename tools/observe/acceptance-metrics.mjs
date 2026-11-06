#!/usr/bin/env node
/**
 * 验收七指标采集器（S1 / V1）——只读、零依赖、不接 gate。
 *
 * 职责：读 `data/` 下的日志 / shadow / chat / state / memory，按**本地日**聚合出
 * DESIGN §9「七个指标」中当前可得的 M1/M2/M3/M4/M7；M5 一律 unavailable（不伪造
 * 近似值），M6 为按需消融（非每日）。输出一页纸或 JSON；只有显式 `--out` 才写
 * `data/metrics-daily.ndjson`，且按 `day` 幂等（同日重跑替换该日全部旧记录）。
 *
 * 口径来源：`.tmp/handover/spec-review-acceptance-metrics.md`（v3，sha256
 * 81c094e3…71c3）；M1/M3 插桩口径见 `.tmp/handover/spec-review-s3-instrumentation.md`
 *（S3a/S3c）。任何口径变更请同步改 `GENERATOR_VERSION`。
 * S3b（M5）口径：扫 `[time-claim] ch=… claims=… verifiable=… mismatch=… unverified=…` 行，
 * 按本地日汇总；`value=mismatch/verifiable`，verifiable>=5 才算 ok（1..4 partial、0 unavailable）。
 *
 * 只读边界：除 `--out` 指定文件外不写任何文件；不碰 daemon、不发消息、不调模型。
 * 依赖：仅 node 内置模块（fs/path/url）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_VERSION = "acceptance-metrics/2";
const SCHEMA_VERSION = 1;
const TICK_MS = 300_000;
const DAY_MS = 86_400_000;
const DEFAULT_TZ = 480;
const DEFAULT_CHARACTER = "assistant";
const STARTUP_MARKER = "[autonomy] runtime 已打开";
const CHAT_FULL_MATCH_WINDOW_MS = 120_000;
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z) (.*)$/;
const ENERGY_RE = /energy=(-?\d+(?:\.\d+)?)/;
const SLEEP_PHASE_RE = /\[sleep\] phase=([a-z-]+)/;
const REPLY_RE = / reply=(.*)$/;
const SITUATION_RE = /\[situation\]\s+lines=(\d+)\s+inferred=(\d+)/;
const RECALL_HIT_RE = /\[recall-hit\]\s+ch=(\S+)\s+n=(\d+)\s+ids=([^ ]+)\s+src=(\S+)/;
const TIME_CLAIM_RE =
  /\[time-claim\]\s+ch=(\S+)\s+claims=(\d+)\s+verifiable=(\d+)\s+mismatch=(\d+)\s+unverified=(\d+)/;
/** M3 睡眠产出采纳率：dream 记忆被检索命中的观察窗（72h）。 */
const M3_WINDOW_HOURS = 72;
const SITUATION_ABSENT_NOTE = "无 situation 落盘（需在装配处加一行 situation 日志，属 S3 接口）";
const M3_ABSENT_NOTE = "M3 接口已就绪，等 P4 dream 落库（尚无 source=dream 的记忆）";
const M5_ABSENT_NOTE = "无 [time-claim] 行（S3b 接口未接线或当日无提及时间）";
const M6_NOTE = "按需消融，非每日（组件级 ablation，需 build 且样本≥5）";

/** 七个指标键，固定顺序，便于人读与 JSON 稳定。 */
const METRIC_KEYS = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];

const HELP = `acceptance-metrics —— DESIGN §9 验收七指标采集器（只读，不接 gate）

用法:
  node tools/observe/acceptance-metrics.mjs [选项]

选项:
  --day <YYYY-MM-DD>   只算指定本地日（默认算今天）
  --days <N>           算最近 N 个本地日（含今天；与 --day 二选一）
  --json                stdout 输出 JSON 数组（默认输出一页纸）
  --out <path>         仅显式传时写入指标流水（必须位于 data/ 内；按 day 幂等）
  --root <dir>         仓库根目录（默认脚本所在仓库根）
  --character <id>     角色 id（默认 ${DEFAULT_CHARACTER}）
  --tz <offsetMinutes> 本地时区偏移，分钟（默认读 data/web-usage-<id>.json 的
                       tzOffsetMinutes，缺省 +${DEFAULT_TZ}）
  --since <when>       主动消息窗口起点（ISO8601 或 epoch 毫秒）；缺省取当前日志
                       autonomy-<id>.log 最后一条「runtime 已打开」启动标记的时间
  --help               显示本帮助

口径（V1）:
  M1 处境事实率：扫 [situation] lines=N inferred=M 行，按本地日 Σinferred/Σlines；
     Σlines>=50 → ok；1..49 → partial；0 → unavailable（保留缺接口 note）。
  M2 夜间在场率：从 [sleep] phase=asleep → 首个 waking|awake 重建睡眠区间，
     与本地日取交集；expectedTicks=ceil(区间秒/300)、sleepTicks=区间内 [sleep]
     行数、coverage=sleepTicks/expectedTicks；coverage<0.8 → partial（不能证明 0）。
     candidates=区间内 shadow 行 emitted 非空或 wouldSpeak 的条数；唤醒端点前
     <1s 的 shadow 行单列 boundaryRows，不计入 candidates/shadowRows。
  M4 energy 动态范围：扫 [sleep] 行 energy=，按本地日 min/max/差；样本<2 → partial。
  M7 首条消息多样性：只统计日志 proactive 行中 opened=true 且 reason=spoke 的
     主动消息（窗口起点见 --since；chat who=her 仅用于在 ±120s 内补全文，不单独
     计数）；skeleton=去标点/emoji 后前 12 字；K=distinct；H=-Σp·log2(p)；
     value=K<=1?0:H/log2(20)（固定分母）；窗口内 0 条→unavailable、
     1..19→partial、>=20→ok。
  M3 睡眠产出采纳率：72h 观察窗内 dream 记忆（source=dream 或 encode_ctx.kind=dream）
     被 [recall-hit] 命中的比例；无 dream 记忆 → unavailable（等 P4 落库）。
  M5 时间一致性：扫 [time-claim] 行，按本地日 Σmismatch/Σverifiable；
     verifiable>=5 → ok；1..4 → partial；0 → unavailable（保留缺接口 note）。
     只认「现在 N 点」「N 小时没见」这类明确表述；12 小时制歧义记 unverified。
  M6：partial（按需消融，非每日）。
`;

function die(message, code = 2) {
  process.stderr.write(`acceptance-metrics: ${message}\n`);
  process.exit(code);
}

function parseSinceValue(value) {
  if (/^\d{10,}$/.test(value)) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  die(`--since 需要 ISO8601 或 epoch 毫秒，收到 ${value}`);
  return null;
}

function parseArgs(argv) {
  const opts = {
    day: null,
    days: null,
    json: false,
    out: null,
    root: null,
    character: DEFAULT_CHARACTER,
    tz: null,
    since: null,
    help: false,
  };
  const takeValue = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) die(`${name} 缺少参数值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--day": {
        const value = takeValue(i, "--day");
        i += 1;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) die(`--day 需要 YYYY-MM-DD，收到 ${value}`);
        opts.day = value;
        break;
      }
      case "--days": {
        const value = takeValue(i, "--days");
        i += 1;
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0 || n > 366) die(`--days 需要 1..366 的整数，收到 ${value}`);
        opts.days = n;
        break;
      }
      case "--out":
        opts.out = takeValue(i, "--out");
        i += 1;
        break;
      case "--root":
        opts.root = takeValue(i, "--root");
        i += 1;
        break;
      case "--character":
        opts.character = takeValue(i, "--character") || DEFAULT_CHARACTER;
        i += 1;
        break;
      case "--tz": {
        const value = takeValue(i, "--tz");
        i += 1;
        const n = Number(value);
        if (!Number.isInteger(n) || n < -720 || n > 840) die(`--tz 需要 -720..840 的整数分钟，收到 ${value}`);
        opts.tz = n;
        break;
      }
      case "--since": {
        const value = takeValue(i, "--since");
        i += 1;
        opts.since = parseSinceValue(value);
        break;
      }
      default:
        die(`未知参数 ${arg}（用 --help 看用法）`);
    }
  }
  if (opts.day !== null && opts.days !== null) die("--day 与 --days 只能二选一");
  return opts;
}

function readTextSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseJsonLines(text) {
  if (text === null) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === "object") out.push(value);
    } catch {
      // 坏行静默跳过：采集器不因一行损坏停摆。
    }
  }
  return out;
}

function localDayOf(ms, tz) {
  return Math.floor((ms + tz * 60_000) / DAY_MS);
}

function dayStringOf(ms, tz) {
  return new Date(ms + tz * 60_000).toISOString().slice(0, 10);
}

function dayStartOf(day, tz) {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) - tz * 60_000;
}

function round(value, digits = 3) {
  if (value === null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(numerator, denominator) {
  if (denominator <= 0) return null;
  return round(numerator / denominator, 3);
}

function readLogFile(file, label) {
  const text = readTextSafe(file);
  if (text === null) return null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LOG_TS_RE.exec(line);
    if (match === null) continue;
    rows.push({ tsText: match[1], ts: Date.parse(match[1]), text: match[2], source: label });
  }
  return { label, rows };
}

function loadLogs(root, character) {
  const dataDir = join(root, "data");
  const suffix = `autonomy-${character}`;
  const candidates = [`${suffix}.log`, `${suffix}.log.1`];
  const loaded = [];
  for (const name of candidates) {
    const parsed = readLogFile(join(dataDir, name), name);
    if (parsed !== null) loaded.push(parsed);
  }
  const seen = new Set();
  const rows = [];
  for (const file of loaded) {
    for (const row of file.rows) {
      const key = `${row.tsText}|${row.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.ts === b.ts ? (a.tsText < b.tsText ? -1 : a.tsText > b.tsText ? 1 : 0) : a.ts - b.ts));
  const currentName = `${suffix}.log`;
  const currentRows = rows.filter((row) => row.source === currentName);
  return { rows, names: loaded.map((file) => file.label), currentRows };
}

function loadShadow(root, character) {
  const name = `intent-live-shadow-${character}.ndjson`;
  const text = readTextSafe(join(root, "data", name));
  const rows = parseJsonLines(text)
    .filter((row) => typeof row.at === "number" && Number.isFinite(row.at))
    .map((row) => ({
      at: row.at,
      emitted: Array.isArray(row.emitted) ? row.emitted : [],
      wouldSpeak: row.wouldSpeak === true,
      raw: row.text,
    }))
    .sort((a, b) => a.at - b.at);
  return { rows, name: text === null ? null : name };
}

function loadChat(root, character) {
  const name = `chat-${character}.ndjson`;
  const text = readTextSafe(join(root, "data", name));
  const rows = parseJsonLines(text)
    .filter(
      (row) =>
        typeof row.atMs === "number" &&
        Number.isFinite(row.atMs) &&
        row.who === "her" &&
        typeof row.text === "string" &&
        row.text.trim() !== "",
    )
    .map((row) => ({ at: row.atMs, text: row.text, channel: typeof row.channel === "string" ? row.channel : null }));
  return { rows, name: text === null ? null : name };
}

/**
 * 读记忆 WAL（`data/memory-<id>.ndjson`，写模型是 put {op, rec}）。
 *
 * 只取算 M3 所需的四个标量：内部 id / created_at / source / encode_ctx.kind；
 * 不读内容、不落内容——采集器输出里只有计数与窗口。
 */
function loadMemory(root, character) {
  const name = `memory-${character}.ndjson`;
  const text = readTextSafe(join(root, "data", name));
  const byId = new Map();
  for (const row of parseJsonLines(text)) {
    if (row === null || typeof row !== "object") continue;
    const rec = row.op === "put" ? row.rec : row.op === undefined ? row : null;
    if (rec === null || typeof rec !== "object") continue;
    if (typeof rec.id !== "string" || rec.id === "") continue;
    if (typeof rec.created_at !== "number" || !Number.isFinite(rec.created_at)) continue;
    // WAL 同一 id 可能被 put 多次（更新）；只保留最后一条，避免 cohort/hits 被重复放大。
    byId.set(rec.id, {
      id: rec.id,
      createdAt: rec.created_at,
      source: typeof rec.source === "string" ? rec.source : "unknown",
      encodeKind:
        rec.encode_ctx !== null && typeof rec.encode_ctx === "object" && typeof rec.encode_ctx.kind === "string"
          ? rec.encode_ctx.kind
          : null,
    });
  }
  const rows = [...byId.values()];
  rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt - b.createdAt));
  return { rows, name: text === null ? null : name };
}

function loadState(root, character) {
  const name = `state-${character}.json`;
  const text = readTextSafe(join(root, "data", name));
  return { name: text === null ? null : name };
}

function loadUsageTz(root, character) {
  const text = readTextSafe(join(root, "data", `web-usage-${character}.json`));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.tzOffsetMinutes === "number" && Number.isInteger(parsed.tzOffsetMinutes)) {
      return parsed.tzOffsetMinutes;
    }
  } catch {
    // 坏文件按缺省时区处理。
  }
  return null;
}

/** 把日志里的睡眠相位行重建成区间列表（可能跨日；未闭合截到日志末尾）。 */
function buildSleepIntervals(logRows) {
  const intervals = [];
  let openStart = null;
  let openTsText = null;
  for (const row of logRows) {
    const phase = SLEEP_PHASE_RE.exec(row.text)?.[1] ?? null;
    if (phase === "asleep") {
      if (openStart === null) {
        openStart = row.ts;
        openTsText = row.tsText;
      }
      continue;
    }
    if (phase === "waking" || phase === "awake") {
      if (openStart !== null) {
        if (row.ts > openStart) intervals.push({ start: openStart, end: row.ts, startText: openTsText, endText: row.tsText });
        openStart = null;
        openTsText = null;
      }
    }
  }
  if (openStart !== null) {
    intervals.push({ start: openStart, end: Number.POSITIVE_INFINITY, startText: openTsText, endText: null });
  }
  return intervals;
}

function sleepLinesIn(rows, start, end) {
  return rows.filter((row) => SLEEP_PHASE_RE.test(row.text) && row.ts >= start && row.ts < end);
}

function energyValueOf(row) {
  const match = ENERGY_RE.exec(row.text);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function isProactiveSpoke(row) {
  return row.text.includes("[autonomy] proactive") && row.text.includes("opened=true") && row.text.includes("reason=spoke");
}

function isProactiveReply(row) {
  return (
    row.text.includes("[autonomy] proactive") &&
    row.text.includes("opened=true") &&
    row.text.includes("reason=spoke") &&
    REPLY_RE.test(row.text)
  );
}

function metricUnavailable(note) {
  return { status: "unavailable", value: null, note };
}

/**
 * S3a M1：处境行事实率。
 *
 * 输入是 daemon 每拍的 `[situation] lines=N inferred=M` 日志（不落行文本）。
 * value = Σinferred / Σlines（目标 0）；样本 <50 行时只给 partial，不能当验收值。
 */
function computeM1(day, tz, ctx) {
  const dayStart = dayStartOf(day, tz);
  const dayEnd = dayStart + DAY_MS;
  let lines = 0;
  let inferred = 0;
  for (const row of ctx.logRows) {
    if (row.ts < dayStart || row.ts >= dayEnd) continue;
    const match = SITUATION_RE.exec(row.text);
    if (match === null) continue;
    const rowLines = Number(match[1]);
    const rowInferred = Number(match[2]);
    if (!Number.isFinite(rowLines) || !Number.isFinite(rowInferred)) continue;
    lines += rowLines;
    inferred += rowInferred;
  }
  if (lines === 0) {
    return { status: "unavailable", value: null, inputs: { lines, inferred }, note: SITUATION_ABSENT_NOTE };
  }
  const value = round(inferred / lines, 4);
  const sufficient = lines >= 50;
  return {
    status: sufficient ? "ok" : "partial",
    value,
    inputs: { lines, inferred },
    unit: "inferred/line",
    note: sufficient ? undefined : `处境行样本 ${lines}（<50，发布后积累满 50 行再作验收值）`,
  };
}

function computeM2(day, tz, ctx) {
  const dayStart = dayStartOf(day, tz);
  const dayEnd = dayStart + DAY_MS;
  const overlaps = [];
  for (const interval of ctx.intervals) {
    const start = Math.max(interval.start, dayStart);
    const end = Math.min(interval.end, dayEnd);
    if (end > start) overlaps.push({ start, end, interval });
  }
  if (overlaps.length === 0) {
    return {
      status: "partial",
      value: null,
      candidates: 0,
      shadowRows: 0,
      boundaryRows: 0,
      sleepTicks: 0,
      expectedTicks: 0,
      coverage: null,
      unit: "candidate/夜",
      sends: 0,
      note: "当日无睡眠区间（未入睡或日志缺失），不能证明 0 候选",
    };
  }
  let expectedTicks = 0;
  let sleepTicks = 0;
  let shadowRows = 0;
  let boundaryRows = 0;
  let candidates = 0;
  let sends = 0;
  for (const overlap of overlaps) {
    expectedTicks += Math.max(1, Math.ceil((overlap.end - overlap.start) / TICK_MS));
    sleepTicks += sleepLinesIn(ctx.logRows, overlap.start, overlap.end).length;
    for (const row of ctx.shadowRows) {
      if (row.at < overlap.start || row.at >= overlap.end) continue;
      const wakeEndpoint = overlap.interval.end;
      const isBoundary = Number.isFinite(wakeEndpoint) && row.at >= wakeEndpoint - 1000 && row.at < wakeEndpoint;
      if (isBoundary) {
        boundaryRows += 1;
        continue;
      }
      shadowRows += 1;
      if (row.emitted.length > 0 || row.wouldSpeak === true) candidates += 1;
    }
    sends += ctx.logRows.filter((row) => isProactiveSpoke(row) && row.ts >= overlap.start && row.ts < overlap.end).length;
  }
  const coverage = percent(sleepTicks, expectedTicks);
  const insufficient = coverage === null || coverage < 0.8;
  return {
    status: insufficient ? "partial" : "ok",
    value: insufficient ? null : candidates,
    candidates,
    shadowRows,
    boundaryRows,
    sleepTicks,
    expectedTicks,
    coverage,
    unit: "candidate/夜",
    sends,
    note: insufficient ? "sleep tick 覆盖不足，不能证明 0 候选" : undefined,
  };
}

/**
 * S3c M3：睡眠产出采纳率 = 72h 观察窗内 dream 记忆被 `[recall-hit]` 命中的比例。
 *
 * - cohort：`created_at` 落在 `[本地日末 - 72h, 本地日末)` 的 dream 记忆
 *   （`source==="dream"` 或 `encode_ctx.kind==="dream"`）；
 * - hit：cohort 的 id 在该条记忆 `created_at` 之后 72h 内出现在任一 `[recall-hit]` 行；
 * - cohort=0 → unavailable（dream 还没落库）；cohort>0 且 hits=0 → partial；否则 ok。
 *
 * 只统计 id/source，不读、不输出记忆内容。
 */
function computeM3(day, tz, ctx) {
  const dayStart = dayStartOf(day, tz);
  const dayEnd = dayStart + DAY_MS;
  const windowStart = dayEnd - M3_WINDOW_HOURS * 3_600_000;
  const cohort = ctx.memoryRows.filter(
    (row) =>
      (row.source === "dream" || row.encodeKind === "dream") &&
      row.createdAt >= windowStart &&
      row.createdAt < dayEnd,
  );
  const hitRows = [];
  for (const row of ctx.logRows) {
    const match = RECALL_HIT_RE.exec(row.text);
    if (match === null) continue;
    hitRows.push({ ts: row.ts, ids: new Set(match[3].split(",").filter((id) => id !== "")) });
  }
  let hits = 0;
  for (const memory of cohort) {
    const deadline = memory.createdAt + M3_WINDOW_HOURS * 3_600_000;
    if (hitRows.some((hit) => hit.ts >= memory.createdAt && hit.ts <= deadline && hit.ids.has(memory.id))) {
      hits += 1;
    }
  }
  if (cohort.length === 0) {
    return {
      status: "unavailable",
      value: null,
      inputs: { cohort: 0, hits: 0, windowHours: M3_WINDOW_HOURS },
      note: M3_ABSENT_NOTE,
    };
  }
  return {
    status: hits === 0 ? "partial" : "ok",
    value: round(hits / cohort.length, 4),
    inputs: { cohort: cohort.length, hits, windowHours: M3_WINDOW_HOURS },
    unit: "adopted/cohort",
    note: hits === 0 ? "cohort 内暂未被检索命中（命中只证明被检索到，不等于被采纳进回复）" : undefined,
  };
}

function computeM5(day, tz, ctx) {
  const dayStart = dayStartOf(day, tz);
  const dayEnd = dayStart + DAY_MS;
  let claims = 0;
  let verifiable = 0;
  let mismatch = 0;
  let unverified = 0;
  const channels = new Set();
  for (const row of ctx.logRows) {
    if (row.ts < dayStart || row.ts >= dayEnd) continue;
    const match = TIME_CLAIM_RE.exec(row.text);
    if (match === null) continue;
    claims += Number(match[2]);
    verifiable += Number(match[3]);
    mismatch += Number(match[4]);
    unverified += Number(match[5]);
    channels.add(match[1]);
  }
  const inputs = { claims, verifiable, mismatch, unverified, channels: [...channels].sort() };
  if (verifiable === 0) {
    return {
      status: "unavailable",
      value: null,
      inputs,
      note:
        claims === 0
          ? M5_ABSENT_NOTE
          : `${M5_ABSENT_NOTE}；当日有 ${claims} 次提及时间，但都不可验（12h 歧义或缺基准）`,
    };
  }
  const sufficient = verifiable >= 5;
  return {
    status: sufficient ? "ok" : "partial",
    value: round(mismatch / verifiable, 4),
    inputs,
    unit: "mismatch/verifiable",
    note: sufficient ? undefined : `可验时间表述 ${verifiable} 条（<5，发布后积累满 5 条再作验收值）`,
  };
}

function computeM4(day, tz, ctx) {
  const dayStart = dayStartOf(day, tz);
  const dayEnd = dayStart + DAY_MS;
  const samples = [];
  let bad = 0;
  for (const row of ctx.logRows) {
    if (!SLEEP_PHASE_RE.test(row.text)) continue;
    if (row.ts < dayStart || row.ts >= dayEnd) continue;
    if (!row.text.includes("energy=")) continue;
    const value = energyValueOf(row);
    if (value === null) {
      bad += 1;
      continue;
    }
    samples.push(value);
  }
  if (samples.length === 0) {
    return { status: "unavailable", value: null, samples: 0, note: "当日无 [sleep] energy= 样本（日志缺失或未运行）" };
  }
  if (samples.length < 2) {
    return {
      status: "partial",
      value: null,
      min: round(samples[0]),
      max: round(samples[0]),
      samples: samples.length,
      note: "energy 样本 <2，不能计算动态范围",
    };
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  return {
    status: "ok",
    value: round(max - min),
    min: round(min),
    max: round(max),
    samples: samples.length,
    unit: "energy",
    ...(bad > 0 ? { note: `忽略 ${bad} 条无法解析的 energy 行` } : {}),
  };
}

function skeletonOf(text) {
  const kept = text.replace(/[^\p{L}\p{N}]+/gu, "");
  return Array.from(kept).slice(0, 12).join("");
}

function startupWindowStart(currentRows) {
  let last = null;
  for (const row of currentRows) {
    if (!row.text.includes(STARTUP_MARKER)) continue;
    if (last === null || row.ts > last) last = row.ts;
  }
  return last;
}

function computeM7(day, tz, ctx) {
  const dayEnd = dayStartOf(day, tz) + DAY_MS;
  const windowStart = ctx.windowStartMs;
  const messages = [];
  for (const row of ctx.logRows) {
    if (row.ts >= dayEnd) continue;
    if (windowStart !== null && row.ts < windowStart) continue;
    if (!isProactiveReply(row)) continue;
    const match = REPLY_RE.exec(row.text);
    const reply = match === null ? "" : match[1].trim();
    if (reply === "") continue;
    // chat 只用来补全文：±120s 内文本前缀/包含匹配，命中 truncated=false；
    // 匹配不到才用日志 reply=（可能被 40 字截断），truncated=true。
    const full = ctx.chatRows.find(
      (chat) =>
        Math.abs(chat.at - row.ts) <= CHAT_FULL_MATCH_WINDOW_MS &&
        (chat.text === reply || chat.text.startsWith(reply) || reply.startsWith(chat.text)),
    );
    messages.push(
      full === undefined
        ? { at: row.ts, text: reply, truncated: true }
        : { at: row.ts, text: full.text, truncated: false },
    );
  }
  messages.sort((a, b) => a.at - b.at);
  const recent = messages.slice(-20);
  const windowNote = windowStart === null ? "（未找到启动标记，无窗口，全日志统计）" : "";
  if (recent.length === 0) {
    return {
      status: "unavailable",
      value: null,
      samples: 0,
      unit: "entropy",
      windowStartMs: windowStart,
      note: `窗口内没有主动消息${windowNote}`,
    };
  }
  const counts = new Map();
  for (const message of recent) {
    const skeleton = skeletonOf(message.text);
    counts.set(skeleton, (counts.get(skeleton) ?? 0) + 1);
  }
  const total = recent.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  const denominator = Math.log2(20);
  const distinct = counts.size;
  const value = distinct <= 1 ? 0 : entropy / denominator;
  return {
    status: total < 20 ? "partial" : "ok",
    value: round(value, 4),
    samples: total,
    unit: "entropy",
    windowStartMs: windowStart,
    truncated: recent.some((message) => message.truncated),
    distinct,
    entropy: round(entropy, 4),
    note:
      total < 20
        ? `主动消息样本 ${total}（<20，发布后积累满 20 条再作验收值）${windowNote}`
        : windowStart === null
          ? "无窗口（未找到启动标记，按全日志统计）"
          : undefined,
  };
}

function computeDay(day, tz, ctx) {
  const m1 = computeM1(day, tz, ctx);
  const m2 = computeM2(day, tz, ctx);
  const m3 = computeM3(day, tz, ctx);
  const m4 = computeM4(day, tz, ctx);
  const m5 = computeM5(day, tz, ctx);
  const m6 = { status: "partial", value: null, note: M6_NOTE };
  const m7 = computeM7(day, tz, ctx);
  return {
    v: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    day,
    tzOffsetMinutes: tz,
    generatedAtMs: ctx.generatedAtMs,
    sources: ctx.sources,
    metrics: { m1, m2, m3, m4, m5, m6, m7 },
  };
}

function formatMetric(name, metric) {
  const label = {
    m1: "M1 处境事实率",
    m2: "M2 夜间在场率",
    m3: "M3 睡眠产出采纳率",
    m4: "M4 energy 动态范围",
    m5: "M5 时间一致性",
    m6: "M6 人格外部化率",
    m7: "M7 首条消息多样性",
  }[name];
  const value = metric.value === null ? "—" : String(metric.value);
  const extra = [];
  if (name === "m1") {
    extra.push(`lines=${metric.inputs?.lines ?? "—"}`, `inferred=${metric.inputs?.inferred ?? "—"}`);
  }
  if (name === "m3") {
    extra.push(`cohort=${metric.inputs?.cohort ?? "—"}`, `hits=${metric.inputs?.hits ?? "—"}`);
  }
  if (name === "m2") {
    extra.push(`candidates=${metric.candidates}`, `shadowRows=${metric.shadowRows}`, `boundaryRows=${metric.boundaryRows}`);
    extra.push(`ticks=${metric.sleepTicks}/${metric.expectedTicks}`, `coverage=${metric.coverage ?? "—"}`, `sends=${metric.sends}`);
  }
  if (name === "m4") {
    extra.push(`min=${metric.min ?? "—"}`, `max=${metric.max ?? "—"}`, `samples=${metric.samples}`);
  }
  if (name === "m5") {
    extra.push(
      `claims=${metric.inputs?.claims ?? "—"}`,
      `verifiable=${metric.inputs?.verifiable ?? "—"}`,
      `mismatch=${metric.inputs?.mismatch ?? "—"}`,
      `unverified=${metric.inputs?.unverified ?? "—"}`,
      `channels=${(metric.inputs?.channels ?? []).join(",") || "—"}`,
    );
  }
  if (name === "m7") {
    extra.push(`samples=${metric.samples}`, `distinct=${metric.distinct ?? "—"}`, `truncated=${metric.truncated ?? "—"}`);
  }
  return `  ${label.padEnd(22)} ${metric.status.padEnd(11)} value=${value}${extra.length > 0 ? `  ${extra.join(" ")}` : ""}${
    metric.note ? `  # ${metric.note}` : ""
  }`;
}

function printHuman(records) {
  const lines = [];
  for (const record of records) {
    lines.push(`[${record.day}] tz=${record.tzOffsetMinutes} sources.log=${record.sources.log.length} shadow=${record.sources.shadow ?? "—"}`);
    for (const key of METRIC_KEYS) lines.push(formatMetric(key, record.metrics[key]));
    lines.push("");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function readExistingMetrics(file) {
  const text = readTextSafe(file);
  if (text === null) return [];
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const record = JSON.parse(trimmed);
      if (record !== null && typeof record === "object" && typeof record.day === "string") records.push(record);
    } catch {
      // 坏行丢弃：指标流水可重建。
    }
  }
  return records;
}

function writeMetricsOut(file, records) {
  const days = new Set(records.map((record) => record.day));
  const kept = readExistingMetrics(file).filter((record) => !days.has(record.day));
  const merged = [...kept, ...records].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const body = merged.map((record) => JSON.stringify(record)).join("\n");
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body === "" ? "" : `${body}\n`, "utf8");
  renameSync(tmp, file);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = resolve(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const character = opts.character;
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) {
    // 缺 data/ 不是崩溃：仍输出结构完整的 unavailable 记录，但提示到 stderr。
    process.stderr.write(`acceptance-metrics: 警告：${dataDir} 不存在（按空数据计算）\n`);
  }
  const usageTz = loadUsageTz(root, character);
  const tz = opts.tz ?? usageTz ?? DEFAULT_TZ;
  const generatedAtMs = Date.now();
  const logs = loadLogs(root, character);
  const shadow = loadShadow(root, character);
  const chat = loadChat(root, character);
  const memory = loadMemory(root, character);
  const state = loadState(root, character);
  const sources = {
    log: logs.names,
    shadow: shadow.name,
    state: state.name,
    chat: chat.name,
  };
  const windowStartMs = opts.since ?? startupWindowStart(logs.currentRows);
  const ctx = {
    generatedAtMs,
    sources,
    logRows: logs.rows,
    shadowRows: shadow.rows,
    chatRows: chat.rows,
    memoryRows: memory.rows,
    intervals: buildSleepIntervals(logs.rows),
    windowStartMs,
  };
  let days;
  if (opts.day !== null) {
    days = [opts.day];
  } else {
    const count = opts.days ?? 1;
    const todayIndex = localDayOf(generatedAtMs, tz);
    days = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      days.push(dayStringOf((todayIndex - offset) * DAY_MS, 0));
    }
  }
  const records = days.map((day) => computeDay(day, tz, ctx));
  const outAbs = opts.out === null ? null : resolve(process.cwd(), opts.out);
  if (outAbs !== null) {
    const rel = relative(dataDir, outAbs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      die(`--out 只允许写到 ${dataDir} 目录内，收到 ${outAbs}`);
    }
    writeMetricsOut(outAbs, records);
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(records, null, 0)}\n`);
  else printHuman(records);
  if (outAbs !== null) process.stderr.write(`acceptance-metrics: 已写入 ${outAbs}\n`);
}

main();
