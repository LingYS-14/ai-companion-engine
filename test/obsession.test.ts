import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/engine/config.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { daysSinceLastRecall, obsessionLine, obsessionTrigger } from "../src/memory/obsession.js";
import { encodingSpecificity } from "../src/memory/specificity.js";

const cfg = loadConfig();
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function rec(extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord {
  return makeMemory({
    id: "m1",
    content: "那天下午她说会一直在窗边等我。",
    source: "player",
    created_at: NOW,
    tags: ["下午", "窗边"],
    ...extra,
  });
}

const calm = { valence: 0.5, rumination: 0 };
const hot = { valence: 0.9, rumination: 0.8 };

describe("§6.8 执念：线索驱动 + 反刍耦合", () => {
  it("线索 + 情绪 + 反刍三项都为 0 时既不入闯也不提醒", () => {
    const res = obsessionTrigger(rec(), { tags: ["完全无关"], now: NOW }, { valence: 0, rumination: 0 }, cfg);
    expect(res.cue).toBe(0);
    expect(res.prob).toBe(0);
    expect(res.kind).toBe(null); // 刚创建，未超 7 天
  });

  it("线索命中 + 高唤醒 + 高反刍 ⇒ INTRUDE，并给出 immediate gain", () => {
    // 记忆编码时 valence=1（runtime.remember 会写入 encode_state.valence）
    const res = obsessionTrigger(rec({ encode_state: { valence: 1 } }), { tags: ["窗边", "下午"], now: NOW }, hot, cfg);
    // cue 1.0 × emotion 0.9 × (0.5 + 0 + 0.5×0.8 = 0.9) = 0.81
    expect(res.cue.toFixed(4)).toBe("1.0000");
    expect(res.emotion.toFixed(4)).toBe("0.9000");
    expect(res.prob.toFixed(4)).toBe("0.8100");
    expect(res.kind).toBe("INTRUDE");
    expect(res.gain?.source).toBe("obsession_intrusion");
    expect(res.gain?.applyAt).toBe("immediate");
    // amount = OBSESSION_GAIN_WEIGHT(0.15) × 0.81
    expect(res.gain?.amount.toFixed(4)).toBe("0.1215");
    expect(res.gain?.ruminationAdd).toBe(0.2);
  });

  it("同样线索但反刍为 0 时 prob 降到阈值以下 ⇒ 不闯入", () => {
    const res = obsessionTrigger(rec({ encode_state: { valence: 1 } }), { tags: ["窗边", "下午"], now: NOW }, { valence: 0.9, rumination: 0 }, cfg);
    // 1.0 × 0.9 × 0.5 = 0.45 < 0.5
    expect(res.prob.toFixed(4)).toBe("0.4500");
    expect(res.kind).toBe(null);
  });

  it("rumination 参与乘法：加到 0.2 就把同一件事推过阈值", () => {
    const at = obsessionTrigger(rec({ encode_state: { valence: 1 } }), { tags: ["窗边", "下午"], now: NOW }, { valence: 0.9, rumination: 0.2 }, cfg);
    // 1.0 × 0.9 × (0.5 + 0.1) = 0.54 > 0.5
    expect(at.prob.toFixed(4)).toBe("0.5400");
    expect(at.kind).toBe("INTRUDE");
  });

  it("负价情绪不算唤起（规格 max(0, …)）", () => {
    const res = obsessionTrigger(rec({ encode_state: { valence: 1 } }), { tags: ["窗边", "下午"], now: NOW }, { valence: -0.5, rumination: 0.9 }, cfg);
    expect(res.emotion).toBe(0);
    expect(res.prob).toBe(0);
    expect(res.kind).toBe(null);
  });

  it("超过 7 天没被想起 ⇒ MILD_REMIND（不闯入也给提醒）", () => {
    const m = rec({ created_at: NOW - 8 * DAY });
    const res = obsessionTrigger(m, { tags: ["无关"], now: NOW }, calm, cfg);
    expect(res.kind).toBe("MILD_REMIND");
    expect(res.daysSinceRecall.toFixed(2)).toBe("8.00");
    expect(res.gain).toBe(null);
  });

  it("days_since_last_recall 没有 last_accessed 时回退到创建时间", () => {
    const m = rec({ created_at: NOW - 3 * DAY });
    expect(daysSinceLastRecall(m, NOW).toFixed(2)).toBe("3.00");
  });

  it("硬删除的记忆永不闯入（显式给了 hard_deleted 时）", () => {
    const m = rec() as MemoryRecord & { hard_deleted?: boolean };
    m.hard_deleted = true;
    const res = obsessionTrigger(m, { tags: ["窗边", "下午"], now: NOW }, hot, cfg);
    expect(res.kind).toBe(null);
    expect(res.prob).toBe(0);
    expect(res.gain).toBe(null);
  });

  it("m.valence 缺失时用编码时的 encode_state.valence，并写进 missing", () => {
    const m = rec({ encode_state: { valence: 1 } });
    const res = obsessionTrigger(m, { tags: ["窗边", "下午"], now: NOW }, hot, cfg);
    // emotion = 0.9 × 1.0 = 0.9，等价于显式给了 valence=1
    expect(res.emotion.toFixed(4)).toBe("0.9000");
    expect(res.missing).toContain("valence");
  });

  it("既无 valence 也无 encode_state 时取中性 0.5，且仍标记缺失", () => {
    const res = obsessionTrigger(rec(), { tags: ["窗边", "下午"], now: NOW }, hot, cfg);
    expect(res.emotion.toFixed(4)).toBe("0.4500"); // 0.9 × 0.5（中性回退）
    expect(res.missing).toContain("valence");
    expect(res.missing).toContain("hard_deleted");
  });

  it("obsessionLine 带上 kind/prob/cue/emotion 与缺失字段", () => {
    const line = obsessionLine(
      obsessionTrigger(rec({ encode_state: { valence: 1 } }), { tags: ["窗边", "下午"], now: NOW }, hot, cfg),
      "m1",
    );
    expect(line).toContain("[obsession] m1 kind=INTRUDE");
    expect(line).toContain("prob=0.8100");
    expect(line).toContain("missing=");
    expect(line).toContain("gain=amount:0.1215");
  });
});

describe("encoding_specificity 的单一真源（F25）", () => {
  it("encode_ctx 为空时退化为标签重合率（与检索原算法一致）", () => {
    expect(encodingSpecificity(rec(), { tags: ["下午", "窗边"] })).toBe(1);
    expect(encodingSpecificity(rec(), { tags: ["下午", "别的"] })).toBe(0.5);
    expect(encodingSpecificity(rec(), { tags: ["别的"] })).toBe(0);
  });

  it("encode_ctx 非空时按编码现场的重合率算", () => {
    const m = rec({ encode_state: { valence: 0.4 }, tags: ["下午"] });
    const withCtx = makeMemory({ ...m, encode_ctx: { place: "窗边", weather: "下雨" } } as never);
    expect(encodingSpecificity(withCtx, { tags: ["窗边"] })).toBe(0.5);
    expect(encodingSpecificity(withCtx, { tags: ["窗边", "下雨"] })).toBe(1);
  });


  it("记账字段 encode_ctx.channel 不能把标签特指度清零（本轮踩到的回归）", () => {
    const m = makeMemory({
      id: "m2",
      content: "她说那天下午一直在窗边等我。",
      source: "player",
      created_at: NOW,
      tags: ["窗边", "下午"],
      encode_ctx: { channel: "gui" },
    });
    expect(encodingSpecificity(m, { tags: ["窗边"] })).toBe(1);
    expect(encodingSpecificity(m, { tags: ["窗边", "无关"] })).toBe(0.5);
  });

  it("查询为空 ⇒ 0（没有特指可言）", () => {
    expect(encodingSpecificity(rec(), { tags: [] })).toBe(0);
  });
});
