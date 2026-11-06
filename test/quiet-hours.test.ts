import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  QUIET_HOURS,
  QUIET_HOURS_FROM,
  QUIET_HOURS_TO,
  isQuietHour,
} from "../src/contracts/quiet-hours.js";
import { QUIET_HOURS as SITUATION_QUIET_HOURS, isQuietHour as situationIsQuietHour } from "../src/orchestrator/intent/situation.js";
import { SPEAK_QUIET_FROM, SPEAK_QUIET_TO } from "../src/autonomy/standalone.js";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("静默时段只有一份事实（F268，审计 L2）", () => {
  it("唯一事实是 23–7，且导出常量来自同一对象", () => {
    expect(QUIET_HOURS).toEqual({ start: 23, end: 7 });
    expect(QUIET_HOURS_FROM).toBe(23);
    expect(QUIET_HOURS_TO).toBe(7);
    expect(Object.isFrozen(QUIET_HOURS)).toBe(true);
  });

  it("isQuietHour：跨零点边界是 23 含、7 不含", () => {
    expect(isQuietHour(22)).toBe(false);
    expect(isQuietHour(23)).toBe(true);
    expect(isQuietHour(0)).toBe(true);
    expect(isQuietHour(6)).toBe(true);
    expect(isQuietHour(7)).toBe(false);
    expect(isQuietHour(14)).toBe(false);
  });

  it("自定义非跨零点窗口也成立（起点含、终点不含）", () => {
    expect(isQuietHour(13, { start: 12, end: 14 })).toBe(true);
    expect(isQuietHour(14, { start: 12, end: 14 })).toBe(false);
    expect(isQuietHour(11, { start: 12, end: 14 })).toBe(false);
  });

  it("意图引擎从 contracts 转出，不是自己另写一份", () => {
    // 同一个对象（转出而非复制）：改一处等于改两处，这正是 L2 要的。
    expect(SITUATION_QUIET_HOURS).toBe(QUIET_HOURS);
    expect(situationIsQuietHour(23)).toBe(true);
    expect(situationIsQuietHour(7)).toBe(false);
    expect(read("src/orchestrator/intent/situation.ts")).toContain('from "../../contracts/quiet-hours.js"');
  });

  it("脊髓层的旧机械门常量与契约相等（R2 不能 import，只能靠锁）", () => {
    expect(SPEAK_QUIET_FROM).toBe(QUIET_HOURS.start);
    expect(SPEAK_QUIET_TO).toBe(QUIET_HOURS.end);
  });

  it("工具层（qq）的默认值也对齐 23–7", () => {
    const text = read("src/qq/types.ts");
    expect(text).toMatch(/quietFrom: 23,/);
    expect(text).toMatch(/quietTo: 7,/);
    expect(text).toContain("contracts/quiet-hours.ts");
  });

  it("插件不再自带主动门（F271）：旧兜底随主动线程一起删除", () => {
    const text = read("src/plugin/index.ts");
    // 主动线程整段删掉了：没有 startProactive，也没有再读 proactive 的 minGapMin / maxPerDay 建第二套阈值。
    // （`minGapMin?: number` 还留在配置类型里：配置兼容，不再被使用。）
    expect(text).not.toContain("startProactive(");
    expect(text).not.toMatch(/p\.minGapMin/);
    expect(text).not.toMatch(/p\.maxPerDay/);
    // 它仍会给窗口桥/OneBot 桥算静默窗，但默认值来自 qq/types（23–7），不是 0–7。
    expect(text).toContain("quietFrom: cfg.quietFrom ?? DEFAULT_QQ_OPTIONS.quietFrom");
    expect(text).not.toMatch(/quietFrom: cfg\.quietFrom \?\? 0/);
  });

  it("全仓不再有第二个 0–7 兜底（防止回归）", () => {
    const files = ["src/plugin/index.ts", "src/qq/types.ts", "src/orchestrator/intent/situation.ts", "src/autonomy/standalone.ts"];
    for (const file of files) {
      expect(read(file)).not.toMatch(/quietFrom\s*\?\?\s*0\b/);
      expect(read(file)).not.toMatch(/quietFrom:\s*0\b/);
    }
  });
});
