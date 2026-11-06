/**
 * W1（task-94）：搜索执行层——mock 全覆盖，禁止真连网。
 *
 * 覆盖 spec v2.3 §6.1 / §7.4 的失败分流：403/404 不重试、429/5xx 只重试一次、
 * 超时/网络/解析失败、私网 URL 被丢弃、日志不带 key 且 query 截 40 字。
 */

import { describe, expect, it } from "vitest";

import type { LearningWebPlan } from "../src/ports/index.js";
import { searchForLearning, searchForTool } from "../src/web/search.js";
import type { WebDeps, WebFetchLike } from "../src/web/types.js";

const NOW = Date.parse("2026-11-01T12:00:00+08:00");

interface Captured {
  readonly url: string;
  readonly init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string };
}

function response(status: number, body: unknown): Awaited<ReturnType<WebFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

function depsFor(impl: WebFetchLike, logs: string[] = []): WebDeps {
  return {
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-secret-should-never-be-logged",
    fetchImpl: impl,
    timeoutMs: 50,
    now: () => NOW,
    log: (line) => logs.push(line),
  };
}

function plan(over: Partial<LearningWebPlan> = {}): LearningWebPlan {
  return { allowSearch: true, querySource: "learning-plan", keyword: "崩坏三 AI助手", ...over };
}

const RESULTS = {
  results: [
    {
      title: "AI助手与往世乐土",
      url: "https://example.com/a",
      snippet: "一段摘要",
      summary: "更长的摘要正文",
      site_name: "example",
      date: "2026-10-31",
      authority: 3,
      rerank_score: 2,
    },
    {
      title: "第二篇",
      url: "https://example.org/b",
      snippet: "摘要二",
      date: "2020-01-01",
      authority: 1,
      rerank_score: 0,
    },
  ],
};

describe("searchForLearning", () => {
  it("allowSearch=false 时不发请求（脊髓说不用查，装配层就不该花钱）", async () => {
    let calls = 0;
    const res = await searchForLearning(plan({ allowSearch: false }), depsFor(() => {
      calls += 1;
      return Promise.resolve(response(200, RESULTS));
    }));
    expect(calls).toBe(0);
    expect(res).toEqual({ ok: true, hits: [], failure: null, status: null });
  });

  it("命中映射：字段、日期、authority/rerank；请求带 query/count 与 Bearer key", async () => {
    const captures: Captured[] = [];
    const res = await searchForLearning(
      plan(),
      depsFor((url, init) => {
        captures.push({ url, init });
        return Promise.resolve(response(200, RESULTS));
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(2);
    expect(res.hits[0]).toMatchObject({
      title: "AI助手与往世乐土",
      url: "https://example.com/a",
      snippet: "一段摘要",
      siteName: "example",
      authority: 3,
      rerankScore: 2,
      summary: "更长的摘要正文",
    });
    expect(res.hits[0]?.publishedAtMs).toBe(Date.parse("2026-10-31T00:00:00Z"));
    const body = JSON.parse(captures[0]?.init.body ?? "{}") as { query?: string; count?: number };
    expect(body).toEqual({ query: "崩坏三 AI助手", count: 5 });
    expect(captures[0]?.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(captures[0]?.init.method).toBe("POST");
    expect(captures[0]?.init.headers.authorization).toContain("Bearer ");
  });

  it("私网/非 https 的结果 URL 直接丢弃（不把它们带进落库）", async () => {
    const res = await searchForLearning(
      plan(),
      depsFor(() =>
        Promise.resolve(
          response(200, {
            results: [
              { title: "坏", url: "http://127.0.0.1/admin", snippet: "" },
              { title: "坏2", url: "https://169.254.169.254/latest/meta-data", snippet: "" },
              { title: "好", url: "https://example.com/ok", snippet: "ok" },
            ],
          }),
        ),
      ),
    );
    expect(res.hits.map((h) => h.url)).toEqual(["https://example.com/ok"]);
  });

  it("429 退避后只重试一次：第二次成功就照常返回", async () => {
    let calls = 0;
    const res = await searchForLearning(
      plan(),
      depsFor(() => {
        calls += 1;
        return Promise.resolve(calls === 1 ? response(429, { error: "rate" }) : response(200, RESULTS));
      }),
    );
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(2);
  });

  it("403 不重试（权限问题重试也没用）", async () => {
    let calls = 0;
    const logs: string[] = [];
    const res = await searchForLearning(
      plan(),
      depsFor(() => {
        calls += 1;
        return Promise.resolve(response(403, { error: "forbidden" }));
      }, logs),
    );
    expect(calls).toBe(1);
    expect(res.failure).toBe("http");
    expect(logs.some((line) => line.startsWith("[web] fail kind=http"))).toBe(true);
  });

  it("5xx 重试一次仍失败 → server 失败结果", async () => {
    let calls = 0;
    const res = await searchForLearning(
      plan(),
      depsFor(() => {
        calls += 1;
        return Promise.resolve(response(503, "busy"));
      }),
    );
    expect(calls).toBe(2);
    expect(res).toMatchObject({ ok: false, failure: "server" });
  });

  it("超时（AbortError）→ timeout；网络异常 → network；都没有重试", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const timeout = await searchForLearning(
      plan(),
      depsFor(() => Promise.reject(abortErr)),
    );
    expect(timeout.failure).toBe("timeout");
    const network = await searchForLearning(
      plan(),
      depsFor(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(network.failure).toBe("network");
  });

  it("坏 JSON / 缺 results 字段 → parse", async () => {
    expect((await searchForLearning(plan(), depsFor(() => Promise.resolve(response(200, "not json"))))).failure).toBe("parse");
    expect((await searchForLearning(plan(), depsFor(() => Promise.resolve(response(200, { data: [] }))))).failure).toBe("parse");
  });

  it("日志：query 截 40 字、不含 key", async () => {
    const logs: string[] = [];
    const longKeyword = "崩坏三".repeat(30);
    await searchForLearning(
      plan({ keyword: longKeyword }),
      depsFor(() => Promise.resolve(response(200, RESULTS)), logs),
    );
    const text = logs.join("\n");
    expect(text).not.toContain("sk-secret");
    expect(text).toContain("[web] search hits=2");
    expect(text).toContain("…");
    expect(text).not.toContain(longKeyword);
  });

  it("searchForTool 走 tool 来源（自由文本，不分计划关键词）", async () => {
    const bodies: string[] = [];
    await searchForTool(
      "AI助手是谁",
      depsFor((_url, init) => {
        bodies.push(init.body);
        return Promise.resolve(response(200, { results: [] }));
      }),
    );
    const body = JSON.parse(bodies[0] ?? "{}") as { query?: string; count?: number };
    expect(body.query).toBe("AI助手是谁");
    expect(body.count).toBe(5);
  });

  it("searchForTool 接受调用方给的 count（task-138 工具面 1–10）", async () => {
    const bodies: string[] = [];
    await searchForTool(
      "AI助手是谁",
      depsFor((_url, init) => {
        bodies.push(init.body);
        return Promise.resolve(response(200, { results: [] }));
      }),
      8,
    );
    const body = JSON.parse(bodies[0] ?? "{}") as { count?: number };
    expect(body.count).toBe(8);
  });
});
