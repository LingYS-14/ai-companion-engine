import { describe, expect, it } from "vitest";
import {
  GUARDIAN_MAX_PER_DAY,
  GUARDIAN_TIMEOUT_MS,
  MAX_WHAT_CHARS,
  buildGuardianRequest,
  chooseGuardianTarget,
  describeGuardianRequest,
  guardianRequestId,
  parseGuardianReply,
  parseGuardianRequest,
  resolveGuardian,
  serializeGuardianRequest,
} from "../src/orchestrator/intent/guardian.js";
import type { HelpRequest } from "../src/orchestrator/intent/types.js";

const AT = "2026-10-31T03:00:00.000Z";
const AT_MS = Date.parse(AT);

function help(overrides: Partial<HelpRequest> = {}): HelpRequest {
  return {
    blockedIntentionId: "itn-1",
    what: "想给她发一条语音，但找不到能用的 TTS 引擎",
    tried: ["查了 tools/voice", "跑了一次 tts.ps1 报错"],
    need: "permission",
    ask: "帮我确认能不能装 edge-tts",
    ...overrides,
  };
}

describe("P4 监护人验证器：请求构造（guardian.ts）", () => {
  it("tried 为空直接拒：没试过就不算求助", () => {
    expect(() => buildGuardianRequest(help({ tried: [] }), AT, AT_MS)).toThrow(RangeError);
  });

  it("what/ask 为空或超长按上限拒", () => {
    expect(() => buildGuardianRequest(help({ what: "   " }), AT, AT_MS)).toThrow(RangeError);
    expect(() => buildGuardianRequest(help({ ask: "x".repeat(MAX_WHAT_CHARS + 1) }), AT, AT_MS)).toThrow(RangeError);
  });

  it("请求 id 是确定性的：同一意图 + 同一分钟 = 同一个 id（幂等落盘）", () => {
    expect(guardianRequestId("itn-1", AT_MS)).toBe(guardianRequestId("itn-1", AT_MS + 30_000));
    expect(guardianRequestId("itn-1", AT_MS)).not.toBe(guardianRequestId("itn-1", AT_MS + 120_000));
  });

  it("规范化：去掉首尾空白，键序固定可读", () => {
    const request = buildGuardianRequest(help({ what: "  空格在两边  " }), AT, AT_MS);
    expect(request.what).toBe("空格在两边");
    expect(serializeGuardianRequest(request).startsWith('{"requestId"')).toBe(true);
  });

  it("请求序列化 → 解析往返一致；坏行带理由", () => {
    const request = buildGuardianRequest(help(), AT, AT_MS);
    const parsed = parseGuardianRequest(serializeGuardianRequest(request));
    expect(parsed.errors).toEqual([]);
    expect(parsed.request).toEqual(request);

    expect(parseGuardianRequest("{bad").request).toBeNull();
    expect(parseGuardianRequest("{}").errors.join("；")).toContain("requestId");
    const noTried = JSON.parse(serializeGuardianRequest(request)) as Record<string, unknown>;
    noTried.tried = [];
    expect(parseGuardianRequest(JSON.stringify(noTried)).errors.join("；")).toContain("tried");
  });
});

describe("P4 监护人验证器：应答解析", () => {
  function reply(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      requestId: "grd-itn-1-1000",
      at: AT,
      from: "lead",
      verdict: "help",
      note: "可以，我帮你确认",
      ...overrides,
    });
  }

  it("合法应答解析成功", () => {
    const parsed = parseGuardianReply(reply());
    expect(parsed.errors).toEqual([]);
    expect(parsed.reply?.verdict).toBe("help");
    expect(parsed.reply?.from).toBe("lead");
  });

  it("非法 from/verdict/空 note 都拒（不猜）", () => {
    expect(parseGuardianReply(reply({ from: "god" })).errors.join("；")).toContain("from");
    expect(parseGuardianReply(reply({ verdict: "ok" })).errors.join("；")).toContain("verdict");
    expect(parseGuardianReply(reply({ note: "  " })).errors.join("；")).toContain("note");
    expect(parseGuardianReply(reply({ retryAfterMs: -1 })).errors.join("；")).toContain("retryAfterMs");
  });
});

