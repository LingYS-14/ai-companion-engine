/**
 * F298：「这条要不要回」只有一份实现。
 *
 * 以前 window 桥的 `decideReply` 与 OneBot 桥的 `decideOneBotReply` 各写一遍，
 * 顺序相同但细节容易分叉（新增媒体类型时只改一边）。现在两者都是适配器，
 * 规则住在 `src/qq/reply-policy.ts`；这里直接测规则本身，并用锁测试盯住
 * 「规则不许再被复制回桥里」。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decideQqReply,
  isEchoLike,
  type QqReplyCandidate,
  type QqReplyPolicy,
  type QqReplyStateView,
} from "../src/qq/reply-policy.js";

const NOW = 1_793_500_000_000;

const policy: QqReplyPolicy = { ignoreOlderThanMs: 600_000, minGapMs: 8_000, maxPerHour: 3 };

const state: QqReplyStateView = { repliedIds: ["seen-1"], lastReplyAt: null, replyTimes: [] };

function candidate(over: Partial<QqReplyCandidate> = {}): QqReplyCandidate {
  return { id: "m-1", text: "在吗", atMs: NOW - 1000, hasMedia: false, fromPeer: true, fromSelf: false, ...over };
}

function judge(over: Partial<QqReplyCandidate> = {}, stateOver: Partial<QqReplyStateView> = {}): ReturnType<typeof decideQqReply> {
  return decideQqReply({ candidate: candidate(over), policy, state: { ...state, ...stateOver }, now: NOW });
}

describe("decideQqReply（F298 唯一判定）", () => {
  it("正常消息可以回", () => {
    expect(judge().ok).toBe(true);
  });

  it("空文本 + 无媒体 → empty，但纯图片/语音消息不算空", () => {
    expect(judge({ text: "  " }).reason).toBe("empty");
    expect(judge({ text: "  ", hasMedia: true }).ok).toBe(true);
  });

  it("回声、不是目标、重复、太旧、间隔、限速，各有各的理由且顺序稳定", () => {
    expect(judge({ fromSelf: true }).reason).toBe("echo");
    expect(judge({ fromPeer: false }).reason).toBe("not-peer");
    expect(judge({ id: "seen-1" }).reason).toBe("duplicate");
    expect(judge({ atMs: 0 }).reason).toBe("stale");
    expect(judge({ atMs: Number.NaN }).reason).toBe("stale");
    expect(judge({ atMs: NOW - 11 * 60_000 }).reason).toBe("stale");
    expect(judge({}, { lastReplyAt: NOW - 1_000 }).reason).toBe("gap");
    expect(judge({}, { replyTimes: [NOW - 1000, NOW - 2000, NOW - 3000] }).reason).toBe("rate");
  });

  it("一小时窗外的旧回复不占限速额度", () => {
    const old = [NOW - 2 * 3_600_000, NOW - 3 * 3_600_000, NOW - 4 * 3_600_000];
    expect(judge({}, { replyTimes: old }).ok).toBe(true);
  });

  it("门限是参数，不是写死的数字", () => {
    const strict: QqReplyPolicy = { ignoreOlderThanMs: 1000, minGapMs: 60_000, maxPerHour: 0 };
    expect(decideQqReply({ candidate: candidate({ atMs: NOW - 2000 }), policy: strict, state, now: NOW }).reason).toBe("stale");
    expect(decideQqReply({ candidate: candidate(), policy: strict, state, now: NOW }).reason).toBe("rate");
  });

  it("isEchoLike 认自己名字、空名和 [tag] 前缀", () => {
    expect(isEchoLike("鲸鱼", "随便说说", ["鲸鱼"])).toBe(true);
    expect(isEchoLike("  ", "随便说说", ["鲸鱼"])).toBe(true);
    expect(isEchoLike("鲸鱼", "[ase] 她刚才说的话", ["鲸鱼"])).toBe(true);
    expect(isEchoLike("用户", "在吗", ["鲸鱼"])).toBe(false);
  });
});

describe("规则只有一份（F298 锁）", () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("两个桥都调 decideQqReply，不再各写一遍", () => {
    expect(read("src/qq/filter.ts")).toContain("decideQqReply(");
    expect(read("src/qq/onebot-bridge.ts")).toContain("decideQqReply(");
  });

  it("判定细节只允许出现在 reply-policy.ts", () => {
    const policyFile = read("src/qq/reply-policy.ts");
    expect(policyFile).toContain("repliedIds.includes");
    expect(policyFile).toContain("maxPerHour");
    for (const path of ["src/qq/filter.ts", "src/qq/onebot-bridge.ts", "src/qq/bridge.ts"]) {
      const text = read(path);
      // 判定细节（查重、限速、过期判断）不许再出现在桥里；桥只做形状适配。
      expect(text).not.toContain("repliedIds.includes");
      expect(text).not.toContain('reason: "rate"');
      expect(text).not.toContain('reason: "duplicate"');
    }
  });
});
