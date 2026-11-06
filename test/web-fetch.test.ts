/**
 * F1 `soul_web_fetch` 的抓取执行层测试（task-166）。
 *
 * 全部用假 fetchImpl：不连网、不碰真实 daemon 的 data/。覆盖设计 §7 的
 * htmlToText / content-type / 截断口径 / 超时 / 重定向 / SSRF / 状态码。
 */
import { describe, expect, it } from "vitest";

// 从 barrel 真实 import（F331 教训：main.mjs 从 dist 的 index.js 静态 import，
// 不是靠源码里出现过某个字符串）。
import {
  FETCH_ALLOWED_TYPES,
  FETCH_MAX_CHARS,
  FETCH_REDIRECT_LIMIT,
  FETCH_TRUNCATE_BYTES,
  fetchPage,
  fetchPageText,
  htmlToText,
  runWebFetch,
} from "../src/web/index.js";
import type { WebDeps } from "../src/web/types.js";

/** 测试时钟：deadline 与 deps.now() 必须同一基准（fetch.ts 走 deps.now 读时钟）。 */
const NOW = 1_700_000_000_000;

interface ResponseSpec {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly reject?: unknown;
}

function headersOf(record: Readonly<Record<string, string>> | undefined): { get(name: string): string | null } | undefined {
  if (record === undefined) return undefined;
  const lower = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function depsOf(
  responses: readonly ResponseSpec[],
  opts: { readonly timeoutMs?: number; readonly logs?: string[] } = {},
): WebDeps & { calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  let index = 0;
  return {
    baseUrl: "https://search.invalid",
    apiKey: "test-key",
    timeoutMs: opts.timeoutMs ?? 8_000,
    now: () => NOW,
    ...(opts.logs === undefined ? {} : { log: (line: string) => opts.logs?.push(line) }),
    calls,
    fetchImpl: (url: string, init: unknown) => {
      calls.push({ url, init });
      const spec = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (spec === undefined) throw new Error("测试没有提供响应");
      if (spec.reject !== undefined) return Promise.reject(spec.reject);
      return Promise.resolve({
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        headers: headersOf(spec.headers),
        text: () => Promise.resolve(spec.body ?? ""),
      });
    },
  };
}

function delayedDeps(
  specs: readonly {
    readonly delayMs: number;
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  }[],
): WebDeps & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    baseUrl: "https://search.invalid",
    apiKey: "test-key",
    timeoutMs: 8_000,
    now: () => NOW,
    calls,
    fetchImpl: (url: string, init) => {
      calls.push(url);
      const spec = specs[Math.min(index, specs.length - 1)];
      index += 1;
      if (spec === undefined) throw new Error("测试没有提供响应");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            ok: spec.status >= 200 && spec.status < 300,
            status: spec.status,
            headers: headersOf(spec.headers),
            text: () => Promise.resolve(spec.body ?? ""),
          });
        }, spec.delayMs);
        init.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    },
  };
}

/**
 * 响应头立即返回、正文慢慢吐出的假实现（task-173 B1 回归用）。
 * F339：真实 fetch 有 `Response.body`，所以这里也提供流式 body，让超时能观测到
 * `reader.cancel()` 被调用（不再只让调用方按时返回、底层下载继续跑）。
 */
function slowBodyDeps(
  bodyDelayMs: number,
  spec: { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string },
): WebDeps & { calls: string[]; cancels: number } {
  const calls: string[] = [];
  let cancels = 0;
  return {
    baseUrl: "https://search.invalid",
    apiKey: "test-key",
    timeoutMs: 8_000,
    now: () => NOW,
    calls,
    get cancels() {
      return cancels;
    },
    fetchImpl: (url: string) => {
      calls.push(url);
      let sent = false;
      return Promise.resolve({
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        headers: headersOf(spec.headers),
        body: {
          getReader: () => ({
            read: () =>
              new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                if (sent) {
                  resolve({ done: true });
                  return;
                }
                setTimeout(() => {
                  sent = true;
                  resolve({ done: false, value: new Uint8Array(Buffer.from(spec.body ?? "", "utf8")) });
                }, bodyDelayMs);
              }),
            cancel: () => {
              cancels += 1;
            },
          }),
        },
        text: () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(spec.body ?? ""), bodyDelayMs);
          }),
      });
    },
  };
}

