#!/usr/bin/env node
/**
 * 自主进程健康检查（一次性，只读）。
 *
 *   node scripts/autonomy/health.mjs            # 人类可读
 *   node scripts/autonomy/health.mjs --json     # 机器可读
 *   node scripts/autonomy/health.mjs --onebot-port 3999   # 换一个 OneBot 探测端口（模拟「依赖不在」）
 *
 * 退出码：0 一切正常（最多只有 ⚠）；1 有需要人工处理的问题
 *         （进程不在 / 心跳过期 / QQ 桥没有移交 / 日志有硬错误 / 外部依赖不在）。
 *
 * 为什么要有它：她现在是常驻进程，出问题不会弹窗，只会安静地不学习、不说话。
 * 06:00 报告、守夜人排查、以及「我怀疑她停了」这三件事都应该先跑它，而不是翻日志。
 *
 * 环境变量：ACE_CHARACTER_ID（默认 assistant）、ACE_DATA_DIR（默认 <repo>/data）、
 *          ACE_ONEBOT_HOST（默认 127.0.0.1）、ACE_ONEBOT_PROBE_PORT（单端口）、
 *          ACE_ONEBOT_PROBE_PORTS（逗号分隔，默认 3000,3001 —— 同一个 OneBot 的 HTTP/WS 端口，任一可连即在线）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const characterId = process.env.ACE_CHARACTER_ID ?? "assistant";
const dataDir = resolve(process.env.ACE_DATA_DIR ?? join(repo, "data"));
const json = process.argv.includes("--json");

const MINUTE = 60_000;
const BEAT_STALE_MS = 20 * MINUTE;
const LOCK_STALE_MS = 10 * MINUTE;

/**
 * 日志行时间戳：F278（2026-10-31T18:14:12Z）起由毫秒级改成秒级，两种都得认。
 * 旧写法 `line.slice(0, 24)` 只对毫秒级行成立；秒级行被截成非时间文本后 Date.parse 变 NaN，
 * 让 [state] 计数与「依赖报错是否新鲜」都误判（R8）。
 */
const LOG_TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;
const logLineAt = (line) => {
  const m = LOG_TS.exec(line);
  return m === null ? Number.NaN : Date.parse(m[1]);
};

const checks = [];
const problems = [];

