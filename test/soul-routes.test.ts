import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SOUL_CSS_PATH,
  SOUL_JS_PATH,
  SOUL_PAGE_PATH,
  createSoulAssetHandler,
  createSoulPageHandler,
} from "../src/plugin/web/soul.js";
import {
  CHAT_HISTORY_PATH,
  CHAT_META_PATH,
  CHAT_SEND_PATH,
  CHAT_THROTTLE_MS,
  chatStatusOf,
  createChatHistoryHandler,
  createChatMetaHandler,
  createChatSendHandler,
} from "../src/plugin/web/chat.js";

/**
 * P4-4 P1：工作台三条只读路由。
 *
 * 为什么单测路由而不是只测整页：静态页本身是文件，加载失败时最典型的症状是
 * 404/空白/异常把宿主请求打挂——所以这里锁三件事：路径对、类型对、缺文件回 404 不抛。
 * 页面内容（HTML/CSS/JS）只做最小存在性断言，具体样式/交互留给真机与后续 P2。
 */

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string | Uint8Array): void;
}

function makeRes(): FakeResponse {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
    },
  };
}

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("P4-4 P1：工作台静态路由", () => {
  it("三条路由路径与页面同源（/soul + /plugins/ai-companion-engine/soul.{css,js}）", () => {
    expect(SOUL_PAGE_PATH).toBe("/soul");
    expect(SOUL_CSS_PATH).toBe("/plugins/ai-companion-engine/soul.css");
    expect(SOUL_JS_PATH).toBe("/plugins/ai-companion-engine/soul.js");
    const index = read("src/plugin/index.ts");
    expect(index).toContain("registerSoulRoute(");
    expect(index).toContain("createSoulPageHandler");
    expect(index).toContain("SOUL_CSS_PATH");
    expect(index).toContain("SOUL_JS_PATH");
  });

  it("首页命中：200 text/html，且引用自己的 css/js", () => {
    const res = makeRes();
    createSoulPageHandler()(undefined, res);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("灵魂 · 工作台");
    expect(res.body).toContain("/plugins/ai-companion-engine/soul.css");
    expect(res.body).toContain("/plugins/ai-companion-engine/soul.js");
  });

  it("样式与脚本命中：200 + 正确 content-type", () => {
    const css = makeRes();
    createSoulAssetHandler("soul.css", "text/css; charset=utf-8")(undefined, css);
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(css.body).toContain("--bg: #070310");

    const js = makeRes();
    createSoulAssetHandler("soul.js", "text/javascript; charset=utf-8")(undefined, js);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.body).toContain("/plugins/ai-companion-engine/state-v2");
  });

  it("文件缺失/路径穿越：404 且不抛（不能把宿主请求打挂）", () => {
    for (const name of ["missing.css", "../client.js", "/etc/passwd"]) {
      const res = makeRes();
      expect(() => createSoulAssetHandler(name, "text/plain")(undefined, res)).not.toThrow();
      expect(res.status).toBe(404);
      expect(res.body).toContain("missing");
    }
  });
});

/* ---------- P2（task-139）：聊天三条路由 ---------- */

class FakeChatRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string>;
  private readonly listeners: Record<string, Array<(arg?: Uint8Array) => void>> = {};

  constructor(options: { method?: string; url?: string; headers?: Record<string, string> } = {}) {
    this.method = options.method;
    this.url = options.url;
    this.headers = options.headers ?? {};
  }

  on(event: string, listener: (arg?: Uint8Array) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  send(body: string): void {
    const chunk = Buffer.from(body);
    for (const listener of this.listeners["data"] ?? []) listener(chunk);
    for (const listener of this.listeners["end"] ?? []) listener();
  }
}

const chatDirs: string[] = [];

function chatTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "soul-chat-"));
  chatDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (chatDirs.length > 0) {
    const dir = chatDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function bodyOf(res: FakeResponse): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

function sendHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "x-soul-csrf": "csrf-1",
    host: "localhost:3080",
    ...overrides,
  };
}

