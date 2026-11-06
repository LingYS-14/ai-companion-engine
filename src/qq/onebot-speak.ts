/**
 * 让自主进程真的「说出声」：走 OneBot HTTP 发一条私聊。
 *
 * 为什么不用窗口通道（`src/qq/send.ts`）：那条路要占据宿主机的鼠标键盘与前台窗口，
 * 只在 DSH 宿主里合适；常驻进程没有 UI 上下文，用 OneBot HTTP 才是无副作用的。
 * 发送失败只影响这一次开口（返回 ok:false），不抛错——她下一拍还有机会。
 *
 * F280（2026-11-01）：本文件原先在 `src/autonomy/qq-speak.ts`（脊髓层），但它的**唯一**
 * 使用方是常驻入口（装配点），脊髓逻辑本身从不发送——它是「对外世界」的实现，
 * 按三层语义应归工具层。搬到这里后，脊髓层不再含任何 QQ 发送代码（审计 P1-6）。
 * 若将来脊髓真的要主动发送，应先在 `src/ports/` 定义 SendPort 再注入，而不是直连 HTTP。
 */

import type { FetchLike } from "../autonomy/llm.js";
import type { OneBotConn } from "../autonomy/onebot-config.js";

export interface SpeakResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly messageId?: number;
}

export interface SpeakerDeps {
  readonly conn: OneBotConn;
  readonly fetchImpl?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

interface OneBotResponse {
  readonly status?: string;
  readonly retcode?: number;
  readonly message?: string;
  readonly data?: { readonly message_id?: number };
}

function parse(raw: string): OneBotResponse | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as OneBotResponse;
  } catch {
    return null;
  }
}

/** 返回一个发一句话的函数；deps 里没有 fetch 时用全局 fetch（脚本环境由 Node 提供） */
export function makeOneBotSpeaker(deps: SpeakerDeps): (text: string) => Promise<SpeakResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return async (text: string): Promise<SpeakResult> => {
    const body = text.trim();
    if (body === "") return { ok: false, detail: "空文本，未发送" };
    if (deps.conn.dryRun) return { ok: true, detail: "dry-run（未真正发送）" };
    if (fetchImpl === undefined) return { ok: false, detail: "没有可用的 fetch" };
    const url = `${deps.conn.baseUrl.replace(/\/+$/u, "")}/send_private_msg`;
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.conn.token}` },
        body: JSON.stringify({ user_id: deps.conn.peer, message: body, auto_escape: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      const parsed = parse(raw);
      if (!res.ok) return { ok: false, detail: `HTTP ${String(res.status)}: ${raw.slice(0, 120)}` };
      if (parsed === null || (parsed.retcode !== undefined && parsed.retcode !== 0)) {
        return { ok: false, detail: `retcode ${String(parsed?.retcode ?? "?")}: ${raw.slice(0, 120)}` };
      }
      const id = parsed.data?.message_id;
      return typeof id === "number" ? { ok: true, detail: "sent", messageId: id } : { ok: true, detail: "sent" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}
