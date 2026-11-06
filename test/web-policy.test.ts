/**
 * W1（task-94）：网页准入策略。
 *
 * 这两个断言点对应 spec v2.3 §6.1 / §8.3 的硬边界：
 *   - learning/hot 的 query 必须等于 planKeyword（隐私：不能从聊天/记忆里拼）；
 *   - 只许 https + 公网地址（不能把内网/元数据服务带进抓取）。
 */

import { describe, expect, it } from "vitest";

import { WebPolicyError, assertPublicUrl, assertSearchRequest } from "../src/web/policy.js";

function reasonOf(fn: () => void): string {
  try {
    fn();
    return "no-throw";
  } catch (err) {
    return err instanceof WebPolicyError ? err.reason : `unexpected:${String(err)}`;
  }
}

describe("assertSearchRequest：来源与 query 口径", () => {
  it("learning-plan/hot-topic：query 必须与 planKeyword 完全一致", () => {
    expect(() => assertSearchRequest({ query: "崩坏三 AI助手", count: 5, querySource: "learning-plan", planKeyword: "崩坏三 AI助手" })).not.toThrow();
    expect(() =>
      assertSearchRequest({ query: "崩坏三 AI助手 用户聊天原文", count: 5, querySource: "learning-plan", planKeyword: "崩坏三 AI助手" }),
    ).toThrow(WebPolicyError);
  });

  it("learning/hot 缺 planKeyword 直接拒（不能靠 query 自由发挥）", () => {
    expect(reasonOf(() => assertSearchRequest({ query: "随便什么", count: 5, querySource: "hot-topic" }))).toBe("plan-mismatch");
  });

  it("tool 面自由文本限 2–120 字、单行、无控制字符", () => {
    expect(() => assertSearchRequest({ query: "AI助手", count: 5, querySource: "tool" })).not.toThrow();
    expect(reasonOf(() => assertSearchRequest({ query: "a", count: 5, querySource: "tool" }))).toBe("query-len");
    expect(reasonOf(() => assertSearchRequest({ query: "长".repeat(121), count: 5, querySource: "tool" }))).toBe("query-len");
    expect(reasonOf(() => assertSearchRequest({ query: "第一行\n第二行", count: 5, querySource: "tool" }))).toBe("query-control");
  });

  it("未知来源 / 空 query / count 越界都拒", () => {
    expect(reasonOf(() => assertSearchRequest({ query: "x", count: 5, querySource: "chat" as never }))).toBe("source");
    expect(reasonOf(() => assertSearchRequest({ query: "   ", count: 5, querySource: "tool" }))).toBe("query-empty");
    expect(reasonOf(() => assertSearchRequest({ query: "AI助手", count: 0, querySource: "tool" }))).toBe("count");
    expect(reasonOf(() => assertSearchRequest({ query: "AI助手", count: 51, querySource: "tool" }))).toBe("count");
  });
});

describe("assertPublicUrl：只许 https + 公网", () => {
  it("https 公网地址通过", () => {
    expect(assertPublicUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(assertPublicUrl("https://www.bilibili.com/video/BV1xx").protocol).toBe("https:");
  });

  it("http / 凭据 URL / 无法解析的 URL 都拒", () => {
    expect(reasonOf(() => assertPublicUrl("http://example.com"))).toBe("url-protocol");
    expect(reasonOf(() => assertPublicUrl("https://user:pass@example.com"))).toBe("url-credentials");
    expect(reasonOf(() => assertPublicUrl("not a url"))).toBe("url-host");
  });

  it("本机/内网/链路本地/元数据地址都拒", () => {
    for (const url of [
      "https://localhost/x",
      "https://foo.localhost/x",
      "https://metadata.google.internal/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://172.16.0.9/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
    ]) {
      expect(reasonOf(() => assertPublicUrl(url)), url).toMatch(/url-(private|host)/);
    }
  });
});