function check(name, ok, detail, severity = "problem") {
  const warn = !ok && severity === "warn";
  checks.push({ name, ok, detail, warn });
  if (!ok && severity === "problem") problems.push(`${name}：${detail}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const now = Date.now();

// 心跳先读：进程探针在受限沙箱里会假阴性（看不到别的进程），要能退回心跳判定
const beat = readJson(join(dataDir, `autonomy-${characterId}.beat`));
const beatAgeMin = beat?.at ? Math.round((now - Number(beat.at)) / MINUTE) : null;
const beatFresh = beatAgeMin !== null && beatAgeMin * MINUTE <= BEAT_STALE_MS;
const beatPid = Number(beat?.pid);

// 1. 进程
const pidFile = join(dataDir, `autonomy-${characterId}.pid`);
const pidRaw = readText(pidFile)?.trim() ?? "";
// pid 文件是 JSON（{pid,startedAt,...}），兼容旧的纯数字写法
const pid = Number(readJson(pidFile)?.pid ?? pidRaw);
const pidText = `pid=${Number.isInteger(pid) && pid > 0 ? String(pid) : "（无）"}`;
const alive = pidAlive(pid);
// 探针在沙箱里可能直接看不到进程（EAR 权限/隔离）；此时若同一 pid 的心跳仍新鲜，
// 说明它确实在跑——只把「探针看不到」当结论会让守夜人和我误判。
const inferredAlive = !alive && beatFresh && beatPid === pid;
check(
  "进程",
  alive,
  inferredAlive
    ? `${pidText}（看不到进程，但同 pid 的心跳还新鲜——可能是受限环境假阴性，也可能是刚退出；下一拍照样会暴露）`
    : pidText,
  inferredAlive ? "warn" : "problem",
);

check(
  "心跳",
  beatFresh,
  beatAgeMin === null ? "没有心跳文件（进程从未跑过 tick）" : `${String(beatAgeMin)} 分钟前，ran=${Array.isArray(beat.ran) ? beat.ran.join("+") : "?"}`,
);

// 3. 写锁归属（QQ 桥必须由常驻进程持有，宿主只观察）
// 旧版锁（没有 version）是 DSH 宿主里旧模块定时器的残留心跳：lock.ts 把它们当"没有锁"，
// 常驻进程每 30 秒会覆盖它一次，所以它是噪音，不是"宿主正在写"。
const lock = readJson(join(dataDir, ".writer-lock"));
const lockOwner = lock?.owner ?? "（无锁）";
const lockAgeMin = lock?.heartbeatAt ? Math.round((now - Number(lock.heartbeatAt)) / MINUTE) : null;
const legacyLock = lock !== null && lock.version !== 2;
const lockDetail = `${String(lockOwner)}${lockAgeMin === null ? "" : `，${String(lockAgeMin)} 分钟前心跳`}`;
if (legacyLock) {
  check("写锁", false, `旧版锁残留（${lockDetail}，没有 version 字段）——宿主旧定时器在刷，常驻进程每 30s 覆盖，可忽略`, "warn");
} else {
  check("写锁", lockOwner === "autonomy" || lock === null, lockDetail, "problem");
}

// 4. 插件侧报告：onebot 是否已移交
// 这份报告由 DSH 插件**启动时**写；数据被清空后插件不会重写（它没有重启），
// 所以「报告缺失」不等于「桥没移交」——再看 relay 里最近 2 分钟有没有 OneBot 心跳事件。
// 心跳事件是 OneBot 真的连上了才会有的，它比文件存在更接近事实。
const report = readJson(join(dataDir, "apply-report.json"));
const relayHeartbeatFresh = (() => {
  try {
    return now - statSync(join(dataDir, `onebot-relay-${characterId}.jsonl`)).mtimeMs <= 2 * MINUTE;
  } catch {
    return false;
  }
})();
const onebot = report?.onebot ?? (relayHeartbeatFresh ? "delegated（报告缺失，按 relay 心跳推断）" : "（无报告）");
const onebotOk = onebot === "delegated" || onebot.startsWith("delegated");
check("QQ 桥", onebotOk, `onebot=${String(onebot)}${report?.error ? `，error=${String(report.error)}` : ""}`);

// 4.5 外部依赖：QQ 侧的 OneBot 服务端是否在监听（她的对外通道）
// 为什么单列：OneBot 没起时她自己的代码完全正常，但日志每 30 秒刷一条 relay 传输层错误；
// 老版本把这些算进「日志异常 ✗」，看起来像她的 bug（2026-10-30 18:18–22:30 实例：n=456）。
// 这里只做 TCP 连通性探测：不发消息、不带 token、不碰任何业务接口。
const ONEBOT_HOST = process.env.ACE_ONEBOT_HOST ?? "127.0.0.1";
const ONEBOT_PROBE_TIMEOUT_MS = 1500;
const probePorts = (() => {
  const argAt = process.argv.indexOf("--onebot-port");
  const raw = argAt >= 0 ? process.argv[argAt + 1] : process.env.ACE_ONEBOT_PROBE_PORT;
  const one = Number(raw);
  if (Number.isInteger(one) && one > 0 && one < 65536) return [one];
  const many = process.env.ACE_ONEBOT_PROBE_PORTS;
  if (many) {
    const list = many
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (list.length > 0) return list;
  }
  // OneBot 的 HTTP(3000) 与 WS(3001) 属于同一个依赖：任一端口可连就说明它在
  return [3000, 3001];
})();

function probeTcp(host, port) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = connect({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(ONEBOT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const onebotUpPorts = [];
for (const port of probePorts) {
  if (await probeTcp(ONEBOT_HOST, port)) {
    onebotUpPorts.push(port);
    break;
  }
}
const onebotUp = onebotUpPorts.length > 0;
const onebotPortsText = probePorts.join("/");
check(
  "外部依赖",
  onebotUp,
  onebotUp
    ? `OneBot 在监听（${ONEBOT_HOST}:${String(onebotUpPorts[0])} 可连，QQ 通道在）`
    : `OneBot 端口 ${ONEBOT_HOST}:${onebotPortsText} 都连不上（外部依赖不在）——她发不出去，但她的代码没问题；`
      + "去查 QQ 端 OneBot（NapCat/LLOneBot）是否在跑、端口是否与 cordis.patch.yml 的 onebot.baseUrl/wsUrl 一致",
  onebotUp ? "info" : "problem",
);

// 5. 审核票据
const review = readJson(join(dataDir, "autonomy-review.json"));
// 票据不是故障：它是"她在退避"的自我保护。用 ⚠ 表示，既不误报成 ✗，也不装作没事。
check("审核票据", review === null, review === null ? "没有待审票据" : `有票据：她正在退避（${String(review.reason ?? "?")}，at=${String(review.at ?? "?")}），窗口回落后会自动解除，90 分钟 TTL 兜底`, "warn");

// 6. 最近一小时模型调用（上限按峰谷算，不写死 12：峰时 6/h、谷时 12/h，休息日 ×1.5）
const usage = readJson(join(dataDir, "autonomy-usage.json"));
const calls = Array.isArray(usage?.calls) ? usage.calls.filter((t) => now - Number(t) < 60 * MINUTE) : [];
let cap = 12;
let phaseLabel = "谷时";
try {
  // 与她自己用的同一份定价逻辑（repo 布局与 runtime 布局里 dist 都在 scripts 的上一级）
  const { pacingFor, isRestDay } = await import(new URL("../../dist/autonomy/pricing.js", import.meta.url).href);
  // 休息日上限 ×1.5（与她自己算的同一口径；F235：此前漏传 restDay，周六 8 次被误报成超峰时 6）
  const localDay = new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
  const restDay = isRestDay(localDay);
  const pacing = pacingFor({ now, tzOffsetMinutes: 8 * 60, restDay });
  cap = pacing.maxCallsPerHour;
  phaseLabel = `${pacing.phase === "peak" ? "峰时" : "谷时"}${restDay ? "·休息日" : ""}`;
} catch {
  // 拿不到就退回旧口径，但明确标注
  phaseLabel = "谷时（定价模块未加载，按旧口径）";
}
const quotaLeft = Math.max(0, cap - calls.length);
  const quotaPct = cap === 0 ? 0 : Math.round((quotaLeft / cap) * 100);
  check(
    "模型调用/小时",
    calls.length <= cap,
    `${String(calls.length)} 次（${phaseLabel}上限 ${String(cap)}/h，余量 ${String(quotaLeft)} 次 / ${String(quotaPct)}%）`,
  );

// 7. 学习轮转
const learn = readJson(join(dataDir, `autonomy-learn-${characterId}.json`));
check(
  "学习轮转",
  learn !== null,
  learn === null
    ? "还没有轮转文件"
    : `rotation=${String(learn.rotation)}，上次 keyword=${String(learn.lastKeyword ?? "?")}，空转 ${String(learn.idleRounds ?? 0)} 轮`,
  "info",
);

// 8. 规模
const knowledgeLines = readText(join(dataDir, `knowledge-${characterId}.ndjson`))?.split("\n").filter((l) => l.trim() !== "").length ?? 0;
const memoryLines = readText(join(dataDir, `memory-${characterId}.ndjson`))?.split("\n").filter((l) => l.trim() !== "").length ?? 0;
check("规模", knowledgeLines > 0, `知识 ${String(knowledgeLines)} 条 / 记忆文件 ${String(memoryLines)} 行（WAL 含历史 upsert）`, "info");

// 8.5 执行队列（at-least-once 的重试队列；积压说明有一类动作一直失败）
const queue = readJson(join(dataDir, "execution", "autonomy-queue.json"));
const queueItems = Array.isArray(queue?.items) ? queue.items : [];
const queuePending = queueItems.filter((i) => i?.state === "pending");
const queueOldest = queuePending.length > 0 ? Math.min(...queuePending.map((i) => Number(i.enqueuedAt) || now)) : null;
check(
  "执行队列",
  queueItems.length <= 20,
  queueItems.length === 0
    ? "空"
    : `${String(queueItems.length)} 条（待跑 ${String(queuePending.length)}，最早 ${String(queueOldest === null ? 0 : Math.max(0, Math.round((now - queueOldest) / MINUTE)))} 分钟前入队）`,
  queueItems.length > 20 ? "warn" : "info",
);

// 8.6 意图节拍（P1/P2：她自己决定“想做什么”的拍子；这里只读落盘事实，不参与任何判定）
// 为什么放在 health 里：她如果不拍，不会报错、也不会弹窗，表现就是“一整天没主动说话”——
// 和“她性格安静”在日志里长得一样。这条把它变成一秒钟能看见的事实。
const liveLines = readText(join(dataDir, `intent-live-shadow-${characterId}.ndjson`))?.split("\n").filter((l) => l.trim() !== "") ?? [];
let lastTick = null;
for (let i = liveLines.length - 1; i >= 0 && lastTick === null; i -= 1) {
  try {
    const row = JSON.parse(liveLines[i]);
    if (row !== null && typeof row === "object" && typeof row.at === "number") lastTick = row;
  } catch {
    // 坏行跳过：观测文件不是状态文件，不值得为一行废掉整项检查
  }
}
const tickAgeMin = lastTick === null ? null : Math.max(0, Math.round((now - lastTick.at) / MINUTE));
const tickOutlet = lastTick?.outlet !== null && typeof lastTick?.outlet === "object" ? lastTick.outlet.target : "?";
const tickReplay = lastTick?.replay !== null && typeof lastTick?.replay === "object" ? (lastTick.replay.threads ?? []).length : 0;
check(
  "意图节拍",
  tickAgeMin !== null && tickAgeMin <= 15,
  lastTick === null
    ? "还没有拍记录（刚重启，或 ACE_INTENT_ENGINE 没开）"
    : `${String(tickAgeMin)} 分钟前一拍：gate=${String(lastTick?.gate ?? "?")}，outlet=${String(tickOutlet)}，回放 ${String(tickReplay)} 条`,
  "warn",
);

// 8.6b 开口倾向（"她安不安静"要能被一眼看见；永远只是提示，不影响退出码）
// 为什么：用户要判断"她安静是没想说话，还是被拦住了"。health 原来只看"15 分钟有没有拍"，
// 拍到了但一整晚没开口时，日志里和"她性格安静"长得一样。这里数"这一拍她自己判定的开口倾向"，
// 不是"真的发出去几条"（发送事实在日志里），所以措辞必须标明口径。
const AIM_LOOKBACK_MS = 24 * 60 * MINUTE;
const AIM_QUIET_WARN_MS = 8 * 60 * MINUTE;
const aims = [];
for (const line of liveLines) {
  try {
    const row = JSON.parse(line);
    if (row === null || typeof row !== "object" || typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
    const outletTarget = row.outlet !== null && typeof row.outlet === "object" ? row.outlet.target : null;
    const aimed = row.wouldSpeak === true || outletTarget === "speak" || (row.reRaised !== null && typeof row.reRaised === "object");
    if (aimed) aims.push(row.at);
  } catch {
    // 坏行跳过（与上一项同口径）
  }
}
const recentAims = aims.filter((at) => now - at <= AIM_LOOKBACK_MS);
const lastAimAt = recentAims.length === 0 ? null : Math.max(...recentAims);
const quietAgeMin = lastAimAt === null ? null : Math.max(0, Math.round((now - lastAimAt) / MINUTE));
const lastGateNote = lastTick === null ? null : `最近一拍 gate=${String(lastTick.gate ?? "?")}`;
const quietDetail =
  lastAimAt === null
    ? liveLines.length === 0
      ? "还没有拍记录，谈不上开口"
      : `最近 24 小时没有一次开口倾向（判定口径）——安静不等于坏了，但值得看一眼她想做的事`
    : `上次想开口在 ${String(quietAgeMin)} 分钟前：24 小时内想开口 ${String(recentAims.length)} 次（判定口径，不是实际发送数）${lastGateNote === null ? "" : `；${lastGateNote}`}`;
check("开口", lastAimAt !== null && quietAgeMin !== null && quietAgeMin <= AIM_QUIET_WARN_MS / MINUTE, quietDetail, "warn");

// 8.6c 对外通道（脊髓熔断，F267；审计 B.6：熔断以前只在内存里，"有没有生效"无法验证）
const spineRaw = readText(join(dataDir, `spine-${characterId}.json`));
let spineSnap = null;
if (spineRaw !== null) {
  try {
    const value = JSON.parse(spineRaw);
    if (value !== null && typeof value === "object" && typeof value.state === "string") spineSnap = value;
  } catch {
    // 坏文件按"没有记录"处理，不猜是闭合
  }
}
if (spineSnap === null) {
  check("对外通道", true, "还没有熔断记录（进程还没触发过通道失败，或本版之前未落盘）", "info");
} else {
  // 快照是「写入时刻的事实」，不是「此刻的事实」：daemon 重启后若还没有新的发送结果，
  // 文件里可能留着上一次的 open，但 openUntilMs 早已过去。这里按 openUntilMs 计算有效态，
  // 避免把陈旧快照当成「仍在熔断」误报（task-162；2026-11-03 实例：快照 10:25 open，
  // 桥 12:53 已恢复，health 仍显示「熔断中到 02:35:17」）。
  const state = String(spineSnap.state);
  const failures = Number.isFinite(Number(spineSnap.failures)) ? Number(spineSnap.failures) : 0;
  const atMs = Number(spineSnap.atMs);
  const openUntilMs = spineSnap.openUntilMs === null || spineSnap.openUntilMs === undefined ? null : Number(spineSnap.openUntilMs);
  const atText = Number.isFinite(atMs)
    ? `${new Date(atMs).toISOString().slice(11, 19)}（${String(Math.max(0, Math.floor((now - atMs) / MINUTE)))} 分钟前）`
    : "时间未知";
  const cooled = state === "open" && Number.isFinite(openUntilMs) && now >= openUntilMs;
  if (state === "closed") {
    check("对外通道", true, `闭合（连续失败 ${String(failures)} 次；快照 ${atText}）`, "info");
  } else if (state === "half-open" || cooled) {
    check(
      "对外通道",
      true,
      `半开（${state === "half-open" ? "熔断冷却已过，等下一次发送探针" : "快照是 open 但冷却期已过，等下一次发送探针"}；快照 ${atText}，连续失败 ${String(failures)} 次）`,
      "info",
    );
  } else {
    const remainMin = Number.isFinite(openUntilMs) ? Math.max(0, Math.ceil((openUntilMs - now) / MINUTE)) : null;
    const until = Number.isFinite(openUntilMs) ? new Date(openUntilMs).toISOString().slice(11, 19) : "时间未知";
    check(
      "对外通道",
      false,
      `熔断中：${state === "half-open" ? "半开探针" : "闭合拒绝发送"}，到 ${until}${remainMin === null ? "" : `（剩余约 ${String(remainMin)} 分钟）`}（连续失败 ${String(failures)} 次；快照 ${atText}；期间她不会生成也不发送）`,
      "warn",
    );
  }
}

// 8.6d 状态写入仲裁（F258/F272：主写者/次要写者 + 写通道；审计 P0-4）
// 拒绝覆盖 = 插件（次要写者）还活着且在尝试写——要么 DSH 没重启（旧插件），要么写通道没接上。
// 主写者覆盖警告 = 磁盘上的状态被别的进程改过（少见，但出现就说明有第二个真实写者）。
const stateLogText = readText(join(dataDir, `autonomy-${characterId}.log`)) ?? "";
let stateRejects = 0;
let stateOverwrites = 0;
for (const line of stateLogText.split("\n")) {
  if (!line.includes("[state]")) continue;
  const at = logLineAt(line);
  if (!Number.isFinite(at) || now - at > 24 * 60 * MINUTE) continue;
  if (line.includes("拒绝覆盖")) stateRejects += 1;
  else if (line.includes("overwrite-warning")) stateOverwrites += 1;
}
check(
  "状态写入",
  stateRejects === 0 && stateOverwrites === 0,
  stateRejects === 0 && stateOverwrites === 0
    ? "24 小时内没有拒绝覆盖 / 主写者覆盖记录（次要写者没在写状态）"
    : `24 小时内有 ${String(stateRejects)} 次拒绝覆盖、${String(stateOverwrites)} 次主写者覆盖警告（看日志里的 [state] 行；拒绝=插件还在试图写）`,
  stateRejects > 0 || stateOverwrites > 0 ? "warn" : "info",
);

// 8.6e 写通道（F290）：插件把写操作投给常驻进程的唯一入口。
// 文件缺失 / pid 对不上 / token 异常，都意味着「插件那边看起来只是写失败」，得有人看得见。
const channel = readJson(join(dataDir, `write-channel-${characterId}.json`));
let channelOk = true;
let channelDetail;
if (channel === null) {
  channelOk = false;
  channelDetail = "没有通道文件（插件的写操作会直接报错；本版之前启动的进程没有它）";
} else {
  const bad = [];
  const channelPid = Number(channel.pid);
  if (channel.version !== 1) bad.push(`版本 ${String(channel.version)} 不是 1`);
  if (!Number.isInteger(channelPid) || channelPid !== pid) {
    bad.push(`通道属于 pid ${String(channel.pid)}，但当前进程是 ${String(pid)}（可能双实例或旧文件）`);
  }
  if (typeof channel.token !== "string" || channel.token.length < 16) bad.push("token 异常（短于 16 字符）");
  const channelPort = Number(channel.port);
  if (!Number.isInteger(channelPort) || channelPort <= 0 || channelPort > 65535) {
    bad.push(`端口非法（${String(channel.port)}）`);
  }
  if (bad.length > 0) {
    channelOk = false;
    channelDetail = bad.join("；");
  } else {
    channelDetail = `127.0.0.1:${String(channelPort)}，pid=${String(channelPid)}（与当前进程一致）`;
  }
}
check(
  "写通道",
  channelOk,
  channelDetail,
  channelOk ? "info" : "warn",
);

// 8.7 监护人收件箱（她求助后没人回的那部分；2 小时没应答才是问题，刚投递不算）
const inboxLines = readText(join(dataDir, `guardian-${characterId}.ndjson`))?.split("\n").filter((l) => l.trim() !== "") ?? [];
// 回执文件名在 F269 之后是 `<安全 id>-<hash>.json`，不能再按 requestId 拼路径；按内容里的 requestId 配对。
const guardianReplyIds = new Set();
try {
  for (const name of readdirSync(join(dataDir, "guardian-reply"))) {
    if (!name.endsWith(".json")) continue;
    try {
      const reply = JSON.parse(readFileSync(join(dataDir, "guardian-reply", name), "utf8"));
      if (reply !== null && typeof reply === "object" && typeof reply.requestId === "string") {
        guardianReplyIds.add(reply.requestId);
      }
    } catch {
      // 坏回执跳过：宁可显示"还没回"，也不要把坏文件当已答
    }
  }
} catch {
  // 目录不存在 = 还没有任何回执
}
let pendingAsks = [];
for (const line of inboxLines) {
  try {
    const request = JSON.parse(line);
    if (request === null || typeof request !== "object" || typeof request.requestId !== "string") continue;
    if (guardianReplyIds.has(request.requestId)) continue;
    const at = Date.parse(String(request.at ?? ""));
    pendingAsks.push({ requestId: request.requestId, ageMs: Number.isFinite(at) ? now - at : 0 });
  } catch {
    // 坏行跳过
  }
}
const staleAsks = pendingAsks.filter((ask) => ask.ageMs > 2 * 60 * MINUTE);
check(
  "监护人收件箱",
  staleAsks.length === 0,
  inboxLines.length === 0
    ? "空（她还没求助过）"
    : pendingAsks.length === 0
      ? `${String(inboxLines.length)} 条请求，全部已有应答`
      : `${String(pendingAsks.length)} 条等应答` + (staleAsks.length > 0 ? `，其中 ${String(staleAsks.length)} 条超过 2 小时（看 \`npm run intent:guardian list\`）` : "（都还没到 2 小时）"),
  staleAsks.length > 0 ? "warn" : "info",
);

