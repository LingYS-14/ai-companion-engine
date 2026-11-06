#!/usr/bin/env node
// QQ 通道自检：把"他能不能正常跟她聊天"拆成可执行的断言，逐条打印 PASS/FAIL。
//
// 为什么要有这个脚本：这条链路横跨三样东西——SnowLuma（OneBot 服务）、中继子进程（WS→JSONL）、
// 插件（判定→生成→窗口发送）。任何一段断了，现象都是"发消息没回"，但修法完全不同。
// 所以自检不只看"能不能发"，而是分四段各验一次：
//   1. SnowLuma HTTP 活着且登录的是预期账号；
//   2. WS 中继仍在收心跳（说明"收"这一半通）；
//   3. 插件已挂上 OneBot 且不是 dryRun（否则它永远不回）；
//   4. 入站整条流水线：注入一条测试事件 → 等日志出现 replied → 说明"判定+生成+发送"都跑了。
//
// 第 4 步默认**不会**往你的 QQ 发消息：注入一条带「（自检消息」标记的事件，
// 插件照常判定+生成，但把回复拦在发送之前（日志出现 "selfcheck held"）。
// 这样反复自检不会再往聊天记录里塞重复的「在呀」；
// 真想验一次真实投递，加 --deliver（那一句会真的发出去）。
//
// 用法：
//   node tools/report/qq-selfcheck.mjs              # 全量（生成但不发送）
//   node tools/report/qq-selfcheck.mjs --deliver    # 真发一条，验窗口通道投递
//   node tools/report/qq-selfcheck.mjs --no-send    # 不注入，只验通道与配置
//   node tools/report/qq-selfcheck.mjs --timeout 90 # 等回复的秒数（默认 60）

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");
const CHAR = process.env["ACE_CHARACTER"] ?? "assistant";

const args = process.argv.slice(2);
const noSend = args.includes("--no-send");
const deliver = args.includes("--deliver");
const timeoutArg = args.indexOf("--timeout");
const WAIT_SEC = timeoutArg >= 0 ? Number(args[timeoutArg + 1] ?? "60") : 60;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** SnowLuma 的端点与 token 都在它自己的配置里（运行实例目录，不是安装副本）。 */
function snowluma() {
  const candidates = [
    join(ROOT, ".tmp-probe", "snowluma-config.json"),
    process.env["ACE_ONEBOT_CONFIG"] ?? join(ROOT, "onebot.json"),
  ];
  for (const path of candidates) {
    const cfg = readJson(path);
    if (cfg === null) continue;
    // 结构的实际形状是 { mode, networks: { httpServers, wsServers, ... } }——早期版本
    // 我曾按顶层 httpServers 读，结果"配置可读"这条一直 FAIL 而通道其实是好的。
    const net = cfg.networks ?? cfg;
    const http = net.httpServers?.[0];
    const ws = net.wsServers?.[0];
    if (http?.port === undefined) continue;
    return {
      baseUrl: `http://${http.host ?? "127.0.0.1"}:${http.port}`,
      token: String(http.accessToken ?? ""),
      wsUrl: `ws://${ws?.host ?? "127.0.0.1"}:${ws?.port ?? 3001}`,
      wsToken: String(ws?.accessToken ?? ""),
    };
  }
  return null;
}