/** 正常分片 body：read 按顺序吐 chunks，记录 cancel 次数；text() 故意抛错以证明没走回退路径。 */
function streamDeps(
  chunks: readonly string[],
  status = 200,
): WebDeps & { calls: string[]; cancels: number; textCalls: number } {
  const calls: string[] = [];
  let cancels = 0;
  let textCalls = 0;
  return {
    baseUrl: "https://search.invalid",
    apiKey: "test-key",
    timeoutMs: 8_000,
    now: () => NOW,
    calls,
    get cancels() {
      return cancels;
    },
    get textCalls() {
      return textCalls;
    },
    fetchImpl: (url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: headersOf({ "content-type": "text/html; charset=utf-8" }),
        body: {
          getReader: () => {
            let index = 0;
            return {
              read: () =>
                Promise.resolve(
                  index < chunks.length
                    ? { done: false, value: new Uint8Array(Buffer.from(chunks[index++] ?? "", "utf8")) }
                    : { done: true },
                ),
              cancel: () => {
                cancels += 1;
              },
            };
          },
        },
        text: () => {
          textCalls += 1;
          return Promise.reject(new Error("有 body 时不该走 res.text()"));
        },
      });
    },
  };
}

/**
 * 分片 body，每片带独立延迟（task-180：验证「每次 read 独立计时」）。
 * 旧实现整个 body 共用一个 timer，两片各 5s 会在 8s 被误判 timeout。
 */
function delayedChunkDeps(
  chunks: readonly { readonly text: string; readonly delayMs: number }[],
): WebDeps & { calls: string[]; cancels: number; textCalls: number } {
  const calls: string[] = [];
  let cancels = 0;
  let textCalls = 0;
  return {
    baseUrl: "https://search.invalid",
    apiKey: "test-key",
    timeoutMs: 8_000,
    now: () => NOW,
    calls,
    get cancels() {
      return cancels;
    },
    get textCalls() {
      return textCalls;
    },
    fetchImpl: (url: string) => {
      calls.push(url);
      let index = 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: headersOf({ "content-type": "text/html" }),
        body: {
          getReader: () => ({
            read: () =>
              new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                const spec = chunks[index];
                if (spec === undefined) {
                  resolve({ done: true });
                  return;
                }
                index += 1;
                setTimeout(
                  () => resolve({ done: false, value: new Uint8Array(Buffer.from(spec.text, "utf8")) }),
                  spec.delayMs,
                );
              }),
            cancel: () => {
              cancels += 1;
            },
          }),
        },
        text: () => {
          textCalls += 1;
          return Promise.reject(new Error("有 body 时不该走 res.text()"));
        },
      });
    },
  };
}

describe("htmlToText（无依赖暴力提取）", () => {
  it("取 title、去 script/style、解实体、压空白", () => {
    const html = [
      "<html><head><title>  Hello &amp; 世界 </title>",
      "<style>body{color:red}</style><script>alert(1)</script></head>",
      "<body><p>第一段&nbsp;文字</p>\n\n\n<p>第二段 &lt;标记&gt;</p></body></html>",
    ].join("");
    const parsed = htmlToText(html);
    expect(parsed.title).toBe("Hello & 世界");
    expect(parsed.text).toContain("第一段 文字");
    expect(parsed.text).toContain("第二段 <标记>");
    expect(parsed.text).not.toContain("alert");
    expect(parsed.text).not.toContain("color:red");
  });

  it("空文档 / 只有不可见容器时正文为空", () => {
    expect(htmlToText("").text).toBe("");
    expect(htmlToText("<script>only</script><style>x{}</style>").text).toBe("");
  });
});

