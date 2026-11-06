/**
 * 「她这句话是不是在说『给你看张图』」——纯模式匹配，不调模型。
 *
 * 为什么值得单独测：这个判据决定"要不要在文字后面附一张图"。判宽了，
 * 她每句话都拖一张 B 站截图过去；判窄了，F102 那种「说了要给图却没图」的事故照旧。
 */

import { describe, expect, it } from "vitest";

import { detectImageIntent, stripImagePromise } from "../src/dialogue/attachment.js";
import { createDialoguePort } from "../src/dialogue/port-adapter.js";

describe("detectImageIntent：只有明确的递图说法才算", () => {
  it("「这张图给你」算（F102 里她就是这么说的一句）", () => {
    expect(detectImageIntent("你看我今天拍的花，像不像你？这张图给你，你认得吗")).toBe(true);
  });

  it("「给你看看这张」算", () => {
    expect(detectImageIntent("给你看看这张，我在路边拍的")).toBe(true);
  });

  it("「发你一张」算", () => {
    expect(detectImageIntent("发你一张刚才的晚霞")).toBe(true);
  });

  it("「拍给你」算", () => {
    expect(detectImageIntent("下次拍了拍给你看")).toBe(true);
  });

  it("空消息不算", () => {
    expect(detectImageIntent("   ")).toBe(false);
  });

  it("普通聊天不算（只有「画面」两个字不算递图）", () => {
    expect(detectImageIntent("那部番的画面很漂亮，但剧情有点慢")).toBe(false);
  });

  it("提到「图」但不是递图（查资料）不算", () => {
    expect(detectImageIntent("我去查一下那张图的出处")).toBe(false);
  });

  it("「我看到一张图」不算递图（她没有说要给）", () => {
    expect(detectImageIntent("我今天在网上看到一张图，很有意思")).toBe(false);
  });

  it("端口转发同一个判断", () => {
    expect(createDialoguePort().wantsImage("这张图给你")).toBe(true);
    expect(createDialoguePort().wantsImage("今天天气不错")).toBe(false);
  });
});

describe("没图就别空口承诺（F102 欠账）", () => {
  it("提图的那句被摘掉，其余照发", () => {
    const r = stripImagePromise("今天走了好多路。这张图给你，拍的花。");
    expect(r.removed).toHaveLength(1);
    expect(r.text).toBe("今天走了好多路。");
  });

  it("整段只有承诺 → 换成诚实兜底，不发空串", () => {
    const r = stripImagePromise("你看我今天拍的花，这张图给你，你认得吗？");
    expect(r.removed).toHaveLength(1);
    expect(r.text).not.toBe("");
    // 兜底句是"承认没有图"，不是继续承诺：不给/发/传图，且含"欠着"
    expect(r.text).toContain("欠着");
    expect(r.text).not.toMatch(/(?:给|发|传)你(?:一张|几张|张)?(?:图|照片|图片)/u);
    expect(r.text).not.toMatch(/(?:这|那|一)张(?:图|照片|图片)(?:给|发|传)你/u);
  });

  it("没提图 → 一个字都不动", () => {
    const r = stripImagePromise("嗯，我在呢。今天有点累。");
    expect(r.removed).toHaveLength(0);
    expect(r.text).toBe("嗯，我在呢。今天有点累。");
  });

  it("只提到「照片」「截图」也算承诺（没图时它们都是空话）", () => {
    expect(stripImagePromise("给你看照片。晚安。").removed).toHaveLength(1);
    expect(stripImagePromise("刚截图了，你看。").removed).toHaveLength(1);
  });

  it("空文本不炸", () => {
    expect(stripImagePromise("   ")).toEqual({ text: "", removed: [] });
  });

  it("端口转发同一个判断", () => {
    expect(createDialoguePort().stripImagePromise("这张图给你。").removed.length).toBe(1);
  });
});
