import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parsePersona } from "../src/dialogue/persona.js";
import { validatePersonalityLoad } from "../src/engine/personality.js";

/**
 * §9.4 的 CI 落点：**仓库里每一张人格卡都必须能加载、且通过七条体检**。
 *
 * 为什么不新增一道 gate 步骤：人格卡是数据不是代码，用 vitest 就够了；
 * 而且 vitest 直接跑 src（不经 dist），不会出现"dist 陈旧所以校验的是上一版"的假绿。
 *
 * 这条测试存在的理由（F155）：人格卡写错一个字不会报任何错——她只是**悄悄少了一层**。
 * 以前她自己的进程根本没加载人格卡，就是这么悄悄过去的。
 */

const DIR = "persona";

describe("persona/*.json 全部可加载", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

  it("至少有一张卡（否则下面的循环是空转）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} 能 parsePersona 且 §9.4 校验通过`, () => {
      const raw = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Record<string, unknown>;
      // 1) 能造出对象（结构/必填/类型）
      const parsed = parsePersona(raw);
      expect(parsed.name.length).toBeGreaterThan(0);
      // 2) 有 personality 段就过七条体检；没有也算合格（人格层可选），但要显式说明
      const personality = raw["personality"];
      if (personality === undefined) {
        expect(parsed.personality).toBeUndefined();
        return;
      }
      const report = validatePersonalityLoad(personality);
      expect(report.errors).toEqual([]);
      expect(report.ok).toBe(true);
      // 3) 卡里声明了 personality 就必须真的被解析进 Persona（否则又是"以为生效了"）
      expect(parsed.personality).toBeDefined();
    });
  }
});
