#!/usr/bin/env node
/**
 * 夜间/早报用的只读取证脚本。
 *
 * 为什么要有它：早报必须“先取证、再叙述”。手写报告容易凭记忆描述数字，
 * 而这个脚本把证据一次性摊开：知识库、记忆库、QQ 状态、学习时间跨度。
 *
 * 只读：不写任何文件，不启动运行时，不需要插件在线。
 * 用法：node tools/report/night-summary.mjs [dataDir]
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/[A-Za-z]:/, (m) => m.slice(1)));
const dataDir = process.argv[2] ?? join(root, "data");
const characterId = process.env.ACE_CHARACTER ?? "assistant";

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 坏行忽略：取证脚本不承担修复职责 */
    }
  }
  return out;
}

function pct(n, d) {
  return d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`;
}

function mmdd(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 知识库 ----------
const kPath = join(dataDir, `knowledge-${characterId}.ndjson`);
const kRows = readJsonl(kPath);
const kLatest = new Map(); // id -> rec，后写覆盖（WAL 语义）
for (const row of kRows) {
  if (row?.op === "put" && row.rec?.id) kLatest.set(row.rec.id, row.rec);
}
const knowledge = [...kLatest.values()];
const biliKnowledge = knowledge.filter((r) => String(r.source ?? "") === "bili");
const byType = {};
for (const r of knowledge) {
  const t = String(r.knowledge_type ?? "unknown");
  byType[t] = (byType[t] ?? 0) + 1;
}
const times = knowledge.map((r) => r.ingested_at).filter((n) => typeof n === "number").sort((a, b) => a - b);
const titles = biliKnowledge
  .map((r) => {
    const raw = String(r.title ?? r.content ?? "").replace(/\s+/g, " ").trim();
    // 知识正文形如「在 B 站看到《《标题》（UP）…」——先去掉前缀，再贪婪取最外层书名号
    const stripped = raw.replace(/^在\s*B\s*站看到/, "").trim();
    // 标题可能自带书名号（《本项目动画短片…》），所以用「》（」前瞻取最外层
    const m = /^《(.+?)(?=》（)/.exec(stripped) ?? /^《([^》]{1,80})》/.exec(stripped);
    const title = (m?.[1] ?? stripped.replace(/^《/, "").split("》")[0]).slice(0, 60);
    return { title: title === "" ? "（无标题）" : title, at: r.ingested_at };
  })
  .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

// ---------- 记忆库 ----------
const mPath = join(dataDir, `memory-${characterId}.ndjson`);
const mRows = readJsonl(mPath);
const mLatest = new Map();
for (const row of mRows) {
  const op = row?.op;
  const id = row?.rec?.id ?? row?.id;
  if (op === "put" && row.rec?.id) mLatest.set(row.rec.id, row.rec);
  else if (op === "del" && id) mLatest.delete(id);
}
const memories = [...mLatest.values()];
const lived = memories.filter((m) => !m.forgotten && !m.suppressed_by_stronger);

// ---------- QQ 状态 ----------
const qPath = join(dataDir, `qq-${characterId}.json`);
let qq = null;
if (existsSync(qPath)) {
  try {
    qq = JSON.parse(readFileSync(qPath, "utf8"));
  } catch {
    qq = null;
  }
}


// ---------- 自主运行（常驻进程） ----------
const logPath = join(dataDir, `autonomy-${characterId}.log`);
const logLines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
const beatPath = join(dataDir, `autonomy-${characterId}.beat`);
let beat = null;
if (existsSync(beatPath)) {
  try {
    beat = JSON.parse(readFileSync(beatPath, "utf8"));
  } catch {
    beat = null;
  }
}
const learnRows = logLines
  .map((line) => /learn topic=(\S+) keyword=(\S+) page=(\d+) fetched=(\d+) ingested=(\d+) skipped=(\d+) blocked=(\d+) offTopic=(\d+) idle=(\d+)/.exec(line))
  .filter((m) => m !== null)
  .map((m) => ({
    topic: m[1],
    keyword: m[2],
    page: Number(m[3]),
    fetched: Number(m[4]),
    ingested: Number(m[5]),
    skipped: Number(m[6]),
    blocked: Number(m[7]),
    offTopic: Number(m[8]),
    idle: Number(m[9]),
  }));
const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
const journalPath = join(dataDir, `selftalk-${characterId}.json`);
let journal = [];
if (existsSync(journalPath)) {
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
    journal = Array.isArray(parsed) ? parsed : [];
  } catch {
    journal = [];
  }
}
// 内部言语以日记为准（日志会重复打 kind=，按日志数会把一次自语数成好几次）
const selftalkCount = journal.length;
const spokenCount = journal.filter((e) => e !== null && typeof e === "object" && e.spoken === true).length;
const heldRows = logLines.filter((l) => l.includes("[voice] held"));
const logSpokeRows = logLines.filter((l) => l.includes("[voice] spoke=true"));
const repeatRows = logLines.filter((l) => l.includes("[selftalk] 重复跳过"));
// 只认真正的异常：`blocked`（擦边）里含 "locked"，所以要用词边界；learn 行本身不算异常
const errorRows = logLines.filter(
  (l) => !l.includes("not-message") && !l.includes(" learn topic=") && /error|失败|异常|locked/i.test(l),
);
const usagePath = join(dataDir, "autonomy-usage.json");
let callsLastHour = 0;
if (existsSync(usagePath)) {
  try {
    const usage = JSON.parse(readFileSync(usagePath, "utf8"));
    const nowMs = Date.now();
    callsLastHour = (Array.isArray(usage?.calls) ? usage.calls : []).filter((c) => typeof c === "number" && nowMs - c < 3_600_000).length;
  } catch {
    callsLastHour = 0;
  }
}
const beatAgeMin = beat !== null && typeof beat.at === "number" ? Math.round((Date.now() - beat.at) / 60_000) : null;

// ---------- 输出 ----------
const lines = [];
lines.push(`# 夜间取证（character=${characterId}）`);
lines.push(`数据目录：${dataDir}`);
lines.push("");
lines.push("## 知识库");
lines.push(`- 总条数：${knowledge.length}（原始行 ${kRows.length}）`);
lines.push(`- 其中 B 站来源：${biliKnowledge.length}（${pct(biliKnowledge.length, knowledge.length)}）`);
lines.push(`- 类型分布：${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(" / ") || "无"}`);
lines.push(`- 入库时间跨度：${mmdd(times[0])} → ${mmdd(times[times.length - 1])}`);
lines.push(`- 最近 6 条：`);
for (const t of titles.slice(0, 6)) lines.push(`  - ${String(t.title).slice(0, 52)}`);
lines.push("");
lines.push("## 记忆（L1）");
lines.push(`- 总条数：${memories.length}，活跃 ${lived.length}，遗忘 ${memories.filter((m) => m.forgotten).length}，被压制 ${memories.filter((m) => m.suppressed_by_stronger).length}`);
if (lived.length > 0) {
  const avgV = lived.reduce((s, m) => s + (Number(m.vividness) || 0), 0) / lived.length;
  lines.push(`- 平均鲜明度：${avgV.toFixed(3)}`);
  const newest = [...lived].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)).slice(0, 4);
  for (const m of newest) lines.push(`  - ${String(m.content ?? "").slice(0, 46)}（${mmdd(m.created_at)}）`);
}
lines.push("");
lines.push("## QQ 通道");
if (qq === null) {
  lines.push("- 没有状态文件（可能从未回过消息）");
} else {
  lines.push(`- 已回复条数：${Array.isArray(qq.repliedIds) ? qq.repliedIds.length : 0}，最近回复：${mmdd(qq.lastReplyAt ?? null)}`);
  lines.push(`- 主动开口：累计 ${Array.isArray(qq.proactiveAt) ? qq.proactiveAt.length : 0} 次，最近 ${mmdd(qq.lastProactiveAt ?? null)}`);
}

