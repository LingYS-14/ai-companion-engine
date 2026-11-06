/**
 * B 站扫码登录（扫码 → 轮询 → 落盘）。
 *
 * 为什么要有这一步：现在能用她的号看 B 站，靠的是有人手动把 cookie 抄进
 * `data/bili-<id>.json`。扫码登录把这件事变成她自己的：面板上出码、手机扫、
 * 服务器把 `SESSDATA`/`bili_jct` 收下来写进同一个文件——**路径不变**，
 * 所以取数层（`public.ts`）一行都不用改。
 *
 * 两个接口（都是公开的）：
 *   - `GET /x/passport-login/web/qrcode/generate` → `{ url, qrcode_key }`
 *   - `GET /x/passport-login/web/qrcode/poll?qrcode_key=…` → `{ code, url? }`
 *     code: 0 成功 / 86101 未扫码 / 86090 已扫描待确认 / 86038 已过期。
 * 成功时 `data.url` 带着 `SESSDATA=…&bili_jct=…&DedeUserID=…`，从查询串里取即可
 * （**不**依赖 set-cookie，避免宿主 fetch 对 cookie jar 的差异）。
 *
 * 安全约定：session 值只写入数据文件，不进日志、不进工具输出；
 * 文件按 0600 落盘（Windows 上权限位不完全生效，但至少不写宽）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BiliError, type BiliSession } from "./public.js";

const PASSPORT = "https://passport.bilibili.com";
const UA = "Mozilla/5.0 ai-companion-engine";
const REFERER = "https://www.bilibili.com/";
const TIMEOUT_MS = 10_000;

/** 扫码会话：`key` 用于轮询，`url` 用来画二维码 */
export interface BiliQrSession {
  readonly key: string;
  readonly url: string;
}

/** 轮询结果：`status` 是给人看的词，`session` 只在 success 时给 */
export interface BiliQrPoll {
  readonly status: "waiting" | "scanned" | "expired" | "success" | "failed";
  readonly detail: string;
  readonly session?: BiliSession;
}

export interface BiliAuthDeps {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

interface JsonEnvelope {
  readonly code?: number;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

interface JsonEnvelopeWithCookies {
  readonly body: JsonEnvelope;
  /** 响应头里的 Set-Cookie（只取 name → value，供扫码成功时兜底取 SESSDATA） */
  readonly cookies: ReadonlyMap<string, string>;
}

function readSetCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  const anyRes = res as unknown as { headers?: { getSetCookie?: () => string[]; get?: (n: string) => string | null } };
  let lines: string[] = [];
  try {
    if (typeof anyRes.headers?.getSetCookie === "function") lines = anyRes.headers.getSetCookie();
  } catch {
    // 忽略：退回到 get("set-cookie")
  }
  if (lines.length === 0) {
    const raw = anyRes.headers?.get?.("set-cookie");
    if (typeof raw === "string" && raw !== "") lines = [raw];
  }
  for (const line of lines) {
    const first = line.split(";")[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name !== "") out.set(name, value);
  }
  return out;
}

async function getJsonFull(deps: BiliAuthDeps, url: string): Promise<JsonEnvelopeWithCookies> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    headers: { "User-Agent": UA, Referer: REFERER, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new BiliError(res.status, `扫码接口返回 HTTP ${res.status}`);
  const cookies = readSetCookies(res);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BiliError(res.status, "扫码接口返回的不是 JSON（可能被 WAF 拦了）");
  }
  return { body: (parsed ?? {}) as JsonEnvelope, cookies };
}

async function getJson(deps: BiliAuthDeps, url: string): Promise<JsonEnvelope> {
  const full = await getJsonFull(deps, url);
  return full.body;
}

