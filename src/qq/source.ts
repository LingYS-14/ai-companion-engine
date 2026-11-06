/**
 * 入站消息的「来源」抽象。
 *
 * 为什么要有这一层：读消息现在有至少三条互不冲突的路——
 *   1. `clipboard`：`qq-ops` 点窗口 + 拖选复制，落到 `bus/inbox/*.json`（当前在用）；
 *   2. `onebot`：QQ 侧运行时（如 SnowLuma）用 OneBot v11 推原生事件，图片/语音/文件都在事件里；
 *   3. `db`：直接读本地消息库（需要先拿到 SQLCipher 密钥，见 `scripts/dbprobe.py`）。
 *
 * 三条路的数据形状不同、可用性不同、风险也不同，但**桥只关心一件事**：
 * 「给我一批有 id、有时间、有发送者、有正文的 InboxMessage」。
 * 所以这里只定义这一个契约，桥的下游（过滤、限速、推状态、写台词、发送）完全不用改。
 *
 * 刻意不做的事：不在这里排序、不去重跨源重复消息的业务语义（`mergeInbox` 只按 id 去重），
 * 也不判断"该不该回"——那是 `filter.ts` 的事。
 */

import type { InboxMessage } from "./types.js";

export type InboundOrigin = "clipboard" | "onebot" | "db";

export interface InboundSource {
  /** 来源标识，用于日志与状态（不该参与判断"这条消息重不重要"） */
  readonly name: InboundOrigin;
  /**
   * 现在能不能用。不可用时桥**跳过**这个源，而不是把整轮判成失败：
   * 例如没装 QQ 侧运行时，`onebot` 永远 false，剪贴板通道应当照常工作。
   */
  available(): boolean;
  /** 拉取当前可见的消息（可以异步；不要求增量，去重交给 `mergeInbox`） */
  pull(now: number): readonly InboxMessage[] | Promise<readonly InboxMessage[]>;
}

/** 按 id 去重、按时间排序。同一 id 出现在两个源里时保留先到的那条（值相同，无所谓）。 */
export function mergeInbox(lists: readonly (readonly InboxMessage[])[]): readonly InboxMessage[] {
  const byId = new Map<string, InboxMessage>();
  for (const list of lists) {
    for (const msg of list) {
      if (!byId.has(msg.id)) byId.set(msg.id, msg);
    }
  }
  return [...byId.values()].sort((a, b) => a.epochNs - b.epochNs);
}

/** 把若干来源合成一个 `readInbox()`。不可用的源直接跳过，不报错。 */
export function composeSources(
  sources: readonly InboundSource[],
): (now: number) => Promise<readonly InboxMessage[]> {
  return async (now: number) => {
    const lists: (readonly InboxMessage[])[] = [];
    for (const src of sources) {
      if (!src.available()) continue;
      try {
        lists.push(await src.pull(now));
      } catch {
        // 单个源失败不能拖垮整轮：下一轮再来
        continue;
      }
    }
    return mergeInbox(lists);
  };
}

/**
 * 把 `bus/inbox` 目录读成来源。
 *
 * `readSync` 由宿主注入（host.ts 的 `readInbox`），这样本模块不碰 fs、测试不需要真目录。
 */
export function clipboardSource(
  readSync: () => readonly InboxMessage[],
  opts: { readonly enabled?: boolean } = {},
): InboundSource {
  return {
    name: "clipboard",
    available: () => opts.enabled !== false,
    pull: () => readSync(),
  };
}

// ---------------------------------------------------------------------------
// OneBot v11 → InboxMessage
// ---------------------------------------------------------------------------

/** OneBot v11 消息段（只声明我们会用到的字段，其余忽略） */
export interface OneBotSegment {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** OneBot v11 事件（同上：只声明用到的） */
export interface OneBotEvent {
  readonly post_type?: string;
  readonly message_type?: string;
  readonly message_id?: number | string;
  readonly time?: number;
  readonly user_id?: number | string;
  readonly raw_message?: string;
  readonly message?: readonly OneBotSegment[] | string;
  readonly sender?: Readonly<{ nickname?: string; card?: string; user_id?: number | string }>;
}

const segText = (s: OneBotSegment): string => {
  const d = s.data ?? {};
  switch (s.type) {
    case "text":
      return typeof d["text"] === "string" ? d["text"] : "";
    case "image":
    case "mface": {
      const file = typeof d["file"] === "string" ? d["file"] : "";
      const url = typeof d["url"] === "string" ? d["url"] : "";
      const name = file !== "" ? file : "图片";
      // 与 parse_msgs.py 的剪贴板标记同形，下游的 parseInbound 不用改：
      // 只有本地路径才能读成字节，URL 目前只作为"对方发了图"的证据。
      return url !== "" ? `[图片 ${name}] <${url}>` : `[图片 ${name}]`;
    }
    case "record":
      return "[语音]";
    case "file": {
      const name = typeof d["name"] === "string" ? d["name"] : typeof d["file"] === "string" ? d["file"] : "文件";
      return `[文件 ${name}]`;
    }
    case "face":
      return "[表情]";
    case "at": {
      const qq = d["qq"];
      return typeof qq === "string" ? `@${qq} ` : "@";
    }
    case "reply":
      return "";
    default:
      return "";
  }
};

/**
 * 把一个 OneBot 私聊事件转成 InboxMessage；不是私聊消息就返回 null。
 *
 * 群聊现在**明确不支持**：桥的去重/限速/回声过滤都是按"一个人"设计的，
 * 群聊要多 peer、多会话，属于后面单独一轮的事，这里不偷偷把它当私聊处理。
 */
export function oneBotEventToInbox(ev: OneBotEvent): InboxMessage | null {
  if (ev.post_type !== "message") return null;
  if (ev.message_type !== "private") return null;
  const time = typeof ev.time === "number" && Number.isFinite(ev.time) && ev.time > 0 ? ev.time : 0;
  if (time === 0) return null;

  const segs: readonly OneBotSegment[] =
    typeof ev.message === "string"
      ? [{ type: "text", data: { text: ev.message } }]
      : (ev.message ?? []);
  const fromSegs = segs.map(segText).join("");
  const text = fromSegs.trim() !== "" ? fromSegs : (ev.raw_message ?? "");
  if (text.trim() === "") return null;

  const id =
    ev.message_id === undefined
      ? `ob_${time}_${String(ev.user_id ?? "0")}`
      : `ob_${String(ev.message_id)}`;
  const sender =
    ev.sender?.card ?? ev.sender?.nickname ?? (ev.user_id === undefined ? "" : String(ev.user_id));

  return {
    id,
    epochNs: time * 1_000_000_000,
    at: hhmmss(time),
    sender,
    text,
  };
}

/** 秒级时间戳 → "HH:MM:SS"（UTC，与剪贴板通道保持一致：它给的也是 QQ 消息自身的时间） */
function hhmmss(seconds: number): string {
  const s = seconds % 86_400;
  const hh = Math.floor(s / 3_600);
  const mm = Math.floor((s % 3_600) / 60);
  const ss = s % 60;
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}
