import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeGatedSender } from "../src/autonomy/qq-runner.js";

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-sender-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("常驻进程出站：走执行层", () => {
  it("同一句话 60 秒内第二次发送被幂等拦下，只真正发一次", async () => {
    const sent: string[] = [];
    const send = makeGatedSender({
      now: () => 1_000_000,
      dataDir: tempDir(),
      send: async (_peer, text) => {
        sent.push(text);
        return { ok: true, detail: "sent" };
      },
    });

    const first = await send(10000001, "在吗");
    const second = await send(10000001, "在吗");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.detail).toContain("重复请求");
    expect(sent).toEqual(["在吗"]);
  });

  it("换一句话就照常发送", async () => {
    const sent: string[] = [];
    const send = makeGatedSender({
      now: () => 1_000_000,
      dataDir: tempDir(),
      send: async (_peer, text) => {
        sent.push(text);
        return { ok: true, detail: "sent" };
      },
    });

    await send(10000001, "在吗");
    await send(10000001, "睡了吗");
    expect(sent).toEqual(["在吗", "睡了吗"]);
  });

  it("发送失败如实上报，不假装成功", async () => {
    const send = makeGatedSender({
      now: () => 1_000_000,
      dataDir: tempDir(),
      send: async () => ({ ok: false, detail: "窗口没开" }),
    });

    const outcome = await send(10000001, "测试失败");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("failed");
  });

  it("上一次失败后的去重记录不能当成功（B.3：否则账上成功、对面没收到）", async () => {
    let attempts = 0;
    const send = makeGatedSender({
      now: () => 1_000_000,
      dataDir: tempDir(),
      send: async () => {
        attempts += 1;
        return { ok: false, detail: "窗口没开" };
      },
    });

    const first = await send(10000001, "同一句话");
    const second = await send(10000001, "同一句话");
    expect(first.ok).toBe(false);
    // at-most-once：第二次不会再调发送器，而是命中失败记录
    expect(attempts).toBe(1);
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("上次未发出");
  });
});
