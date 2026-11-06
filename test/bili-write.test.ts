import { describe, expect, it } from "vitest";
import {
  getVideoDetail,
  likeVideo,
  postComment,
  postDanmaku,
  type BiliWriteDeps,
} from "../src/bili/write.js";

const SESSION = { sessdata: "SESSDATA-VALUE-123", biliJct: "CSRF-VALUE-456" };
const NOW = 1_700_000_000_000;

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
  fn: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

function deps(fetchFn: typeof fetch, log?: (line: string) => void): BiliWriteDeps {
  return {
    fetchFn,
    now: () => NOW,
    session: SESSION,
    ...(log === undefined ? {} : { log }),
  };
}

function form(call: FetchCall): URLSearchParams {
  return new URLSearchParams(String(call.init.body));
}

function headers(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("B 站写客户端：发弹幕", () => {
  it("打到 dm/post，表单字段齐全，csrf 只进表单", async () => {
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0, message: "0", data: {} }));
    const result = await postDanmaku(deps(fn), {
      bvid: "BV1xx411c7mD",
      cid: 42,
      text: "这段真好听",
      progressMs: 12_345,
    });

    expect(result).toEqual({ ok: true, code: 0, message: "ok", data: {} });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.bilibili.com/x/v2/dm/post");
    expect(call?.init.method).toBe("POST");
    expect(headers(call!).Cookie).toBe("SESSDATA=SESSDATA-VALUE-123; bili_jct=CSRF-VALUE-456");
    expect(headers(call!)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers(call!).Origin).toBe("https://www.bilibili.com");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);

    const body = form(call!);
    expect(body.get("type")).toBe("1");
    expect(body.get("oid")).toBe("42");
    expect(body.get("msg")).toBe("这段真好听");
    expect(body.get("progress")).toBe("12345");
    expect(body.get("bvid")).toBe("BV1xx411c7mD");
    // Web 端 dm/post 的必填外观字段：漏掉会被 B 站判成 -400「请求错误」。
    expect(body.get("mode")).toBe("1");
    expect(body.get("fontsize")).toBe("25");
    expect(body.get("color")).toBe("16777215");
    expect(body.get("pool")).toBe("0");
    expect(body.get("plat")).toBe("1");
    expect(body.get("csrf")).toBe("CSRF-VALUE-456");
  });

  it("progress 非法时回落 0；日志不出现任何凭据", async () => {
    const logs: string[] = [];
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0, data: null }));
    await postDanmaku(deps(fn, (line) => logs.push(line)), {
      bvid: "BV1xx411c7mD",
      cid: 7,
      text: "  hi  ",
      progressMs: Number.NaN,
    });

    expect(form(calls[0]!).get("progress")).toBe("0");
    expect(form(calls[0]!).get("msg")).toBe("hi");
    const joined = logs.join("\n");
    expect(joined).toContain("[bili] POST /x/v2/dm/post");
    expect(joined).not.toContain("SESSDATA-VALUE-123");
    expect(joined).not.toContain("CSRF-VALUE-456");
  });

  it("缺 bili_jct 直接失败，不发请求", async () => {
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0 }));
    const result = await postDanmaku(
      { fetchFn: fn, now: () => NOW, session: { sessdata: "only-sessdata" } },
      { bvid: "BV1xx411c7mD", cid: 1, text: "hi" },
    );
    expect(result).toMatchObject({ ok: false, code: -3, retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("入参不合法时既不请求也不抛异常", async () => {
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0 }));
    const zero = await postDanmaku(deps(fn), { bvid: "BV1xx411c7mD", cid: 0, text: "hi" });
    const empty = await postDanmaku(deps(fn), { bvid: "BV1xx411c7mD", cid: 1, text: "   " });
    expect(zero).toMatchObject({ ok: false, code: -4 });
    expect(empty).toMatchObject({ ok: false, code: -4 });
    expect(calls).toHaveLength(0);
  });
});

