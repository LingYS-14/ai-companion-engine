/**
 * 「这条消息要不要回」的唯一实现（F298）。
 *
 * 以前两个 QQ 桥各写了一份：`src/qq/filter.ts` 的 `decideReply`（window 通道）
 * 与 `src/qq/onebot-bridge.ts` 的 `decideOneBotReply`（OneBot 通道）。顺序一样，
 * 但一处新增媒体类型时只改了一边——审计 P1-4 说的「工具层做业务判断」就是这种情况：
 * 判断被复制，迟早分叉。
 *
 * 现在两份都变成适配器：把各自协议消息压成 `QqReplyCandidate`，再调这里。
 * 规则仍然住在工具层（`src/qq/`），因为搬到大脑层需要一箩筐端口注入
 * （ReplyJudge），那是独立的一刀，见 `docs/ARCHITECTURE.md` 的 D11。
 *
 * 有意的取舍：
 * - **静默时段不拦回信**。静默时段约束的是「她主动开口」（proactive），
 *   不是「你半夜找她她不说话」。早期两边共用一套门，结果凌晨发消息她完全不回，
 *   看起来像掉线。
 * - 顺序固定：空 → 回声 → 不是目标 → 重复 → 太旧 → 间隔 → 限速。
 *   先便宜后昂贵；日志里第一个出现的拒绝原因就是最外层原因。
 * - 这里不碰时钟、不读盘：`now` 由调用方算好传进来。
 */

/** 归一化后的候选消息 */
export interface QqReplyCandidate {
  readonly id: string;
  readonly text: string;
  /** 事件时间（毫秒墙钟） */
  readonly atMs: number;
  readonly hasMedia: boolean;
  /** 发信人是不是配置里的 peer（目标本人） */
  readonly fromPeer: boolean;
  /** 是不是她自己的回声 */
  readonly fromSelf: boolean;
}

/** 回信门限：只取判断用到的四项 */
export interface QqReplyPolicy {
  readonly ignoreOlderThanMs: number;
  readonly minGapMs: number;
  readonly maxPerHour: number;
}

/** 回信判断用到的状态切片（与 QQStateRecord 结构兼容） */
export interface QqReplyStateView {
  readonly repliedIds: readonly string[];
  readonly lastReplyAt: number | null;
  readonly replyTimes: readonly number[];
}

export type QqReplySkipReason = "empty" | "echo" | "not-peer" | "duplicate" | "stale" | "gap" | "rate";

export interface QqReplyJudgement {
  readonly ok: boolean;
  readonly reason?: QqReplySkipReason;
  readonly detail: string;
}

/** 自己发的消息回流时常带 `[tag] ` 前缀 */
const ECHO_TAG = /^\[[a-z0-9_-]{1,16}\]\s/i;

const HOUR_MS = 3_600_000;

/** 自己发的消息会从 QQ 回流进 inbox，必须排掉，否则会自问自答 */
export function isEchoLike(name: string, text: string, selfSenders: readonly string[]): boolean {
  if (selfSenders.includes(name)) return true;
  if (name.trim() === "") return true;
  return ECHO_TAG.test(text.trim());
}

export function decideQqReply(input: {
  readonly candidate: QqReplyCandidate;
  readonly policy: QqReplyPolicy;
  readonly state: QqReplyStateView;
  readonly now: number;
}): QqReplyJudgement {
  const { candidate, policy, state, now } = input;

  const hasText = candidate.text.trim() !== "";
  if (!hasText && !candidate.hasMedia) {
    return { ok: false, reason: "empty", detail: "没有内容" };
  }
  if (candidate.fromSelf) {
    return { ok: false, reason: "echo", detail: "自己发的回声" };
  }
  if (!candidate.fromPeer) {
    return { ok: false, reason: "not-peer", detail: "不是目标本人" };
  }
  if (state.repliedIds.includes(candidate.id)) {
    return { ok: false, reason: "duplicate", detail: "这条已经回过了" };
  }
  if (!Number.isFinite(candidate.atMs) || candidate.atMs <= 0) {
    return { ok: false, reason: "stale", detail: "事件没有可用时间" };
  }
  const ageMs = now - candidate.atMs;
  if (ageMs > policy.ignoreOlderThanMs) {
    return { ok: false, reason: "stale", detail: `太旧了（${Math.round(ageMs / 60_000)} 分钟前）` };
  }
  if (state.lastReplyAt !== null && now - state.lastReplyAt < policy.minGapMs) {
    return { ok: false, reason: "gap", detail: `距上一条不到 ${Math.round(policy.minGapMs / 1000)} 秒` };
  }
  const recent = state.replyTimes.filter((t) => now - t < HOUR_MS).length;
  if (recent >= policy.maxPerHour) {
    return { ok: false, reason: "rate", detail: `一小时内已回 ${recent} 条（上限 ${policy.maxPerHour}）` };
  }
  return { ok: true, detail: "可以回" };
}
