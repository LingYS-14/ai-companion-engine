import { describe, expect, it } from "vitest";
import {
  buildDshAsk,
  buildDshReply,
  describeDshAsk,
  DSH_TIMEOUT_MS,
  dshAskId,
  dshFactsPath,
  dshInboxPath,
  dshReplyDir,
  parseDshAsk,
  parseDshInbox,
  parseDshReply,
  parseDshFactLines,
  recordedDshIds,
  resolveDshAsk,
  serializeDshAsk,
  serializeDshFact,
  serializeDshReply,
} from "../src/orchestrator/intent/dsh-bridge.js";

const AT = Date.parse("2026-10-31T08:40:00.000Z");

describe("DSH 双向桥（方向二）：她 → DSH", () => {
  it("路径按约定落在 data/ 下", () => {
    expect(dshInboxPath("/tmp/data", "assistant")).toBe("/tmp/data/dsh-inbox-assistant.ndjson");
    expect(dshReplyDir("/tmp/data")).toBe("/tmp/data/dsh-reply");
    expect(dshFactsPath("/tmp/data", "assistant")).toBe("/tmp/data/dsh-facts-assistant.ndjson");
  });

  it("F254：id 里不能有冒号（它要当文件名用，Windows 不允许）", () => {
    const id = dshAskId("live-check-2026-10-31T11:43", AT);
    expect(id).not.toContain(":");
    expect(id.startsWith("dsh-live-check-2026-10-31T11-43-")).toBe(true);
  });

  it("幂等 id 是 dsh-<意图>-<分钟>，非法字符被清掉", () => {
    expect(dshAskId("itn-reach_out-1", AT)).toBe(`dsh-itn-reach_out-1-${String(Math.floor(AT / 60_000))}`);
    // 路径分隔符不能留
    const id = dshAskId("a/b c", AT);
    expect(id.startsWith("dsh-a-b-c-")).toBe(true);
    expect(id.includes("/")).toBe(false);
    expect(() => dshAskId("   ", AT)).toThrow(RangeError);
    expect(() => dshAskId("x", Number.NaN)).toThrow(RangeError);
  });

  it("造请求：形状完整、超时 2 小时、tried 去掉空串", () => {
    const ask = buildDshAsk({
      intentionId: "itn-1",
      atMs: AT,
      kind: "help",
      text: "  我写不进文件，能帮我看一下吗？  ",
      tried: ["查了权限", "  ", "重启了脚本"],
    });
    expect(ask.text).toBe("我写不进文件，能帮我看一下吗？");
    expect(ask.tried).toEqual(["查了权限", "重启了脚本"]);
    expect(ask.at).toBe("2026-10-31T08:40:00Z");
    expect(ask.expiresAt).toBe("2026-10-31T10:40:00Z");
    expect(Date.parse(ask.expiresAt) - Date.parse(ask.at)).toBe(DSH_TIMEOUT_MS);
    expect(ask.kind).toBe("help");
  });

  it("造请求的非法输入抛 RangeError（宁可不写也不写坏行）", () => {
    const base = { intentionId: "itn-1", atMs: AT, kind: "help" as const, text: "帮我看看" };
    expect(() => buildDshAsk({ ...base, text: "   " })).toThrow(RangeError);
    expect(() => buildDshAsk({ ...base, text: "x".repeat(301) })).toThrow(RangeError);
    expect(() => buildDshAsk({ ...base, tried: new Array(6).fill("试过") })).toThrow(RangeError);
    expect(() => buildDshAsk({ ...base, tried: ["x".repeat(201)] })).toThrow(RangeError);
    expect(() => buildDshAsk({ ...base, kind: "unknown" as never })).toThrow(RangeError);
  });

  it("序列化往返：一行 JSON，重新解析一致", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "observe", text: "看看现在几点", tried: ["看了一眼"] });
    const line = serializeDshAsk(ask);
    expect(line.includes("\n")).toBe(false);
    expect(parseDshAsk(JSON.parse(line))).toEqual(ask);
  });

  it("解析整份 inbox：好行保留、坏行计数", () => {
    const good = serializeDshAsk(buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" }));
    const text = [good, "{not json", JSON.stringify({ version: 1, id: "x" }), "", good].join("\n");
    const parsed = parseDshInbox(text);
    expect(parsed.asks).toHaveLength(2);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toContain("不是 JSON");
    expect(parsed.errors[1]).toContain("形状不对");
  });

  it("parseDshAsk 对坏形状返回 null（版本不符/超长/时间倒挂/kind 未知）", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" });
    const base = JSON.parse(serializeDshAsk(ask)) as Record<string, unknown>;
    expect(parseDshAsk({ ...base, version: 2 })).toBeNull();
    expect(parseDshAsk({ ...base, kind: "say" })).toBeNull();
    expect(parseDshAsk({ ...base, text: "" })).toBeNull();
    expect(parseDshAsk({ ...base, expiresAt: base.at })).toBeNull();
    expect(parseDshAsk({ ...base, tried: ["ok", 3] })).toBeNull();
    expect(parseDshAsk(null)).toBeNull();
  });

  it("回执：构造、序列化、解析往返", () => {
    const reply = buildDshReply({ id: "dsh-itn-1-X", atMs: AT, by: "lead", verdict: "answered", answer: "文件我已经帮你打开了。" });
    expect(reply.at).toBe("2026-10-31T08:40:00Z");
    expect(parseDshReply(JSON.parse(serializeDshReply(reply)))).toEqual(reply);
  });

  it("回执的非法输入抛 RangeError / 解析返回 null", () => {
    expect(() => buildDshReply({ id: "guardian-1", atMs: AT, by: "lead", verdict: "answered" })).toThrow(RangeError);
    expect(() => buildDshReply({ id: "dsh-1", atMs: AT, by: " ", verdict: "answered" })).toThrow(RangeError);
    expect(() => buildDshReply({ id: "dsh-1", atMs: AT, by: "lead", verdict: "maybe" as never })).toThrow(RangeError);
    expect(() => buildDshReply({ id: "dsh-1", atMs: AT, by: "lead", verdict: "answered", answer: "x".repeat(501) })).toThrow(RangeError);
    expect(parseDshReply({ id: "dsh-1" })).toBeNull();
  });

  it("配对：已答/帮不了/稍后都落成一句事实", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" });
    const answered = resolveDshAsk(ask, buildDshReply({ id: ask.id, atMs: AT + 60_000, by: "lead", verdict: "answered", answer: "好了" }), AT + 120_000);
    expect(answered.status).toBe("answered");
    expect(answered.fact).toBe("DSH 回我了：好了");
    const declined = resolveDshAsk(ask, buildDshReply({ id: ask.id, atMs: AT + 60_000, by: "lead", verdict: "declined" }), AT + 120_000);
    expect(declined.status).toBe("declined");
    expect(declined.fact).toContain("帮不了");
    const later = resolveDshAsk(ask, buildDshReply({ id: ask.id, atMs: AT + 60_000, by: "lead", verdict: "later", answer: "十分钟" }), AT + 120_000);
    expect(later.status).toBe("later");
    expect(later.fact).toContain("稍后");
  });

  it("配对：没回执未超时是 pending（不编事实），超时是 expired（同一句「暂无回音」）", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" });
    const pending = resolveDshAsk(ask, null, AT + 60_000);
    expect(pending.status).toBe("pending");
    expect(pending.fact).toBeNull();
    const expired = resolveDshAsk(ask, null, AT + DSH_TIMEOUT_MS + 1000);
    expect(expired.status).toBe("expired");
    expect(expired.fact).toBe("问过，暂无回音");
    expect(() => resolveDshAsk(ask, null, Number.NaN)).toThrow(RangeError);
  });

  it("摘要一行、不复述全文", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "notify", text: "我想告诉你一件事：" + "很长".repeat(40) });
    const line = describeDshAsk(ask);
    expect(line).toContain("DSH 请求");
    expect(line).toContain("notify");
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("DSH 请求带意图 id（超时升级要用）", () => {
  it("序列化/解析保住 intentionId", () => {
    const ask = buildDshAsk({ intentionId: "cap-gap:create:write", atMs: AT, kind: "help", text: "帮我看看" });
    expect(ask.intentionId).toBe("cap-gap:create:write");
    const back = parseDshAsk(JSON.parse(serializeDshAsk(ask)));
    expect(back?.intentionId).toBe("cap-gap:create:write");
  });

  it("缺 intentionId 的行算形状不对（旧行没有它，我不假装兼容）", () => {
    const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" });
    const raw = JSON.parse(serializeDshAsk(ask)) as Record<string, unknown>;
    const without = { ...raw };
    delete without.intentionId;
    expect(parseDshAsk(without)).toBeNull();
  });
});

