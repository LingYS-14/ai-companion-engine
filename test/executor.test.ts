import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backoffFor, drainPending } from "../src/execution/executor.js";
import { PendingQueue } from "../src/execution/queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpQueue(): { queue: PendingQueue; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ase-executor-"));
  dirs.push(dir);
  const file = join(dir, "queue.json");
  return { queue: PendingQueue.open(file, 0).queue, dir };
}

const enqueue = (queue: PendingQueue, id: string, now: number): void => {
  queue.enqueue({ id, toolId: "bili.ingest", input: { id }, subject: "autonomy:tick", now });
};

describe("backoffFor", () => {
  it("指数增长且封顶", () => {
    expect(backoffFor(0, 5_000, 600_000)).toBe(5_000);
    expect(backoffFor(1, 5_000, 600_000)).toBe(10_000);
    expect(backoffFor(3, 5_000, 600_000)).toBe(40_000);
    expect(backoffFor(20, 5_000, 600_000)).toBe(600_000);
  });
});

describe("drainPending", () => {
  it("成功：出队并计数", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    const res = await drainPending({
      queue,
      now: () => 1_000,
      run: async () => ({ ok: true }),
    });
    expect(res).toMatchObject({ attempted: 1, succeeded: 1, retried: 0, dropped: 0 });
    expect(queue.size).toBe(0);
  });

  it("可重试失败：退回 pending 并退避", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    const res = await drainPending({
      queue,
      now: () => 1_000,
      run: async () => ({ ok: false, retryable: true, detail: "网络抖了一下" }),
      options: { baseBackoffMs: 1_000 },
    });
    expect(res).toMatchObject({ attempted: 1, succeeded: 0, retried: 1, dropped: 0 });
    const item = queue.all()[0];
    expect(item?.state).toBe("pending");
    expect(item?.attempts).toBe(1);
    expect(item?.notBefore).toBe(2_000);
  });

  it("不可重试失败：立刻丢掉（死信）", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    const res = await drainPending({
      queue,
      now: () => 1_000,
      run: async () => ({ ok: false, retryable: false, detail: "参数不合法" }),
    });
    expect(res).toMatchObject({ dropped: 1, retried: 0 });
    expect(queue.size).toBe(0);
    expect(res.lines.join("\n")).toContain("不可重试");
  });

  it("到上限不再重试：丢弃并记死信", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    queue.retryLater("a", 0, 0); // attempts:1
    queue.retryLater("a", 0, 0); // attempts:2
    const res = await drainPending({
      queue,
      now: () => 10,
      run: async () => ({ ok: false, retryable: true, detail: "还是不通" }),
      options: { maxAttempts: 2 },
    });
    expect(res).toMatchObject({ dropped: 1, retried: 0 });
    expect(queue.size).toBe(0);
    expect(res.lines.join("\n")).toContain("dead");
  });

  it("run 抛异常：当作可重试，不让一轮拖垮整个 tick", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    const res = await drainPending({
      queue,
      now: () => 5,
      run: async () => {
        throw new Error("LLM 500");
      },
    });
    expect(res).toMatchObject({ attempted: 1, retried: 1 });
    expect(res.lines.join("\n")).toContain("LLM 500");
  });

  it("limit 生效，且只跑到点的条目", async () => {
    const { queue } = tmpQueue();
    enqueue(queue, "a", 0);
    enqueue(queue, "b", 0);
    enqueue(queue, "c", 0);
    queue.enqueue({ id: "later", toolId: "bili.ingest", input: {}, subject: "s", now: 0, notBefore: 99_999 });
    const res = await drainPending({
      queue,
      now: () => 1_000,
      run: async () => ({ ok: true }),
      options: { limit: 2 },
    });
    expect(res.attempted).toBe(2);
    expect(res.succeeded).toBe(2);
    expect(queue.size).toBe(2);
    expect(queue.all().map((i) => i.id).sort()).toEqual(["c", "later"]);
  });
});
