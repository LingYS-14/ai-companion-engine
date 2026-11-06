import { describe, expect, it } from "vitest";
import {
  GAP_DECLINED_RETRY_MS,
  GAP_HELPED_COOLDOWN_MS,
  canAskAgain,
  gapAskOutcome,
} from "../src/orchestrator/intent/gap-outcome.js";
import { buildGuardianRequest, type GuardianReply } from "../src/orchestrator/intent/guardian.js";
import { formatUtc } from "../src/orchestrator/intent/episode.js";
import type { AskHistoryEntry } from "../src/orchestrator/intent/ask-help.js";
import type { HelpRequest } from "../src/orchestrator/intent/types.js";

const BASE = Date.UTC(2026, 9, 31, 2, 0, 0);
const HOUR = 3_600_000;
const INTENTION = "cap-gap:create:write";

function helpRequest(): HelpRequest {
  return {
    blockedIntentionId: INTENTION,
    what: "我想做点东西，可手边没有能写文件的能力。",
    tried: ["先看看手边有什么能用的"],
    need: "permission",
    ask: "能给我一个可以写文件的能力吗？",
  };
}

function requestAt(atMs: number) {
  return buildGuardianRequest(helpRequest(), formatUtc(atMs), atMs);
}

function historyAt(atMs: number, requestId: string): AskHistoryEntry {
  return { requestId, intentionId: INTENTION, askedAtMs: atMs };
}

function replyAt(atMs: number, requestId: string, verdict: "help" | "decline" | "later", retryAfterMs?: number): GuardianReply {
  return {
    requestId,
    at: formatUtc(atMs),
    from: "lead",
    verdict,
    note: "测试回执",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

describe("gap-outcome: 没问过 / 等回音", () => {
  it("从没问过 → 允许问", () => {
    const outcome = gapAskOutcome({ intentionId: INTENTION, history: [], requests: [], replies: [], nowMs: BASE });
    expect(outcome.state).toBe("never_asked");
    expect(canAskAgain(outcome, BASE).allowed).toBe(true);
  });

  it("已投递、还没到 2 小时 → 等回音，不许重复问", () => {
    const request = requestAt(BASE);
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, request.requestId)],
      requests: [request],
      replies: [],
      nowMs: BASE + HOUR,
    });
    expect(outcome.state).toBe("waiting");
    const verdict = canAskAgain(outcome, BASE + HOUR);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("等回音");
  });

  it("超时后按 guardian 的降频时间（超时 + 24h）才允许再问", () => {
    const request = requestAt(BASE);
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, request.requestId)],
      requests: [request],
      replies: [],
      nowMs: BASE + 3 * HOUR,
    });
    expect(outcome.state).toBe("timed_out");
    expect(canAskAgain(outcome, BASE + 3 * HOUR).allowed).toBe(false);
    expect(canAskAgain(outcome, BASE + 27 * HOUR).allowed).toBe(true);
  });

  it("历史里找不到请求原文（可能被清理）→ 按还在等处理，不重复问", () => {
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, "grd-gone-1")],
      requests: [],
      replies: [],
      nowMs: BASE + 10 * 24 * HOUR,
    });
    expect(outcome.state).toBe("waiting");
    expect(canAskAgain(outcome, BASE + 10 * 24 * HOUR).allowed).toBe(false);
  });
});

describe("gap-outcome: 答完之后", () => {
  it("答应了（help）→ 安静 14 天，之后允许再问（能力可能一直没落地）", () => {
    const request = requestAt(BASE);
    const reply = replyAt(BASE + HOUR, request.requestId, "help");
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, request.requestId)],
      requests: [request],
      replies: [reply],
      nowMs: BASE + 2 * HOUR,
    });
    expect(outcome.state).toBe("helped");
    expect(canAskAgain(outcome, BASE + 2 * HOUR).allowed).toBe(false);
    expect(canAskAgain(outcome, BASE + HOUR + GAP_HELPED_COOLDOWN_MS - 1).allowed).toBe(false);
    expect(canAskAgain(outcome, BASE + HOUR + GAP_HELPED_COOLDOWN_MS + 1).allowed).toBe(true);
  });

  it("拒绝了（decline）→ 冷却 7 天，不是永久封死", () => {
    const request = requestAt(BASE);
    const reply = replyAt(BASE + HOUR, request.requestId, "decline");
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, request.requestId)],
      requests: [request],
      replies: [reply],
      nowMs: BASE + 2 * HOUR,
    });
    expect(outcome.state).toBe("declined");
    expect(canAskAgain(outcome, BASE + 2 * HOUR).reason).toContain("7 天");
    expect(canAskAgain(outcome, BASE + HOUR + GAP_DECLINED_RETRY_MS - 1).allowed).toBe(false);
    expect(canAskAgain(outcome, BASE + HOUR + GAP_DECLINED_RETRY_MS + 1).allowed).toBe(true);
  });

  it("让等一等（later）→ 按对方给的 retryAfter 等", () => {
    const request = requestAt(BASE);
    const reply = replyAt(BASE + HOUR, request.requestId, "later", 4 * HOUR);
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, request.requestId)],
      requests: [request],
      replies: [reply],
      nowMs: BASE + 2 * HOUR,
    });
    expect(outcome.state).toBe("later");
    expect(canAskAgain(outcome, BASE + 2 * HOUR).allowed).toBe(false);
    expect(canAskAgain(outcome, BASE + 5 * HOUR + 1).allowed).toBe(true);
  });

  it("同一缺口问过两次时只看最新那条；同一条请求被回两次时取更晚的回执", () => {
    const first = requestAt(BASE);
    const second = requestAt(BASE + 10 * HOUR);
    const olderReply = replyAt(BASE + HOUR, second.requestId, "decline");
    const newerReply = replyAt(BASE + 11 * HOUR, second.requestId, "help");
    const outcome = gapAskOutcome({
      intentionId: INTENTION,
      history: [historyAt(BASE, first.requestId), historyAt(BASE + 10 * HOUR, second.requestId)],
      requests: [first, second],
      replies: [olderReply, newerReply],
      nowMs: BASE + 12 * HOUR,
    });
    expect(outcome.requestId).toBe(second.requestId);
    expect(outcome.state).toBe("helped");
  });

  it("非法 nowMs 抛 RangeError", () => {
    expect(() => gapAskOutcome({ intentionId: INTENTION, history: [], requests: [], replies: [], nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => canAskAgain({ intentionId: INTENTION, requestId: null, state: "never_asked", askedAtMs: null, nextAskAtMs: null, note: "" }, -1)).toThrow(RangeError);
  });
});
