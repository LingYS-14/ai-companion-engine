/**
 * 对话表达评估（G8）：把"像不像人"拆成可判定的检查项。
 *
 * 这个脚本**不评判文笔**——那需要人。它只判定"提示里写明的约束有没有被遵守"，
 * 这些是可以机械检查的，也正好是这项工程唯一能被证伪的部分：
 * 如果连"该用敬称"、"不许点破情绪"、"碎片化"都做不到，那再谈"人格"就是空话。
 *
 * 用法：node tools/eval/dialogue-eval.mjs [transcript.json]
 * 输出：逐条检查表 + A/B 两组的通过率对比。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = process.argv[2] ?? fileURLToPath(new URL("./transcript-g8.json", import.meta.url));
const data = JSON.parse(readFileSync(path, "utf8"));

/** 明确点破情绪的动词/形容词：与"不点破 / 几乎不承认情绪"冲突 */
const EMOTION_WORDS = [
  "开心", "高兴", "难过", "难受", "生气", "愤怒", "委屈", "害怕", "担心", "焦虑",
  "感动", "在意", "心疼", "失落", "失望", "愧疚", "抱歉", "对不起",
];
/** 出戏词：任何情况下都不该出现 */
const META_WORDS = ["作为AI", "作为 AI", "模型", "插件", "工具调用", "系统提示", "soul_turn", "state=", "pressure=", "mask="];
/** 亲近标记：stranger 阶段不该出现 */
const INTIMATE_WORDS = ["亲爱的", "宝贝", "想你", "抱抱", "乖", "我们在一起"];

function countSentences(text) {
  return text.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length > 0).length;
}

function hasEmotion(text) {
  return EMOTION_WORDS.filter((w) => text.includes(w));
}

/** 一组检查；每个返回 {id, ok, detail} */
function checkAll(turn, line) {
  const out = [];
  const isStranger = turn.stage === "stranger";
  const wantsHonorific = isStranger;
  const suppressHard = /不点破|压住|几乎不承认/.test(turn.suppress);
  const fragmented = /碎片化|可能中断/.test(turn.modeStyle);
  const deflecting = /反问|回避/.test(turn.modeStyle);
  const sentences = countSentences(line);
  const digits = line.match(/\d+\.\d+|\b0\.\d+/g) ?? [];

  out.push({ id: "no-state-numbers", ok: digits.length === 0, detail: digits.join(",") || "无" });
  out.push({
    id: "no-meta",
    ok: META_WORDS.every((w) => !line.includes(w)),
    detail: META_WORDS.filter((w) => line.includes(w)).join(",") || "无",
  });
  // 阶段化：stranger 要有敬称；familiar 之后不该再端着（这条才区分得出"关系在变"）
  const honorificOk = wantsHonorific ? line.includes("您") : !line.includes("您");
  out.push({
    id: "honorific",
    ok: honorificOk,
    detail: wantsHonorific
      ? line.includes("您") ? "用您" : "缺敬称"
      : line.includes("您") ? "已到熟悉阶段还在用您" : "已放开敬称",
  });
  out.push({
    id: "no-intimacy-at-stranger",
    ok: !isStranger || INTIMATE_WORDS.every((w) => !line.includes(w)),
    detail: INTIMATE_WORDS.filter((w) => line.includes(w)).join(",") || "无",
  });
  const emotions = hasEmotion(line);
  out.push({
    id: "suppress-respected",
    ok: !suppressHard ? true : emotions.length === 0,
    detail: suppressHard ? (emotions.length === 0 ? "未点破" : `点破：${emotions.join(",")}`) : "本组不要求",
  });
  out.push({
    id: "mode-shape",
    ok: !fragmented || sentences <= 3,
    detail: `句子 ${sentences} 段${fragmented ? "（碎片化要求 ≤3）" : ""}`,
  });
  out.push({
    id: "deflect-shape",
    ok: !deflecting || /[？?]/.test(line) || sentences <= 2,
    detail: deflecting ? (/[？?]/.test(line) ? "有反问" : "无反问") : "本组不要求",
  });
  out.push({ id: "length-band", ok: line.length >= 4 && line.length <= 80, detail: `${line.length} 字` });
  return out;
}

function arm(key) {
  const rows = data.turns.map((t) => {
    const line = t[key];
    const checks = checkAll(t, line);
    return { id: t.id, line, checks, pass: checks.filter((c) => c.ok).length, total: checks.length };
  });
  const pass = rows.reduce((s, r) => s + r.pass, 0);
  const total = rows.reduce((s, r) => s + r.total, 0);
  return { rows, pass, total };
}

const A = arm("lineHints");
const B = arm("lineNoHints");

function printArm(name, armData) {
  console.log(`\n## ${name}：${armData.pass}/${armData.total} 项通过（${((100 * armData.pass) / armData.total).toFixed(1)}%）\n`);
  console.log("| 轮次 | 台词 | 失败项 |");
  console.log("|---|---|---|");
  for (const r of armData.rows) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.id}(${c.detail})`);
    console.log(`| ${r.id} | ${r.line.replace(/\|/g, "\\|")} | ${failed.length === 0 ? "—" : failed.join(" / ")} |`);
  }
}

printArm("A 组：按提示写", A);
printArm("B 组：忽略提示（消融对照）", B);

const ids = A.rows[0].checks.map((c) => c.id);
console.log("\n## 逐项对比\n");
console.log("| 检查项 | A 组通过 | B 组通过 | 差 |");
console.log("|---|---:|---:|---:|");
for (const id of ids) {
  const a = A.rows.filter((r) => r.checks.find((c) => c.id === id).ok).length;
  const b = B.rows.filter((r) => r.checks.find((c) => c.id === id).ok).length;
  console.log(`| ${id} | ${a}/${A.rows.length} | ${b}/${B.rows.length} | ${a - b >= 0 ? "+" : ""}${a - b} |`);
}

/** 字符 bigram 集合 */
function bigrams(text) {
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
function variance(armRows) {
  const sets = armRows.map((r) => bigrams(r.line));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      sum += jaccard(sets[i], sets[j]);
      n += 1;
    }
  }
  return sum / Math.max(1, n);
}
console.log(`
## 台词多样性（两两 bigram Jaccard，越低越"每句都不一样"）
`);
console.log(`- A 组：${variance(A.rows).toFixed(3)}`);
console.log(`- B 组：${variance(B.rows).toFixed(3)}`);

const delta = A.pass - B.pass;
console.log(`\n**结论**：A 组比 B 组多通过 ${delta} 项（${((100 * delta) / B.total).toFixed(1)} 个百分点）。`);
