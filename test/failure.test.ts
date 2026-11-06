import { describe, expect, it } from "vitest";
import { classifyFailure, isTransientError, retryableFor } from "../src/execution/failure.js";

describe("失败分类（H3/H3b）", () => {
  const atMost = { idempotency: "at-most-once" as const, queryable: false };

  it("网络/限流错误归 TRANSIENT，不管幂等语义", () => {
    expect(classifyFailure(new Error("ETIMEDOUT"), atMost)).toBe("TRANSIENT");
    expect(classifyFailure(new Error("502 bad gateway"), atMost)).toBe("TRANSIENT");
    expect(classifyFailure(new Error("rate limit exceeded"), atMost)).toBe("TRANSIENT");
  });

  it("不可查询的 at-most-once 遇到非网络错误 → INDETERMINATE，不猜结果", () => {
    expect(classifyFailure(new Error("400 bad request"), atMost)).toBe("INDETERMINATE");
  });

  it("可查询或幂等的同类错误 → PERMANENT", () => {
    expect(classifyFailure(new Error("400 bad request"), { idempotency: "at-most-once", queryable: true })).toBe("PERMANENT");
    expect(classifyFailure(new Error("400 bad request"), { idempotency: "idempotent", queryable: false })).toBe("PERMANENT");
  });

  it("只有 TRANSIENT 允许重试（INDETERMINATE/PARTIAL 一律不重试）", () => {
    expect(retryableFor("TRANSIENT")).toBe(true);
    expect(retryableFor("INDETERMINATE")).toBe(false);
    expect(retryableFor("PARTIAL")).toBe(false);
    expect(retryableFor("PERMANENT")).toBe(false);
  });

  it("isTransientError 对非 Error 也按字符串匹配", () => {
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("ok")).toBe(false);
  });
});
