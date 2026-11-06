import { describe, expect, it } from "vitest";
import {
  clipboardSource,
  composeSources,
  mergeInbox,
  oneBotEventToInbox,
  type InboundSource,
} from "../src/qq/source.js";
import type { InboxMessage } from "../src/qq/types.js";

const msg = (id: string, epochNs: number, text = "hi", sender = "用户"): InboxMessage => ({
  id,
  epochNs,
  at: "12:00:00",
  sender,
  text,
});

describe("mergeInbox", () => {
  it("按时间排序", () => {
    const out = mergeInbox([[msg("b", 3)], [msg("a", 1)], [msg("c", 2)]]);
    expect(out.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("同一 id 跨源只留一条", () => {
    const out = mergeInbox([[msg("a", 1, "剪贴板")], [msg("a", 1, "事件")]]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("剪贴板");
  });

  it("空输入得到空数组", () => {
    expect(mergeInbox([])).toEqual([]);
    expect(mergeInbox([[], []])).toEqual([]);
  });
});

describe("composeSources", () => {
  const src = (name: InboundSource["name"], available: boolean, list: () => readonly InboxMessage[]): InboundSource => ({
    name,
    available: () => available,
    pull: list,
  });

  it("跳过不可用来源", async () => {
    const read = composeSources([src("clipboard", true, () => [msg("a", 1)]), src("onebot", false, () => [msg("b", 2)])]);
    expect((await read(0)).map((m) => m.id)).toEqual(["a"]);
  });

  it("一个源抛错不影响其它源", async () => {
    const boom: InboundSource = {
      name: "db",
      available: () => true,
      pull: () => {
        throw new Error("库还没解密");
      },
    };
    const read = composeSources([boom, src("clipboard", true, () => [msg("a", 1)])]);
    expect((await read(0)).map((m) => m.id)).toEqual(["a"]);
  });

  it("异步源会被等待", async () => {
    const slow: InboundSource = {
      name: "onebot",
      available: () => true,
      pull: async () => [msg("z", 9)],
    };
    const read = composeSources([slow]);
    expect((await read(0))[0]?.id).toBe("z");
  });
});

describe("clipboardSource", () => {
  it("默认可用，pull 就是读目录", async () => {
    const s = clipboardSource(() => [msg("a", 1)]);
    expect(s.available()).toBe(true);
    expect(await s.pull(0)).toHaveLength(1);
  });

  it("enabled=false 时不可用（但不会抛错）", () => {
    const s = clipboardSource(() => [msg("a", 1)], { enabled: false });
    expect(s.available()).toBe(false);
  });
});

describe("oneBotEventToInbox", () => {
  it("私聊文本 → InboxMessage", () => {
    const out = oneBotEventToInbox({
      post_type: "message",
      message_type: "private",
      message_id: 12345,
      time: 1_700_000_000,
      user_id: 10000002,
      message: [{ type: "text", data: { text: "在吗" } }],
      sender: { nickname: "用户" },
    });
    expect(out).not.toBeNull();
    expect(out?.id).toBe("ob_12345");
    expect(out?.sender).toBe("用户");
    expect(out?.epochNs).toBe(1_700_000_000_000_000_000);
    expect(out?.text).toBe("在吗");
  });

  it("图片段带 url 时保留地址（与剪贴板标记同形）", () => {
    const out = oneBotEventToInbox({
      post_type: "message",
      message_type: "private",
      message_id: 1,
      time: 1_700_000_001,
      message: [
        { type: "text", data: { text: "看这个" } },
        { type: "image", data: { file: "a.jpg", url: "https://example.test/a.jpg" } },
      ],
    });
    expect(out?.text).toContain("[图片 a.jpg] <https://example.test/a.jpg>");
  });

  it("语音/文件/表情段有可读占位", () => {
    const out = oneBotEventToInbox({
      post_type: "message",
      message_type: "private",
      message_id: 2,
      time: 1_700_000_002,
      message: [
        { type: "record", data: { file: "v.amr" } },
        { type: "file", data: { name: "报告.pdf" } },
        { type: "face", data: { id: "1" } },
      ],
    });
    expect(out?.text).toBe("[语音][文件 报告.pdf][表情]");
  });

  it("字符串形式的消息体也能读", () => {
    const out = oneBotEventToInbox({
      post_type: "message",
      message_type: "private",
      message_id: 3,
      time: 1_700_000_003,
      raw_message: "纯文本",
      message: "纯文本",
    });
    expect(out?.text).toBe("纯文本");
  });

  it("群聊 / 非消息事件 / 无正文 / 无时间 → null", () => {
    expect(oneBotEventToInbox({ post_type: "message", message_type: "group", time: 1, message: "hi" })).toBeNull();
    expect(oneBotEventToInbox({ post_type: "notice", time: 1, raw_message: "hi" })).toBeNull();
    expect(
      oneBotEventToInbox({ post_type: "message", message_type: "private", time: 1, message: [{ type: "reply", data: {} }] }),
    ).toBeNull();
    expect(oneBotEventToInbox({ post_type: "message", message_type: "private", message: "hi" })).toBeNull();
  });

  it("没有 message_id 时用 time+user_id 拼一个稳定 id", () => {
    const out = oneBotEventToInbox({
      post_type: "message",
      message_type: "private",
      time: 1_700_000_004,
      user_id: 42,
      message: "hi",
    });
    expect(out?.id).toBe("ob_1700000004_42");
  });
});