describe("B 站写客户端：评论与点赞", () => {
  it("评论用 aid 作 oid，字段是 message", async () => {
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0, data: { rpid: 1 } }));
    const result = await postComment(deps(fn), { aid: 987, text: "这条值得更多人看到" });
    expect(result.ok).toBe(true);

    const call = calls[0]!;
    expect(call.url).toBe("https://api.bilibili.com/x/v2/reply/add");
    const body = form(call);
    expect(body.get("type")).toBe("1");
    expect(body.get("oid")).toBe("987");
    expect(body.get("message")).toBe("这条值得更多人看到");
    expect(body.get("csrf")).toBe("CSRF-VALUE-456");
  });

  it("点赞 like=1，取消赞时 like=0", async () => {
    const { calls, fn } = fakeFetch(() => jsonResponse({ code: 0, data: {} }));
    await likeVideo(deps(fn), { aid: 5 });
    await likeVideo(deps(fn), { aid: 5, like: false });

    expect(calls[0]?.url).toBe("https://api.bilibili.com/x/web-interface/archive/like");
    expect(form(calls[0]!).get("like")).toBe("1");
    expect(form(calls[1]!).get("like")).toBe("0");
    expect(form(calls[0]!).get("aid")).toBe("5");
  });
});

describe("B 站写客户端：失败语义", () => {
  it("B 站业务 code 非 0 时结构化失败，且错误信息脱敏", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ code: 12002, message: "评论区已关闭 CSRF-VALUE-456 SESSDATA-VALUE-123" }),
    );
    const result = await postComment(deps(fn), { aid: 1, text: "hi" });
    expect(result).toMatchObject({ ok: false, code: 12002, retryable: false });
    if (!result.ok) {
      expect(result.message).toContain("12002");
      expect(result.message).not.toContain("CSRF-VALUE-456");
      expect(result.message).not.toContain("SESSDATA-VALUE-123");
    }
  });

  it("网络错误可重试，message 里的 cookie 被抹掉", async () => {
    const fn = (async () => {
      throw new Error("connect reset with SESSDATA-VALUE-123");
    }) as unknown as typeof fetch;
    const result = await likeVideo(deps(fn), { aid: 2 });
    expect(result).toMatchObject({ ok: false, code: -1, retryable: true });
    if (!result.ok) {
      expect(result.message).toContain("B 站写请求失败");
      expect(result.message).not.toContain("SESSDATA-VALUE-123");
    }
  });

  it("HTTP 503 可重试；返回非 JSON 视为解析失败", async () => {
    const unavailable = fakeFetch(() => jsonResponse({ code: 0 }, 503));
    const a = await likeVideo(deps(unavailable.fn), { aid: 3 });
    expect(a).toMatchObject({ ok: false, code: 503, retryable: true });

    const broken = fakeFetch(() => new Response("not json", { status: 200 }));
    const b = await likeVideo(deps(broken.fn), { aid: 3 });
    expect(b).toMatchObject({ ok: false, code: -2, retryable: true });
  });
});

describe("B 站写客户端：视频详情", () => {
  it("解析 aid/cid/标题/简介/时长，并把 cookie 放 header", async () => {
    const { calls, fn } = fakeFetch(() =>
      jsonResponse({
        code: 0,
        data: {
          bvid: "BV1xx411c7mD",
          aid: 111,
          cid: 222,
          title: "标题",
          desc: "简介",
          duration: 180,
          owner: { name: "UP" },
          pages: [{ cid: 222 }],
        },
      }),
    );
    const detail = await getVideoDetail(deps(fn), "BV1xx411c7mD");
    expect(detail).toEqual({
      bvid: "BV1xx411c7mD",
      aid: 111,
      cid: 222,
      title: "标题",
      description: "简介",
      durationSec: 180,
      owner: "UP",
      pages: 1,
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD");
    expect(headers(call).Cookie).toBe("SESSDATA=SESSDATA-VALUE-123; bili_jct=CSRF-VALUE-456");
    expect(call.init.method).toBe("GET");
  });

  it("读失败只记一行脱敏日志并返回 null", async () => {
    const logs: string[] = [];
    const { fn } = fakeFetch(() =>
      jsonResponse({ code: -404, message: "什么 SESSDATA-VALUE-123 都不存在" }),
    );
    const detail = await getVideoDetail(deps(fn, (line) => logs.push(line)), "BV1bad");
    expect(detail).toBeNull();
    const joined = logs.join("\n");
    expect(joined).toContain("detail code=-404");
    expect(joined).not.toContain("SESSDATA-VALUE-123");
  });

  it("缺 aid/cid 的视频视为读不到", async () => {
    const { fn } = fakeFetch(() => jsonResponse({ code: 0, data: { bvid: "BV1" } }));
    expect(await getVideoDetail(deps(fn), "BV1")).toBeNull();
  });
});
