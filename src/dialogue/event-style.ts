/**
 * 事件级表达层（F31）：让「这一轮发生了什么」进入台词约束。
 *
 * ## 为什么需要它
 *
 * G8 评估第 3 轮暴露过一件事：用户已经在指责，下发的仍是"客气、保持距离、用敬称"，
 * 写出来的台词读起来像客服。原因是表达层只有三层信息 —— `[style]`（当前状态）、
 * `[stage-style]`（关系阶段）、`[expr]`（依恋基调）—— **没有一层描述"这一轮是什么事"**。
 * 状态和阶段都是慢变量，事件是快变量，缺了它，模型只能靠猜。
 *
 * ## 与 §5.2 的关系
 *
 * 规格没有这一层；`EXPRESSION_TABLE` 是 (依恋象限 × 关系阶段) → 风格（F20 已记）。
 * 这里补的是第三维：事件。它不改既有三层的语义，只追加一条**允许/禁止边界的许可**，
 * 所以即使规格日后补上这一层，这里的实现也只是它的一个具体化（键名与文案都在本文件里）。
 *
 * ## 设计约束
 *
 * - 纯函数、无 I/O、无时钟：event_type 是调用方给的字符串。
 * - 认不出的事件类型返回 null，不猜（宁可不加约束，也不要加错约束）。
 * - 只放宽"能不能这样反应"，不改变称呼与敬称层级（那是 stage 的事）。
 */

import type { Mode } from "../engine/modes.js";

export interface EventRegister {
  /** 稳定键名，测试与日志用 */
  readonly key: string;
  /** 人类可读的事件类名 */
  readonly label: string;
  /** 这一轮允许的反应方式（放宽，不是要求） */
  readonly permission: string;
  /** 这一轮容易踩的坑 */
  readonly avoid: string;
}

/** 关键词表：顺序即优先级（冲突类先命中，因为它最容易写错） */
const RULES: readonly { readonly key: string; readonly label: string; readonly words: readonly string[] }[] = [
  { key: "conflict", label: "冲突/指责", words: ["吵", "指责", "抱怨", "质问", "生气", "冲突", "翻旧账", "criticiz", "argue"] },
  { key: "apology", label: "道歉", words: ["道歉", "对不起", "是我不好", "sorry"] },
  { key: "cold_war", label: "冷战", words: ["冷战", "不理", "沉默", "别跟我说话"] },
  { key: "praise", label: "夸奖", words: ["夸", "真棒", "厉害", "喜欢你这样", "praise"] },
  { key: "intimacy", label: "亲近", words: ["想你", "抱", "撒娇", "亲", "靠近", "intimacy"] },
];

const TEXT: Readonly<Record<string, EventRegister>> = {
  conflict: {
    key: "conflict",
    label: "冲突/指责",
    permission: "可以不立刻接住对方的情绪：允许短句、允许反问、允许说「我现在不想聊这个」。先反应，再解释。",
    avoid: "别用客服式安抚（「我理解您的感受」），也别急着认错到没有立场——那会让指责显得没有落下。",
  },
  apology: {
    key: "apology",
    label: "道歉",
    permission: "可以只接受一部分，也可以说「我还需要点时间」。接受时要具体，不要一句「没关系」把事带过。",
    avoid: "别立刻反过来安慰道歉的人，那等于替他免除责任。",
  },
  cold_war: {
    key: "cold_war",
    label: "冷战",
    permission: "允许沉默与省略：可以少说、可以只应一声，把话留到下一次。",
    avoid: "别追问「你到底怎么了」，也别用长段落解释自己。",
  },
  praise: {
    key: "praise",
    label: "夸奖",
    permission: "允许不自在：可以反问、可以转开话题、可以只应一小句。",
    avoid: "别机械谦虚（「哪里哪里」），也别把夸奖升级成表白。",
  },
  intimacy: {
    key: "intimacy",
    label: "亲近",
    permission: "允许主动示好，但上限由关系阶段决定（stranger/familiar 阶段要收着）。",
    avoid: "别把亲近当默认许可：独占性表达留给 close/beloved。",
  },
};

/**
 * 由事件类型推出本轮的表达许可。
 *
 * @param eventType 调用方给的标签（如 `争吵`、`praise`）；为空或认不出时返回 null
 * @param mode 当前状态机模式；`BREAK` 时即使在亲近场景也会收掉主动示好
 */
export function eventStyleFor(eventType?: string, mode?: Mode): EventRegister | null {
  if (eventType === undefined || eventType.trim() === "") return null;
  const text = eventType.toLowerCase();
  const hit = RULES.find((r) => r.words.some((w) => text.includes(w)));
  if (hit === undefined) return null;
  const base = TEXT[hit.key];
  if (base === undefined) return null;
  if (mode === "BREAK" && hit.key === "intimacy") {
    // BREAK 是"装不下"的状态：亲近场景的主动示好在这里会被读成失控
    return {
      ...base,
      permission: "这一轮不建议主动示好：先让情绪落地，允许只说很短的一句。",
      avoid: "别在 BREAK 里主动拉近关系，那会让崩溃显得像撒娇。",
    };
  }
  return base;
}

/** 一行下发文本（工具输出用，保持与其他 `[xxx]` 行同样的形状） */
export function eventStyleLine(reg: EventRegister | null): string {
  if (reg === null) return "[event] none";
  return `[event] key=${reg.key} label=${reg.label} permission=${reg.permission} avoid=${reg.avoid}`;
}