describe("P4 监护人验证器：状态机与超时语义", () => {
  const request = buildGuardianRequest(help(), AT, AT_MS);

  it("未超时：pending，下一问时间 = 创建 + 2 小时（不连环催）", () => {
    const resolution = resolveGuardian(request, null, AT_MS + 60_000);
    expect(resolution.state).toBe("pending");
    expect(resolution.nextAskAtMs).toBe(AT_MS + GUARDIAN_TIMEOUT_MS);
    expect(resolution.fact).toBeNull();
  });

  it("超时没人回：写「问过，暂无回音」，不清零尝试次数，只降频到 24 小时后", () => {
    const resolution = resolveGuardian(request, null, AT_MS + GUARDIAN_TIMEOUT_MS + 1);
    expect(resolution.state).toBe("timed-out");
    expect(resolution.fact).toBe("问过，暂无回音");
    expect(resolution.nextAskAtMs).toBe(AT_MS + GUARDIAN_TIMEOUT_MS + 24 * 60 * 60_000);
    expect(resolution.note).toContain("不清零");
  });

  it("监护人回 help：状态 answered，不再限制追问时间", () => {
    const reply = {
      requestId: request.requestId,
      at: AT,
      from: "lead" as const,
      verdict: "help" as const,
      note: "可以，我来确认",
    };
    const resolution = resolveGuardian(request, reply, AT_MS + 1_000);
    expect(resolution.state).toBe("answered");
    expect(resolution.nextAskAtMs).toBeNull();
    expect(resolution.fact).toBeNull();
  });

  it("回 later：按 retryAfterMs 降频；没给就用 2 小时默认", () => {
    const later = {
      requestId: request.requestId,
      at: AT,
      from: "owner" as const,
      verdict: "later" as const,
      note: "我在忙，晚点",
      retryAfterMs: 30 * 60_000,
    };
    const resolution = resolveGuardian(request, later, AT_MS + 1_000);
    expect(resolution.state).toBe("answered");
    expect(resolution.nextAskAtMs).toBe(AT_MS + 30 * 60_000);
  });

  it("回 decline：记一句事实，别反复问", () => {
    const decline = {
      requestId: request.requestId,
      at: AT,
      from: "owner" as const,
      verdict: "decline" as const,
      note: "这件事不能做",
    };
    const resolution = resolveGuardian(request, decline, AT_MS + 1_000);
    expect(resolution.fact).toContain("帮不了");
    expect(resolution.note).toContain("别反复问");
  });

  it("应答 id 对不上直接抛（防止把别人的回答套到这次请求上）", () => {
    const wrong = {
      requestId: "grd-other-1",
      at: AT,
      from: "lead" as const,
      verdict: "help" as const,
      note: "行",
    };
    expect(() => resolveGuardian(request, wrong, AT_MS)).toThrow(RangeError);
  });
});

describe("P4 监护人验证器：找谁 + 摘要", () => {
  it("用户最近活跃 → owner；很久没动静 → lead（监护人）", () => {
    expect(chooseGuardianTarget({ nowMs: AT_MS, ownerLastActiveMs: AT_MS - 5 * 60_000 })).toBe("owner");
    expect(chooseGuardianTarget({ nowMs: AT_MS, ownerLastActiveMs: AT_MS - 90 * 60_000 })).toBe("lead");
    expect(chooseGuardianTarget({ nowMs: AT_MS, ownerLastActiveMs: null })).toBe("lead");
  });

  it("每天全局最多两次是常量，不是随手拍的数字", () => {
    expect(GUARDIAN_MAX_PER_DAY).toBe(2);
  });

  it("摘要一行说清：卡在哪、试过什么、需要什么、希望对方做什么", () => {
    const line = describeGuardianRequest(buildGuardianRequest(help(), AT, AT_MS));
    expect(line).toContain("【求助】");
    expect(line).toContain("试过");
    expect(line).toContain("需要");
    expect(line).toContain("希望你");
  });
});
