import { describe, expect, it } from "vitest";

import {
  CHAT_THROTTLE_MS,
  chatStatusOf,
  createChatSendHandler,
  type ChatSendOutcome,
} from "../src/plugin/web/chat.js";

/**
 * P2.1（task-157）：网页聊天 HTTP 错误面。
 *
 * 锁两件事（设计 §7.3）：
 * 1) 超时 504（与通道不可用 503 分开）；
 * 2) 所有错误响应统一 `{ok:false, code, message, detail}`，detail 与 message 并存
 *    （旧前端读 message，新前端可读 detail）。
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

class FakeReq {
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

  emit(body: string): void {
    for (const fn of this.listeners.data ?? []) fn(new Uint8Array(Buffer.from(body, "utf8")));
    for (const fn of this.listeners.end ?? []) fn();
  }
}

const CSRF = "csrf-token-for-test";

interface SendInput {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  call?: (text: string) => Promise<ChatSendOutcome>;
  throttleMs?: number;
  now?: () => number;
}

async function send(input: SendInput): Promise<{ status: number; body: Record<string, unknown> }> {
  let now = 0;
  const handler = createChatSendHandler({
    csrf: CSRF,
    call: input.call ?? (async () => ({ ok: true, reply: "嗯。" })),
    now: input.now ?? (() => now),
    ...(input.throttleMs === undefined ? {} : { throttleMs: input.throttleMs }),
  });
  now = 0;
  const res = makeRes();
  const req = new FakeReq({
    method: input.method ?? "POST",
    url: "/plugins/ai-companion-engine/chat/send",
    headers: input.headers ?? {
      "content-type": "application/json",
      "x-soul-csrf": CSRF,
      "sec-fetch-site": "same-origin",
    },
  });
  handler(req, res);
  req.emit(input.body ?? JSON.stringify({ text: "在吗" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { status: res.status, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe("chatStatusOf：设计 §7.3 的状态码映射", () => {
  it("timeout → 504（P2.1：与 503 的通道不可用分开）", () => {
    expect(chatStatusOf("timeout")).toBe(504);
  });

  it("其余码保持：asleep 409 / bad-request 400 / 通道 503 / 空回复 502 / 其它 500", () => {
    expect(chatStatusOf("asleep")).toBe(409);
    expect(chatStatusOf("bad-request")).toBe(400);
    expect(chatStatusOf("daemon-unavailable")).toBe(503);
    expect(chatStatusOf("CHANNEL_DOWN")).toBe(503);
    expect(chatStatusOf("CHANNEL_UNSUPPORTED")).toBe(503);
    expect(chatStatusOf("chat-model-unavailable")).toBe(503);
    expect(chatStatusOf("chat-empty-reply")).toBe(502);
    expect(chatStatusOf("chat-engine-failed")).toBe(500);
    expect(chatStatusOf("别的码")).toBe(500);
  });
});

describe("错误体统一带 detail（task-157）", () => {
  it("405：方法不对也带 detail", async () => {
    const r = await send({ method: "GET" });
    expect(r.status).toBe(405);
    expect(r.body).toMatchObject({ ok: false, code: "method", detail: expect.any(String) });
    expect(r.body.detail).toBe(r.body.message);
  });

  it("403 CSRF 失败带 detail", async () => {
    const r = await send({ headers: { "content-type": "application/json", "x-soul-csrf": "wrong" } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "csrf", detail: expect.any(String) });
  });

  it("403 跨站请求带 detail", async () => {
    const r = await send({ headers: { "content-type": "application/json", "x-soul-csrf": CSRF, "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "cross-site", detail: expect.any(String) });
  });

  it("415 content-type 带 detail", async () => {
    const r = await send({ headers: { "content-type": "text/plain", "x-soul-csrf": CSRF } });
    expect(r.status).toBe(415);
    expect(r.body).toMatchObject({ ok: false, code: "content-type", detail: expect.any(String) });
  });

  it("429 节流：detail 与 retryAfterMs 并存", async () => {
    const handler = createChatSendHandler({
      csrf: CSRF,
      call: async () => ({ ok: true, reply: "嗯。" }),
      now: () => 0,
    });
    const headers = { "content-type": "application/json", "x-soul-csrf": CSRF, "sec-fetch-site": "same-origin" };
    const first = makeRes();
    const firstReq = new FakeReq({ method: "POST", headers });
    handler(firstReq, first);
    firstReq.emit(JSON.stringify({ text: "第一句" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.status).toBe(200);

    const second = makeRes();
    const secondReq = new FakeReq({ method: "POST", headers });
    handler(secondReq, second);
    secondReq.emit(JSON.stringify({ text: "第二句" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = JSON.parse(second.body) as Record<string, unknown>;
    expect(second.status).toBe(429);
    expect(body).toMatchObject({ ok: false, code: "throttled", detail: expect.any(String) });
    expect(body.retryAfterMs).toBe(CHAT_THROTTLE_MS);
  });

  it("400 坏 JSON 带 detail", async () => {
    const r = await send({ body: "{不是 JSON" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad-request", detail: expect.any(String) });
  });

  it("400 非法 JSON `{bad` 时给出 bad-request 且不调通道（task-176）", async () => {
    let called = 0;
    const r = await send({
      body: "{bad",
      call: async () => {
        called += 1;
        return { ok: true, reply: "不该走到这里" };
      },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad-request", detail: "请求体不是合法 JSON" });
    expect(r.body.message).toBe("请求体不是合法 JSON");
    expect(called).toBe(0);
  });

  it("400 缺 text 字段带 detail（task-172 补分支）", async () => {
    const r = await send({ body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad-request", detail: "缺少 text 字段" });
  });

  it("400 空消息带 detail（task-172 补分支）", async () => {
    const r = await send({ body: JSON.stringify({ text: "   " }) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad-request", detail: "消息是空的" });
  });

  it("400 消息超长带 detail（task-172 补分支）", async () => {
    const r = await send({ body: JSON.stringify({ text: "x".repeat(2_001) }) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad-request" });
    expect(String(r.body.detail)).toContain("消息太长");
  });

  it("413 请求体超限带 detail", async () => {
    const r = await send({ body: JSON.stringify({ text: "x".repeat(9 * 1024) }) });
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ ok: false, code: "too-large", detail: expect.any(String) });
  });

  it("业务失败：asleep→409，detail 透出她那边的原因", async () => {
    const r = await send({ call: async () => ({ ok: false, code: "asleep", message: "她睡着了（phase=asleep）" }) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "asleep", detail: "她睡着了（phase=asleep）" });
  });

  it("业务失败：timeout→504（不是 503），detail 还在", async () => {
    const r = await send({ call: async () => ({ ok: false, code: "timeout", message: "等太久了" }) });
    expect(r.status).toBe(504);
    expect(r.body).toMatchObject({ ok: false, code: "timeout", detail: "等太久了" });
  });

  it("call 抛异常 → 500 engine-error，detail 是异常文本", async () => {
    const r = await send({
      call: async () => {
        throw new Error("炸了");
      },
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, code: "engine-error", detail: "这一轮没走完：炸了" });
  });
});
