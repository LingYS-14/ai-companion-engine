/**
 * `--say` 模式（装配层，F281）。
 *
 * 常驻入口原本把这段流程写在 `main()` 里：读 OneBot 配置 → 过「能直接说出口」的闸 →
 * 发一条私聊 → 用退出码表示结果。它是**装配语义**（把工具层的发送与原话过滤接起来），
 * 但写在入口里既不能单测，也让入口继续变厚。
 *
 * 这里只编排、不实现：读连接、原话改写成能说出口的话、发送，三件事都由调用方注入。
 */

import type { OneBotConn } from "../autonomy/onebot-config.js";

/** 发送结果（与 `src/qq/onebot-speak.ts` 的 SpeakResult 同形，这里不 import 工具层）。 */
export interface SayResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly messageId?: number;
}

export interface SayModeDeps {
  /** 日志出口（入口注入带时间戳与轮转的实现） */
  readonly log: (line: string) => void;
  /** 读 OneBot 连接；读不到返回 null */
  readonly loadConn: () => OneBotConn | null;
  /** 把原话改成能直接说出口的一句；改不出来返回 null（旁白框架/元叙述会被拦） */
  readonly humanize: (raw: string) => string | null;
  /** 真的发出去 */
  readonly speak: (conn: OneBotConn, line: string) => Promise<SayResult>;
}

/**
 * 跑一次 `--say`，返回进程退出码（0 成功 / 1 失败）。
 *
 * 约定：所有失败都只记日志、返回码，不抛错——入口拿它设 `process.exitCode`。
 */
export async function runSayMode(raw: string, deps: SayModeDeps): Promise<number> {
  const conn = deps.loadConn();
  if (conn === null) {
    deps.log("[autonomy] --say：没读到 OneBot 连接配置（cordis.patch.yml 的 onebot 段）");
    return 1;
  }
  // 手动探针也走同一道闸：旁白框架/元叙述不发出去（2026-10-29 用户反馈）
  const line = deps.humanize(raw);
  if (line === null) {
    deps.log("[autonomy] --say 拒绝：这句改不成能直接说出口的话");
    return 1;
  }
  const out = await deps.speak(conn, line);
  deps.log(`[autonomy] --say ok=${String(out.ok)} detail=${out.detail}`);
  return out.ok ? 0 : 1;
}
