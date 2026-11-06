#!/usr/bin/env node
/**
 * P3 结构性消融观测台（离线、只读、零模型调用）
 *
 * 回答的问题：**她的行为里，有多少是记忆造成的？**
 * 做法：用她真实的 S 层 / 关系阶段 / 知识缺口构造若干 `IntentTickInput`，
 * 每个输入跑两遍（原样 / 摘掉某个记忆组件），只比较"会做什么"（浮现类别、最高分意图、会不会主动开口）。
 *
 * 用法：
 *   node tools/intent/ablation.mjs                      # 默认 10 个样本，打印一页纸
 *   node tools/intent/ablation.mjs --samples 12 --json  # 机器可读
 *   node tools/intent/ablation.mjs --out data/intent-ablation-assistant.json
 *   node tools/intent/ablation.mjs --components replay_threads,knowledge_gap
 *
 * 需要先 `npm run build`（读 dist/）。只读她的数据：不写她的状态、不发消息、不调模型。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return value;
}

const help = arg("help", false);
if (help) {
  console.log(`用法：node tools/intent/ablation.mjs [选项]

  --state <path>       她的状态文件（默认 data/state-assistant.json）
  --knowledge <path>   她的知识库（默认 data/knowledge-assistant.ndjson）
  --samples <n>        样本数（默认 10；少于 5 个不下因果结论）
  --components <list>  只跑指定组件，逗号分隔：replay_threads,drive_history,knowledge_gap
  --json               输出 JSON（而不是一页纸）
  --out <path>         把 JSON 写到文件（仍会在终端打印摘要）
  --help               显示这段
`);
  process.exit(0);
}

async function loadDist(rel) {
  return import(pathToFileURL(resolve(repoRoot, "dist", rel)).href);
}

const statePath = resolve(repoRoot, String(arg("state", "data/state-assistant.json")));
const knowledgePath = resolve(repoRoot, String(arg("knowledge", "data/knowledge-assistant.ndjson")));
const sampleCount = Number(arg("samples", "10"));
const wantJson = arg("json", false) === true;
const outPath = arg("out", undefined);
const componentsArg = arg("components", undefined);

if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 200) {
  console.error("✗ --samples 必须是 1..200 的整数");
  process.exit(2);
}
if (!existsSync(statePath)) {
  console.error(`✗ 读不到状态文件：${statePath}`);
  process.exit(1);
}

const { runIntentTick } = await loadDist("orchestrator/intent/tick.js");
const { runAblation, describeAblation, ABLATION_COMPONENTS } = await loadDist("orchestrator/intent/ablation.js");
const { buildSituation } = await loadDist("orchestrator/intent/situation.js");
const { coverageGap } = await loadDist("learning/curiosity.js");

let components = ABLATION_COMPONENTS;
if (typeof componentsArg === "string") {
  const wanted = componentsArg.split(",").map((item) => item.trim()).filter(Boolean);
  const bad = wanted.filter((item) => !ABLATION_COMPONENTS.includes(item));
  if (bad.length > 0) {
    console.error(`✗ 未知消融组件：${bad.join(", ")}（可选：${ABLATION_COMPONENTS.join(", ")}）`);
    process.exit(2);
  }
  components = wanted;
}

// ── 读她的真实状态（只读） ────────────────────────────────────────────────
const stateFile = JSON.parse(readFileSync(statePath, "utf8"));
const s = stateFile.s ?? stateFile;
if (!s || typeof s.energy !== "number") {
  console.error(`✗ ${statePath} 里没有 S 层（期望 { s: {...} } 或直接是 SState）`);
  process.exit(1);
}
const bondProgress = Number(stateFile.bondProgress ?? 0);

// 阶段门槛：离线工具不加载 engine 配置，把 §5.2 四档抄在这里并标注（与 shadow.mjs 同一口径）
const FALLBACK_BANDS = [
  ["stranger", 0, 0.25],
  ["familiar", 0.25, 0.55],
  ["close", 0.55, 0.85],
  ["beloved", 0.85, 1.0],
];
const stage =
  FALLBACK_BANDS.find(([, lo, hi]) => bondProgress >= lo && bondProgress < hi)?.[0] ??
  FALLBACK_BANDS[FALLBACK_BANDS.length - 1][0];

// ── 知识覆盖缺口（只读；知识库是 WAL，必须剥 rec 再传给 coverageGap） ────────
let gap;
if (existsSync(knowledgePath)) {
  const records = readFileSync(knowledgePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .map((record) => (record && record.op === "put" && record.rec ? record.rec : null))
    .filter((record) => record && typeof record.freshness === "number");
  gap = coverageGap(records);
}

// ── 样本网格：固定、可复现；覆盖"有/没有未完成的事"与"能力全关/额度用完/单写者冲突" ──
const HOURS = [23, 9, 14];
const GAPS = [5, 120, 600];
const VARIANTS = [
  { threads: true, affordances: "full", rph: 8, singleWriter: false },
  { threads: false, affordances: "full", rph: 8, singleWriter: false },
  { threads: true, affordances: "none", rph: 8, singleWriter: false },
  { threads: true, affordances: "full", rph: 0, singleWriter: false },
  { threads: true, affordances: "full", rph: 8, singleWriter: true },
];
const FULL_AFFORDANCES = [
  { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
  { tool: "bili.read", risk: 0, requiresLogin: false, rateLimited: false },
  { tool: "desktop.screen", risk: 0, requiresLogin: false, rateLimited: false },
];

function inputAt(index) {
  const hour = HOURS[index % HOURS.length];
  const gapMin = GAPS[Math.floor(index / HOURS.length) % GAPS.length];
  const variant = VARIANTS[Math.floor(index / (HOURS.length * GAPS.length)) % VARIANTS.length];
  const situation = {
    at: "2026-10-31T12:00:00.000Z",
    localHour: hour,
    channel: "qq",
    participants: ["owner"],
    affordances: variant.affordances === "full" ? FULL_AFFORDANCES : [],
    sinceLastContactMin: gapMin,
    activeIntents: [],
    budget: { rph: variant.rph, peak: false },
    singleWriterConflict: variant.singleWriter,
  };
  const threads = variant.threads ? [{ id: "thread-ablation-1", title: "上次没聊完的那件事", staleMin: 600 }] : [];
  const base = {
    situation,
    state: s,
    stage,
    recentFailureRate: 0,
    openIntentCount: 0,
    maxOpenIntents: 3,
    valueDeviation: 0.1,
    ...(typeof gap === "number" ? { coverageGap: gap } : {}),
    trust: 0.5,
    trustFloor: 0.2,
    threads,
  };
  // 第二拍：带上一拍的驱动与累积器（让 drive_history 有东西可摘）
  const first = runIntentTick(base);
  return { ...base, previousDrive: first.drive, accumulator: first.accumulator };
}

const samples = Array.from({ length: sampleCount }, (_unused, index) => ({
  label: `样本 ${index + 1}（${HOURS[index % HOURS.length]} 点 / ${GAPS[Math.floor(index / HOURS.length) % GAPS.length]} 分钟前）`,
  input: inputAt(index),
}));

const report = runAblation(samples, components);

const payload = {
  generatedAt: new Date().toISOString(),
  state: { path: statePath, bondProgress, stage, coverageGap: typeof gap === "number" ? Number(gap.toFixed(6)) : null },
  knowledge: { path: knowledgePath, exists: existsSync(knowledgePath) },
  samples: report.samples,
  report,
};

if (typeof outPath === "string") {
  const target = resolve(repoRoot, outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

if (wantJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`她的状态：stage=${stage}  bondProgress=${bondProgress.toFixed(4)}  知识缺口=${typeof gap === "number" ? gap.toFixed(4) : "无知识记录"}`);
  for (const line of describeAblation(report)) console.log(line);
  if (typeof outPath === "string") console.log(`已写：${outPath}`);
}
