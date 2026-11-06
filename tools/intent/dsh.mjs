#!/usr/bin/env node
/**
 * DSH 收件箱 CLI —— 人这一侧的「她 → DSH」通道（P1 / 计划 §2.6 方向二）。
 *
 * 为什么是 CLI 而不是让本体去猜：她求助时写 `data/dsh-inbox-<id>.ndjson`，
 * 回执由**人/代理**写 `data/dsh-reply/<id>.json`。这个脚本只读收件箱、只写回执文件，
 * 不碰她的进程、不调模型、不发 QQ。
 *
 *   node tools/intent/dsh.mjs list                     # 看她在问什么（默认）
 *   node tools/intent/dsh.mjs answer <id> --answer "…" # 回答
 *   node tools/intent/dsh.mjs answer <id> --decline    # 帮不了（带一句原因）
 *   node tools/intent/dsh.mjs answer <id> --later      # 稍后
 *   node tools/intent/dsh.mjs resolve                  # 请求×回执汇总
 *
 * 所有时间只用来**读**（判断是否超时）；写回执用当前时间，由脚本取一次。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 代码根固定为脚本所在仓库/运行时仓库（发布后脚本在 runtime 里，也能找到 dist/）。
const CODE_ROOT = resolve(HERE, "..", "..");

const HELP = `用法： node tools/intent/dsh.mjs <命令> [参数]

命令：
  list（默认）             看她的 DSH 收件箱：谁在等回音、问了什么、试过什么、还有多久超时
  answer <id> --answer "…"  回答（会写成 $data/dsh-reply/<id>.json，她下一拍读到）
  answer <id> --decline [--note "…"]   帮不了，给她一句原因
  answer <id> --later [--note "…"]     稍后再说
  resolve                  请求×回执的汇总（含超时判定）
  --json                   输出机器可读 JSON
  --root <目录>            数据根目录（默认：本脚本所在的运行时/仓库根）
  --character <id>         角色 id（默认 assistant）
  --by <名字>              回执署名（默认 lead）
  --help                   打这段帮助
`;

function loadModule() {
  // 发布后 dist 与 tools 同级；开发时也是在 CODE_ROOT/dist。
  return import(pathToFileURL(join(CODE_ROOT, "dist", "orchestrator", "intent", "dsh-bridge.js")).href);
}

function parseArgs(argv) {
  const out = { _: [], json: false, root: CODE_ROOT, character: "assistant", by: "lead", answer: undefined, note: undefined, verdict: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--character") out.character = argv[++i];
    else if (a === "--by") out.by = argv[++i];
    else if (a === "--answer") out.answer = argv[++i];
    else if (a === "--note") out.note = argv[++i];
    else if (a === "--decline") out.verdict = "declined";
    else if (a === "--later") out.verdict = "later";
    else if (a.startsWith("--")) throw new Error(`未知参数：${a}`);
    else out._.push(a);
  }
  return out;
}

function readJsonLines(file) {
  if (!existsSync(file)) return { lines: [], exists: false };
  const text = readFileSync(file, "utf8");
  return { lines: text.split(/\r?\n/).filter((l) => l.trim().length > 0), exists: true };
}

function readReplies(dir) {
  const replies = new Map();
  if (!existsSync(dir)) return { replies, errors: [] };
  const errors = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (typeof raw !== "object" || raw === null || typeof raw.id !== "string") {
        errors.push(`${name}：形状不对`);
        continue;
      }
      replies.set(raw.id, raw);
    } catch (err) {
      errors.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { replies, errors };
}

function statusZh(status) {
  switch (status) {
    case "pending":
      return "等回音";
    case "answered":
      return "已答";
    case "declined":
      return "帮不了";
    case "later":
      return "稍后";
    case "expired":
      return "已超时";
    default:
      return status;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const mod = await loadModule();
  const dataDir = join(resolve(args.root), "data");
  const inbox = mod.dshInboxPath(dataDir, args.character);
  const replyDir = mod.dshReplyDir(dataDir);

  const cmd = args._[0] ?? "list";
  const nowMs = Date.now();
  const { lines } = readJsonLines(inbox);
  const parsed = mod.parseDshInbox(lines.join("\n"));
  const { replies, errors: replyErrors } = readReplies(replyDir);

  // 用现成的 fail-closed 解析把坏回执挑出来；坏文件不参与配对。
  const goodReplies = new Map();
  for (const [id, raw] of replies) {
    const reply = mod.parseDshReply(raw);
    if (reply === null) replyErrors.push(`${id}.json：形状不对`);
    else goodReplies.set(id, reply);
  }

  if (cmd === "list") {
    const rows = parsed.asks.map((ask) => {
      const res = mod.resolveDshAsk(ask, goodReplies.get(ask.id) ?? null, nowMs);
      return { ...ask, status: res.status, fact: res.fact, reply: goodReplies.get(ask.id) ?? null };
    });
    if (args.json) {
      process.stdout.write(JSON.stringify({ inbox, replyDir, asks: rows, errors: [...parsed.errors, ...replyErrors] }, null, 2) + "\n");
      return 0;
    }
    if (rows.length === 0) {
      process.stdout.write(
        `DSH 收件箱是空的：她还没通过 DSH 求助过（这不等于「没人管」，只等于「还没开口」）。\n路径：${inbox}\n`,
      );
      return 0;
    }
    process.stdout.write(`她的 DSH 收件箱（${String(rows.length)} 条）：\n`);
    for (const row of rows) {
      process.stdout.write(`\n[${statusZh(row.status)}] ${row.id}\n`);
      process.stdout.write(`  时间：${row.at}（${row.kind}）\n`);
      process.stdout.write(`  想问：${row.text}\n`);
      if (row.tried.length > 0) process.stdout.write(`  试过：${row.tried.join("；")}\n`);
      if (row.reply !== null) process.stdout.write(`  回执：${row.reply.by} / ${row.reply.answer || row.reply.verdict}\n`);
      else if (row.status !== "expired") process.stdout.write(`  超时：${row.expiresAt}\n`);
      if (row.fact !== null) process.stdout.write(`  她会记住：${row.fact}\n`);
    }
    if (parsed.errors.length > 0) process.stdout.write(`\n坏的 inbox 行：${String(parsed.errors.length)} 条\n`);
    process.stdout.write(`\n回法：node tools/intent/dsh.mjs answer <id> --answer "……"\n`);
    return 0;
  }

  if (cmd === "resolve") {
    const rows = parsed.asks.map((ask) => {
      const res = mod.resolveDshAsk(ask, goodReplies.get(ask.id) ?? null, nowMs);
      return { id: ask.id, status: res.status, fact: res.fact };
    });
    const counts = rows.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
    if (args.json) {
      process.stdout.write(JSON.stringify({ counts, rows, errors: [...parsed.errors, ...replyErrors] }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      `请求 ${String(rows.length)} 条：已答 ${String(counts.answered ?? 0)} / 等答复 ${String(counts.pending ?? 0)} / 已超时 ${String(
        counts.expired ?? 0,
      )} / 帮不了 ${String(counts.declined ?? 0)} / 稍后 ${String(counts.later ?? 0)}\n`,
    );
    for (const row of rows) {
      const fact = row.fact === null ? "（还没结果）" : `→ 事实：${row.fact}`;
      process.stdout.write(`- ${row.id}：${statusZh(row.status)} ${fact}\n`);
    }
    return 0;
  }

  if (cmd === "answer") {
    const id = args._[1];
    if (typeof id !== "string" || id.length === 0) {
      process.stderr.write("缺少请求 id：node tools/intent/dsh.mjs answer <id> --answer \"…\"\n");
      return 2;
    }
    const ask = parsed.asks.find((a) => a.id === id);
    if (ask === undefined) {
      process.stderr.write(`收件箱里没有 ${id}：不写回执（避免她收到对不上的回答）。\n`);
      return 1;
    }
    const verdict = args.verdict ?? (args.answer !== undefined ? "answered" : "");
    if (verdict === "") {
      process.stderr.write("需要 --answer \"…\" 或 --decline / --later。\n");
      return 2;
    }
    let answer = args.answer ?? args.note ?? "";
    if (verdict === "answered" && answer.trim().length === 0) {
      process.stderr.write("--answer 不能为空（回答她之前先说点什么）。\n");
      return 2;
    }
    if (verdict === "declined" && answer.trim().length === 0) answer = "这个我暂时帮不了，抱歉。";
    if (verdict === "later" && answer.trim().length === 0) answer = "稍等，我手头还有点事。";
    const reply = mod.buildDshReply({ id, atMs: nowMs, by: args.by, verdict, answer });
    mkdirSync(replyDir, { recursive: true });
    const file = join(replyDir, `${id}.json`);
    writeFileSync(file, mod.serializeDshReply(reply), "utf8");
    process.stdout.write(`已写回执：${file}\n`);
    process.stdout.write(`她会记住：${mod.resolveDshAsk(ask, reply, nowMs).fact ?? "（已答）"}\n`);
    return 0;
  }

  process.stderr.write(`未知命令：${cmd}\n\n${HELP}`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`dsh.mjs 出错：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
