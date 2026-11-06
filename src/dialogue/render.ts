/**
 * 表达层：把"状态 + 关系"折成**结构化提示**，交给 LLM 生成台词（本文件不调 LLM）。
 *
 * 两条纪律：
 *   1. EXPRESSION_TABLE 在规格里是空表（0/16 格，写"v5.3 补全"）。
 *      空表必须抛错，而不是静默回退到某个默认措辞 —— 否则"表达层没实现"会伪装成"角色说话平淡"。
 *   2. mode 与 stage 的映射是**实现侧提示词**，不是规格常量；标注为 impl-hint，改动不需要 bump 规格。
 */

import { knobText, type EngineConfig } from "../engine/config.js";
import type { Mode } from "../engine/modes.js";
import type { Stage } from "../engine/bonds.js";
import type { ExpressionHint } from "./expression.js";
import { wonderTopic, type Wonder } from "../psychology/wonder.js";

/** EXPRESSION_TABLE 是否真的被填了；没填就抛"未实现" */
export function assertExpressionTable(cfg: EngineConfig): void {
  const t = knobText(cfg, "EXPRESSION_TABLE");
  if (typeof t !== "string" || /补全|TODO|见\s*§|→|^\{/.test(t)) {
    throw new Error(
      `EXPRESSION_TABLE 尚未填值（当前：${JSON.stringify(t)}）——表达层不可用，禁止静默默认`,
    );
  }
}

/** impl-hint：模式 → 说话方式。不是规格常量，不进校验。 */
const MODE_STYLE: Readonly<Record<Mode, string>> = {
  NORMAL: "自然、松弛，句子长度随话题走",
  DEFENSE: "句子变短，回避核心问题，用反问挡回去",
  BREAK: "句子碎片化，重复词增多，可能中断",
  OBSESSION: "追问细节、反复确认，话题收窄到对方",
  OVERDRIVE: "情绪外溢、语速快、感叹多",
  LAZY: "回应变慢变短，敷衍但不失礼",
};

/** impl-hint：关系阶段 → 距离/称呼倾向。 */
const STAGE_STYLE: Readonly<Record<Stage, string>> = {
  stranger: "客气、保持距离、用敬称",
  familiar: "放松、有玩笑、开始用简称",
  close: "省略客套、有默契、记得旧事",
  beloved: "亲密、允许脆弱、独占性表达",
};

export interface PromptHints {
  readonly mode: Mode;
  readonly stage: Stage | null;
  readonly valence: number;
  readonly arousal: number;
  readonly maskIntegrity: number;
  readonly suppressionLoad: number;
  /**
   * 表达风格（G5-③）：`(quadrant, stage) → style` 的命中结果。
   * 依恋属于 D 层，缺省时表达层只按关系阶段给建议，不假装知道象限。
   */
  readonly expression?: ExpressionHint;
  /**
   * 人格卡对某个阶段的语气覆盖（F35）。
   *
   * 只覆盖文本，不改变优先级——`[style]` 与 `[event]` 仍压在它上面。
   * 没有这一层时，所有角色共用一套通用梯度（stranger 一律"客气、用敬称"），
   * 自来熟的角色会被演成客服，这是 G8 评估里最刺眼的一处。
   */
  readonly stageStyleOverride?: Partial<Record<Stage, string>>;
  /**
   * 动机层（§ 动机自拟，见 src/psychology/wonder.ts）：她此刻**想说什么**。
   *
   * 与 mode/stage 分开是关键：那是"怎么说"（语气/距离），这是"想说什么内容"。
   * 没有它，台词永远在回应对方，主动的那一半（在乎什么）无处落地。
   */
  readonly wonder?: Wonder;
}

/** 把 TurnResult.hints 折成给 DialogueGenerator 的输入（纯数据，可快照、可断言） */
export function composePrompt(hints: PromptHints): {
  readonly modeStyle: string;
  readonly stageStyle: string;
  readonly expressionStyle: string;
  readonly suppressInstruction: string;
  /** 动机层的一句话（`[world] …`）；wonder 不够高时为空串，不占位、不改其它层 */
  readonly world: string;
  readonly signals: Readonly<Record<string, number>>;
} {
  const mask = hints.maskIntegrity;
  const suppressInstruction =
    mask > 0.7
      ? "情绪可以在语气里透一点，但不点破"
      : mask > 0.35
        ? "把情绪压住，用行为/细节暗示"
        : "几乎不承认情绪，只做表面回应";

  const expressionStyle =
    hints.expression === undefined
      ? "（未配置依恋 D 层，只按关系阶段说话）"
      : `tone=${hints.expression.tone}；move=${hints.expression.move}；avoid=${hints.expression.avoid}`;

  // 动机层单独成键：不混进 modeStyle/stageStyle，既有断言与"怎么说"的语义都不受影响。
  // 0.6 以下不输出——不是每轮都非得说点"有意义"的话。
  const wonder = hints.wonder;
  const world =
    wonder !== undefined && wonder.score >= 0.6
      ? `[world] 你现在更想说的是：${wonderTopic(wonder)?.note ?? wonder.reason}`
      : "";

  return {
    modeStyle: MODE_STYLE[hints.mode],
    stageStyle:
      hints.stage === null
        ? "（暂无关系进度，按普通相识处理）"
        : (hints.stageStyleOverride?.[hints.stage] ?? STAGE_STYLE[hints.stage]),
    expressionStyle,
    suppressInstruction,
    world,
    signals: {
      valence: hints.valence,
      arousal: hints.arousal,
      maskIntegrity: mask,
      suppressionLoad: hints.suppressionLoad,
    },
  };
}