lines.push("");
lines.push("## 自主运行（夜间）");
if (logLines.length === 0) {
  lines.push("- 没有自主进程日志：她这一夜没有自主运行");
} else {
  lines.push(`- 心跳：${beat === null ? "无心跳文件" : `${beatAgeMin} 分钟前（pid=${String(beat.pid ?? "?")}，ran=${(beat.ran ?? []).join("+")}）`}`);
  lines.push(`- 日志覆盖：${logLines[0].slice(0, 16)} → ${logLines[logLines.length - 1].slice(0, 16)}（共 ${logLines.length} 行）`);
  lines.push(`- 学习拍数：${learnRows.length}；学到 ${sum(learnRows, "ingested")} 条，抓 ${sum(learnRows, "fetched")} 条，跳过 ${sum(learnRows, "skipped")}（擦边 ${sum(learnRows, "blocked")} / 离题 ${sum(learnRows, "offTopic")}）`);
  if (learnRows.length > 0) {
    const recent = learnRows.slice(-3);
    for (const r of recent) lines.push(`  - ${r.keyword}（${r.topic}）page=${r.page} 入库 ${r.ingested} / 抓 ${r.fetched}`);
  }
  const spokenNote = spokenCount === 0 && logSpokeRows.length > 0 ? `（旧日记没有这个标记；日志里记了 ${logSpokeRows.length} 次）` : "";
  lines.push(`- 内部言语：日记 ${selftalkCount} 条；说出口 ${spokenCount} 条${spokenNote}（静默/配额拦下 ${heldRows.length} 次，重复句跳过 ${repeatRows.length} 次）`);
  lines.push(`- 模型调用：最近一小时 ${callsLastHour} 次`);
  lines.push(`- 异常行：${errorRows.length} 条${errorRows.length === 0 ? "" : `（最近：${errorRows[errorRows.length - 1].slice(0, 90)}）`}`);
  const reviewPath = join(dataDir, "autonomy-review.json");
  lines.push(`- 人工审核票据：${existsSync(reviewPath) ? "待处理" : "无"}`);
}

lines.push("");
lines.push("## 自检");
lines.push(`- 知识库文件：${existsSync(kPath) ? "存在" : "缺失"}；记忆文件：${existsSync(mPath) ? "存在" : "缺失"}；QQ 状态：${existsSync(qPath) ? "存在" : "缺失"}`);
lines.push(`- 重复 id：${kRows.length - new Set(kRows.filter((r) => r?.rec?.id).map((r) => r.rec.id)).size} 条（WAL 行数与唯一 id 之差）`);

process.stdout.write(`${lines.join("\n")}\n`);
