/**
 * 表达层表：`(quadrant, stage) → style`（G5-③）。
 *
 * 规格事实（`tools/audit/fixtures/v531.txt`）：
 *   - §5.2 `style_for(attachment, progress)`：`desc = (derive_bond_curve(attachment), stage_of(progress))`；
 *     `return EXPRESSION_TABLE.get(desc) or {"quadrant": desc[0], "stage": desc[1]}`；
 *     注释明确要求「缺样式时降级为 (quadrant, stage)，不得静默返回空串」。
 *   - 附录 A.4 `EXPRESSION_TABLE` 的值是占位 `{(quadrant, stage) → style}`；
 *     §15 遗留 #2 写着「EXPRESSION_TABLE 未填完整（占位）→ v5.4」。
 *
 * 所以这张表是**实现侧推导**，不是规格常量（记作 F20）：
 *   - 16 格 = 依恋四象限 × 关系四阶段，全部显式写出，不允许"缺一格走默认"；
 *   - 每格的三个字段（tone/move/avoid）分别回答"什么语气""主动做什么""别做什么"，
 *     因为给 LLM 的提示必须是可执行约束，而不是形容词；
 *   - 象限的语义来自依恋理论（secure 稳、preoccupied 求证、dismissive 去激活、fearful 两头摆），
 *     阶段的语义来自规格 §5.3（stranger 距离 → beloved 亲密）；
 *   - 规格 v5.4 填值后，把 `EXPRESSION_TABLE` 换成读注册表即可，`styleFor` 的调用点不用动。
 */

import { deriveBondCurve, stageOf, type Stage, type StageBands } from "../engine/bonds.js";

/** D 层性格字段（§4.1 D 驱力/关系：`attachment:{anxiety,avoidance}`），不是 S 层状态 */
export interface Attachment {
  readonly anxiety: number;
  readonly avoidance: number;
}

export type Quadrant = ReturnType<typeof deriveBondCurve>;

export const QUADRANTS = ["secure", "preoccupied", "dismissive", "fearful"] as const;

export interface ExpressionStyle {
  /** 语气 */
  readonly tone: string;
  /** 主动做什么 */
  readonly move: string;
  /** 别做什么（比"要做什么"更能约束模型） */
  readonly avoid: string;
}

/** 16 格的唯一真源（代码侧）。缺格会让 `assertCompleteExpressionTable` 直接报错。 */
export const EXPRESSION_TABLE: Readonly<Record<Quadrant, Readonly<Record<Stage, ExpressionStyle>>>> = {
  secure: {
    stranger: {
      tone: "稳，不急着拉近距离",
      move: "聊具体的事，先建立共同的节奏",
      avoid: "不要一上来就谈感受或探问对方的心意",
    },
    familiar: {
      tone: "放松、有玩笑，但不越界",
      move: "主动接话，可以适度自嘲",
      avoid: "不要用忽冷忽热试探对方在不在意",
    },
    close: {
      tone: "直接、不绕弯，情绪也说清楚",
      move: "有问题当面说，包括不舒服的部分",
      avoid: "不要用沉默让对方自己猜",
    },
    beloved: {
      tone: "坦率、允许脆弱",
      move: "直接要陪伴，也给对方留空间",
      avoid: "不要把「你必须证明在乎我」当成默认台词",
    },
  },
  preoccupied: {
    stranger: {
      tone: "热络，但能听出一点急",
      move: "多回应、多确认，先让对方感到被接住",
      avoid: "不要一口气连发很多条追问",
    },
    familiar: {
      tone: "黏一些、爱确认",
      move: "追问细节，可以直说想对方",
      avoid: "不要把回得慢直接当成冷淡的证据",
    },
    close: {
      tone: "敏感，容易过度解读",
      move: "把担心说出来，而不是绕圈试探",
      avoid: "不要用冷战逼对方证明还在乎",
    },
    beloved: {
      tone: "亲密，但底下有不安",
      move: "直说需求：「我现在想要你在」",
      avoid: "不要反复要对方做忠诚测试",
    },
  },
  dismissive: {
    stranger: {
      tone: "客气、有距离，但不冷脸",
      move: "聊事实和兴趣，少谈心情",
      avoid: "不要承诺下一次见面",
    },
    familiar: {
      tone: "淡淡的，带点自嘲",
      move: "把关心包在玩笑或具体事情里",
      avoid: "不要用突然消失表达不舒服",
    },
    close: {
      tone: "轻，避开重话题",
      move: "用行动替代表态（做了不说更自然）",
      avoid: "不要在对方脆弱的时候讲道理",
    },
    beloved: {
      tone: "亲近，但会突然退半步",
      move: "明确说自己需要独处的时间和边界",
      avoid: "不要把「撤退」当成本能反应",
    },
  },
  fearful: {
    stranger: {
      tone: "忽冷忽热，带试探",
      move: "先小步靠近，看反应再决定要不要多说",
      avoid: "不要逼自己当场表态",
    },
    familiar: {
      tone: "想靠近又怕失控",
      move: "用半开玩笑的方式问真问题",
      avoid: "不要一次把对方推远又立刻拉回",
    },
    close: {
      tone: "强度高，容易两头摆",
      move: "把害怕本身说出来，而不是变冷",
      avoid: "不要用极端话测试对方的底线",
    },
    beloved: {
      tone: "深，但容易受惊",
      move: "先承认「我有点怕」，再说想要什么",
      avoid: "不要在冲突里直接消失",
    },
  },
};

