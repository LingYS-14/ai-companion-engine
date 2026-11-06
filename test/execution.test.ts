import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionGateway } from "../src/execution/gateway.js";
import { requestFingerprint } from "../src/execution/hash.js";
import type { ToolAdapterSpec } from "../src/execution/types.js";

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-exec-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Ctx {
  gateway: ExecutionGateway;
  dir: string;
  calls: number;
  now: number;
}

function makeCtx(spec: Partial<ToolAdapterSpec<string, string>> = {}, maxPerMinute = 100): Ctx {
  const dir = makeDir();
  const ctx: Ctx = {
    dir,
    calls: 0,
    now: 1_000_000,
    gateway: new ExecutionGateway({
      now: () => ctx.now,
      eventsFile: join(dir, "events.ndjson"),
      idemFile: join(dir, "idem.json"),
    }),
  };
  ctx.gateway.register<string, string>({
    toolId: "qq.send",
    idempotency: "at-most-once",
    riskTier: "external",
    queryable: false,
    timeoutMs: 10_000,
    maxPerMinute,
    dedupeTtlMs: 60_000,
    call: async (input) => {
      ctx.calls += 1;
      if (spec.call !== undefined) return spec.call(input);
      return `sent:${input}`;
    },
  });
  return ctx;
}

describe("执行层 · 幂等", () => {
  it("at-most-once：同一句话在窗口内只发出一次", async () => {
    const ctx = makeCtx();
    const first = await ctx.gateway.execute("qq.send", "在吗", { subject: "dev:1", target: "qq:10000001" });
    const second = await ctx.gateway.execute("qq.send", "在吗", { subject: "dev:1", target: "qq:10000001" });
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("deduplicated");
    expect(ctx.calls).toBe(1);
  });

  it("同一句话发给不同对象不会互相去重", async () => {
    const ctx = makeCtx();
    await ctx.gateway.execute("qq.send", "在吗", { subject: "dev:1", target: "qq:a" });
    await ctx.gateway.execute("qq.send", "在吗", { subject: "dev:1", target: "qq:b" });
    expect(ctx.calls).toBe(2);
  });

  it("过了去重窗口可以再发一次", async () => {
    const ctx = makeCtx();
    await ctx.gateway.execute("qq.send", "晚安", { subject: "dev:1", target: "qq:a" });
    ctx.now += 61_000;
    const again = await ctx.gateway.execute("qq.send", "晚安", { subject: "dev:1", target: "qq:a" });
    expect(again.status).toBe("succeeded");
    expect(ctx.calls).toBe(2);
  });

  it("失败后 at-most-once 不自动重发，返回失败而不是重复发送", async () => {
    const ctx = makeCtx({
      call: async () => {
        throw new Error("fetch failed");
      },
    });
    const first = await ctx.gateway.execute("qq.send", "早", { subject: "dev:1", target: "qq:a" });
    expect(first.status).toBe("failed");
    expect(first.failure?.class).toBe("TRANSIENT");
    // at-most-once + 不可查询 → 失败也保留记录，后续请求是 deduplicated
    const second = await ctx.gateway.execute("qq.send", "早", { subject: "dev:1", target: "qq:a" });
    expect(second.status).toBe("deduplicated");
    expect(ctx.calls).toBe(1);
  });
});

describe("执行层 · 限速与失败分类", () => {
  it("超过每分钟上限返回 rate-limited，不调用适配器", async () => {
    const ctx = makeCtx({}, 2);
    await ctx.gateway.execute("qq.send", "a", { subject: "dev:1", target: "qq:a" });
    await ctx.gateway.execute("qq.send", "b", { subject: "dev:1", target: "qq:a" });
    const third = await ctx.gateway.execute("qq.send", "c", { subject: "dev:1", target: "qq:a" });
    expect(third.status).toBe("rate-limited");
    expect(ctx.calls).toBe(2);
  });

  it("不可查询通道的非网络错误判 INDETERMINATE（不猜结果）且不可重试", async () => {
    const ctx = makeCtx({
      call: async () => {
        throw new Error("窗口句柄找不到");
      },
    });
    const outcome = await ctx.gateway.execute("qq.send", "x", { subject: "dev:1", target: "qq:a" });
    expect(outcome.failure?.class).toBe("INDETERMINATE");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("未注册的工具直接失败，不落事件也不调用", async () => {
    const ctx = makeCtx();
    const outcome = await ctx.gateway.execute("bili.comment", "x", { subject: "dev:1" });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.class).toBe("PERMANENT");
    expect(ctx.calls).toBe(0);
  });
});

describe("执行层 · 日志与指纹", () => {
  it("事件日志有 start 与 succeeded 两行且含摘要", async () => {
    const ctx = makeCtx();
    await ctx.gateway.execute("qq.send", "用户，晚上好", { subject: "autonomy:tick", target: "qq:a" });
    const lines = readFileSync(join(ctx.dir, "events.ndjson"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0] ?? "{}") as { status?: string; inputDigest?: string; subject?: string };
    const second = JSON.parse(lines[1] ?? "{}") as { status?: string };
    expect(first.status).toBe("start");
    expect(first.inputDigest).toContain("用户");
    expect(first.subject).toBe("autonomy:tick");
    expect(second.status).toBe("succeeded");
  });

  it("指纹对键顺序不敏感，对目标敏感", () => {
    const a = requestFingerprint({ toolId: "t", target: "x", payload: { b: 1, a: 2 } });
    const b = requestFingerprint({ toolId: "t", target: "x", payload: { a: 2, b: 1 } });
    const c = requestFingerprint({ toolId: "t", target: "y", payload: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("幂等存储落盘且能重开复用", async () => {
    const ctx = makeCtx();
    await ctx.gateway.execute("qq.send", "落盘", { subject: "dev:1", target: "qq:a" });
    const reopened = new ExecutionGateway({
      now: () => ctx.now,
      eventsFile: join(ctx.dir, "events.ndjson"),
      idemFile: join(ctx.dir, "idem.json"),
    });
    expect(existsSync(join(ctx.dir, "idem.json"))).toBe(true);
    expect(reopened.specsList()).toEqual([]);
  });
});
