import { describe, expect, it } from "vitest";

import { ChatChannelError, makeChannelChat, type ChannelChatCallInput, type ChannelChatResult } from "../src/plugin/channel-chat.js";
import { WriteChannelUnavailableError } from "../src/plugin/write-client.js";

/**
 * P2.1（task-157）：网页聊天写通道封装。
 *
 * 锁三件事：
 * 1) 投递形状（`op:"chat"`、payload `{text}`、默认 90s 超时）；
 * 2) `ok:false` 转 `ChatChannelError`（code 原样，前端错误码不丢）；
 * 3) 通道缺失/连不上给出明确提示，且**不回退本进程执行**。
 */

const DEPS = { dataDir: "C:/data", characterId: "assistant" };

function fakeCall(result: ChannelChatResult): {
  calls: ChannelChatCallInput[];
  call: (input: ChannelChatCallInput) => Promise<ChannelChatResult>;
} {
  const calls: ChannelChatCallInput[] = [];
  return {
    calls,
    call: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

describe("makeChannelChat：op:\"chat\" 写通道封装", () => {
  it("投递形状：op=chat、payload={text}、默认 90s 超时", async () => {
    const fake = fakeCall({ ok: true, result: { reply: "嗯。" } });
    const chat = makeChannelChat({ ...DEPS, call: fake.call });

    const result = await chat("在吗");

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      dataDir: "C:/data",
      characterId: "assistant",
      op: "chat",
      payload: { text: "在吗" },
      timeoutMs: 90_000,
    });
    expect(result.reply).toBe("嗯。");
  });

  it("成功时把 daemon 的 ChatResult 原样返回（mode/stage 可选字段不丢）", async () => {
    const fake = fakeCall({ ok: true, result: { reply: "晚安。", mode: "NORMAL", stage: "beloved" } });
    const chat = makeChannelChat({ ...DEPS, call: fake.call });
    await expect(chat("晚安")).resolves.toEqual({ reply: "晚安。", mode: "NORMAL", stage: "beloved" });
  });

  it("超时可覆盖（测试与将来调参用）", async () => {
    const fake = fakeCall({ ok: true, result: { reply: "嗯。" } });
    await makeChannelChat({ ...DEPS, call: fake.call, timeoutMs: 500 })("在吗");
    expect(fake.calls[0]?.timeoutMs).toBe(500);
  });

  it("ok:false → 抛 ChatChannelError，code 原样保留（asleep 等业务码）", async () => {
    const fake = fakeCall({ ok: false, error: "她在睡觉", code: "asleep" });
    const chat = makeChannelChat({ ...DEPS, call: fake.call });

    const err = await chat("在吗").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatChannelError);
    expect((err as ChatChannelError).code).toBe("asleep");
    expect((err as ChatChannelError).message).toContain("她在睡觉");
  });

  it("ok:false 但没给 code → 退回 daemon-unavailable（不瞎猜 500）", async () => {
    const fake = fakeCall({ ok: false, error: "写通道没给原因" });
    const chat = makeChannelChat({ ...DEPS, call: fake.call });
    const err = await chat("在吗").catch((e: unknown) => e);
    expect((err as ChatChannelError).code).toBe("daemon-unavailable");
  });

  it("ok:true 但没有 result → ChatChannelError（不把 undefined 当回复）", async () => {
    const fake = fakeCall({ ok: true });
    const chat = makeChannelChat({ ...DEPS, call: fake.call });
    const err = await chat("在吗").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatChannelError);
    expect((err as ChatChannelError).code).toBe("daemon-unavailable");
  });

  it("通道缺失/连不上 → ChatChannelError(CHANNEL_DOWN) + 明确提示（不回退本进程）", async () => {
    const chat = makeChannelChat({
      ...DEPS,
      call: async () => {
        throw new WriteChannelUnavailableError("写通道文件不存在：C:/data/write-channel-assistant.json");
      },
    });

    const err = await chat("在吗").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatChannelError);
    expect((err as ChatChannelError).code).toBe("CHANNEL_DOWN");
    expect((err as ChatChannelError).message).toContain("写通道不可用");
    expect((err as ChatChannelError).message).toContain("daemon 没跑");
  });
});