async function callOneBot(ep, action, body) {
  const res = await fetch(`${ep.baseUrl}/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 中继 JSONL 的最后一行心跳距今多久（毫秒）；读不到返回 null */
function heartbeatAgeMs() {
  const path = join(DATA, `onebot-relay-${CHAR}.jsonl`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (rec?.kind !== "event" || typeof rec.data !== "string") continue;
    let event;
    try {
      event = JSON.parse(rec.data);
    } catch {
      continue;
    }
    const ms = typeof event?.time === "number" ? event.time * 1000 : undefined;
    if (event?.post_type === "meta_event" && ms !== undefined) return Date.now() - ms;
  }
  return null;
}

const ep = snowluma();
check("SnowLuma 配置可读（HTTP 端点 + token）", ep !== null, ep === null ? "找不到 onebot_*.json" : ep.baseUrl);

if (ep !== null) {
  try {
    const r = await callOneBot(ep, "get_login_info");
    const uid = r.json?.data?.user_id;
    check(
      "SnowLuma 在线且已登录",
      r.json?.status === "ok" && typeof uid === "number",
      `user_id=${uid ?? "?"} nickname=${r.json?.data?.nickname ?? "?"}`,
    );
    const friends = await callOneBot(ep, "get_friend_list");
    const list = Array.isArray(friends.json?.data) ? friends.json.data : [];
    const peer = list.find((f) => String(f.user_id) === "10000001");
    check("对聊对象在好友列表里", peer !== undefined, peer === undefined ? "没找到 10000001" : `10000001 ${peer.remark ?? peer.nickname ?? ""}`);
  } catch (err) {
    check("SnowLuma 在线且已登录", false, `请求失败：${String(err)}`);
  }
}

const age = heartbeatAgeMs();
check(
  "WS 中继仍在收心跳（收消息这一半通）",
  age !== null && age < 120_000,
  age === null ? "中继 JSONL 里没有心跳" : `最近心跳 ${Math.round(age / 1000)}s 前`,
);

const report = readJson(join(DATA, "apply-report.json"));
check("插件已挂上 OneBot 监听", report?.onebot === "listening", `apply-report.onebot=${report?.onebot ?? "?"}`);
const registered = Array.isArray(report?.registered) ? report.registered : [];
check(
  "工具面完整（含 soul_qq_status / soul_qq_poll）",
  registered.includes("soul_qq_status") && registered.includes("soul_qq_poll"),
  `${registered.length} 个工具`,
);

const state = readJson(join(DATA, `qq-${CHAR}.json`));
check("QQ 桥有状态文件（游标/去重表）", state !== null, state === null ? "缺失，可能从未跑过" : `cursor=${state.cursorEpochNs ?? 0} replied=${(state.repliedIds ?? []).length}`);

const logPath = join(DATA, `qq-${CHAR}.log`);
const logSizeBefore = existsSync(logPath) ? statSync(logPath).size : 0;

if (!noSend) {
  const messageId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const event = {
    time: Math.floor(Date.now() / 1000),
    self_id: 10000002,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    user_id: 10000001,
    message_id: messageId,
    message: [{ type: "text", data: { text: "（自检消息，别慌）在吗？我想确认我们还能正常说话。" } }],
    raw_message: "（自检消息，别慌）在吗？我想确认我们还能正常说话。",
    sender: { user_id: 10000001, nickname: "用户" },
  };
  const relayPath = join(DATA, `onebot-relay-${CHAR}.jsonl`);
  appendFileSync(relayPath, JSON.stringify({ kind: "event", data: JSON.stringify(event) }) + "\n", "utf8");
  console.log(`\n已注入一条测试入站消息（message_id=${messageId}），等最多 ${WAIT_SEC}s 看是否回信…\n`);

  const deadline = Date.now() + WAIT_SEC * 1000;
  let replied = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (!existsSync(logPath)) continue;
    const size = statSync(logPath).size;
    if (size <= logSizeBefore) continue;
    // 只认**这次注入之后追加的字节**。早先版本读文件末尾 4000 字找 "replied"，
    // 会把上一轮的旧回复当成本轮结果——报告全绿，其实什么都没发生。
    const appended = readFileSync(logPath).subarray(logSizeBefore).toString("utf8");
    const fresh = appended.split(String.fromCharCode(10)).filter((l) => l.trim() !== "");
    const line = fresh.find((l) =>
      deliver ? l.includes("[onebot] replied") : l.includes("[onebot] selfcheck held"),
    );
    if (line !== undefined) {
      replied = line.trim();
      break;
    }
    const failed = fresh.find((l) => l.includes("[onebot] send-failed") || l.includes("[onebot] llm-failed"));
    if (failed !== undefined) {
      replied = null;
      console.log(`出现失败行：${failed.trim()}`);
      break;
    }
  }
  if (deliver) {
    check(
      "端到端：收到消息 → 判定 → 生成 → 发送成功",
      replied !== null,
      replied === null ? "等不到 replied（看她是否真的回了你的 QQ）" : replied.slice(0, 160),
    );
    const sent = replied !== null && replied.includes("window:");
    check("发送走的是窗口通道（电脑端也能看到）", sent, sent ? "detail 含 window:" : "不是窗口通道发的，电脑端可能看不到");
  } else {
    check(
      "端到端：收到消息 → 判定 → 生成（回复被拦下，不发进真实聊天）",
      replied !== null,
      replied === null ? "等不到 selfcheck held（插件没消费注入事件？）" : replied.slice(0, 160),
    );
    check("没有往真实 QQ 发送", replied !== null && !replied.includes("window:"), replied === null ? "无生成结果" : "回复只写进了日志");
  }
} else {
  console.log("\n--no-send：跳过端到端注入（不会真的发消息）\n");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 条通过`);
if (failed.length > 0) {
  console.log("需要处理的：");
  for (const f of failed) console.log(` - ${f.name}${f.detail === undefined ? "" : `（${f.detail}）`}`);
  process.exit(1);
}