describe("fetchPageText：成功路径", () => {
  it("返回 title/正文/finalUrl/字节数，并带截断阈值与默认字数常量", async () => {
    const deps = depsOf([
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>T</title></head><body><p>Hello &amp; 世界</p></body></html>",
      },
    ]);
    const result = await fetchPageText("https://example.com/a", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.title).toBe("T");
    expect(result.page?.text).toBe("Hello & 世界");
    expect(result.page?.finalUrl).toBe("https://example.com/a");
    expect(result.page?.bytes).toBeGreaterThan(0);
    expect(result.page?.truncated).toBe(false);
    expect(FETCH_TRUNCATE_BYTES).toBe(256 * 1024);
    expect(FETCH_MAX_CHARS).toBe(2_000);
    expect(FETCH_REDIRECT_LIMIT).toBe(3);
    expect(FETCH_ALLOWED_TYPES).toContain("text/html");
    expect(typeof fetchPageText).toBe("function");
    // 真实 fetch 对 GET 带 body 会直接抛错（Request with GET/HEAD method cannot have body），
    // 这里锁住：抓取必须是 GET、不带 body、手动重定向。
    const init = deps.calls[0]?.init as { method?: string; body?: unknown; redirect?: string } | undefined;
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("manual");
  });

  it("maxChars 限制返回字符数（按码点，不切代理对）", async () => {
    const body = `<html><body><p>${"字".repeat(3_000)}</p></body></html>`;
    const deps = depsOf([{ status: 200, headers: { "content-type": "text/html" }, body }]);
    const result = await fetchPageText("https://example.com/long", deps, { maxChars: 500 });
    expect(result.ok).toBe(true);
    expect(Array.from(result.page?.text ?? "").length).toBe(500);
  });

  it("fetchPage 兼容旧形状（content/url）", async () => {
    const deps = depsOf([
      { status: 200, headers: { "content-type": "text/html" }, body: "<p>旧调用</p>" },
    ]);
    const result = await fetchPage("https://example.com/old", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.content).toBe("旧调用");
    expect(result.page?.url).toBe("https://example.com/old");
  });
});

