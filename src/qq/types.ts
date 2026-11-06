/**
 * QQ 桥的共享类型。
 *
 * 这一层存在的理由：`qq-ops` 那套通道是「宿主进程发真实鼠标键盘 + 文件队列，
 * 消息落到 `bus/inbox/*.json`」。本模块**不重写**那套通道，只做三件事：
 *   1. 把 inbox 的 JSON 读成一个有类型、可过滤的队列；
 *   2. 决定「这条要不要回」（去回声、去重、静默时段、限速）；
 *   3. 让引擎推一轮状态、把「怎么说」交给宿主 LLM，再把台词发回去。
 *
 * 所有与外部世界的接触都收在 `QQDeps` 里，所以 bridge 本身是纯逻辑，测试不需要 QQ。
 */

/** `bus/inbox/<epoch_ns>_<id>.json` 的一条 */
export interface InboxMessage {
  readonly id: string;
  /** 文件名前缀的纳秒时间戳——比 at 里的 HH:MM:SS 可靠，跨天也不会乱序 */
  readonly epochNs: number;
  /** "HH:MM:SS" */
  readonly at: string;
  /** 群里看到的名字。自己发的会回流成「鲸鱼」或「(未解析)」 */
  readonly sender: string;
  readonly text: string;
}

/** 持久化到 `data/qq-<characterId>.json` 的桥状态 */
export interface QQStateRecord {
  /** 已经处理过的最大 epochNs（跳过历史积压用） */
  cursorEpochNs: number;
  /** 已回过的消息 id（防同一轮重复回；只保留最近 200 条） */
  repliedIds: string[];
  /** 最近 1 小时的回帖时间戳，用来限速 */
  replyTimes: number[];
  lastReplyAt: number | null;
  /**
   * 她主动开口的时间戳（滚动 24 小时，用来算"今天说过几句"）。
   * 旧存档没有这个字段，按空数组读。
   */
  proactiveAt?: number[];
  lastProactiveAt?: number | null;
  /**
   * OneBot 通道最近一次「处理并记账」的事件时间（毫秒）。
   * 窗口通道不用它；旧存档没有这个字段，读成 null。
   */
  onebotLastEventAt?: number | null;
}

export interface QQOptions {
  /** 只回这个人的消息（QQ 昵称，不是 QQ 号） */
  readonly peer: string;
  /** 自己的名字/回声标记；sender 命中即视为自己发的 */
  readonly selfSenders: readonly string[];
  /** 静默时段（本地小时，左闭右开）。默认 0..7 不回 */
  readonly quietFrom: number;
  readonly quietTo: number;
  /** 两条回复之间至少间隔多久（毫秒） */
  readonly minGapMs: number;
  /** 每小时最多回几条 */
  readonly maxPerHour: number;
  /** 比这更早的消息不回（避免打开开关后把历史积压全回一遍） */
  readonly ignoreOlderThanMs: number;
  /** 试运行：照常生成台词但**不发送**，只把「本来会说什么」记进状态与日志 */
  readonly dryRun: boolean;
  /** 出站前缀（qqbus send --tag），也用来识别自己的回声 */
  readonly tag: string;
}

export const DEFAULT_QQ_OPTIONS: QQOptions = {
  peer: "用户",
  selfSenders: ["鲸鱼", "(未解析)", ""],
  // 与 `src/contracts/quiet-hours.ts` 的 23–7 保持一致（F268）。工具层不能 import 大脑内部，
  // 所以这里只能写字面量——由 `test/quiet-hours.test.ts` 锁住两处相等，不靠人记得同步。
  quietFrom: 23,
  quietTo: 7,
  minGapMs: 8_000,
  maxPerHour: 30,
  ignoreOlderThanMs: 10 * 60_000,
  dryRun: true,
  tag: "ase",
};

export function emptyQQState(): QQStateRecord {
  return { cursorEpochNs: 0, repliedIds: [], replyTimes: [], lastReplyAt: null };
}
