/**
 * 记忆卫生：把「测试消息」和「工程对话」从她的情景记忆里排掉。
 *
 * 为什么需要这个模块：QQ 通道的端到端自检必须真的走一遍「收到 → 判定 → 生成 → 发送」，
 * 但那条测试消息如果被当成普通对话写进记忆，她会真的"记住"我们拿她做测试——
 * 这既污染人格，也会在之后的召回里冒出来。工程对话（"前缀去掉了吗""方括号"）
 * 同理：那是我们在修工具，不是她在和用户聊天。
 *
 * 判定刻意保守：只认**明确的**测试/工程特征，不碰正常聊天。
 * 宁可漏掉一条，也不要把用户说的话当成垃圾删掉。
 */

/** 一条情景记忆里与清洗相关的字段（只需要这几个，便于单测直接构造） */
export interface HygieneRecord {
  readonly id: string;
  readonly content: string;
  /** 毫秒时间戳；用来在报告里排序，不参与判定 */
  readonly created_at?: number;
}

export type DropReason = "self-check" | "engineering" | "placeholder" | "empty";

export interface DropItem {
  readonly id: string;
  readonly content: string;
  readonly reason: DropReason;
  readonly matched: string;
  /** 毫秒时间戳（仅用于报告排序与展示） */
  readonly created_at?: number;
}

export interface PurgePlan {
  /** 应删除的条目 */
  readonly drop: readonly DropItem[];
  /** 应保留的条目（已按 id 去重，保留最后一次写入） */
  readonly keep: readonly HygieneRecord[];
  /** 因重复（同一 id 出现多次）被合并掉的行数 */
  readonly duplicateLines: number;
}

/** 自检消息的标记前缀：`tools/report/qq-selfcheck.mjs` 注入时使用 */
export const SELF_CHECK_MARK = "（自检消息";

/** 明确的测试/自检特征 */
const SELF_CHECK_PATTERNS: readonly RegExp[] = [
  /^\s*（自检消息/,
  /\[\s*self-?check\s*\]/i,
  /^\s*（通道(自检|测试)/,
  /^\s*（测试消息/,
];

/**
 * 工程对话特征：只收「明显是在聊工具/代码」的说法。
 * 说明：「插件」「引擎」这类词也可能是正常吐槽，所以必须再配一个动作词（去掉/修/重启/配置/日志/代码/接口/版本/测试）。
 */
const ENGINEERING_PATTERNS: readonly RegExp[] = [
  /前缀.*(方括号|标签|\[ase\])/i,
  /(方括号|\[ase\]|\[lead\]).*(前缀|标签)/i,
  /(去掉|清除|删掉).*(前缀|标签|方括号)/,
  /(npm|gate|vitest|typescript|jsonl|ndjson|api|http|token|cookie|snowluma|onebot|web ?socket|ws)/i,
  /(日志|配置|接口|版本|代码|测试|部署|重启|编译|构建|依赖|插件|引擎).{0,12}(报错|失败|改|修|加|删|重启|不对|问题|通过|绿)/,
  /(报错|失败|改好了|修好了|通过了|已经上线|重载|热重载)/,
];

/** 纯占位内容：从图片消息派生的说明句，本身不是她说的话 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [/^（对方发来一张图片）$/, /^（对方发来\s*\d+\s*张图片）$/, /^\[图片[^\]]*\]$/];

function firstMatch(patterns: readonly RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m !== null) return m[0];
  }
  return null;
}

/** 判断一条内容属于哪一类垃圾；返回 null 表示这是正常对话，应保留 */
export function classifyJunk(content: string): { reason: DropReason; matched: string } | null {
  const text = (content ?? "").trim();
  if (text === "") return { reason: "empty", matched: "" };

  const selfCheck = firstMatch(SELF_CHECK_PATTERNS, text);
  if (selfCheck !== null) return { reason: "self-check", matched: selfCheck };

  const placeholder = firstMatch(PLACEHOLDER_PATTERNS, text);
  if (placeholder !== null) return { reason: "placeholder", matched: placeholder };

  const engineering = firstMatch(ENGINEERING_PATTERNS, text);
  if (engineering !== null) return { reason: "engineering", matched: engineering };

  return null;
}

/** 只看是不是测试/工程消息（给运行时守卫用，不需要 id） */
export function isJunkMemory(content: string): boolean {
  return classifyJunk(content) !== null;
}

/**
 * 这条入站消息是不是自检注入的（而不是他真在说话）。
 * 自检只该验「判定→生成」这一段，不该把生成的回复真的发到他的 QQ 里：
 * 2026-10-29 实测，自检重复注入会把同一句「在吗」连回好几遍，
 * 聊天记录里看起来就像她在回答很久以前的话。
 */
export function isSelfCheck(content: string): boolean {
  return firstMatch(SELF_CHECK_PATTERNS, content) !== null;
}

/**
 * 生成清洗计划（纯函数，不碰磁盘）。
 * `records` 应按文件顺序传入；同一 id 出现多次时保留最后一次（与 WAL 回放语义一致）。
 */
export function planMemoryPurge(records: readonly HygieneRecord[]): PurgePlan {
  const byId = new Map<string, HygieneRecord>();
  let duplicateLines = 0;
  for (const rec of records) {
    if (byId.has(rec.id)) duplicateLines += 1;
    byId.set(rec.id, rec);
  }

  const drop: DropItem[] = [];
  const keep: HygieneRecord[] = [];
  for (const rec of byId.values()) {
    const junk = classifyJunk(rec.content);
    if (junk === null) keep.push(rec);
    else {
      drop.push({
        id: rec.id,
        content: rec.content,
        reason: junk.reason,
        matched: junk.matched,
        ...(rec.created_at === undefined ? {} : { created_at: rec.created_at }),
      });
    }
  }
  const order = (a: HygieneRecord | DropItem): number => ("created_at" in a && a.created_at !== undefined ? a.created_at : 0);
  drop.sort((a, b) => order(a) - order(b));
  return { drop, keep, duplicateLines };
}
