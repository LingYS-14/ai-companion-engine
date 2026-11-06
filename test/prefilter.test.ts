/**
 * G6-⑥：§6.6 第一行的检索预筛（渠道分区 + top-200 + 执念兜底）。
 *
 * 这些断言要守住三件事：分区真的分区、top-k 真的截断、执念永远进候选。
 * 前两条是性能契约，第三条是**正确性**契约——执念被预筛漏掉，§6.8 就没有入口。
 */

import { describe, expect, it } from "vitest";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { ALL_CHANNELS, channelOf, DEFAULT_CHANNEL, INDEX_TOP_K, prefilter } from "../src/memory/prefilter.js";
import { loadConfig, DEFAULT_CONFIG_URL } from "../src/engine/config.js";

const cfg = loadConfig(DEFAULT_CONFIG_URL);
const NOW = 1_793_000_000_000;

function mem(id: string, content: string, opts: Partial<{ channel: string; obsession: boolean; tags: string[]; forgotten: boolean }> = {}): MemoryRecord {
  const rec = makeMemory({
    id,
    content,
    source: "player",
    created_at: NOW,
    tags: opts.tags ?? ["下午"],
    encode_ctx: opts.channel === undefined ? {} : { channel: opts.channel },
  });
  return {
    ...rec,
    is_obsession: opts.obsession ?? false,
    forgotten: opts.forgotten ?? false,
  };
}

describe("prefilter（G6-⑥ §6.6 第一行）", () => {
  it("top_k 取规格字面量 200", () => {
    expect(INDEX_TOP_K).toBe(200);
  });

  it("渠道取 encode_ctx.channel，没有就归到 gui", () => {
    expect(channelOf(mem("a", "x", { channel: "qq" }))).toBe("qq");
    expect(channelOf(mem("b", "x"))).toBe(DEFAULT_CHANNEL);
    expect(DEFAULT_CHANNEL).toBe("gui");
  });

  it("只把本渠道的记忆放进候选", () => {
    const records = [mem("a", "窗边 下午", { channel: "gui" }), mem("b", "窗边 晚上", { channel: "qq" })];
    const res = prefilter(records, "窗边", cfg, "gui");
    expect(res.candidates.map((m) => m.id)).toEqual(["a"]);
    expect(res.poolSize).toBe(1);
  });

  it("不分区（ALL_CHANNELS）：调用方不知道渠道时全库检索，QQ/网页记忆也进来（F199）", () => {
    const records = [mem("a", "窗边 下午", { channel: "gui" }), mem("b", "窗边 晚上", { channel: "qq" }), mem("c", "窗边 夜里", { channel: "web" })];
    const res = prefilter(records, "窗边", cfg, ALL_CHANNELS);
    expect(res.poolSize).toBe(3);
    expect(res.candidates.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("超过 200 条时按语义截断，并报告被截掉的条数", () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 260; i += 1) records.push(mem(`m${i}`, `无关内容 ${i}`));
    records.push(mem("hit", "窗边 下午 风很冷"));
    const res = prefilter(records, "窗边 风很冷", cfg, DEFAULT_CHANNEL);
    expect(res.poolSize).toBe(261);
    expect(res.candidates).toHaveLength(INDEX_TOP_K);
    expect(res.dropped).toBe(61);
    // 相关的那条必须在候选里（语义排名第一）
    expect(res.candidates.map((m) => m.id)).toContain("hit");
    expect(res.candidates[0]!.id).toBe("hit");
  });

  it("本渠道不足 200 条时不截断", () => {
    const records = [mem("a", "窗边"), mem("b", "下午")];
    const res = prefilter(records, "窗边", cfg);
    expect(res.candidates).toHaveLength(2);
    expect(res.dropped).toBe(0);
  });

  it("被 top-k 截掉的执念记忆仍会被拉回候选（否则 §6.8 没有入口）", () => {
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 205; i += 1) records.push(mem(`m${i}`, `无关内容 ${i}`));
    records.push(mem("obs", "一条执念记忆", { obsession: true }));
    const res = prefilter(records, "无关", cfg);
    expect(res.candidates).toHaveLength(INDEX_TOP_K + 1);
    expect(res.obsessionAdded).toBe(1);
    expect(res.candidates.map((m) => m.id)).toContain("obs");
  });

  it("执念已在 top-k 里时不重复添加", () => {
    const records = [mem("obs", "窗边 下午", { obsession: true })];
    const res = prefilter(records, "窗边", cfg);
    expect(res.candidates.map((m) => m.id)).toEqual(["obs"]);
    expect(res.obsessionAdded).toBe(0);
  });

  it("遗忘的记忆不进任何渠道", () => {
    const records = [mem("gone", "窗边", { forgotten: true }), mem("alive", "窗边")];
    const res = prefilter(records, "窗边", cfg);
    expect(res.candidates.map((m) => m.id)).toEqual(["alive"]);
    expect(res.poolSize).toBe(1);
  });

  it("确定性：同分按 id 字典序，同一输入两次结果一致", () => {
    const records = [mem("b", "同样的句子"), mem("a", "同样的句子"), mem("c", "同样的句子")];
    const first = prefilter(records, "同样的句子", cfg).candidates.map((m) => m.id);
    const second = prefilter([...records].reverse(), "同样的句子", cfg).candidates.map((m) => m.id);
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });

  it("空查询不抛错，退化成「全都要」（只受 top-k 约束）", () => {
    const records = [mem("a", "窗边"), mem("b", "下午")];
    const res = prefilter(records, "", cfg);
    expect(res.candidates).toHaveLength(2);
  });
});