// 8.8 DSH 收件箱（方向二：她把"卡住的事"投给 DSH，我这一侧处理；2 小时没回会自动升级到监护人收件箱）
// 为什么单独一条：DSH 收件箱没人看时，她的求助会静默超时——超时后会升级，但升级本身也值得被看见。
const dshLines = readText(join(dataDir, `dsh-inbox-${characterId}.ndjson`))?.split("\n").filter((l) => l.trim() !== "") ?? [];
let dshPending = [];
for (const line of dshLines) {
  try {
    const ask = JSON.parse(line);
    if (ask === null || typeof ask !== "object" || typeof ask.id !== "string") continue;
    if (existsSync(join(dataDir, "dsh-reply", `${ask.id}.json`))) continue;
    const at = Date.parse(String(ask.at ?? ""));
    dshPending.push({ id: ask.id, ageMs: Number.isFinite(at) ? Math.max(0, now - at) : 0 });
  } catch {
    // 坏行跳过
  }
}
const dshStale = dshPending.filter((ask) => ask.ageMs > 2 * 60 * MINUTE);
check(
  "DSH 收件箱",
  dshStale.length === 0,
  dshLines.length === 0
    ? "空（她还没往 DSH 投过事）"
    : dshPending.length === 0
      ? `${String(dshLines.length)} 条，全部已回`
      : `${String(dshPending.length)} 条等回` + (dshStale.length > 0 ? `，其中 ${String(dshStale.length)} 条超过 2 小时（看 \`npm run intent:dsh list\`，超时会自动升级到监护人收件箱）` : "（都还没到 2 小时）"),
  dshStale.length > 0 ? "warn" : "info",
);

