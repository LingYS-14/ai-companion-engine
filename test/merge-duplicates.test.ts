import { describe, expect, it } from "vitest";

import { planMerge, readStore } from "../tools/maintenance/merge-duplicates.mjs";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

const rec = (id: string, content: string, createdAt: number, extra = {}) => ({
  id,
  content,
  source: "player",
  created_at: createdAt,
  vividness: 0.4,
  access_count: 1,
  last_accessed: createdAt,
  ...extra,
});

describe("存量记忆去重（merge-duplicates）", () => {
  it("24 小时内的同句合并：保留最早一条，访问次数相加，取最大鲜活度", () => {
    const plan = planMerge([
      rec("a", "在吗？我回来了。", T0, { vividness: 0.3, access_count: 1 }),
      rec("b", "在吗 我回来了", T0 + 2 * HOUR, { vividness: 0.9, access_count: 2 }),
      rec("c", "今天也想跟你多聊一会儿", T0 + 3 * HOUR),
    ]);
    expect(plan.dropped).toBe(1);
    expect(plan.records.map((r) => r.id).sort()).toEqual(["a", "c"]);
    const kept = plan.records.find((r) => r.id === "a");
    expect(kept?.vividness).toBe(0.9);
    expect(kept?.access_count).toBe(3);
  });

  it("间隔超过 24 小时算两次事件，不合并", () => {
    const plan = planMerge([rec("a", "我回来了", T0), rec("b", "我回来了", T0 + 25 * HOUR)]);
    expect(plan.dropped).toBe(0);
    expect(plan.records).toHaveLength(2);
  });

  it("不同来源的同一句话不合并", () => {
    const plan = planMerge([
      rec("a", "我回来了", T0, { source: "player" }),
      rec("b", "我回来了", T0 + HOUR, { source: "self" }),
    ]);
    expect(plan.dropped).toBe(0);
  });

  it("读 WAL：del 生效、坏行跳过", () => {
    const raw = [
      JSON.stringify({ op: "put", rec: rec("a", "一", T0) }),
      "{ broken",
      JSON.stringify({ op: "put", rec: rec("b", "二", T0) }),
      JSON.stringify({ op: "del", id: "b" }),
    ].join("\n");
    const { records, corrupt } = readStore(raw);
    expect(records.map((r) => r.id)).toEqual(["a"]);
    expect(corrupt).toBe(1);
  });
});
