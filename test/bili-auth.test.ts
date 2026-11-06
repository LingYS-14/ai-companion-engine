import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pollQrLogin, requestQrLogin, saveBiliSession, sessionFromCookies, sessionFromLoginUrl } from "../src/bili/auth.js";

const TMP_ROOT = process.env["TMP_ROOT"] ?? join(process.cwd(), ".tmp-probe");
mkdirSync(TMP_ROOT, { recursive: true });

/** 造一个只认识两个 URL 的 fetch：generate 与 poll */
function fakeFetch(generate: unknown, poll?: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/qrcode/poll") ? poll : generate;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("B 站扫码登录", () => {
  it("requestQrLogin 解出 url 与 qrcode_key", async () => {
    const fetchFn = fakeFetch({ code: 0, data: { url: "https://passport.bilibili.com/h5-app/passport/login/scan?x=1", qrcode_key: "K1" } });
    const s = await requestQrLogin({ fetchFn });
    expect(s.key).toBe("K1");
    expect(s.url).toContain("passport.bilibili.com");
  });

  it("requestQrLogin 缺字段时报错", async () => {
    const fetchFn = fakeFetch({ code: 0, data: {} });
    await expect(requestQrLogin({ fetchFn })).rejects.toThrow(/缺 url/);
  });

  it("poll 的四种状态都认识", async () => {
    const cases: Array<[number, string]> = [
      [86101, "waiting"],
      [86090, "scanned"],
      [86038, "expired"],
      [-1, "failed"],
    ];
    for (const [code, status] of cases) {
      const r = await pollQrLogin({ fetchFn: fakeFetch({}, { code: 0, data: { code } }) }, "K1");
      expect(r.status).toBe(status);
    }
  });

  it("poll 成功时从回调 url 取 session（不解码 SESSDATA）", async () => {
    const back = "https://passport.bilibili.com/login/crossDomain?SESSDATA=abc%2C123&bili_jct=JCT&DedeUserID=42";
    const r = await pollQrLogin({ fetchFn: fakeFetch({}, { code: 0, data: { code: 0, url: back } }) }, "K1");
    expect(r.status).toBe("success");
    expect(r.session?.sessdata).toBe("abc%2C123");
    expect(r.session?.biliJct).toBe("JCT");
  });

  it("sessionFromLoginUrl 缺 SESSDATA 返回 null", () => {
    expect(sessionFromLoginUrl("https://x/y?bili_jct=1")).toBeNull();
    expect(sessionFromLoginUrl("not a url")).toBeNull();
  });

  it("empty key 直接 failed，不发请求", async () => {
    const r = await pollQrLogin({}, "  ");
    expect(r.status).toBe("failed");
  });

  it("saveBiliSession 落盘字段正确且不写多余元数据", () => {
    const dir = join(TMP_ROOT, "biliauth-test");
    rmSync(dir, { recursive: true, force: true });
    const path = join(dir, "bili-assistant.json");
    saveBiliSession(path, { sessdata: "S%2C1", biliJct: "J" }, { now: () => 1234 });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ sessdata: "S%2C1", biliJct: "J", savedAt: 1234 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("poll 成功但回调不含 SESSDATA 时，退回到 Set-Cookie", async () => {
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      headers: { getSetCookie: () => ["SESSDATA=abc%2C1%2Cxyz; Path=/; Domain=.bilibili.com", "bili_jct=J1; Path=/"] },
      text: async () => JSON.stringify({ code: 0, data: { code: 0, url: "https://passport.biligame.com/x?gourl=1" } }),
    })) as unknown as typeof fetch;
    const r = await pollQrLogin({ fetchFn }, "K1");
    expect(r.status).toBe("success");
    expect(r.session?.sessdata).toBe("abc%2C1%2Cxyz");
    expect(r.session?.biliJct).toBe("J1");
  });

  it("poll 成功但两条路都没有登录态时，报「只成功了一半」并说明原因", async () => {
    const logs: string[] = [];
    const fetchFn = (async () => ({
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [] },
      text: async () => JSON.stringify({ code: 0, data: { code: 0, url: "" } }),
    })) as unknown as typeof fetch;
    const r = await pollQrLogin({ fetchFn, log: (l) => logs.push(l) }, "K1");
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/只成功了一半/);
    expect(r.detail).toMatch(/回调 url 为空/);
    expect(logs.join(" | ")).toMatch(/code=0 url_len=0/);
  });

  it("sessionFromCookies 缺 SESSDATA 返回 null", () => {
    expect(sessionFromCookies(new Map())).toBeNull();
    expect(sessionFromCookies(new Map([["bili_jct", "x"]]))).toBeNull();
    expect(sessionFromCookies(new Map([["SESSDATA", "s1"]]))).toEqual({ sessdata: "s1" });
  });
});