const logPath = join(dataDir, `autonomy-${characterId}.log`);
const logTail = readText(logPath)?.split("\n").slice(-400).filter((l) => l.trim() !== "") ?? [];
// 注意 `\blocked\b` 曾经是「\b + locked」的笔误：它会把 `reason=locked`（写者锁被别人拿着，
// 正常）判成日志异常。这里显式写 `\bblocked\b`，并在注释里留档，避免下次又被"看起来一样"骗过去。
const errorLines = logTail.filter(
  (l) => !l.includes(" learn topic=") && !l.includes("[autonomy] dry-run actions=") && /\berror\b|失败|异常|\bblocked\b/i.test(l),
);
// 传输层/外部依赖的报错单独归因：relay 连不上 OneBot、OneBot HTTP 发不出去。
// 端口不可达 → 它们是「外部依赖不在」的症状，全部归第 4.5 项，不算代码错误；
// 端口可达但 400 行窗口里还留着旧行 → 只算「历史」，不判红（否则 OneBot 一恢复还要红一小时）；
// 端口可达且最近 10 分钟仍有 → 真问题（配置/代码错），照旧当 hard error。
const DEPENDENCY_HINTS = ["[relay]", "closed-before-open", "relay 子进程", "onebot-http", "ws error", "ws.onerror"];
const DEPENDENCY_QUIET_MS = 10 * MINUTE;
const isDependencyLog = (l) => DEPENDENCY_HINTS.some((h) => l.includes(h));
const lineAt = (l) => {
  const t = logLineAt(l);
  return Number.isFinite(t) ? t : null;
};
const dependencyLogLines = errorLines.filter(isDependencyLog);
const freshDependencyLines = onebotUp ? dependencyLogLines.filter((l) => now - (lineAt(l) ?? 0) <= DEPENDENCY_QUIET_MS) : [];
const externalLogLines = dependencyLogLines.filter((l) => !freshDependencyLines.includes(l));
const ownErrorLines = errorLines.filter((l) => !externalLogLines.includes(l));

