/**
 * 插件侧三个 HTTP 端点的处理函数（F277：从 `plugin/index.ts` 搬出来）。
 *
 * 为什么单独放这里：审计 R4 文本规则禁止装配点文件直接写 HTML / `res.end(`。
 * 这些函数是「web 实现细节」，不是装配逻辑；装配点只保留注册与拆除（effect）。
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

import { pollQrLogin, requestQrLogin, saveBiliSession } from "../../bili/auth.js";
import { loadBiliSession } from "../../bili/public.js";
import { AVATAR_PATH } from "./assets.js";

/** 宿主配置里这三个端点在意的字段（结构子集，不 import 装配根类型） */
export interface HandlerConfig {
  readonly dataDir: string;
  readonly characterId: string;
  /**
   * 显示名（F326 方案 A）：只用于 UI 文案，不参与头像解析。
   * 头像按 characterId 找 assets/<characterId>.<ext>，没有就 404。
   */
  readonly displayName?: string;
}

/** 宿主传进来的 Node `ServerResponse` 的最小形状（与装配点里的同名接口结构一致） */
export interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  /** 二进制（png/jpg）用 Uint8Array 写 */
  end(body: string | Uint8Array): void;
}

export type RouteHandler = (req: unknown, res: WebResponseLike) => void;

/** 包内 assets 目录（dist/plugin/../../assets） */
function resolveAssetsDir(): string {
  return fileURLToPath(new URL("../../assets", import.meta.url));
}

/** 头像基名：F326 起按 characterId 找资源，名本体只接受安全字符 */
function avatarNameFrom(conf: HandlerConfig, url: string): string | null {
  const wanted = conf.characterId;
  // characterId 参与文件路径，必须过白名单字符校验（防目录穿越/符号链接）
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(wanted)) return null;
  let asked: string | null = null;
  try {
    asked = new URL(url, "http://localhost").searchParams.get("f");
  } catch {
    asked = null;
  }
  // 带了参数就必须与 characterId 一致（防止用同一个端点放任意文件名进来）
  if (asked !== null && asked !== wanted) return null;
  return wanted;
}

/** 头像扩展名按顺序探测：找到第一个存在的资源就用它 */
const AVATAR_EXTS: readonly string[] = [".png", ".jpg", ".jpeg", ".webp"];

function readAvatarWithExt(dir: string, base: string): { readonly bytes: Uint8Array; readonly name: string } | null {
  for (const ext of AVATAR_EXTS) {
    const name = `${base}${ext}`;
    const bytes = readAvatarBytes(dir, name);
    if (bytes !== null) return { bytes, name };
  }
  return null;
}

function readAvatarBytes(dir: string, name: string): Uint8Array | null {
  const full = resolve(dir, name);
  if (full !== resolve(dir, basename(name))) return null;
  if (!full.startsWith(`${resolve(dir)}${sep}`)) return null;
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}

function contentTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

