/**
 * task-169 C：生成侧回声自检的纯函数（Dice / 前缀剥离 / 窗口截取）。
 *
 * 这些数是阈值的依据：Dice 口径一旦漂移，0.65 这个阈值就失去意义。
 */

import { describe, expect, it } from "vitest";

import {
  diceBigrams,
  echoScore,
  isEcho,
  normalizeEchoText,
  recentRefs,
  stripSelfPrefix,
  takeLatestRefs,
} from "../src/maintenance/echo-guard.js";

describe("normalizeEchoText", () => {
  it("只留字母数字（含中文），大小写不敏感", () => {
    expect(normalizeEchoText("Hello，世界！123")).toBe("hello世界123");
    expect(normalizeEchoText("  ...  ")).toBe("");
  });
});

describe("stripSelfPrefix", () => {
  it("剥掉主动开口/回信写入记忆时的外壳", () => {
    expect(stripSelfPrefix("我主动开口说：「今天的风很轻」")).toBe("今天的风很轻");
    expect(stripSelfPrefix("我说：「嗯」")).toBe("嗯");
    expect(stripSelfPrefix("我说：普通句子")).toBe("普通句子");
  });

  it("没有前缀时原样（只去首尾空白），不误伤普通句子", () => {
    expect(stripSelfPrefix("  今天天气不错  ")).toBe("今天天气不错");
    expect(stripSelfPrefix("我主动开口说了很多")).toBe("我主动开口说了很多");
  });
});

describe("diceBigrams", () => {
  it("同一段文本 Dice=1，完全不同=0，空/单字符=0", () => {
    const text = "今天下雨了，我坐在窗边看雨";
    expect(diceBigrams(text, text)).toBe(1);
    expect(diceBigrams("abcdefghij", "1234567890")).toBe(0);
    expect(diceBigrams("", "")).toBe(0);
    expect(diceBigrams("我", "我")).toBe(0);
  });

  it("高度相似（只差一个字）仍然高，但不到 1", () => {
    const a = "今天下雨了，我坐在窗边看雨";
    const b = "今天下雨了，我坐在窗边听雨";
    const score = diceBigrams(a, b);
    expect(score).toBeGreaterThan(0.65);
    expect(score).toBeLessThan(1);
  });

  it("写入记忆时的外壳不算差异（剥离后比较）", () => {
    expect(diceBigrams("我主动开口说：「今天的风很轻」", "今天的风很轻")).toBe(1);
  });
});

describe("echoScore / isEcho", () => {
  const long = "今天的雨下得很轻，我一直在窗边看着水痕往下走";

  it("取与参照集的最大相似度（不是平均）", () => {
    expect(echoScore(long, ["完全不同的一句话在这里", long])).toBe(1);
  });

  it("短句（归一化后不足 8 字符）不判重，返回 0", () => {
    expect(echoScore("在吗", ["在吗", "在吗"])).toBe(0);
    expect(isEcho("在吗", ["在吗"], 0.65)).toBe(false);
  });

  it("阈值边界：0.65 与 0.8 都按 >= 判", () => {
    expect(isEcho(long, [long], 0.65)).toBe(true);
    expect(isEcho(long, [long], 0.8)).toBe(true);
    expect(isEcho(long, [long], 1)).toBe(true);
  });

  it("参照为空时 0，不误报", () => {
    expect(echoScore(long, [])).toBe(0);
    expect(isEcho(long, [], 0.65)).toBe(false);
  });
});

describe("recentRefs", () => {
  const now = 1_700_000_000_000;
  const HOUR = 3_600_000;

  it("只留窗口内、丢空文本/非法时间/未来时间，保持旧→新顺序", () => {
    const refs = recentRefs(
      [
        { text: "太早了", atMs: now - 30 * HOUR },
        { text: "昨天的雨", atMs: now - 2 * HOUR },
        { text: "", atMs: now - HOUR },
        { text: "刚刚的风", atMs: now - 1_000 },
        { text: "未来", atMs: now + HOUR },
        { text: "坏时间", atMs: Number.NaN },
      ],
      now,
      24 * HOUR,
    );
    expect(refs).toEqual(["昨天的雨", "刚刚的风"]);
  });

  it("窗口非法时返回空（不抛）", () => {
    expect(recentRefs([{ text: "x", atMs: now }], now, 0)).toEqual([]);
    expect(recentRefs([{ text: "x", atMs: now }], Number.NaN, HOUR)).toEqual([]);
  });
});

describe("takeLatestRefs（task-170 B1）", () => {
  const now = 1_700_000_000_000;
  const MIN = 60_000;
  const HOUR = 3_600_000;

  it("拼接顺序不是时间顺序时，按 atMs 排序后取最新 lookback 条", () => {
    const refs = takeLatestRefs(
      [
        { text: "最新一条", atMs: now - 1 * MIN },
        { text: "最旧一条", atMs: now - 60 * MIN },
        { text: "中间一条", atMs: now - 30 * MIN },
      ],
      2,
    );
    expect(refs).toEqual(["中间一条", "最新一条"]);
  });

  it("回归：25 条旧参照在前、最新一条在数组最前，截断后最新一条仍参与比较", () => {
    const entries = [
      { text: "刚刚说的这句", atMs: now - MIN },
      ...Array.from({ length: 25 }, (_, i) => ({
        text: `旧的第${String(i)}条`,
        atMs: now - (i + 2) * HOUR,
      })),
    ];
    const refs = takeLatestRefs(entries, 20);
    expect(refs).toHaveLength(20);
    expect(refs.at(-1)).toBe("刚刚说的这句");
    expect(refs).not.toContain("旧的第24条");
  });

  it("丢非法时间戳/空白文本，并去首尾空白", () => {
    const refs = takeLatestRefs(
      [
        { text: " 旧句 ", atMs: now - MIN },
        { text: "   ", atMs: now },
        { text: "坏时间", atMs: Number.NaN },
        { text: " 新句 ", atMs: now - 1_000 },
      ],
      20,
    );
    expect(refs).toEqual(["旧句", "新句"]);
  });

  it("lookback 非正/非有限返回空（不抛）", () => {
    expect(takeLatestRefs([{ text: "x", atMs: now }], 0)).toEqual([]);
    expect(takeLatestRefs([{ text: "x", atMs: now }], Number.NaN)).toEqual([]);
  });
});