// 上游临时错误（5xx/超时/限流）单独算：它们会重试，不该把她的整体状态判成故障。
// 2026-10-30 实例：DeepSeek 返回 503 Service is too busy，health 报 ✗，但下一拍就正常了。
const TRANSIENT_ERROR = /LLM HTTP 5\d\d|Service is too busy|ETIMEDOUT|ECONNRESET|ECONNREFUSED|\b429\b|fetch failed/i;
const hardLines = ownErrorLines.filter((l) => !TRANSIENT_ERROR.test(l));
const transientCount = ownErrorLines.length - hardLines.length;
check(
  "日志异常",
  hardLines.length === 0,
  hardLines.length > 0
    ? `最近 400 行有 ${String(hardLines.length)} 条：${hardLines[hardLines.length - 1].slice(0, 120)}`
      + (externalLogLines.length > 0
        ? onebotUp
          ? `（另有 ${String(externalLogLines.length)} 条历史传输层行未计入代码错误）`
          : `（另有 ${String(externalLogLines.length)} 条传输层错误已归入「外部依赖」）`
        : "")
    : externalLogLines.length > 0
      ? onebotUp
        ? `最近 400 行只剩 ${String(externalLogLines.length)} 条历史传输层错误（OneBot 已恢复、10 分钟内无新的，不算代码错误）：${externalLogLines[externalLogLines.length - 1].slice(0, 120)}`
        : `最近 400 行有 ${String(externalLogLines.length)} 条传输层错误（OneBot 连不上，归入「外部依赖」，不重复计入代码错误）：${externalLogLines[externalLogLines.length - 1].slice(0, 120)}`
      : transientCount > 0
        ? `最近 400 行有 ${String(transientCount)} 条上游临时错误（5xx/超时，会重试）`
        : "最近 400 行没有异常",
  hardLines.length > 0 ? "problem" : externalLogLines.length > 0 || transientCount > 0 ? "warn" : "info",
);