describe("DSH 回执落事实（她记进记忆的那一句）", () => {
  const ask = buildDshAsk({ intentionId: "itn-1", atMs: AT, kind: "help", text: "帮我看看" });

  it("pending 不落事实（没结果不编）", () => {
    const pending = resolveDshAsk(ask, null, AT + 60_000);
    expect(pending.status).toBe("pending");
    expect(() => serializeDshFact(pending, AT + 60_000)).toThrow(RangeError);
  });

  it("answered 落一行事实，解析往返一致", () => {
    const reply = buildDshReply({ id: ask.id, atMs: AT + 120_000, by: "lead", verdict: "answered", answer: "文件我已经打开了。" });
    const resolved = resolveDshAsk(ask, reply, AT + 120_000);
    expect(resolved.fact).toContain("DSH 回我了");
    const line = serializeDshFact(resolved, AT + 180_000);
    const parsed = parseDshFactLines(line);
    expect(parsed.errors).toEqual([]);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]?.id).toBe(ask.id);
    expect(parsed.facts[0]?.status).toBe("answered");
    expect(parsed.facts[0]?.fact).toBe(resolved.fact);
    expect(parsed.facts[0]?.recordedAtMs).toBe(AT + 180_000);
  });

  it("过期落“问过，暂无回音”，并按 id 去重", () => {
    const expired = resolveDshAsk(ask, null, AT + DSH_TIMEOUT_MS + 1000);
    const line = serializeDshFact(expired, AT + DSH_TIMEOUT_MS + 2000);
    expect(line).toContain("问过，暂无回音");
    const twice = `${line}\n${line}\n{not json`;
    const parsed = parseDshFactLines(twice);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.errors).toHaveLength(1);
    expect(recordedDshIds(twice).has(ask.id)).toBe(true);
    expect(recordedDshIds(twice).size).toBe(1);
  });

  it("坏行计入 errors、好行照读", () => {
    const expired = resolveDshAsk(ask, null, AT + DSH_TIMEOUT_MS + 1000);
    const ok = serializeDshFact(expired, AT + DSH_TIMEOUT_MS + 5000);
    const text = [
      ok,
      "",
      JSON.stringify({ version: 2, id: "x" }),
      JSON.stringify({ version: 1, id: "y", at: "z", status: "pending", fact: "f", recordedAtMs: 1 }),
    ].join("\n");
    const parsed = parseDshFactLines(text);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.errors).toHaveLength(2);
  });
});
