import { describe, expect, it } from "vitest";
import {
  QUIET_HOURS,
  buildSituation,
  canSendEffects,
  hasHardBlock,
  isQuietHour,
  maxAffordanceRisk,
  type SituationInput,
} from "../src/orchestrator/intent/situation.js";
import type { Affordance } from "../src/orchestrator/intent/types.js";

const AFF: Affordance[] = [
  { tool: "qq.send_text", risk: 1, requiresLogin: true, rateLimited: false },
  { tool: "bili.read", risk: 0, requiresLogin: true, rateLimited: false },
];

function input(overrides: Partial<SituationInput> = {}): SituationInput {
  return {
    at: "2026-10-31T14:00:00.000Z",
    localHour: 14,
    channel: "qq",
    participants: ["owner"],
    affordances: AFF,
    sinceLastContactMin: 30,
    activeIntents: [],
    budget: { rph: 8, peak: false },
    ...overrides,
  };
}

describe("§4.2 情境帧构建（P0 纯函数，不碰 Date）", () => {
  it("静默时段 23–7 跨零点：23/0/6 是静默，7/14/22 不是", () => {
    expect(QUIET_HOURS).toEqual({ start: 23, end: 7 });
    expect(isQuietHour(23)).toBe(true);
    expect(isQuietHour(0)).toBe(true);
    expect(isQuietHour(6)).toBe(true);
    expect(isQuietHour(7)).toBe(false);
    expect(isQuietHour(14)).toBe(false);
    expect(isQuietHour(22)).toBe(false);
    // 非跨零点区间也成立（可传自定义时段，不新增旋钮，仅参数）
    expect(isQuietHour(13, { start: 12, end: 14 })).toBe(true);
    expect(isQuietHour(14, { start: 12, end: 14 })).toBe(false);
    // 边界：起点含、终点不含
    expect(isQuietHour(22, { start: 22, end: 23 })).toBe(true);
    expect(isQuietHour(23, { start: 22, end: 23 })).toBe(false);
  });

  it("非法小时 / 负分钟 / 负额度当场抛 RangeError", () => {
    expect(() => isQuietHour(24)).toThrow(RangeError);
    expect(() => isQuietHour(-1)).toThrow(RangeError);
    expect(() => isQuietHour(3.5)).toThrow(RangeError);
    expect(() => buildSituation(input({ localHour: 24 }))).toThrow(RangeError);
    expect(() => buildSituation(input({ sinceLastContactMin: -1 }))).toThrow(RangeError);
    expect(() => buildSituation(input({ budget: { rph: -1, peak: false } }))).toThrow(RangeError);
    expect(() => buildSituation(input({ sinceLastContactMin: Number.NaN }))).toThrow(RangeError);
  });

  it("hardBlocks 顺序与条件：静默 → 单写者 → 额度 → 无能力", () => {
    const quiet = buildSituation(
      input({
        localHour: 23,
        singleWriterConflict: true,
        budget: { rph: 0, peak: false },
        affordances: [],
      }),
    );
    expect(quiet.hardBlocks).toEqual(["quiet_hours", "single_writer_conflict", "rate_limited", "no_affordance"]);
    expect(quiet.budget.quietHours).toBe(true);

    const clean = buildSituation(input());
    expect(clean.hardBlocks).toEqual([]);
    expect(clean.budget.quietHours).toBe(false);
  });

  it("canSendEffects：静默/单写者/额度任一命中就不能做副作用动作；无能力不拦", () => {
    const clean = buildSituation(input());
    expect(canSendEffects(clean)).toBe(true);
    expect(canSendEffects(buildSituation(input({ localHour: 23 })))).toBe(false);
    expect(canSendEffects(buildSituation(input({ singleWriterConflict: true })))).toBe(false);
    expect(canSendEffects(buildSituation(input({ budget: { rph: 0, peak: false } })))).toBe(false);
    // 没有可用工具只能说明"只能想不能做"，不是危险状态，不判不可发
    const noTools = buildSituation(input({ affordances: [] }));
    expect(canSendEffects(noTools)).toBe(true);
    expect(hasHardBlock(noTools, "no_affordance")).toBe(true);
  });

  it("快照是复制：调用方改自己的数组/对象不影响已建好的帧", () => {
    const participants = ["owner"];
    const affordances = [...AFF];
    const frame = buildSituation(input({ participants, affordances }));
    participants.push("guest");
    affordances.push({ tool: "desktop.click", risk: 1, requiresLogin: false, rateLimited: false });
    expect(frame.participants).toEqual(["owner"]);
    expect(frame.affordances.map((item) => item.tool)).toEqual(["qq.send_text", "bili.read"]);
  });

  it("maxAffordanceRisk 取最高风险级；空能力表为 0", () => {
    expect(maxAffordanceRisk(buildSituation(input()))).toBe(1);
    expect(
      maxAffordanceRisk(
        buildSituation(
          input({ affordances: [{ tool: "desktop.click", risk: 3, requiresLogin: false, rateLimited: false }] }),
        ),
      ),
    ).toBe(3);
    expect(maxAffordanceRisk(buildSituation(input({ affordances: [] })))).toBe(0);
  });
});
