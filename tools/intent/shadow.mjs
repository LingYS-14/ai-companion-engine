#!/usr/bin/env node
/**
 * 意向引擎 P0 的**离线观测台**（shadow 样本生成器，只读她的数据、只写一个样本文件）。
 *
 * 它回答用户在 PLAN 里要的那件事：**「她想做的是不是像回事」**——不接线、不发消息、不调模型，
 * 只拿她**此刻真实的状态**（`data/state-*.json`）和真实的**知识覆盖缺口**（`data/knowledge-*.ndjson`）
 * 在一个固定情境网格上跑一遍：B0 投影 → B1 候选 → B2 打分 → 排序 → 自述。
 *
 * 用法（先在仓根 `npm run build`，它读 `dist/`）：
 *   node tools/intent/shadow.mjs
 *   node tools/intent/shadow.mjs --lines 40 --stage close --out data/intent-shadow-assistant.ndjson
 *   node tools/intent/shadow.mjs --state data/state-assistant.json --knowledge data/knowledge-assistant.ndjson
 *
 * 纪律：
 *   - **只读**：只读 `state` / `knowledge` / `persona`，不写 S 层、不写记忆、不碰写锁、不启动 runtime；
 *   - **零模型调用**：全部是 P0 的纯函数；噪声字段写死 0（样本要可复现，不要随机数）；
 *   - **诚实标注近似**：`valueDeviation`、`recentFailureRate`、`openIntentCount` 运行时还没接（P1），
 *     这里用 `--value-deviation` 等参数给固定值并在每条样本里原样记录，方便以后对拍；
 *   - 输出文件默认进 `data/`（已 gitignore），不污染仓库。
 *
 * 退出码：0 正常；1 读不到 state / 依赖缺失（dist 未 build）；2 参数非法。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function loadDist(rel) {
  const path = join(dist, rel);
  if (!existsSync(path)) {
    console.error(`✗ 找不到 ${path}——先在仓根跑 \`npm run build\`（本工具读 dist/，不读 src/）`);
    process.exit(1);
  }
  return import(`file://${path.replace(/\\/g, "/")}`);
}

const statePath = resolve(root, String(arg("state", join("data", "state-assistant.json"))));
const knowledgePath = resolve(root, String(arg("knowledge", join("data", "knowledge-assistant.ndjson"))));
const outPath = resolve(root, String(arg("out", join("data", "intent-shadow-assistant.ndjson"))));
const lines = Number(arg("lines", 30));
const stageArg = String(arg("stage", "auto"));
const valueDeviation = Number(arg("value-deviation", 0.2));
const recentFailureRate = Number(arg("failure-rate", 0));
const openIntentCount = Number(arg("open-intents", 0));

if (!Number.isInteger(lines) || lines < 1 || lines > 200) {
  console.error("✗ --lines 必须是 1..200 的整数");
  process.exit(2);
}
if (!["auto", "stranger", "familiar", "close", "beloved"].includes(stageArg)) {
  console.error("✗ --stage 只能是 auto / stranger / familiar / close / beloved");
  process.exit(2);
}
if (![valueDeviation, recentFailureRate].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
  console.error("✗ --value-deviation / --failure-rate 必须是 [0,1] 的有限数");
  process.exit(2);
}
if (!existsSync(statePath)) {
  console.error(`✗ 读不到状态文件：${statePath}`);
  process.exit(1);
}

const { buildSituation } = await loadDist("orchestrator/intent/situation.js");
const { projectDrive } = await loadDist("orchestrator/intent/drive.js");
const { generateCandidates } = await loadDist("orchestrator/intent/candidates.js");
const { rankCandidates, scoreCandidate } = await loadDist("orchestrator/intent/scoring.js");
const { narrateCandidate } = await loadDist("orchestrator/intent/narrative.js");
const { coverageGap } = await loadDist("learning/curiosity.js");

// ── 读她的真实状态（只读） ────────────────────────────────────────────────
const stateFile = JSON.parse(readFileSync(statePath, "utf8"));
const s = stateFile.s ?? stateFile;
if (!s || typeof s.energy !== "number") {
  console.error(`✗ ${statePath} 里没有 S 层（期望 { s: {...} } 或直接是 SState）`);
  process.exit(1);
}

// ── 关系阶段：默认按她真实的 bondProgress 推（§5.2 STAGE_THRESHOLD 右开区间） ──
// 接线后这里应换成 `stageOf(bondProgress, stageBands(engineConfig))`（`src/engine/bonds.ts`）；
// 本工具是离线观测台，不加载 engine 配置，所以把 §5.2 的四档门槛抄在这里，并在样本里标注。
const FALLBACK_BANDS = [
  ["stranger", 0, 0.25],
  ["familiar", 0.25, 0.55],
  ["close", 0.55, 0.85],
  ["beloved", 0.85, 1.0],
];
const bondProgress = Number(stateFile.bondProgress ?? 0);
const autoStage =
  FALLBACK_BANDS.find(([, lo, hi]) => bondProgress >= lo && bondProgress < hi)?.[0] ??
  FALLBACK_BANDS[FALLBACK_BANDS.length - 1][0];
const stage = stageArg === "auto" ? autoStage : stageArg;

// ── 读真实知识覆盖缺口（只读） ────────────────────────────────────────────
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
    // 知识库是 WAL：`{op:"put", rec:{...freshness}}`；`delete` 之类的行没有 rec，直接跳过
    .map((record) => (record && record.op === "put" && record.rec ? record.rec : null))
    .filter((record) => record && typeof record.freshness === "number");
  gap = coverageGap(records);
}

// ── 情境网格：固定、可复现，不随机 ─────────────────────────────────────────
const HOURS = [23, 9, 14]; // 静默 / 早晨 / 下午
const GAPS = [5, 120, 600]; // 刚聊过 / 两小时 / 十小时
const VARIANTS = [
  { threads: 0, affordances: "full", rph: 8, singleWriter: false }, // 一切正常、没有未完的事
  { threads: 1, affordances: "full", rph: 8, singleWriter: false }, // 有一件没聊完的
  { threads: 0, affordances: "none", rph: 8, singleWriter: false }, // 有能力全关（登录掉了/工具不可用）
  { threads: 1, affordances: "full", rph: 0, singleWriter: false }, // 今天额度用完
  { threads: 1, affordances: "full", rph: 8, singleWriter: true }, // 另一个进程在写
];

const FULL_AFFORDANCES = [
  { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
  { tool: "bili.read", risk: 0, requiresLogin: false, rateLimited: false },
  { tool: "desktop.screen", risk: 0, requiresLogin: false, rateLimited: false },
];
const NONE_AFFORDANCES = [];

function variantAt(t) {
  const hour = HOURS[t % HOURS.length];
  const gapMin = GAPS[Math.floor(t / HOURS.length) % GAPS.length];
  const variant = VARIANTS[Math.floor(t / (HOURS.length * GAPS.length)) % VARIANTS.length];
  return { hour, gapMin, variant };
}

const samples = [];
for (let t = 0; t < lines; t += 1) {
  const { hour, gapMin, variant } = variantAt(t);
  const frame = buildSituation({
    at: "2026-10-31T12:00:00.000Z", // 固定串：localHour 由情境给，避免机器时区影响样本
    localHour: hour,
    channel: "qq",
    participants: ["owner"],
    affordances: variant.affordances === "full" ? FULL_AFFORDANCES : NONE_AFFORDANCES,
    sinceLastContactMin: gapMin,
    activeIntents: [],
    budget: { rph: variant.rph, peak: false },
    singleWriterConflict: variant.singleWriter,
  });

  const drive = projectDrive({
    state: s,
    stage,
    sinceLastContactMin: gapMin,
    recentFailureRate,
    openIntentCount,
    maxOpenIntents: 3,
    coverageGap: gap,
    valueDeviation,
  });

  const threads = variant.threads ? [{ id: "thread-shadow-1", title: "上次没聊完的那件事", staleMin: 600 }] : [];
  const candidates = generateCandidates({ frame, drive, threads });
  const ranked = rankCandidates(candidates);
  const scored = ranked.map((candidate) => ({
    kind: candidate.kind,
    goal: candidate.goal,
    score: Number(scoreCandidate(candidate, drive, frame).toFixed(6)),
  }));
  const top = scored[0] ?? null;
  const narrative = top ? narrateCandidate(ranked[0]) : null;

  samples.push({
    i: t + 1,
    localHour: hour,
    sinceLastContactMin: gapMin,
    rph: variant.rph,
    threads: variant.threads,
    affordances: variant.affordances,
    singleWriter: variant.singleWriter,
    drive: Object.fromEntries(Object.entries(drive).map(([k, v]) => [k, Number(v.toFixed(6))])),
    hardBlocks: frame.hardBlocks,
    candidates: scored,
    topKind: top?.kind ?? null,
    narrative: narrative ? { line: narrative.line, whyLine: narrative.whyLine } : null,
    approximations: {
      stage,
      bondProgress,
      stageSource: stageArg === "auto" ? "fallback-bands" : "cli",
      valueDeviation,
      recentFailureRate,
      openIntentCount,
      coverageGap: gap ?? null,
    },
  });
}

writeFileSync(outPath, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n", "utf8");

// ── 一页纸摘要 ────────────────────────────────────────────────────────────
const count = (keys) => {
  const tally = {};
  for (const sample of samples) {
    const key = keys(sample);
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
};
const fmt = (tally) =>
  Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join("  ");

console.log("意图引擎 shadow 样本（只读、零模型调用）");
console.log(`  状态文件   ${statePath}`);
console.log(`  知识文件   ${existsSync(knowledgePath) ? knowledgePath : "（无，novelty 取中性 0.5）"}`);
console.log(`  知识覆盖缺口 ${gap === undefined ? "（无记录 → 0.5）" : gap.toFixed(4)}`);
console.log(`  关系阶段   ${stage}（bondProgress ${bondProgress.toFixed(4)}${stageArg === "auto" ? "，自动推导" : "，命令行指定"}）`);
console.log(`  近似量     valueDeviation ${valueDeviation}  ·  failureRate ${recentFailureRate}（P1 才接线）`);
console.log(`  样本       ${samples.length} 条 → ${outPath}`);
console.log("");
console.log(`  top 类别分布： ${fmt(count((x) => x.topKind ?? "（无候选）"))}`);
console.log(`  有 hardBlock： ${samples.filter((x) => x.hardBlocks.length > 0).length} / ${samples.length}`);
console.log(`  无候选样本：   ${samples.filter((x) => !x.topKind).length} / ${samples.length}`);
const scores = samples.map((x) => x.candidates[0]?.score ?? 0);
console.log(`  top 分数区间： ${Math.min(...scores).toFixed(3)} ～ ${Math.max(...scores).toFixed(3)}`);
console.log("");
for (const sample of samples.slice(0, 6)) {
  console.log(`  #${sample.i} ${sample.localHour}点 间隔${sample.sinceLastContactMin}分 → ${sample.topKind ?? "（无）"}`);
  if (sample.narrative) {
    console.log(`      ${sample.narrative.line}`);
    console.log(`      ${sample.narrative.whyLine}`);
  }
}
