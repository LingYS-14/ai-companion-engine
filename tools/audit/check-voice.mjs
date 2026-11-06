#!/usr/bin/env node
/**
 * 表达质量检查：她「想过」和「说出口」的话里，有没有不该出现的元叙述。
 *
 *   node tools/audit/check-voice.mjs          # 人读
 *   node tools/audit/check-voice.mjs --json   # 机读（测试用）
 *
 * 三类问题：
 *   1. 元叙述：把「记忆库/检索/条目/知识库/日记/向量/语义/标签/召回」说出口——内部机制不该出现在台词里
 *   2. 自述框架：「我在心里想着…」「刚刚在心里念了一句：」——人是直接说的，不是先描述内心活动
 *   3. 复读：同一天里归一化后相同、或二元组相似度 ≥0.9 的句子重复出现（内部言语重复说明种子没轮换）
 *   4. 做不到的承诺：常驻进程只能发文字，说「这张图给你」「稍后发你照片」就是许下做不到的事
 *
 * 退出码：有问题 1，没有问题 0。检查只读，不改任何数据。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = process.argv.includes("--json");
const writeBaseline = process.argv.includes("--write-baseline");
const hoursArg = process.argv.find((a) => a.startsWith("--hours="));
const windowHours = hoursArg === undefined ? 24 : Number(hoursArg.slice("--hours=".length));
const characterId = process.env.ACE_CHARACTER_ID ?? "assistant";
const dataDir = resolve(process.env.ACE_DATA_DIR ?? join(repo, "data"));

const META_WORDS = ["记忆库", "检索", "条目", "知识库", "日记", "向量", "语义", "标签", "召回", "数据库"];
const THINK_ALOUD = /(我)?(刚刚|刚才|这会儿|现在)?(又)?(在)?心里(想着|想到|想起|琢磨|念了一句|念着)/u;
const PROMISE = /(?:这|那|一)张(?:图|照片|图片)(?:给|发|传)你|(?:给|发|传)你(?:一张|几张|张)(?:图|照片|图片|文件)|(?:等会|稍等|稍后|马上)[^。！？]{0,6}(?:给|发|传)你[^。！？]{0,4}(?:图|照片|文件)/u;

// 已知历史问题（ratchet）：只写进 spec/config/voice-baseline.json 的文本才被忽略，
// 新出现的问题一律失败。这样既不粉饰过去，也不让门禁永远红着。
const baselinePath = resolve(process.env.ACE_VOICE_BASELINE ?? join(repo, "spec", "config", "voice-baseline.json"));
const known = new Set();
const loadedKnown = new Set();
if (existsSync(baselinePath)) {
  try {
    const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
    for (const item of Array.isArray(raw) ? raw : []) { known.add(String(item)); loadedKnown.add(String(item)); }
  } catch {
    // 基线坏了就当没有：宁可多报，不可漏报
  }
}

const problems = [];
const suppressed = [];
// 只看最近 N 小时：F92（种子轮换 / 去重）之前的日记留着不改，历史复读不该让门禁一直红
const since = Date.now() - (Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24) * 3_600_000;
const inWindow = (at) => typeof at !== "number" || !Number.isFinite(at) || at >= since;
const facts = { entries: 0, spoke: 0, replied: 0, generated: 0 };

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(text) {
  const s = normalize(text);
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common += 1;
  return (2 * common) / (A.size + B.size);
}

function record(kind, where, word, text) {
  const key = `${kind}|${normalize(text)}`;
  if (known.has(key)) suppressed.push({ kind, where, word, text });
  else problems.push({ kind, where, word, text });
}

function scan(text, where, spoken = false) {
  for (const word of META_WORDS) {
    if (text.includes(word)) record("meta", where, word, text);
  }
  if (THINK_ALOUD.test(text)) record("think-aloud", where, "心里+想/念", text);
  // 承诺类只在「真说出口」时算问题：运行时 humanize() 已经把这类句子拦在出口，
  // 日记保留原文是设计（F102），不该反过来让审计报错。
  if (spoken && PROMISE.test(text)) record("promise", where, "发图/发文件", text);
}

// 1) 内部言语日记
const journalPath = join(dataDir, `selftalk-${characterId}.json`);
let entries = [];
if (existsSync(journalPath)) {
  try {
    const raw = JSON.parse(readFileSync(journalPath, "utf8"));
    entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    record("journal-unreadable", journalPath, "", "");
  }
}
facts.entries = entries.length;
const texts = [];
for (const entry of entries) {
  if (!inWindow(entry?.at)) continue;
  if (typeof entry?.text !== "string" || entry.text.trim() === "") continue;
  if (entry.spoken === true) facts.spoke += 1;
  texts.push(entry.text);
  scan(entry.text, `selftalk#${String(entry.id ?? "?")}`, entry.spoken === true);
}

// 复读：同一天内两两比较太贵，直接全量两两（日记上限 500 条，够小）
const seen = new Map();
for (const text of texts) {
  const key = normalize(text);
  if (key === "") continue;
  if (seen.has(key)) {
    record("repeat", "selftalk", "完全相同", text);
  } else {
    seen.set(key, text);
  }
}
for (let i = 0; i < texts.length; i += 1) {
  for (let j = i + 1; j < texts.length; j += 1) {
    // 完全相同的已经在上面按"完全相同"记过一次，这里只找"不像同一句但几乎一样"
    if (normalize(texts[i]) === normalize(texts[j])) continue;
    if (dice(texts[i], texts[j]) >= 0.9) {
      record("repeat", "selftalk", "高度相似", `${texts[i]} ／ ${texts[j]}`);
    }
  }
}

// 2) 说出口的台词（QQ 日志）
const logPath = join(dataDir, `qq-${characterId}.log`);
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.includes("[qq] generated ")) facts.generated += 1;
    const m = /\[onebot\] replied: .*?\| (.+)$/.exec(line);
    if (m === null) continue;
    if (line.includes("selfcheck")) continue;
    facts.replied += 1;
    scan(m[1], "qq-reply");
  }
}

const dropped = Math.max(0, facts.generated - facts.replied);

// --write-baseline：把当前问题并入基线（只增不减；删基线要人手动删，避免偷偷放过新问题）
if (writeBaseline) {
  const merged = new Set([...loadedKnown, ...problems.map((p) => `${p.kind}|${normalize(p.text)}`)]);
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify([...merged].sort(), null, 2)}
`, "utf8");
  console.log(`已写入基线：${baselinePath}（${String(merged.size)} 条）`);
  process.exit(0);
}
if (!json) {
  console.log(`表达质量检查：日记 ${String(facts.entries)} 条（说出口 ${String(facts.spoke)}）；生成 ${String(facts.generated)} 次、回出去 ${String(facts.replied)} 次（未回 ${String(dropped)}）`);
  for (const p of problems.slice(0, 20)) {
    console.log(`  ✗ [${p.kind}] ${p.where} ${p.word === "" ? "" : `「${p.word}」`}${p.text.slice(0, 60)}`);
  }
  if (suppressed.length > 0) console.log(`（已知历史问题 ${String(suppressed.length)} 条，见 spec/config/voice-baseline.json，不计入）`);
  if (problems.length === 0) console.log("PASS 表达质量：元叙述 0、自述框架 0、复读 0、做不到的承诺 0（新问题）");
  else console.log(`✗ 表达质量：${String(problems.length)} 处`);
}
if (json) {
  process.stdout.write(`${JSON.stringify({ passed: problems.length === 0, facts, suppressed: suppressed.length, problems }, null, 2)}\n`);
}
process.exit(problems.length === 0 ? 0 : 1);
