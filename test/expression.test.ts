/**
 * 表达层测试（G5-③）：`(quadrant, stage) → style` 的 16 格表。
 *
 * 规格把 EXPRESSION_TABLE 留成占位（§15 遗留 #2「v5.4 填文案」），但 `style_for`
 * 的降级语义是写死的：`EXPRESSION_TABLE.get(desc) or {"quadrant":…, "stage":…}`，
 * 且注释要求「不得静默返回空串」。所以这里测两件事：
 *   1. 实现侧把 16 格填满了（缺一格就报错，而不是让角色说话变平淡）；
 *   2. 真缺格时走规格允许的降级路径，且降级结果不为空。
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/engine/config.js";
import { stageBands } from "../src/engine/bonds.js";
import {
  EXPRESSION_TABLE,
  QUADRANTS,
  assertCompleteExpressionTable,
  expressionLine,
  styleFor,
  validateAttachment,
  type ExpressionStyle,
} from "../src/dialogue/expression.js";

const cfg = await loadConfig();
const bands = stageBands(cfg);

const ALL_STAGES = ["stranger", "familiar", "close", "beloved"] as const;

describe("16 格表完整性", () => {
  it("四象限 × 四阶段 = 16 格，全部通过完整性检查", () => {
    assertCompleteExpressionTable();
    expect(QUADRANTS).toHaveLength(4);
    for (const q of QUADRANTS) {
      expect(Object.keys(EXPRESSION_TABLE[q])).toHaveLength(4);
    }
  });

  it("每格三个字段都非空（tone/move/avoid）", () => {
    for (const q of QUADRANTS) {
      for (const stage of ALL_STAGES) {
        const cell = EXPRESSION_TABLE[q][stage];
        expect(cell.tone.trim().length).toBeGreaterThan(4);
        expect(cell.move.trim().length).toBeGreaterThan(4);
        expect(cell.avoid.trim().length).toBeGreaterThan(4);
      }
    }
  });

  it("16 格语气互不相同（防止复制粘贴导致四象限说一样的话）", () => {
    const tones = QUADRANTS.flatMap((q) => ALL_STAGES.map((s) => EXPRESSION_TABLE[q][s].tone));
    expect(new Set(tones).size).toBe(16);
  });

  it("缺一格就抛错，并指出缺哪格", () => {
    const broken = {
      ...EXPRESSION_TABLE,
      fearful: {
        ...EXPRESSION_TABLE.fearful,
        beloved: { tone: "", move: "x", avoid: "y" },
      },
    } as typeof EXPRESSION_TABLE;
    expect(() => assertCompleteExpressionTable(broken)).toThrow(/fearful\/beloved/);
  });
});

describe("styleFor：象限与阶段都由数值推导", () => {
  it("依恋四象限按 0.5 边界分流（与 §5.1 derive_bond_curve 同判据）", () => {
    expect(styleFor({ anxiety: 0.2, avoidance: 0.2 }, 0.1, bands).quadrant).toBe("secure");
    expect(styleFor({ anxiety: 0.6, avoidance: 0.2 }, 0.1, bands).quadrant).toBe("preoccupied");
    expect(styleFor({ anxiety: 0.2, avoidance: 0.7 }, 0.1, bands).quadrant).toBe("dismissive");
    expect(styleFor({ anxiety: 0.6, avoidance: 0.7 }, 0.1, bands).quadrant).toBe("fearful");
  });

  it("阶段按 STAGE_THRESHOLD 边界切换（0.25 / 0.55 / 0.80）", () => {
    const a = { anxiety: 0.2, avoidance: 0.2 };
    expect(styleFor(a, 0.0, bands).stage).toBe("stranger");
    expect(styleFor(a, 0.2499, bands).stage).toBe("stranger");
    expect(styleFor(a, 0.25, bands).stage).toBe("familiar");
    expect(styleFor(a, 0.55, bands).stage).toBe("close");
    expect(styleFor(a, 0.8, bands).stage).toBe("beloved");
    expect(styleFor(a, 1.0, bands).stage).toBe("beloved");
  });

  it("同一输入稳定，且命中表时 source=table", () => {
    const hint = styleFor({ anxiety: 0.6, avoidance: 0.7 }, 0.6, bands);
    expect(hint.source).toBe("table");
    expect(hint.quadrant).toBe("fearful");
    expect(hint.stage).toBe("close");
    expect(hint).toEqual(styleFor({ anxiety: 0.6, avoidance: 0.7 }, 0.6, bands));
  });

  it("越界或非有限的依恋值直接抛错，不静默夹取", () => {
    expect(() => validateAttachment({ anxiety: -0.1, avoidance: 0.2 })).toThrow(RangeError);
    expect(() => validateAttachment({ anxiety: 0.2, avoidance: 1.1 })).toThrow(RangeError);
    expect(() => validateAttachment({ anxiety: Number.NaN, avoidance: 0.2 })).toThrow(RangeError);
  });
});

describe("降级路径（规格允许，但不能是空串）", () => {
  it("表整张为空时返回 quadrant/stage 描述，source=fallback", () => {
    const empty = {} as Record<string, Record<string, ExpressionStyle>>;
    const hint = styleFor({ anxiety: 0.6, avoidance: 0.7 }, 0.9, bands, empty as never);
    expect(hint.source).toBe("fallback");
    expect(hint.quadrant).toBe("fearful");
    expect(hint.stage).toBe("beloved");
    expect(hint.tone).toContain("fearful");
    expect(hint.tone).toContain("beloved");
    expect(hint.move.length).toBeGreaterThan(0);
  });

  it("只缺一格时，只有那一格降级，其余仍命中表", () => {
    const partial = {
      secure: { ...EXPRESSION_TABLE.secure, familiar: undefined },
      preoccupied: EXPRESSION_TABLE.preoccupied,
      dismissive: EXPRESSION_TABLE.dismissive,
      fearful: EXPRESSION_TABLE.fearful,
    } as unknown as typeof EXPRESSION_TABLE;
    const miss = styleFor({ anxiety: 0.2, avoidance: 0.2 }, 0.3, bands, partial);
    expect(miss.source).toBe("fallback");
    const hit = styleFor({ anxiety: 0.2, avoidance: 0.2 }, 0.6, bands, partial);
    expect(hit.source).toBe("table");
  });
});

describe("expressionLine", () => {
  it("一行里带齐五个字段，方便 soul_turn 直接拼输出", () => {
    const line = expressionLine(styleFor({ anxiety: 0.35, avoidance: 0.3 }, 0, bands));
    expect(line).toMatch(/^quadrant=secure stage=stranger source=table tone=/);
    expect(line).toContain("move=");
    expect(line).toContain("avoid=");
  });
});
