/**
 * A39：`preprocessLanguageFeatures` 必须是纯函数、输出结构化、不写状态。
 *
 * 对应 v5.4-P1 §4.10 与 §3.1 的 A39：属性测试（确定性 + 键齐备）+ 源码扫描（无 state/bond/m 赋值、
 * 无 Date.now/Math.random）。这是"具身接口"的门，不是渲染质量的测试。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { preprocessLanguageFeatures } from "../src/dialogue/embodiment.js";
import { arrayOf, forAll, int, pick } from "./support/prop.js";

const SRC = readFileSync(new URL("../src/dialogue/embodiment.ts", import.meta.url), "utf8");

describe("A39: preprocessLanguageFeatures 纯函数", () => {
  it("源码不写 state/bond/m，也不读时间与随机", () => {
    const body = SRC.slice(SRC.indexOf("export function preprocessLanguageFeatures"));
    expect(body).not.toMatch(/\bstate\.[a-z_]+ *=[^=]/);
    expect(body).not.toMatch(/\bbond\.[a-z_]+ *=[^=]/);
    expect(body).not.toMatch(/\bm\.[a-z_]+ *=[^=]/);
    expect(body).not.toContain("Date.now");
    expect(body).not.toContain("Math.random");
  });

  it("确定性：同一句两次输出完全相等", () => {
    forAll(arrayOf(pick(["嗯", "…", "！", "哈哈", "累", "月亮", " ", "？"]), 0, 12), (parts) => {
      const text = parts.join("");
      expect(preprocessLanguageFeatures(text)).toEqual(preprocessLanguageFeatures(text));
    });
  });

  it("输出结构化：tokens / sentiment_hint 齐备且落在合法范围", () => {
    forAll(arrayOf(pick(["累", "开心", "…", "！", "花", "在吗"]), 0, 10), (parts) => {
      const f = preprocessLanguageFeatures(parts.join(""));
      expect(Array.isArray(f.tokens)).toBe(true);
      expect(f.sentiment_hint).toBeGreaterThanOrEqual(-1);
      expect(f.sentiment_hint).toBeLessThanOrEqual(1);
      expect(f.intensity).toBeGreaterThanOrEqual(0);
      expect(f.intensity).toBeLessThanOrEqual(1);
      expect(f.render_hints.pauseMs).toBeGreaterThanOrEqual(80);
      expect(f.render_hints.pauseMs).toBeLessThanOrEqual(340);
    });
  });

  it("方向感：夸她比对她说累更正面", () => {
    const nice = preprocessLanguageFeatures("今天你好好看，谢谢～");
    const sad = preprocessLanguageFeatures("好累啊，真的难受…");
    expect(nice.sentiment_hint).toBeGreaterThan(sad.sentiment_hint);
  });

  it("空串与非字符串不抛错", () => {
    expect(preprocessLanguageFeatures("").tokens).toEqual([]);
    // 运行时防御：QQ 事件字段可能缺（类型上不可能，但线上 JSON 什么都可能）
    expect(preprocessLanguageFeatures(undefined as unknown as string).intensity).toBe(0);
  });

  it("重复字符会抬 intensity（哈哈哈 比 哈哈 更用力）", () => {
    const a = preprocessLanguageFeatures("哈哈");
    const b = preprocessLanguageFeatures("哈哈哈哈哈哈");
    expect(b.repetition).toBeGreaterThan(a.repetition);
    expect(b.intensity).toBeGreaterThanOrEqual(a.intensity);
  });

  it("int 生成器兜底：随机长度字符串不崩", () => {
    forAll(int(0, 200), (n) => {
      const f = preprocessLanguageFeatures("啊".repeat(n));
      expect(Number.isFinite(f.sentiment_hint)).toBe(true);
    });
  });
});
