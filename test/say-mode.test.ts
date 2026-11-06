import { describe, expect, it } from "vitest";

import { runSayMode } from "../src/assembly/say-mode.js";
import type { OneBotConn } from "../src/autonomy/onebot-config.js";

const conn: OneBotConn = {
  baseUrl: "http://127.0.0.1:3000",
  wsUrl: "ws://127.0.0.1:3001",
  token: "t",
  peer: 1,
  dryRun: false,
};

interface Calls {
  readonly logs: string[];
  readonly spoken: string[];
}

const deps = (
  overrides: Partial<Parameters<typeof runSayMode>[1]> = {},
): { calls: Calls; deps: Parameters<typeof runSayMode>[1] } => {
  const calls: Calls = { logs: [], spoken: [] };
  const base = {
    log: (line: string) => calls.logs.push(line),
    loadConn: (): OneBotConn | null => conn,
    humanize: (raw: string): string | null => `人话：${raw}`,
    speak: async (c: OneBotConn, line: string) => {
      calls.spoken.push(`${String(c.peer)}|${line}`);
      return { ok: true, detail: "发送成功", messageId: 7 };
    },
  };
  return { calls, deps: { ...base, ...overrides } };
};

describe("--say 模式（F281）", () => {
  it("读不到 OneBot 配置：退出码 1、说清是配置问题、不发送", async () => {
    const h = deps({ loadConn: () => null });
    await expect(runSayMode("在吗", h.deps)).resolves.toBe(1);
    expect(h.calls.logs[0]).toContain("没读到 OneBot 连接配置");
    expect(h.calls.spoken).toEqual([]);
  });

  it("原话改不成能说出口的话：退出码 1、记拒绝、不发送", async () => {
    const h = deps({ humanize: () => null });
    await expect(runSayMode("（旁白：她笑了）", h.deps)).resolves.toBe(1);
    expect(h.calls.logs[0]).toContain("拒绝");
    expect(h.calls.spoken).toEqual([]);
  });

  it("成功：发送的是 humanize 之后的那句，退出码 0，日志带 messageId 结果", async () => {
    const h = deps();
    await expect(runSayMode("在吗，我想你了", h.deps)).resolves.toBe(0);
    expect(h.calls.spoken).toEqual(["1|人话：在吗，我想你了"]);
    expect(h.calls.logs.join("\n")).toContain("--say ok=true");
  });

  it("发送失败：退出码 1，但仍把失败原因记进日志", async () => {
    const h = deps({
      speak: async () => ({ ok: false, detail: "HTTP 500: boom" }),
    });
    await expect(runSayMode("在吗", h.deps)).resolves.toBe(1);
    expect(h.calls.logs.join("\n")).toContain("--say ok=false");
    expect(h.calls.logs.join("\n")).toContain("HTTP 500: boom");
  });

  it("空文本也走 humanize（是否可发由那一层判定），不在这里特判", async () => {
    let received = "";
    const h = deps({
      humanize: (raw: string) => {
        received = raw;
        return null;
      },
    });
    await expect(runSayMode("", h.deps)).resolves.toBe(1);
    expect(received).toBe("");
  });

  it("装配锁：入口的 --say 分支已改为调用 runSayMode", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../scripts/autonomy/main.mjs", import.meta.url), "utf8");
    expect(main).toContain('from "../../dist/assembly/say-mode.js"');
    expect(main).toContain("await runSayMode(text, {");
    expect(main).not.toContain("--say 拒绝：这句改不成能直接说出口的话");
  });
});
