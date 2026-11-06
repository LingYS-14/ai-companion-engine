#!/usr/bin/env node
/**
 * 监护人通道（P4，用户 m04764 难点 1：真正的难点不是"能不能说"，而是"说完没人回"）
 *
 * 她是写请求的一方（`data/guardian-<id>.ndjson` append）；**响应的一方是这里的人**——
 * 用户不在电脑旁时，由 Lead（本机代理）看到请求、写下应答文件
 * （`data/guardian-reply/<requestId>.json`），再由解析逻辑转成人话事实。
 *
 * 这个 CLI 只做三件事，全部只读或单文件写，不碰她的运行时：
 *   list    看现在有没有待回音的请求（默认命令）
 *   answer  回一条（help / later / decline），写应答文件
 *   resolve 把"请求 × 应答"解成事实（超时写成"问过，暂无回音"，不清零她的尝试次数）
 *
 * 用法：
 *   node tools/intent/guardian.mjs                      # 等同 list
 *   node tools/intent/guardian.mjs list --json
 *   node tools/intent/guardian.mjs answer grd-itn-1-123 --help --note "我在，说吧"
 *   node tools/intent/guardian.mjs answer <id> --later 2h --note "半小时后再说"
 *   node tools/intent/guardian.mjs answer <id> --decline --note "这个我帮不了"
 *   node tools/intent/guardian.mjs resolve
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const GUARDIAN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function usage() {
  return [
    "监护人通道 CLI",
    "",
    "  node tools/intent/guardian.mjs                    # 列出现在待回音的请求",
    "  node tools/intent/guardian.mjs list --json        # 机器可读",
    "  node tools/intent/guardian.mjs answer <id> --help --note \"我在\"",
    "  node tools/intent/guardian.mjs answer <id> --later 2h --note \"等我一下\"",
    "  node tools/intent/guardian.mjs answer <id> --decline --note \"这个我帮不了\"",
    "  node tools/intent/guardian.mjs resolve            # 解析出事实（超时/拒绝/答应）",
    "",
    "选项：--root <目录>（默认仓库根）、--character <id>（默认 assistant）、--from owner|lead（默认 lead）",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { command: "list", requestId: null, verdict: null, note: null, later: null, json: false, root: REPO, character: "assistant", from: "lead" };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" && (rest.length > 0 || args.requestId !== null)) args.verdict = "help";
    else if (a === "--help") return { ...args, command: "help" };
    else if (a === "--later") args.verdict = "later";
    else if (a === "--decline") args.verdict = "decline";
    else if (a === "--note") {
      args.note = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--later-ms") {
      args.later = Number(argv[i + 1] ?? "0") || null;
      i += 1;
    } else if (a === "--root") {
      args.root = resolve(argv[i + 1] ?? ".");
      i += 1;
    } else if (a === "--character") {
      args.character = argv[i + 1] ?? "assistant";
      i += 1;
    } else if (a === "--from") {
      args.from = argv[i + 1] ?? "lead";
      i += 1;
    } else rest.push(a);
  }
  if (rest.length > 0) args.command = rest[0];
  if (args.command === "answer") args.requestId = rest[1] ?? null;
  // `--later 2h` 这种写法：`--later` 后跟的是时长而不是开关
  const laterIdx = argv.indexOf("--later");
  if (laterIdx >= 0) {
    const maybeDuration = argv[laterIdx + 1];
    if (maybeDuration !== undefined && /^\d+(\.\d+)?[hm]$/.test(maybeDuration)) {
      const num = Number.parseFloat(maybeDuration);
      args.later = /h$/.test(maybeDuration) ? num * 3600 * 1000 : num * 60 * 1000;
      args.verdict = "later";
    }
  }
  return args;
}

function laterIso(ms) {
  return new Date(ms).toISOString();
}

async function loadModules() {
  // 代码（dist）永远从本仓库/运行时根加载；`--root` 只决定数据落在哪
  const base = join(REPO, "dist", "orchestrator", "intent");
  const persist = await import(`file:///${join(base, "persist.js").replace(/\\/g, "/")}`);
  const guardian = await import(`file:///${join(base, "guardian.js").replace(/\\/g, "/")}`);
  return { persist, guardian };
}

function fmtAge(nowMs, atIso) {
  const ms = nowMs - Date.parse(atIso);
  if (!Number.isFinite(ms)) return "?";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分前`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage());
    return 0;
  }

  const { persist, guardian } = await loadModules();
  const inbox = persist.guardianInboxPath(args.root, args.character);
  const replyDir = persist.guardianReplyDir(args.root);
  const nowMs = Date.now();

  const requests = persist.readGuardianRequests(inbox);
  const replies = persist.readGuardianReplies(replyDir);
  const resolutions = persist.resolveGuardianRequests(requests.requests, replies.replies, nowMs);

  if (args.command === "answer") {
    if (args.requestId === null) throw new Error("answer 需要 requestId");
    if (args.verdict === null) throw new Error("answer 需要 --help / --later <时长> / --decline 之一");
    const idx = requests.requests.findIndex((r) => r.requestId === args.requestId);
    if (idx < 0) throw new Error(`收件箱里没有这个 requestId：${args.requestId}`);
    const note = (args.note ?? "").trim() || defaultNote(args.verdict);
    const reply = {
      requestId: args.requestId,
      at: laterIso(nowMs),
      from: args.from === "owner" ? "owner" : "lead",
      verdict: args.verdict,
      note,
      ...(args.later === null ? {} : { retryAfterMs: Math.round(args.later) }),
    };
    const path = persist.writeGuardianReply(replyDir, reply);
    const resolution = guardian.resolveGuardian(requests.requests[idx], reply, nowMs);
    console.log(`已写应答：${path}`);
    console.log(`状态：${resolution.state}${resolution.note === "" ? "" : `（${resolution.note}）`}`);
    if (resolution.fact !== null) console.log(`她会记住这句：${resolution.fact}`);
    return 0;
  }

  if (args.command === "resolve") {
    const timedOut = resolutions.filter((r) => r.state === "timed-out");
    const answered = resolutions.filter((r) => r.state === "answered");
    const pending = resolutions.filter((r) => r.state === "pending");
    if (args.json) {
      console.log(JSON.stringify({ requests: requests.requests.length, answered: answered.length, pending: pending.length, timedOut: timedOut.length, resolutions, replyErrors: replies.errors, requestErrors: requests.errors }, null, 2));
      return 0;
    }
    console.log(`请求 ${requests.requests.length} 条：已答 ${answered.length} / 等答复 ${pending.length} / 已超时 ${timedOut.length}`);
    for (const [i, r] of resolutions.entries()) {
      const req = requests.requests[i];
      const fact = r.fact === null ? "" : ` → 事实：${r.fact}`;
      console.log(`- ${req.requestId} [${r.state}]${fact}`);
    }
    if (replies.errors.length > 0) console.log(`应答坏文件 ${replies.errors.length} 个：${replies.errors.join("；")}`);
    if (requests.errors.length > 0) console.log(`请求坏行 ${requests.errors.length} 条：${requests.errors.join("；")}`);
    return 0;
  }

  // list
  if (args.json) {
    console.log(JSON.stringify({ now: laterIso(nowMs), requests: requests.requests.map((r, i) => ({ ...r, resolution: resolutions[i] })), replies: replies.replies, replyErrors: replies.errors, requestErrors: requests.errors, replyDir, inbox }, null, 2));
    return 0;
  }

  if (requests.requests.length === 0) {
    console.log(`监护人收件箱是空的（${inbox}）。她现在没有需要人帮忙的事——这不算"没人管"，只算"还没开口"。`);
    return 0;
  }

  console.log(`监护人收件箱：${requests.requests.length} 条（${inbox}）`);
  for (const [i, r] of requests.requests.entries()) {
    const req = r;
    const res = resolutions[i];
    const verdict = res.state === "pending" ? "等回音" : res.state === "answered" ? `已答（${res.reply?.verdict ?? "?"}）` : "已超时";
    console.log("");
    console.log(`[${req.requestId}] ${verdict} · ${fmtAge(nowMs, req.at)} · 需要：${req.need}`);
    console.log(`  她卡在：${req.what}`);
    console.log(`  已经试过：${req.tried.join(" / ")}`);
    console.log(`  想请你：${req.ask}`);
    if (res.fact !== null) console.log(`  若就这样放着：${res.fact}`);
    console.log(`  回法：node tools/intent/guardian.mjs answer ${req.requestId} --help --note "我在，说吧"`);
  }
  if (replies.errors.length > 0) console.log(`\n应答坏文件 ${replies.errors.length} 个：${replies.errors.join("；")}`);
  return 0;
}

function defaultNote(verdict) {
  if (verdict === "help") return "我在，说吧。";
  if (verdict === "later") return "稍等，我手头还有点事。";
  return "这个我暂时帮不了，抱歉。";
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`guardian: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
