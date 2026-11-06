#!/usr/bin/env node
/**
 * 早报生成器：把夜里的事实拼成一份可交付的 markdown。
 *
 *   node tools/report/morning-report.mjs           # 写 docs/MORNING-REPORT-<日期>.md
 *   node tools/report/morning-report.mjs --dry     # 只打印，不落盘
 *
 * 原则：只写能从数据里取到的；判断（成效/问题/下一步）留给人补，脚本不编。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dry = process.argv.includes("--dry");
const stamp = new Date();
const pad = (n) => String(n).padStart(2, "0");
const day = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`;

function runNode(script, args) {
  try {
    return execFileSync(process.execPath, [script, ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const out = typeof err.stdout === "string" ? err.stdout : "";
    return `${out}\n（这一项取证失败：${String(err.status ?? "?")}）`;
  }
}

const night = runNode(join(repo, "tools", "report", "night-summary.mjs"), []);
const health = runNode(join(repo, "scripts", "autonomy", "health.mjs"), []);

function countEvents(dir) {
  if (!existsSync(dir)) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson")) continue;
    files += 1;
    try {
      lines += readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim() !== "").length;
    } catch {
      // 读不到就当 0：报表不能因为一个坏文件整份不出来
    }
  }
  return { files, lines };
}
const execEvents = countEvents(join(repo, "data", "execution"));

// 昨夜新增的 F 编号：从缺口台账里按标题日期过滤（只列标题，不复述正文）
function recentGaps(text, day, lookbackDays = 1) {
  const out = [];
  const re = /^## (F\d+)（(\d{4}-\d{2}-\d{2})[^）]*）(.+)$/gm;
  const today = Date.parse(`${day}T00:00:00Z`);
  let m = re.exec(text);
  while (m !== null) {
    const at = Date.parse(`${m[2]}T00:00:00Z`);
    if (Number.isFinite(at) && today - at <= lookbackDays * 86_400_000 && today - at >= 0) {
      out.push({ id: m[1], when: m[2], title: m[3].trim() });
    }
    m = re.exec(text);
  }
  return out;
}
const notesPath = join(repo, "docs", "V5.4-P1-NOTES.md");
const gaps = existsSync(notesPath) ? recentGaps(readFileSync(notesPath, "utf8"), day) : [];

// 计划里还没做完的条目（⬜ 或「未完成」），只取标题行前 120 字
function unfinishedPlan() {
  const p = join(repo, "docs", "PLAN-SPINE.md");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((line) => /⬜|未完成|未做/.test(line) && line.trim() !== "")
    .slice(0, 6)
    .map((line) => line.replace(/^[-*]\s*/, "").trim().slice(0, 120));
}

