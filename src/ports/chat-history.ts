/**
 * P2 网页聊天：共享对话历史的端口类型。
 *
 * 为什么放在 ports：QQ 桥（tools 层）与 chat-turn（spine 层）都要读写同一段历史，
 * 而 tools 不能 import spine（R3）——共用的形状只能落在这一层公共门面。
 * 这里没有 IO、没有时钟；真正的落盘在 `src/autonomy/chat-log.ts`（spine，注入 now）。
 */

/** 一条对话记录。`channel` 标明从哪儿来/往哪儿去，UI 用它标来源。 */
export interface ChatHistoryEntry {
  readonly atMs: number;
  readonly who: "peer" | "her";
  readonly text: string;
  readonly channel: "qq" | "web";
}

/**
 * 共享历史的最小接口。
 *
 * `recent` 按时间正序返回最近 N 条（N 由调用方给，实现自己 clamp 到内存上限）；
 * `append` 只追加、不改写。实现必须容忍坏行：历史文件是明文 NDJSON，崩溃/手改都可能留下半行。
 */
export interface ChatHistoryStore {
  recent(limit: number): readonly ChatHistoryEntry[];
  append(entry: ChatHistoryEntry): void;
}