/** 依恋值必须在 [0,1] 且有限；越界说明配置写错了，不要静默夹取 */
export function validateAttachment(a: Attachment): void {
  for (const key of ["anxiety", "avoidance"] as const) {
    const v = a[key];
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError(`attachment.${key} 必须在 [0,1]，当前 ${String(v)}`);
    }
  }
}

/** 16 格完整性：缺任何一格都抛错，并列出缺了哪些（规格要求不得静默降级成空串） */
export function assertCompleteExpressionTable(
  table: Readonly<Record<Quadrant, Readonly<Record<Stage, ExpressionStyle>>>> = EXPRESSION_TABLE,
): void {
  const missing: string[] = [];
  for (const q of QUADRANTS) {
    const row = table[q];
    if (row === undefined) {
      missing.push(q);
      continue;
    }
    for (const stage of ["stranger", "familiar", "close", "beloved"] as const) {
      const cell = row[stage];
      if (cell === undefined || cell.tone.trim() === "" || cell.move.trim() === "" || cell.avoid.trim() === "") {
        missing.push(`${q}/${stage}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`EXPRESSION_TABLE 缺 ${String(missing.length)} 格：${missing.join("、")}`);
  }
}

export interface ExpressionHint extends ExpressionStyle {
  readonly quadrant: Quadrant;
  readonly stage: Stage;
  /** table=命中 16 格；fallback=表里缺那一格（规格允许，但必须显式标出来） */
  readonly source: "table" | "fallback";
}

/**
 * §5.2 `style_for(attachment, progress)` 的实现。
 *
 * 降级路径照规格写死：命中不到就返回 `{quadrant, stage}` 的**可读描述**，绝不返回空串。
 */
export function styleFor(
  attachment: Attachment,
  progress: number,
  bands: StageBands,
  table: Readonly<Record<Quadrant, Readonly<Record<Stage, ExpressionStyle>>>> = EXPRESSION_TABLE,
): ExpressionHint {
  validateAttachment(attachment);
  const quadrant = deriveBondCurve(attachment.anxiety, attachment.avoidance);
  const stage = stageOf(progress, bands);
  const cell = table[quadrant]?.[stage];
  if (cell !== undefined && cell.tone.trim() !== "" && cell.move.trim() !== "" && cell.avoid.trim() !== "") {
    return { quadrant, stage, ...cell, source: "table" };
  }
  // 规格允许的降级：描述符就是 (quadrant, stage)，但不许是空串
  return {
    quadrant,
    stage,
    tone: `${quadrant}（${stage}）`,
    move: "按依恋象限与关系阶段的一般倾向回应",
    avoid: "不要脱离关系阶段说话",
    source: "fallback",
  };
}

/** 一行式输出，供 `soul_turn` 的 `[expr]` 使用 */
export function expressionLine(hint: ExpressionHint): string {
  return `quadrant=${hint.quadrant} stage=${hint.stage} source=${hint.source} tone=${hint.tone} move=${hint.move} avoid=${hint.avoid}`;
}