describe("fetchPageText：拒绝与失败分类", () => {
  it("content-type 不在白名单 → unsupported-type，且不读正文", async () => {
    let textRead = false;
    const deps: WebDeps = {
      baseUrl: "https://search.invalid",
      apiKey: "k",
      now: () => 0,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: headersOf({ "content-type": "image/png" }),
          text: () => {
            textRead = true;
            return Promise.resolve("binary");
          },
        }),
    };
    const result = await fetchPageText("https://example.com/x.png", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("unsupported-type");
    expect(textRead).toBe(false);
  });

  it("content-length 已超过 256KB → too-large（不下载正文）", async () => {
    let textRead = false;
    const deps: WebDeps = {
      baseUrl: "https://search.invalid",
      apiKey: "k",
      now: () => 0,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: headersOf({ "content-type": "text/html", "content-length": String(FETCH_TRUNCATE_BYTES + 1) }),
          text: () => {
            textRead = true;
            return Promise.resolve("x");
          },
        }),
    };
    const result = await fetchPageText("https://example.com/big", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("too-large");
    expect(textRead).toBe(false);
  });

  it("没有 content-length 的大页面：读完再按 UTF-8 字节截断，truncated=true", async () => {
    const big = `<html><body><p>${"a".repeat(FETCH_TRUNCATE_BYTES + 10_000)}</p></body></html>`;
    const deps = depsOf([{ status: 200, headers: { "content-type": "text/html" }, body: big }]);
    const result = await fetchPageText("https://example.com/huge", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.truncated).toBe(true);
    expect(result.page?.bytes).toBeGreaterThan(FETCH_TRUNCATE_BYTES);
    expect(result.page?.text).not.toContain("undefined");
  });

  it("超时（AbortError）→ timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const deps = depsOf([{ status: 0, reject: abort }]);
    const result = await fetchPageText("https://example.com/slow", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("timeout");
  });

  it("网络错误 → network", async () => {
    const deps = depsOf([{ status: 0, reject: new TypeError("fetch failed") }]);
    const result = await fetchPageText("https://example.com/err", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("network");
  });

  it("404 → not-found；403 → http", async () => {
    const notFound = await fetchPageText("https://example.com/404", depsOf([{ status: 404 }]));
    expect(notFound.failure).toBe("not-found");
    expect(notFound.status).toBe(404);
    const forbidden = await fetchPageText("https://example.com/403", depsOf([{ status: 403 }]));
    expect(forbidden.failure).toBe("http");
  });

  it("429 退避后只重试一次，仍失败 → rate-limit（共 2 次请求）", async () => {
    const deps = depsOf([{ status: 429 }, { status: 429 }]);
    const result = await fetchPageText("https://example.com/limited", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("rate-limit");
    expect(deps.calls).toHaveLength(2);
  });

  it("500 重试一次后成功 → ok", async () => {
    const deps = depsOf([
      { status: 500 },
      { status: 200, headers: { "content-type": "text/plain" }, body: "ok text" },
    ]);
    const result = await fetchPageText("https://example.com/flaky", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.text).toBe("ok text");
    expect(deps.calls).toHaveLength(2);
  });

  it("重定向 ≤3 跳逐跳重验：最终地址生效", async () => {
    const deps = depsOf([
      { status: 302, headers: { location: "/mid" } },
      { status: 301, headers: { location: "https://example.com/final" } },
      { status: 200, headers: { "content-type": "text/html" }, body: "<p>到了</p>" },
    ]);
    const result = await fetchPageText("https://example.com/start", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.url).toBe("https://example.com/start");
    expect(result.page?.finalUrl).toBe("https://example.com/final");
    expect(deps.calls.map((c) => c.url)).toEqual([
      "https://example.com/start",
      "https://example.com/mid",
      "https://example.com/final",
    ]);
  });

  it("重定向超过 3 跳 → http（最多 4 次请求）", async () => {
    const deps = depsOf([{ status: 302, headers: { location: "/loop" } }]);
    const result = await fetchPageText("https://example.com/loop0", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("http");
    expect(deps.calls).toHaveLength(4);
  });

  it("重定向跳到私网/非 https → blocked（逐跳校验）", async () => {
    const deps = depsOf([{ status: 302, headers: { location: "http://127.0.0.1/secret" } }]);
    const result = await fetchPageText("https://example.com/jump", deps);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("blocked");
  });

  it("非 443 端口 / 内嵌凭据 / IPv6 字面量 → blocked（不发起请求）", async () => {
    for (const url of [
      "https://example.com:8443/a",
      "https://user:pass@example.com/a",
      "https://[::1]/a",
    ]) {
      const deps = depsOf([{ status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" }]);
      const result = await fetchPageText(url, deps);
      expect(result.ok, url).toBe(false);
      expect(result.failure, url).toBe("blocked");
      expect(deps.calls, url).toHaveLength(0);
    }
  });

  it("空正文 → parse", async () => {
    const result = await fetchPageText(
      "https://example.com/empty",
      depsOf([{ status: 200, headers: { "content-type": "text/html" }, body: "<script>only</script>" }]),
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("parse");
  });

  it("缺 content-type 时按 text/html 处理并记日志", async () => {
    const logs: string[] = [];
    const deps = depsOf([{ status: 200, body: "<p>没有类型</p>" }], { logs });
    const result = await fetchPageText("https://example.com/no-type", deps);
    expect(result.ok).toBe(true);
    expect(logs.some((line) => line.includes("content-type 缺失"))).toBe(true);
  });
});

describe("整体 deadline（task-172）", () => {
  it("deadline 已过：直接 timeout，不发起请求", async () => {
    const deps = delayedDeps([{ delayMs: 1_000, status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" }]);
    const result = await fetchPageText("https://example.com/a", deps, { deadlineAtMs: NOW - 1 });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("timeout");
    expect(deps.calls).toHaveLength(0);
  });

  it("慢响应：单次尝试也被整体 deadline 截断（不用等满 8s）", async () => {
    const deps = delayedDeps([{ delayMs: 5_000, status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" }]);
    const started = Date.now();
    const result = await fetchPageText("https://example.com/slow", deps, { deadlineAtMs: NOW + 80 });
    expect(result.failure).toBe("timeout");
    expect(deps.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("重试前预算不足：不再发第二次请求，折成 timeout", async () => {
    const deps = depsOf([
      { status: 500 },
      { status: 200, headers: { "content-type": "text/html" }, body: "<p>ok</p>" },
    ]);
    const result = await fetchPageText("https://example.com/retry", deps, { deadlineAtMs: NOW + 100 });
    expect(result.failure).toBe("timeout");
    expect(deps.calls).toHaveLength(1);
  });

  it("响应头立即回、正文卡住：整体 deadline 仍然生效且真正 cancel 底层 body（task-173 B1 / F339）", async () => {
    const deps = slowBodyDeps(5_000, {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>x</p>",
    });
    const started = Date.now();
    const result = await fetchPageText("https://example.com/slow-body", deps, { deadlineAtMs: NOW + 80 });
    expect(result.failure).toBe("timeout");
    expect(deps.calls).toHaveLength(1);
    // F339：不是只让调用方返回，reader.cancel() 必须被调用（真实 fetch 里这会中止下载）。
    expect(deps.cancels).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("多次跳转共享同一 deadline：总耗时受限", async () => {
    const deps = delayedDeps([
      { delayMs: 30, status: 302, headers: { location: "/next" } },
      { delayMs: 5_000, status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" },
    ]);
    const started = Date.now();
    const result = await fetchPageText("https://example.com/hop", deps, { deadlineAtMs: NOW + 90 });
    expect(result.failure).toBe("timeout");
    expect(deps.calls.length).toBeGreaterThanOrEqual(1);
    expect(deps.calls.length).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("body 流式读取与累计预算（F339）", () => {
  it("有 body 时分片读取并按 UTF-8 拼接，不调 res.text()", async () => {
    const deps = streamDeps([
      "<html><head><title>流</title></head><body><p>你",
      "好，世界</p></body></html>",
    ]);
    const result = await fetchPageText("https://example.com/stream", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.title).toBe("流");
    expect(result.page?.text).toBe("你好，世界");
    expect(deps.textCalls).toBe(0);
    expect(deps.cancels).toBe(0);
  });

  it("分片 body 超过 256KB：截断语义保持，bytes 仍报原始字节", async () => {
    const html = `<html><body><p>${"a".repeat(FETCH_TRUNCATE_BYTES + 10_000)}</p></body></html>`;
    const mid = Math.floor(html.length / 2);
    const deps = streamDeps([html.slice(0, mid), html.slice(mid)]);
    const result = await fetchPageText("https://example.com/big-stream", deps);
    expect(result.ok).toBe(true);
    expect(result.page?.truncated).toBe(true);
    expect(result.page?.bytes).toBeGreaterThan(FETCH_TRUNCATE_BYTES);
    expect(result.page?.bytes).toBe(Buffer.byteLength(html, "utf8"));
    expect(Array.from(result.page?.text ?? "").length).toBe(FETCH_MAX_CHARS);
    expect(deps.cancels).toBe(0);
  });

  it("累计预算：两跳各推进 13s（>24s 总额）后，第三次请求不再发出，折成 timeout", async () => {
    let clock = NOW;
    const calls: string[] = [];
    const deps: WebDeps & { calls: string[] } = {
      baseUrl: "https://search.invalid",
      apiKey: "test-key",
      timeoutMs: 8_000,
      now: () => clock,
      calls,
      fetchImpl: (url: string) => {
        calls.push(url);
        // 每次请求（含跳转）都把注入时钟推进 13s：两次后累计 26s > 24s 总预算。
        clock += 13_000;
        return Promise.resolve({
          ok: false,
          status: 302,
          headers: headersOf({ location: "/next" }),
          text: () => Promise.resolve(""),
        });
      },
    };
    const result = await fetchPageText("https://example.com/budget", deps, { deadlineAtMs: NOW + 24_000 });
    expect(result.failure).toBe("timeout");
    expect(deps.calls).toHaveLength(2);
    expect(clock).toBe(NOW + 26_000);
  });
});

describe("每次 read 独立计时（task-180 rev2）", () => {
  it("两片各 5s、总 10s < 24s deadline：成功拼接，不 timeout（旧实现在 8s 会误判）", async () => {
    const deps = delayedChunkDeps([
      { text: "<html><body><p>前", delayMs: 5_000 },
      { text: "半</p></body></html>", delayMs: 5_000 },
    ]);
    const result = await fetchPageText("https://example.com/two-slow-chunks", deps, { deadlineAtMs: NOW + 24_000 });
    expect(result.ok).toBe(true);
    expect(result.page?.text).toBe("前半");
    expect(deps.cancels).toBe(0);
    expect(deps.textCalls).toBe(0);
  }, 20_000);

  it("单片 9s > 单次超时 8s：timeout 且 cancel 被调用", async () => {
    const deps = delayedChunkDeps([{ text: "<p>too slow</p>", delayMs: 9_000 }]);
    const started = Date.now();
    const result = await fetchPageText("https://example.com/one-slow-chunk", deps, { deadlineAtMs: NOW + 24_000 });
    expect(result.failure).toBe("timeout");
    expect(deps.cancels).toBe(1);
    // 在单次 8s 处就返回，不用等满 9s。
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 20_000);

  it("整体 deadline 在两片之间耗尽：timeout 且 cancel，不再发起下一次 read", async () => {
    let readCalls = 0;
    let cancels = 0;
    let textCalls = 0;
    let nowCalls = 0;
    const deps: WebDeps = {
      baseUrl: "https://search.invalid",
      apiKey: "test-key",
      timeoutMs: 8_000,
      // 第 1 次：doFetch 前的预算检查；第 2 次：第一片 read 前；第 3 次（第二片 read 前）已越过 24s deadline。
      now: () => {
        nowCalls += 1;
        return nowCalls <= 2 ? NOW : NOW + 30_000;
      },
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: headersOf({ "content-type": "text/html" }),
          body: {
            getReader: () => ({
              read: () => {
                readCalls += 1;
                return Promise.resolve({ done: false, value: new Uint8Array(Buffer.from("片", "utf8")) });
              },
              cancel: () => {
                cancels += 1;
              },
            }),
          },
          text: () => {
            textCalls += 1;
            return Promise.reject(new Error("有 body 时不该走 text()"));
          },
        }),
    };
    const result = await fetchPageText("https://example.com/budget-between-chunks", deps, {
      deadlineAtMs: NOW + 24_000,
    });
    expect(result.failure).toBe("timeout");
    // supervisor rev2 B2：预算耗尽也要先 cancel 掉已取得的 reader，不能只抛错。
    expect(cancels).toBe(1);
    expect(readCalls).toBe(1);
    expect(textCalls).toBe(0);
  });
});

describe("barrel 真实导出（F331 教训）", () => {
  it("runWebFetch / fetchPageText / htmlToText / 常量都能从 src/web/index.js 导入", () => {
    expect(typeof runWebFetch).toBe("function");
    expect(typeof fetchPageText).toBe("function");
    expect(typeof htmlToText).toBe("function");
    expect(typeof FETCH_TRUNCATE_BYTES).toBe("number");
  });
});
