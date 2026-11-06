// OneBot WS 中继：由宿主插件以独立 node 子进程启动（宿主里个别 node 路径会用到
// ELECTRON_RUN_AS_NODE=1），拿到未被 Electron 改写的 WebSocket/fetch。
// 用法：node ws-relay.mjs <wsUrl> <token> <outFile>
// 事件按行写 JSON（JSONL）；断线 3s→30s 退避重连；收到 SIGTERM/SIGINT 时退出。
// 启动/连上各写一条 relay 记录（带 pid），让宿主日志在没有进程表的情况下也能证明它活着。
import { appendFileSync } from "node:fs";
import { connect as netConnect } from "node:net";

const [wsUrl, token, outFile] = process.argv.slice(2);
if (!wsUrl || !outFile) {
  process.stderr.write("usage: ws-relay.mjs <wsUrl> <token> <outFile>\n");
  process.exit(2);
}

let attempt = 0;
let closed = false;
let socket = null;

const out = (line) => {
  try {
    appendFileSync(outFile, line + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`write failed: ${String(err)}\n`);
  }
};

const backoff = () => Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 4));

// undici 的 WebSocket 在连接失败时只给一个 message 为空的 TypeError，拿不到
// ECONNREFUSED 之类的真实原因。这里在报错后自己探一次 TCP，把「端口没人听」
// 和「握手/鉴权失败」区分开——日志里必须能直接读出是哪一种。
function probeTcp(wsUrl, done) {
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    done("wsUrl 无法解析");
    return;
  }
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
  const host = parsed.hostname;
  const socket = netConnect({ host, port });
  let settled = false;
  const finish = (msg) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    done(msg);
  };
  socket.setTimeout(1500, () => finish(`TCP ${host}:${port} 探测超时（ETIMEDOUT）`));
  socket.once("connect", () => finish(`TCP ${host}:${port} 可达 → 失败在 WS 握手/鉴权层，不是端口没开`));
  socket.once("error", (err) => finish(`TCP ${host}:${port} 不可达：${String(err.code ?? err.message)}`));
}

function connect() {
  if (closed) return;
  const url = token === "" ? wsUrl : `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    schedule(`ctor: ${String(err)}`);
    return;
  }
  socket = ws;
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    attempt = 0;
    out(JSON.stringify({ kind: "relay", at: "open" }));
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    out(JSON.stringify({ kind: "event", data: event.data }));
  });
  ws.addEventListener("error", (event) => {
    // 这里必须把真实原因打出来。以前只取 raw.error/raw.message，而 Node 的
    // ErrorEvent.message 对连接失败经常是空串、raw.error 是 TypeError 实例，
    // String(TypeError) 恒为 "TypeError" —— 日志等于没有诊断信息。
    const err = event && typeof event === "object" ? event.error : undefined;
    let detail;
    if (err instanceof Error) {
      detail = `${err.name}: ${err.message || "(空 message)"}${err.code ? ` [${String(err.code)}]` : ""}`;
      // undici 的 WebSocket 常把真正的系统错误塞进 cause（如 ECONNREFUSED），
      // 只打外层 TypeError 仍然等于没诊断，所以把 cause 链也摊出来。
      let cause = err.cause;
      for (let depth = 0; depth < 3 && cause !== undefined && cause !== null; depth += 1) {
        detail +=
          cause instanceof Error
            ? ` <- ${cause.name}: ${cause.message || "(空 message)"}${cause.code ? ` [${String(cause.code)}]` : ""}`
            : ` <- ${String(cause)}`;
        cause = cause instanceof Error ? cause.cause : undefined;
      }
    } else if (err !== undefined && err !== null) {
      detail = String(err);
    } else if (event && typeof event.message === "string" && event.message.length > 0) {
      detail = event.message;
    } else {
      detail = `未提供原因（readyState=${String(ws.readyState)}，url=${url}）`;
    }
    process.stderr.write(`[relay] ws error: ${detail}
`);
    probeTcp(url, (msg) => {
      process.stderr.write(`[relay] 诊断: ${msg}
`);
    });
  });
  ws.addEventListener("close", (event) => {
    socket = null;
    const code = event && typeof event.code === "number" ? event.code : "?";
    const reason = event && typeof event.reason === "string" && event.reason.length > 0 ? event.reason : "（无 reason）";
    if (!closed) process.stderr.write(`[relay] close code=${String(code)} reason=${reason}\n`);
    if (!closed) schedule(opened ? "closed" : "closed-before-open");
  });
}

function schedule(why) {
  const delay = backoff();
  attempt += 1;
  process.stderr.write(`[relay] ${why}; retry in ${delay}ms (n=${attempt})\n`);
  setTimeout(connect, delay);
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    closed = true;
    try {
      socket?.close(1000, "stop");
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}

out(JSON.stringify({ kind: "relay", at: "start", pid: process.pid }));
connect();