describe("P2：网页聊天路由（meta / history / send）", () => {
  it("三条路径与 index 注册点都在（页面与 daemon 对得上）", () => {
    expect(CHAT_META_PATH).toBe("/plugins/ai-companion-engine/chat/meta");
    expect(CHAT_HISTORY_PATH).toBe("/plugins/ai-companion-engine/chat/history");
    expect(CHAT_SEND_PATH).toBe("/plugins/ai-companion-engine/chat/send");
    const index = read("src/plugin/index.ts");
    expect(index).toContain("registerChatRoutes(");
    expect(index).toContain("createChatMetaHandler");
    expect(index).toContain("createChatHistoryHandler");
    expect(index).toContain("createChatSendHandler");
    // P2.1（task-157）：写通道调用下沉到 channel-chat.ts，index 只留 ChatResult 映射。
    expect(index).toContain("makeChannelChat(");
    expect(index).toContain("ChatChannelError");
  });

  it("chat/meta：200 给出 csrf 与轮询/上限参数", () => {
    const res = makeRes();
    createChatMetaHandler({ csrf: "csrf-abc" })(undefined, res);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(res)).toMatchObject({ csrf: "csrf-abc", maxChars: 2000, pollMs: 2000 });
  });

  it("chat/history：读共享文件尾部、坏行跳过、limit 生效、缺文件空列表", () => {
    const dir = chatTempDir();
    const lines = [
      { atMs: 1, who: "peer", text: "a", channel: "qq" },
      { atMs: 2, who: "her", text: "b", channel: "web" },
      { atMs: 3, who: "peer", text: "c", channel: "web" },
    ].map((e) => JSON.stringify(e));
    writeFileSync(join(dir, "chat-test.ndjson"), [...lines, "{坏行", ""].join("\n"));

    const res = makeRes();
    createChatHistoryHandler({ dataDir: dir, characterId: "test" })(
      { url: `${CHAT_HISTORY_PATH}?limit=2` },
      res,
    );
    expect(res.status).toBe(200);
    const body = bodyOf(res) as { messages: Array<{ text: string }> };
    expect(body.messages.map((m) => m.text)).toEqual(["b", "c"]);

    const empty = makeRes();
    createChatHistoryHandler({ dataDir: dir, characterId: "nobody" })({ url: CHAT_HISTORY_PATH }, empty);
    expect(bodyOf(empty)).toEqual({ messages: [] });
  });

  it("chat/send：CSRF + JSON + 节流通过后返回她的回复", async () => {
    const res = makeRes();
    const handler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: true, reply: "嗯♪", mode: "NORMAL", stage: "熟悉的伙伴" }),
    });
    const req = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    handler(req, res);
    req.send(JSON.stringify({ text: "在吗" }));
    await flush();

    expect(res.status).toBe(200);
    expect(bodyOf(res)).toMatchObject({ ok: true, reply: "嗯♪", mode: "NORMAL", stage: "熟悉的伙伴" });
  });

  it("chat/send：只收 POST（其它方法 405）", () => {
    const res = makeRes();
    createChatSendHandler({ csrf: "csrf-1", now: () => 0, call: async () => ({ ok: true, reply: "x" }) })(
      new FakeChatRequest({ method: "GET", url: CHAT_SEND_PATH, headers: sendHeaders() }),
      res,
    );
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
  });

  it("chat/send：CSRF 缺失/不匹配 → 403 且不调 daemon", () => {
    let called = 0;
    const res = makeRes();
    createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => {
        called += 1;
        return { ok: true, reply: "x" };
      },
    })(
      new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders({ "x-soul-csrf": "wrong" }) }),
      res,
    );
    expect(res.status).toBe(403);
    expect(bodyOf(res).code).toBe("csrf");
    expect(called).toBe(0);
  });

  it("chat/send：跨站请求 / 非同源 Origin → 403", () => {
    const cross = makeRes();
    createChatSendHandler({ csrf: "csrf-1", now: () => 0, call: async () => ({ ok: true, reply: "x" }) })(
      new FakeChatRequest({
        method: "POST",
        url: CHAT_SEND_PATH,
        headers: sendHeaders({ "sec-fetch-site": "cross-site" }),
      }),
      cross,
    );
    expect(cross.status).toBe(403);
    expect(bodyOf(cross).code).toBe("cross-site");

    const origin = makeRes();
    createChatSendHandler({ csrf: "csrf-1", now: () => 0, call: async () => ({ ok: true, reply: "x" }) })(
      new FakeChatRequest({
        method: "POST",
        url: CHAT_SEND_PATH,
        headers: sendHeaders({ origin: "http://evil.example" }),
      }),
      origin,
    );
    expect(origin.status).toBe(403);
    expect(bodyOf(origin).code).toBe("origin");
  });

  it("chat/send：content-type 不是 JSON → 415；请求体过大 → 413；坏 JSON/空消息 → 400", async () => {
    const wrongType = makeRes();
    createChatSendHandler({ csrf: "csrf-1", now: () => 0, call: async () => ({ ok: true, reply: "x" }) })(
      new FakeChatRequest({
        method: "POST",
        url: CHAT_SEND_PATH,
        headers: sendHeaders({ "content-type": "text/plain" }),
      }),
      wrongType,
    );
    expect(wrongType.status).toBe(415);

    const tooBig = makeRes();
    const bigHandler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: true, reply: "x" }),
    });
    const bigReq = new FakeChatRequest({
      method: "POST",
      url: CHAT_SEND_PATH,
      headers: sendHeaders(),
    });
    bigHandler(bigReq, tooBig);
    bigReq.send(JSON.stringify({ text: "x".repeat(9_000) }));
    await flush();
    expect(tooBig.status).toBe(413);

    const badJson = makeRes();
    const badHandler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: true, reply: "x" }),
    });
    const badReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    badHandler(badReq, badJson);
    badReq.send("{不是 json");
    await flush();
    expect(badJson.status).toBe(400);

    const empty = makeRes();
    const emptyHandler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: true, reply: "x" }),
    });
    const emptyReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    emptyHandler(emptyReq, empty);
    emptyReq.send(JSON.stringify({ text: "   " }));
    await flush();
    expect(empty.status).toBe(400);
    expect(bodyOf(empty).code).toBe("bad-request");
  });

  it("chat/send：1 请求 / 1.5s 节流 → 第二次 429，带 retryAfterMs", async () => {
    let nowMs = 0;
    const handler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => nowMs,
      call: async () => ({ ok: true, reply: "嗯♪" }),
    });

    const first = makeRes();
    const firstReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    handler(firstReq, first);
    firstReq.send(JSON.stringify({ text: "在吗" }));
    await flush();
    expect(first.status).toBe(200);

    nowMs = 200;
    const second = makeRes();
    const secondReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    handler(secondReq, second);
    secondReq.send(JSON.stringify({ text: "在吗" }));
    await flush();
    expect(second.status).toBe(429);
    expect(bodyOf(second)).toMatchObject({ code: "throttled", retryAfterMs: CHAT_THROTTLE_MS - 200 });
  });

  it("chat/send：daemon 业务错误码映射成 HTTP（asleep→409 / unavailable→503）", async () => {
    const asleep = makeRes();
    const asleepHandler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: false, code: "asleep", message: "她在睡觉" }),
    });
    const asleepReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    asleepHandler(asleepReq, asleep);
    asleepReq.send(JSON.stringify({ text: "在吗" }));
    await flush();
    expect(asleep.status).toBe(409);
    expect(bodyOf(asleep).code).toBe("asleep");

    const down = makeRes();
    const downHandler = createChatSendHandler({
      csrf: "csrf-1",
      now: () => 0,
      call: async () => ({ ok: false, code: "daemon-unavailable", message: "通道没开" }),
    });
    const downReq = new FakeChatRequest({ method: "POST", url: CHAT_SEND_PATH, headers: sendHeaders() });
    downHandler(downReq, down);
    downReq.send(JSON.stringify({ text: "在吗" }));
    await flush();
    expect(down.status).toBe(503);
  });

  it("chatStatusOf：错误码 → HTTP 的映射表（与设计 §7.3 一致）", () => {
    expect(chatStatusOf("asleep")).toBe(409);
    expect(chatStatusOf("bad-request")).toBe(400);
    expect(chatStatusOf("chat-model-unavailable")).toBe(503);
    expect(chatStatusOf("chat-empty-reply")).toBe(502);
    expect(chatStatusOf("something-else")).toBe(500);
  });
});