if (json) {
  console.log(
    JSON.stringify(
      {
        at: now,
        characterId,
        deps: { onebot: { host: ONEBOT_HOST, ports: probePorts, reachable: onebotUpPorts } },
        checks,
        problems,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`# 自主进程健康检查（${new Date(now).toISOString()}，character=${characterId}）`);
  for (const c of checks) console.log(`${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.name}：${c.detail}`);
  if (problems.length === 0) {
    const ticketNote =
      review === null
        ? "没有待审票据。"
        : "有一张审核票据——她在退避（模型调用暂停），窗口回落后自动解除，不是故障。";
    console.log(`\n结论：正常。她在跑，QQ 桥在她手里，${ticketNote}`);
  } else {
    console.log(`\n结论：${String(problems.length)} 项需要处理——`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\n常用修法：重新拉起 = scripts/autonomy/stop.ps1 然后 start.ps1（或等守夜人 15 分钟内拉起）；");
    console.log("桥没移交 = 检查 cordis.patch.yml 的 qq.onebot.owner 是否为 autonomy，并看 data/apply-report.json；");
    if (!onebotUp) console.log(`外部依赖不在 = ${ONEBOT_HOST}:${onebotPortsText} 没人监听：先确认 QQ 端 OneBot（NapCat/LLOneBot）在跑、端口与 cordis.patch.yml 的 onebot.baseUrl/wsUrl 一致——这不是她的代码问题；`);
    console.log("票据过期 = 6 小时自动失效，不会把她永久哑掉。");
  }
}

process.exit(problems.length === 0 ? 0 : 1);