/** 显示名只用于页面文案：转义后再拼进 HTML，避免配置里出现标签字符。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}

/** 极简页面：深色、二维码居中、每 2 秒问一次状态。不引前端框架，字符串就是全部。 */
export function buildBiliQrPage(endpoint: string, displayName?: string): string {
  // F326：人格卡删除后不再硬编码角色名；有 displayName 用显示名，没有就用中性的「她」。
  const who = escapeHtml(displayName?.trim() || "她");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>B 站登录 · ${who}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 50% -10%,#241033 0%,#0b0512 55%,#070310 100%);
    color:#f3e8ff;font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .card{width:360px;padding:26px 24px;border-radius:18px;text-align:center;
    background:rgba(19,10,30,.82);border:1px solid rgba(255,158,214,.28);
    box-shadow:0 20px 60px rgba(0,0,0,.55),0 0 40px rgba(167,139,250,.12);backdrop-filter:blur(8px)}
  h1{margin:0 0 4px;font-size:17px;font-weight:600;letter-spacing:.5px}
  .sub{margin:0 0 18px;font-size:12px;color:#b9a8d6}
  .qr{width:280px;height:280px;margin:0 auto;border-radius:14px;background:#fff;padding:8px;
    box-shadow:0 0 30px rgba(255,158,214,.25)}
  .qr img{width:100%;height:100%;display:block;border-radius:8px}
  .status{margin-top:16px;font-size:13px;min-height:20px;color:#e9d5ff}
  .hint{margin-top:10px;font-size:12px;color:#8e7fae}
  button{margin-top:16px;padding:8px 18px;border-radius:999px;cursor:pointer;
    border:1px solid rgba(255,158,214,.45);background:rgba(255,158,214,.12);color:#ffd6ec;font-size:13px}
  button:hover{background:rgba(255,158,214,.2)}
  .ok{color:#7ef0c0}
  .err{color:#ffb3c0}
</style>
<body><div class="card">
  <h1>让${who}自己登录 B 站</h1>
  <p class="sub">用手机上的哔哩哔哩 App 扫码，确认后登录态会存到本机</p>
  <div class="qr"><img id="qr" alt="登录二维码" src=""></div>
  <div class="status" id="status">正在取二维码…</div>
  <div class="hint">登录态只写进本机 <code>data/bili-*.json</code>，不进日志、不进对话。</div>
  <button id="refresh" type="button">换个码</button>
</div>
<script>
(function(){
  var endpoint = ${JSON.stringify(endpoint)};
  var key = null, timer = null;
  var img = document.getElementById("qr");
  var status = document.getElementById("status");
  function say(text, cls){ status.textContent = text; status.className = "status" + (cls ? " " + cls : ""); }
  function stop(){ if (timer) { clearInterval(timer); timer = null; } }
  function fresh(){
    stop(); say("正在取二维码…");
    fetch(endpoint + "?api=1", {cache:"no-store"}).then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.ok) { say("取二维码失败：" + (d && d.detail ? d.detail : "未知错误"), "err"); return; }
      key = d.key; img.src = d.dataUrl; say("等你扫码");
      timer = setInterval(poll, 2000);
    }).catch(function(e){ say("取二维码失败：" + e, "err"); });
  }
  function poll(){
    if (!key) return;
    fetch(endpoint + "?check=" + encodeURIComponent(key), {cache:"no-store"}).then(function(r){ return r.json(); }).then(function(d){
      if (!d) return;
      if (d.status === "waiting") return;
      if (d.status === "scanned") { say("扫到了，等你在手机上点确认"); return; }
      if (d.status === "success") { stop(); say(d.detail, "ok"); img.style.opacity = "0.35"; return; }
      if (d.status === "expired") { stop(); say("二维码过期了，点下面换一个", "err"); return; }
      say(d.detail || "登录失败", "err");
    }).catch(function(){ /* 网络抖动就算了，下轮再问 */ });
  }
  document.getElementById("refresh").addEventListener("click", fresh);
  if ("__LOGGED_IN__" === "true") { say("本机已有登录态；扫一次会覆盖成新号"); }
  fresh();
})();
</script>
</body></html>`;
}

/** 人格卡头像端点：`GET <AVATAR_PATH>?f=<文件名>` */
export function createAvatarHandler(conf: HandlerConfig): RouteHandler {
  const assetsDir = resolveAssetsDir();
  return (req, res) => {
    try {
      const url = String((req as { url?: string } | null)?.url ?? "");
      const base = avatarNameFrom(conf, url);
      if (base === null) {
        res.writeHead(404, {});
        res.end("no avatar");
        return;
      }
      const avatar = readAvatarWithExt(assetsDir, base);
      if (avatar === null) {
        res.writeHead(404, {});
        res.end("avatar missing");
        return;
      }
      res.writeHead(200, {
        "content-type": contentTypeOf(avatar.name),
        "cache-control": "public, max-age=86400",
      });
      res.end(avatar.bytes);
    } catch (err) {
      res.writeHead(500, {});
      res.end(`avatar error: ${String(err)}`);
    }
  };
}

/** 扫码登录页：`/plugins/ai-companion-engine/bili-qr`（`?api=1` 出 JSON，`?check=<key>` 轮询） */
export const BILI_QR_PATH = "/plugins/ai-companion-engine/bili-qr";

export function createBiliQrHandler(input: { conf: HandlerConfig; log?: (line: string) => void }): RouteHandler {
  const { conf, log } = input;
  const sessionPath = (): string => join(conf.dataDir, `bili-${conf.characterId}.json`);
  // 轮询每 2 秒一次，只在状态变化时写日志，避免刷屏；失败时把 detail 一起记下，方便事后取证。
  const lastPollStatus = new Map<string, string>();
  const html = buildBiliQrPage(BILI_QR_PATH, conf.displayName);
  return (req, res) => {
    let url: URL;
    try {
      url = new URL(String((req as { url?: string } | null)?.url ?? ""), "http://localhost");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad url");
      return;
    }
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      try {
        const check = url.searchParams.get("check");
        if (check !== null) {
          const r = await pollQrLogin({ log: (line) => log?.(`ai-companion-engine: ${line}`) }, check);
          if (lastPollStatus.get(check) !== r.status) {
            lastPollStatus.set(check, r.status);
            log?.(`ai-companion-engine: 扫码状态 ${r.status}${r.detail === "" ? "" : `（${r.detail}）`}`);
          }
          if (r.status === "success" && r.session !== undefined) {
            saveBiliSession(sessionPath(), r.session);
            json(200, { status: "success", detail: "登录成功：登录态已写入本机，可以关掉这页" });
            return;
          }
          json(200, { status: r.status, detail: r.detail });
          return;
        }
        if (url.searchParams.get("api") === "1") {
          const s = await requestQrLogin();
          const dataUrl = await QRCode.toDataURL(s.url, { margin: 1, width: 280, errorCorrectionLevel: "M" });
          json(200, { ok: true, key: s.key, dataUrl });
          return;
        }
        const loggedIn = loadBiliSession(conf.dataDir, conf.characterId) !== null;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html.replace("__LOGGED_IN__", loggedIn ? "true" : "false"));
      } catch (err) {
        json(500, { status: "failed", detail: err instanceof Error ? err.message : String(err) });
      }
    })();
  };
}

/** 头像端点路径（装配点注册时用，避免两处各写一遍） */
export const AVATAR_ROUTE_PATH = AVATAR_PATH;

/** UI 面板数据端点：`GET /plugins/ai-companion-engine/state-v2`。
 *
 * 读文件的两件事（意图事实、状态快照）由装配点以回调递进来——
 * 工具层不 import 大脑实现（R3），但可以决定怎么把它们端出去。 */
export const PANEL_STATE_PATH = "/plugins/ai-companion-engine/state-v2";

/**
 * 面板「当场回一句」端点（F299 / 审计 P1-9 交互半）。
 *
 * 工具层只做协议部分：只收 POST、限长、JSON 形状校验、把业务回调的结论写成 JSON。
 * 「收件箱里有没有这条、写什么回执、缺省话术是什么」都在大脑层
 * （`orchestrator/intent/panel-answer.ts`），由装配点注入——否则规则又跑回工具层。
 */
export const ANSWER_PATH = "/plugins/ai-companion-engine/answer";

/** 面板按钮的三个动作（与两种通道各自的 verdict 枚举分开） */
export type PanelAnswerAction = "answer" | "later" | "decline";

export interface PanelAnswerBody {
  readonly target: "dsh" | "guardian";
  readonly id: string;
  readonly action: PanelAnswerAction;
  readonly note?: string;
}

const ANSWER_MAX_BODY = 8 * 1024;
const ANSWER_ACTIONS: readonly PanelAnswerAction[] = ["answer", "later", "decline"];

export function parsePanelAnswerBody(raw: unknown): PanelAnswerBody | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "请求体必须是 JSON 对象" };
  const body = raw as Record<string, unknown>;
  const target = body.target;
  if (target !== "dsh" && target !== "guardian") return { error: "target 只能是 dsh 或 guardian" };
  const id = body.id;
  if (typeof id !== "string" || id.trim() === "") return { error: "缺少请求 id" };
  const action = body.action;
  if (typeof action !== "string" || !ANSWER_ACTIONS.includes(action as PanelAnswerAction)) {
    return { error: `action 只能是 ${ANSWER_ACTIONS.join(" / ")}` };
  }
  const note = body.note;
  if (note !== undefined && typeof note !== "string") return { error: "note 必须是字符串" };
  return {
    target,
    id,
    action: action as PanelAnswerAction,
    ...(note === undefined ? {} : { note }),
  };
}

interface AnswerRequestLike {
  readonly method?: string;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
}

export function createAnswerHandler(input: {
  answer: (body: PanelAnswerBody) => { ok: boolean; detail: string };
}): RouteHandler {
  const { answer } = input;
  return (req, res) => {
    const request = req as AnswerRequestLike;
    if (request.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, detail: "这个端点只收 POST" }));
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooBig = false;
    const finish = (raw: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, detail: "请求体不是合法 JSON" }));
        return;
      }
      const body = parsePanelAnswerBody(parsed);
      if ("error" in body) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, detail: body.error }));
        return;
      }
      try {
        const outcome = answer(body);
        res.writeHead(outcome.ok ? 200 : 409, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(outcome));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, detail: `回执没写成：${String(err)}` }));
      }
    };
    request.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > ANSWER_MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooBig) {
        res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, detail: "请求体太大（上限 8 KB）" }));
        return;
      }
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, detail: "请求体读失败" }));
    });
  };
}


export function createStateHandler(input: { buildPayload: () => unknown }): RouteHandler {
  const { buildPayload } = input;
  return (req, res) => {
    void req;
    try {
      const payload = buildPayload();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `状态读取失败：${String(err)}` }));
    }
  };
}
