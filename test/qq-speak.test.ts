import { describe, expect, it } from "vitest";

import type { FetchLike } from "../src/autonomy/llm.js";
import type { OneBotConn } from "../src/autonomy/onebot-config.js";
import { makeOneBotSpeaker } from "../src/qq/onebot-speak.js";

const conn: OneBotConn = {
  baseUrl: "http://127.0.0.1:3000/",
  token: "tok",
  peer: 10000001,
  dryRun: false,
};

interface Call {
  readonly url: string;
  readonly init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string };
}

function stubFetch(status: number, raw: string): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(raw),
    });
  };
  return { calls, fetchImpl };
}

describe("makeOneBotSpeaker：把一句话真的发出去", () => {
  it("POST send_private_msg，带 token、user_id、正文；返回 message_id", async () => {
    const { calls, fetchImpl } = stubFetch(200, JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 42 } }));
    const speak = makeOneBotSpeaker({ conn, fetchImpl });
    const out = await speak("  晚风有点凉，记得加件外套  ");
    expect(out).toEqual({ ok: true, detail: "sent", messageId: 42 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("http://127.0.0.1:3000/send_private_msg");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(call.init.body)).toEqual({ user_id: 10000001, message: "晚风有点凉，记得加件外套", auto_escape: false });
  });

  it("retcode 非 0 → ok:false，并且不抛错", async () => {
    const { fetchImpl } = stubFetch(200, JSON.stringify({ retcode: 1400, message: "bad" }));
    const out = await makeOneBotSpeaker({ conn, fetchImpl })("在吗");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("1400");
  });

  it("HTTP 500 / 非 JSON / fetch 抛错 → 都返回 ok:false", async () => {
    const bad = makeOneBotSpeaker({ conn, fetchImpl: stubFetch(500, "boom").fetchImpl });
    expect((await bad("在吗")).ok).toBe(false);

    const notJson = makeOneBotSpeaker({ conn, fetchImpl: stubFetch(200, "<html>").fetchImpl });
    expect((await notJson("在吗")).ok).toBe(false);

    const throwing: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const out = await makeOneBotSpeaker({ conn, fetchImpl: throwing })("在吗");
    expect(out).toEqual({ ok: false, detail: "ECONNREFUSED" });
  });

  it("dryRun 不发网络请求；空文本直接拒绝", async () => {
    const { calls, fetchImpl } = stubFetch(200, "{}");
    const dry = makeOneBotSpeaker({ conn: { ...conn, dryRun: true }, fetchImpl });
    expect((await dry("在吗")).ok).toBe(true);
    expect(calls).toHaveLength(0);

    const real = makeOneBotSpeaker({ conn, fetchImpl });
    expect((await real("   ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
