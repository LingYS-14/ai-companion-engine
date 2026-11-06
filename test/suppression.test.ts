/**
 * G6-⑤：§6.5 `suppressed_by_stronger` 的写入方（规则自拟，见 src/memory/suppression.ts）。
 *
 * 这些断言的意义不是"证明规格对"，而是把**我们自拟的规则**钉死：
 * 谁能压谁、差多少才压、什么时候解除。规则一旦漂移，这里先红。
 */

import { describe, expect, it } from "vitest";
import { makeMemory } from "../src/memory/types.js";
import { memoryStrength, reconcileSuppression, SUPPRESS_MARGIN } from "../src/memory/suppression.js";

const NOW = 1_793_000_000_000;

function mem(id: string, vividness: number, confidence: number, tags: string[]) {
  return makeMemory({ id, content: `${id} 的内容`, source: "player", created_at: NOW, vividness, confidence, tags });
}

describe("suppression（G6-⑤ 自拟规则）", () => {
  it("强度 = 鲜活度 × 可信度", () => {
    expect(memoryStrength(mem("a", 0.8, 0.5, ["t"]))).toBeCloseTo(0.4, 12);
    expect(memoryStrength(mem("b", 0, 1, ["t"]))).toBe(0);
    expect(memoryStrength(mem("c", 2, 2, ["t"]))).toBe(1); // 越界夹取，不信任外部写入
  });

  it("强度差跨过门槛才压制，对手被标 suppressed 且带强度", () => {
    const strong = mem("new", 0.9, 0.9, ["窗边"]); // 0.81
    const weak = mem("old", 0.5, 0.5, ["窗边"]); // 0.25
    const patches = reconcileSuppression(strong, [weak]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ id: "old", suppressed: true });
    expect(patches[0]!.strength).toBeGreaterThan(0);
    expect(patches[0]!.strength).toBeLessThanOrEqual(1);
  });

  it("平手不压制：差小于门槛时两条都留着（不能随机淘汰）", () => {
    const a = mem("a", 0.6, 0.6, ["t"]); // 0.36
    const b = mem("b", 0.6, 0.58, ["t"]); // 0.348，差 0.012 < 0.15
    expect(reconcileSuppression(a, [b])).toHaveLength(0);
    expect(SUPPRESS_MARGIN).toBeGreaterThan(0.012);
  });

  it("精确在门槛上算压制（>= 而不是 >）", () => {
    const strong = mem("s", 0.8, 1, ["t"]); // 0.8
    const weak = mem("w", 0.65, 1, ["t"]); // 0.65，差 0.15
    const patches = reconcileSuppression(strong, [weak]);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.id).toBe("w");
  });

  it("反过来：新写入的更弱时，压的是它自己", () => {
    const oldStrong = mem("old", 0.9, 0.9, ["t"]); // 0.81
    const incoming = mem("new", 0.4, 0.4, ["t"]); // 0.16
    const patches = reconcileSuppression(incoming, [oldStrong]);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ id: "new", suppressed: true });
  });

  it("不共享标签不竞争（不同话题不该互相压制）", () => {
    const a = mem("a", 0.9, 0.9, ["窗边"]);
    const b = mem("b", 0.1, 0.1, ["晚饭"]);
    expect(reconcileSuppression(a, [b])).toHaveLength(0);
  });

  it("标签为空不竞争（没有「同一件事」的依据）", () => {
    const a = mem("a", 0.9, 0.9, []);
    const b = mem("b", 0.1, 0.1, []);
    expect(reconcileSuppression(a, [b])).toHaveLength(0);
  });

  it("已遗忘的记忆不参与竞争", () => {
    const a = mem("a", 0.9, 0.9, ["t"]);
    const b = { ...mem("b", 0.1, 0.1, ["t"]), forgotten: true };
    expect(reconcileSuppression(a, [b])).toHaveLength(0);
  });

  it("可逆：曾被压制的记忆反超后解除", () => {
    const incoming = mem("new", 0.95, 0.95, ["t"]); // 0.9025
    const old = mem("old", 0.6, 0.6, ["t"]); // 0.36
    const suppressedOld = { ...old, suppressed_by_stronger: true, suppression_strength: 0.4 };
    // 已经被压住、差值也只是更大，就不重复写盘（幂等；强度不无限叠加）
    expect(reconcileSuppression(incoming, [suppressedOld])).toHaveLength(0);

    const reversed = { ...suppressedOld, vividness: 1, confidence: 1 }; // 1.0 反超
    const clearing = reconcileSuppression(mem("new2", 0.5, 0.5, ["t"]), [reversed]);
    expect(clearing.some((p) => p.id === "old" && p.suppressed === false)).toBe(true);
  });

  it("已经被压住且差值没变时不重复下发补丁（幂等，避免每轮写盘）", () => {
    const strong = mem("s", 0.9, 0.9, ["t"]);
    const weak = { ...mem("w", 0.4, 0.4, ["t"]), suppressed_by_stronger: true, suppression_strength: 0.5 };
    expect(reconcileSuppression(strong, [weak])).toHaveLength(0);
  });

  it("自己不会压自己（id 相同直接跳过）", () => {
    const a = mem("same", 0.9, 0.9, ["t"]);
    expect(reconcileSuppression(a, [a])).toHaveLength(0);
  });
});