/** 申请一个登录二维码；返回值里的 `url` 直接交给扫码端渲染 */
export async function requestQrLogin(deps: BiliAuthDeps = {}): Promise<BiliQrSession> {
  const body = await getJson(deps, `${PASSPORT}/x/passport-login/web/qrcode/generate`);
  if (body.code !== 0) throw new BiliError(200, body.message ?? "申请二维码失败");
  const url = typeof body.data?.["url"] === "string" ? body.data["url"] : "";
  const key = typeof body.data?.["qrcode_key"] === "string" ? body.data["qrcode_key"] : "";
  if (url === "" || key === "") throw new BiliError(200, "二维码返回里缺 url/qrcode_key");
  return { key, url };
}

/** 从回调 url 的查询串里取 session；缺 SESSDATA 视为失败 */
export function sessionFromLoginUrl(raw: string): BiliSession | null {
  // 不能走 `new URL(...).searchParams`：它会把 `%2C` 解码成逗号，而 SESSDATA 里的
  // `%2C` 是 cookie 的真实内容，解码后发回去服务器就不认了。这里按原始串取词。
  const pick = (name: string): string => {
    const m = new RegExp(`(?:^|[?&])${name}=([^&#]*)`).exec(raw);
    return m === null ? "" : (m[1] ?? "");
  };
  const sessdata = pick("SESSDATA");
  if (sessdata.trim() === "") return null;
  const jct = pick("bili_jct");
  return { sessdata, ...(jct === "" ? {} : { biliJct: jct }) };
}

/** 从 Set-Cookie 里取 session（有些账号/风控分支只给 cookie，不给回调 url） */
export function sessionFromCookies(cookies: ReadonlyMap<string, string>): BiliSession | null {
  const sessdata = (cookies.get("SESSDATA") ?? "").trim();
  if (sessdata === "") return null;
  const jct = (cookies.get("bili_jct") ?? "").trim();
  return { sessdata, ...(jct === "" ? {} : { biliJct: jct }) };
}

/** 轮询一次：调用方（页面）每 2 秒问一次即可 */
export async function pollQrLogin(deps: BiliAuthDeps, key: string): Promise<BiliQrPoll> {
  const k = key.trim();
  if (k === "") return { status: "failed", detail: "缺少 qrcode_key" };
  const full = await getJsonFull(deps, `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(k)}`);
  const body = full.body;
  const code = typeof body.data?.["code"] === "number" ? body.data["code"] : -1;
  if (code === 86101) return { status: "waiting", detail: "等待扫码" };
  if (code === 86090) return { status: "scanned", detail: "已扫码，等你在手机上确认" };
  if (code === 86038) return { status: "expired", detail: "二维码已过期，刷新一下" };
  if (code !== 0) return { status: "failed", detail: body.message ?? `未知状态 ${String(code)}` };

  const back = typeof body.data?.["url"] === "string" ? body.data["url"] : "";
  const cookieNames = Array.from(full.cookies.keys()).sort();
  // 两条路都试：回调 url（常规）→ Set-Cookie（有些分支只给 cookie）。
  const session = sessionFromLoginUrl(back) ?? sessionFromCookies(full.cookies);
  deps.log?.(
    `扫码轮询 code=0 url_len=${String(back.length)} cookie_names=[${cookieNames.join(",")}] ` +
      `got=${session === null ? "none" : "session"}`,
  );
  if (session === null) {
    const hint = back === "" ? "回调 url 为空" : "回调 url 里没有 SESSDATA";
    const cookiesHint = cookieNames.length === 0 ? "响应也没带 cookie" : `cookie 只有 [${cookieNames.join(",")}]`;
    return { status: "failed", detail: `登录只成功了一半：${hint}，${cookiesHint}` };
  }
  return { status: "success", detail: "登录成功", session };
}

/** 把 session 写进 `data/bili-<id>.json`（与读侧同一路径、同一字段名） */
export function saveBiliSession(path: string, session: BiliSession, deps: BiliAuthDeps = {}): void {
  const payload = {
    sessdata: session.sessdata,
    ...(session.biliJct === undefined ? {} : { biliJct: session.biliJct }),
    // dedeUserId 只是给人看的元数据，传输层用不到，不落盘（少一条泄露路径）
    savedAt: (deps.now ?? Date.now)(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  deps.log?.("B 站登录态已保存（内容不进日志）");
}
