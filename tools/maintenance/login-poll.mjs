// 轮询 B站扫码登录：成功后按插件的格式原子写 bili_credential.json。
// 用法：node login-poll.mjs <qrcode_key> [maxSeconds]
import { writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const home = "C:\\Users\\user\\.dsh\\bili-duty";
const key = process.argv[2];
const maxSec = Number(process.argv[3] ?? 220);
const logPath = join(home, "login-poll.log");

function log(line) {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

if (key === undefined || key === "") {
  log("FAIL 没有 qrcode key");
  process.exit(2);
}

const deadline = Date.now() + maxSec * 1000;
log(`start key=${key.slice(0, 8)}… maxSec=${String(maxSec)}`);

function fromUrl(raw) {
  const out = {};
  if (typeof raw !== "string" || raw === "") return out;
  const q = raw.indexOf("?");
  const body = q < 0 ? raw : raw.slice(q + 1);
  for (const part of body.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = decodeURIComponent(part.slice(0, eq));
    const v = decodeURIComponent(part.slice(eq + 1));
    if (k === "SESSDATA" || k === "sessdata") out.sessdata = v;
    if (k === "bili_jct") out.bili_jct = v;
    if (k === "DedeUserID") out.dedeuserid = v;
    if (k === "buvid3") out.buvid3 = v;
  }
  return out;
}

function fromCookies(list) {
  const out = {};
  for (const c of list) {
    const first = c.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const k = first.slice(0, eq).trim();
    const v = first.slice(eq + 1).trim();
    if (k === "SESSDATA") out.sessdata = v;
    if (k === "bili_jct") out.bili_jct = v;
    if (k === "DedeUserID") out.dedeuserid = v;
    if (k === "buvid3") out.buvid3 = v;
  }
  return out;
}

async function once() {
  const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  const body = await res.json();
  const data = body?.data ?? {};
  const code = data.code;
  if (code === 86101) return { state: "waiting" };
  if (code === 86090) return { state: "scanned" };
  if (code === 86038) return { state: "expired" };
  if (code !== 0) return { state: `unknown:${String(code)}` };
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const merged = { ...fromUrl(String(data.url ?? "")), ...fromCookies(setCookies) };
  return { state: "done", cred: merged };
}

for (;;) {
  if (Date.now() > deadline) {
    log("TIMEOUT 没等到扫码成功");
    process.exit(3);
  }
  try {
    const r = await once();
    if (r.state === "done") {
      const cred = r.cred ?? {};
      if (typeof cred.sessdata !== "string" || cred.sessdata === "") {
        log("DONE but no SESSDATA（登录只成功一半）");
        process.exit(4);
      }
      const out = {
        sessdata: cred.sessdata,
        bili_jct: cred.bili_jct ?? "",
        buvid3: cred.buvid3 ?? "",
        dedeuserid: cred.dedeuserid ?? "",
      };
      const target = join(home, "bili_credential.json");
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), { encoding: "utf8" });
      renameSync(tmp, target);
      log(`DONE 凭证已写入 keys=${Object.keys(out).filter((k) => out[k] !== "").join(",")}`);
      process.exit(0);
    }
    if (r.state === "expired") {
      log("EXPIRED 二维码过期");
      process.exit(5);
    }
    if (r.state === "scanned") log("scanned 已扫码，等确认");
  } catch (err) {
    log(`ERR ${err instanceof Error ? err.message : String(err)}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
