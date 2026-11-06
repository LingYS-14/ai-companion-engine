/**
 * 关系推进脚本（G8-①）：把 bond 从 stranger 一路推到 beloved，采集四个阶段的真实提示。
 *
 * 为什么需要它：上一轮评估九轮全在 stranger（吵架把 bond 打回 0），
 * 所以"她熟了以后怎么说话"这条主线**一格都没测到**。这里用真实的
 * `SoulRuntime.turn()` 一路推进（不是手写状态），把每一档的阶段提示原样抓下来，
 * 再交给 dialogue-eval.mjs 判定。
 *
 * 用法：node tools/eval/stage-progression.mjs
 * 产出：控制台表格 + tools/eval/transcript-stages.json（提示已填好，台词留空待补）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../dist/engine/clock.js";
import { SoulRuntime } from "../../dist/plugin/runtime.js";
import { styleFor } from "../../dist/dialogue/expression.js";
import { stageBands } from "../../dist/engine/bonds.js";
import { loadConfig } from "../../dist/engine/config.js";

const cfg = await loadConfig();
// 本机 Temp 对沙箱不可写（EPERM）：临时目录只能落在工作区里
const TMP_ROOT = new URL("../../.tmp-probe/", import.meta.url).pathname.replace(/^\//, "");
mkdirSync(TMP_ROOT, { recursive: true });
const dir = mkdtempSync(join(TMP_ROOT, "stage-"));
const clock = new FakeClock();

// 从零开场：主角刚认识她（§9.3 初值）
const stateFile = (id) => join(dir, `state-${id}.json`);

async function fresh(characterId) {
  const rt = await SoulRuntime.open({ characterId, dataDir: dir, trace: false }, clock);
  return rt;
}

const rt = await fresh("stages");

/** 一轮"高 valence 的正面互动"：把 valence 推到 0.74 上限附近，驱动 bond 前进 */
const POSITIVE = {
  text: "今天想跟你多聊一会儿。",
  appraisal: { goal_congruence: 1, goal_relevance: 1, coping_potential: 1, novelty: 0.2, legitimacy: 1 },
};

const STAGES = ["stranger", "familiar", "close", "beloved"];
const rows = [];
let turns = 0;
let captured = new Set();

while (rows.length < STAGES.length && turns < 400) {
  const r = rt.turn(POSITIVE, { source: "player", eventType: "intimacy" });
  turns += 1;
  const stage = r.stage ?? "stranger";
  if (!captured.has(stage)) {
    captured.add(stage);
    rows.push({
      stage,
      turns,
      bond: Number(r.bondProgress.toFixed(4)),
      modeStyle: r.style.modeStyle,
      stageStyle: r.style.stageStyle,
      expression: r.expression,
      suppress: r.style.suppressInstruction,
    });
  }
}

// 依恋四象限 × beloved：表达层是纯函数，不需要真跑对话，但要与运行时同一份表
const beloved = 0.86;
const bands = stageBands(cfg);
const QUADRANTS = [
  { name: "secure", attachment: { anxiety: 0.35, avoidance: 0.3 } },
  { name: "preoccupied", attachment: { anxiety: 0.75, avoidance: 0.3 } },
  { name: "dismissive", attachment: { anxiety: 0.3, avoidance: 0.75 } },
  { name: "fearful", attachment: { anxiety: 0.8, avoidance: 0.8 } },
];
const quadRows = QUADRANTS.map((q) => {
  const hint = styleFor(q.attachment, beloved, bands);
  return { quadrant: q.name, attachment: q.attachment, hint };
});

console.log("# 关系推进实测（真实 turn 驱动，非手写状态）\n");
console.log(`从零到 beloved 共 ${turns} 轮（每轮 valence 顶到 ~0.74，bond 按分档速率递增）\n`);
console.log("| 阶段 | 第几轮 | bond | modeStyle | stageStyle | expr tone |");
console.log("|---|---:|---:|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.stage} | ${r.turns} | ${r.bond} | ${r.modeStyle} | ${r.stageStyle} | ${r.expression.tone} |`);
}

console.log("\n# beloved × 四象限（表达层纯函数）\n");
console.log("| 象限 | tone | move | avoid |");
console.log("|---|---|---|---|");
for (const q of quadRows) {
  console.log(`| ${q.quadrant} | ${q.hint.tone} | ${q.hint.move} | ${q.hint.avoid} |`);
}

// 生成 transcript 骨架：提示已填，台词留空（由人补，A/B 两组各写一遍）
const turnsOut = [];
for (const r of rows) {
  turnsOut.push({
    id: `s-${r.stage}`,
    user: "今天想跟你多聊一会儿。",
    mode: "NORMAL",
    stage: r.stage,
    modeStyle: r.modeStyle,
    stageStyle: r.stageStyle,
    exprTone: r.expression.tone,
    exprMove: r.expression.move,
    exprAvoid: r.expression.avoid,
    suppress: r.suppress,
    lineHints: "",
    lineNoHints: "",
  });
}
for (const q of quadRows) {
  turnsOut.push({
    id: `q-${q.quadrant}`,
    user: "（beloved 阶段的一句日常）",
    mode: "NORMAL",
    stage: "beloved",
    modeStyle: styleFor(q.attachment, beloved, bands) === undefined ? "" : "自然、松弛，句子长度随话题走",
    stageStyle: "可以亲近、不必客气、允许用昵称",
    exprTone: q.hint.tone,
    exprMove: q.hint.move,
    exprAvoid: q.hint.avoid,
    suppress: "情绪可以直接说",
    lineHints: "",
    lineNoHints: "",
  });
}
writeFileSync(
  new URL("./transcript-stages.json", import.meta.url),
  `${JSON.stringify({ note: "G8-① 关系推进 + 四象限骨架：提示由真实运行时导出，lineHints/lineNoHints 待补", turns: turnsOut }, null, 2)}\n`,
  "utf8",
);

console.log(`\n已写出骨架：tools/eval/transcript-stages.json（${turnsOut.length} 格，台词待补）`);
rmSync(dir, { recursive: true, force: true });
