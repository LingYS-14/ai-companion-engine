/**
 * 「这条要不要回」的**工具层适配器**（F298 后只剩形状转换）。
 *
 * 判断本身在 `src/qq/reply-policy.ts`：两个桥以前各写一份，顺序一样但细节会分叉
 * （新增媒体类型时只改了一边）。这里只做三件事——把 window 桥的 `InboxMessage`
 * 压成 `QqReplyCandidate`、把 `QQOptions` 里判断用的四项挑出来、把结果翻回旧形状。
 *
 * 静默时段仍然**不拦回信**：那是「她主动开口」的规则（proactive），
 * 不是「你半夜找她她不说话」。
 */

import { decideQqReply, isEchoLike } from "./reply-policy.js";
import type { QqReplyPolicy, QqReplyStateView } from "./reply-policy.js";
import type { InboxMessage, QQOptions, QQStateRecord } from "./types.js";

export type SkipReason =
  | "empty"
  | "echo"
  | "not-peer"
  | "duplicate"
  | "stale"
  | "quiet"
  | "gap"
  | "rate";

export interface Decision {
  readonly ok: boolean;
  readonly reason?: SkipReason;
  /** 给人看的说明（日志/工具输出用） */
  readonly detail: string;
}

/** 自己发的消息会从 QQ 回流进 inbox，必须排掉，否则会自问自答 */
export function isEcho(msg: InboxMessage, opts: QQOptions): boolean {
  return isEchoLike(msg.sender, msg.text, opts.selfSenders);
}

export interface DecideInput {
  readonly msg: InboxMessage;
  readonly opts: QQOptions;
  readonly state: QQStateRecord;
  /** 墙钟毫秒 */
  readonly now: number;
  /** 本地小时 0..23（由调用方给，不在本模块里碰 Date） */
  readonly localHour: number;
}

export function replyPolicyOf(opts: QQOptions): QqReplyPolicy {
  return {
    ignoreOlderThanMs: opts.ignoreOlderThanMs,
    minGapMs: opts.minGapMs,
    maxPerHour: opts.maxPerHour,
  };
}

export function decideReply(input: DecideInput): Decision {
  const { msg, opts, state, now } = input;
  const fromSelf = isEcho(msg, opts);
  const judgement = decideQqReply({
    candidate: {
      id: msg.id,
      text: msg.text,
      atMs: msg.epochNs / 1e6,
      hasMedia: false,
      fromPeer: msg.sender === opts.peer,
      fromSelf,
    },
    policy: replyPolicyOf(opts),
    state: state as QqReplyStateView,
    now,
  });
  if (judgement.ok) return { ok: true, detail: judgement.detail };
  // 保留旧文案里带上下文的两句（排查时第一眼就能看出是"谁发的"）
  if (judgement.reason === "echo") {
    return { ok: false, reason: "echo", detail: `自己发的回声（${msg.sender.trim() === "" ? "空名" : msg.sender}）` };
  }
  if (judgement.reason === "not-peer") {
    return { ok: false, reason: "not-peer", detail: `不是 ${opts.peer}（${msg.sender}）` };
  }
  return judgement.reason === undefined
    ? { ok: false, detail: judgement.detail }
    : { ok: false, reason: judgement.reason, detail: judgement.detail };
}