// 表达质量：她说过的话里有没有元叙述/自述框架/复读（新问题才算）
function voiceLine() {
  try {
    const out = execFileSync(process.execPath, [join(repo, "tools", "audit", "check-voice.mjs")], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().split("\n")[0];
  } catch (err) {
    const out = typeof err.stdout === "string" ? err.stdout.trim() : "";
    return out === "" ? "表达质量检查失败（未取到输出）" : `${out.split("\n").slice(-1)[0]}`;
  }
}
const voiceText = voiceLine().replace(/^表达质量检查：/u, "");

const snapshotDir = join(repo, "data", "archive", "snapshots", day);
const snapshotToday = existsSync(join(snapshotDir, "manifest.json"));
const learnLine = /- 学习拍数：([^\n]+)/.exec(night);
const selftalkLine = /- 内部言语：([^\n]+)/.exec(night);

// 从夜间取证里抠几个数，拼成「一句话」；抠不到就诚实说缺失
function pick(re, text) {
  const m = re.exec(text);
  return m === null ? "?" : m[1];
}
const knowledgeCount = pick(/- 总条数：([0-9]+)（原始行/, night);
const memoryLine = /## 记忆（L1）[\s\S]*?- 总条数：([0-9]+)，活跃 ([0-9]+)/.exec(night);
const memoryCount = memoryLine === null ? "?" : memoryLine[1];
const memoryActive = memoryLine === null ? "?" : memoryLine[2];
const beatLine = /- 心跳：([^\n]+)/.exec(night);
const beatText = beatLine === null ? "取证缺失" : beatLine[1];

const nightBody = night
  .replace(/^# 夜间取证[^\n]*\n[^\n]*\n\n/, "")
  .split("\n")
  .map((line) => (line.startsWith("## ") ? `### ${line.slice(3)}` : line))
  .join("\n");

// 意向引擎：她这一拍在想什么（看板接早报；取不到就诚实说缺，不编）
function intentFacts() {
  try {
    const out = execFileSync(process.execPath, [join(repo, "tools", "intent", "dashboard.mjs"), "--json"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const payload = JSON.parse(out);
    const report = payload.report ?? {};
    const lines = Array.isArray(report.lines) ? report.lines : [];
    if (lines.length === 0) return ["- 意向引擎：看板没有给出指标行（结构与预期不符）"];
    const approx = Number(payload.approximated ?? 0);
    const corrupt = Number(payload.corrupt ?? 0);
    const head =
      `- 样本：${String(payload.records ?? 0)} 拍（来源 \`${String(payload.file ?? "?")}\`` +
      `${approx > 0 ? `，离线近似 ${String(approx)} 拍` : ""}${corrupt > 0 ? `，坏行 ${String(corrupt)}` : ""}）`;
    return [head, ...lines.map((line) => `- ${line}`)];
  } catch {
    return ["- 意向引擎还没有真实样本（重启后第一拍起写 `data/intent-live-shadow-<id>.ndjson`）"];
  }
}
const intentLines = intentFacts();

// 一昼夜活动（F211 的 `tools/intent/activity.mjs`）：只搬事实行与提示，不在早报里另算一遍。
function activityFacts() {
  try {
    const out = execFileSync(process.execPath, [join(repo, "tools", "intent", "activity.mjs"), "--json"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const payload = JSON.parse(out);
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    if (lines.length === 0) return ["- 活动汇总没有给出事实行（结构与预期不符）"];
    return [
      ...lines.slice(1).map((line) => `- ${line}`),
      ...(warnings.length === 0 ? [] : ["- 提示：" + warnings.join("；")]),
      ...(Array.isArray(payload.diagnostics) && payload.diagnostics.length > 0
        ? ["- 读取异常：" + payload.diagnostics.join("；")]
        : []),
    ];
  } catch {
    return ["- 活动汇总跑不起来（可能需要先 `npm run build`）"];
  }
}
const activityLines = activityFacts();

const body = `# 早报 ${day}

> 生成时间：${stamp.toISOString()}（本地 ${day} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}）
> 取证生成：\`tools/report/morning-report.mjs\`；判断段由人补，脚本不编。

## 一、一句话

她还在跑：心跳 ${beatText}；知识 ${knowledgeCount} 条、记忆 ${memoryCount} 条（活跃 ${memoryActive}）。下面是她这一夜留下的可取证据，以及需要人判断的部分。

## 二、她今晚做了什么

${nightBody}

## 三、进程与通道

\`\`\`
${health.trim()}
\`\`\`

- 执行层事件：${String(execEvents.files)} 个文件、${String(execEvents.lines)} 行（\`data/execution/\`）

## 四、成效

事实（脚本取的，能复现）：

- 学习：${learnLine === null ? "取证缺失" : learnLine[1]}
- 内部言语：${selftalkLine === null ? "取证缺失" : selftalkLine[1]}
- 执行层事件：${String(execEvents.files)} 个文件、${String(execEvents.lines)} 行；今日数据快照：${snapshotToday ? "已生成" : "未生成"}
- 表达质量：${voiceText}

### 意向引擎（她这一拍在想什么）

${intentLines.join("\n")}

- 原始观测：\`data/intent-live-shadow-<id>.ndjson\`；复跑 \`npm run intent:dashboard\`

### 她的意图活动（一昼夜）

${activityLines.join("\n")}

- 复跑 \`npm run intent:activity\`（同一份数据，只读）

判断（需要人写，不代写）：

<!-- judgment:start -->
- （待补）学到的内容里有多少是新的、多少是同质重复
- （待补）对话里有没有真的用上记忆与知识（举一条真机回复）
- （待补）她这一夜的表达是否像人（不是「像助手」）
<!-- judgment:end -->

## 五、问题与修复（昨夜清单）

${gaps.length === 0 ? "- 昨夜没有新增 F 编号（缺口台账 `docs/DESIGN.md`）" : gaps.map((g) => `- **${g.id}**（${g.when}）${g.title}`).join("\n")}

## 六、对终极目标的下一步建议

<!-- next:start -->
- （待补）承接「独立常驻个体，DSH 仅作桥接端口」：下一步三件事＋理由
<!-- next:end -->
- 计划里还没做完的（自动摘录，判断仍需人写）：
${unfinishedPlan().length === 0 ? "  - （计划文档里没有 ⬜/未完成 条目）" : unfinishedPlan().map((l) => `  - ${l}`).join("\n")}

## 七、取证命令（可复现）

\`\`\`bash
npm run report:night
node scripts/autonomy/health.mjs
npm run intent:dashboard -- --json
node tools/report/morning-report.mjs --dry
npm run gate
\`\`\`
`;

const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg === undefined ? join(repo, "docs", `MORNING-REPORT-${day}.md`) : resolve(targetArg.slice("--target=".length));

// 判断段是人写的：重跑时从旧文件里的标记之间原样搬回来，别让脚本的"事实刷新"擦掉判断。
// 用 indexOf 切片而不是 RegExp：标记里有 "<!--"，拼进正则容易踩转义坑。
function sliceBetween(text, tag) {
  const open = `<!-- ${tag}:start -->`;
  const close = `<!-- ${tag}:end -->`;
  const a = text.indexOf(open);
  if (a < 0) return null;
  const b = text.indexOf(close, a);
  if (b < 0) return null;
  const bodyText = text.slice(a + open.length, b).trim();
  if (bodyText === "" || bodyText.includes("（待补）")) return null;
  return bodyText;
}
function replaceBetween(text, tag, replacement) {
  const open = `<!-- ${tag}:start -->`;
  const close = `<!-- ${tag}:end -->`;
  const a = text.indexOf(open);
  if (a < 0) return text;
  const b = text.indexOf(close, a);
  if (b < 0) return text;
  return text.slice(0, a + open.length) + "\n" + replacement + "\n" + text.slice(b);
}
let prevText = "";
if (existsSync(target)) {
  try { prevText = readFileSync(target, "utf8"); } catch { prevText = ""; }
}
let finalBody = body;
for (const tag of ["judgment", "next"]) {
  const kept = sliceBetween(prevText, tag);
  if (kept === null) continue;
  finalBody = replaceBetween(finalBody, tag, kept);
}
if (dry) {
  process.stdout.write(body);
} else {
  writeFileSync(target, finalBody, "utf8");
  process.stdout.write(`写好了：${target}\n`);
}
