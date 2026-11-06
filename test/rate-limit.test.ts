import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/execution/rate-limit.js";

describe("每分钟限速", () => {
  it("超过上限就拒绝，且不占名额", () => {
    const limiter = new RateLimiter();
    expect(limiter.tryAcquire("qq.send", 2, 1000)).toBe(true);
    expect(limiter.tryAcquire("qq.send", 2, 2000)).toBe(true);
    expect(limiter.tryAcquire("qq.send", 2, 3000)).toBe(false);
    expect(limiter.count("qq.send", 3000)).toBe(2);
  });

  it("窗口滚过之后重新放行", () => {
    const limiter = new RateLimiter();
    expect(limiter.tryAcquire("qq.send", 1, 1000)).toBe(true);
    expect(limiter.tryAcquire("qq.send", 1, 60_500)).toBe(false);
    expect(limiter.tryAcquire("qq.send", 1, 61_100)).toBe(true);
  });

  it("不同工具各算各的", () => {
    const limiter = new RateLimiter();
    expect(limiter.tryAcquire("a", 1, 1000)).toBe(true);
    expect(limiter.tryAcquire("b", 1, 1000)).toBe(true);
    expect(limiter.tryAcquire("a", 1, 1000)).toBe(false);
  });
});
