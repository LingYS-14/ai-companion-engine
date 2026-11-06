import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTER_META, makeAdapter } from "../src/execution/adapters.js";
import { PendingQueue } from "../src/execution/queue.js";
import { ExecutionGateway } from "../src/execution/gateway.js";

const dirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-queue-"));
  dirs.push(dir);
  return join(dir, "queue.json");
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("执行层 · 落盘队列", () => {
  it("按入队顺序给出到点条目，未到点的先不跑", () => {
    const file = tempFile();
    const { queue } = PendingQueue.open(file, 1000);
    queue.enqueue({ id: "a", toolId: "bili.ingest", input: { bvid: "BV1" }, subject: "autonomy:1", now: 1000 });
    queue.enqueue({ id: "b", toolId: "bili.ingest", input: { bvid: "BV2" }, subject: "autonomy:1", now: 1000, notBefore: 5000 });
    expect(queue.due(1000).map((item) => item.id)).toEqual(["a"]);
    expect(queue.due(5000).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("崩溃恢复：running 的条目退回 pending 并记一次尝试", () => {
    const file = tempFile();
    const first = PendingQueue.open(file, 1000);
    first.queue.enqueue({ id: "x", toolId: "bili.ingest", input: {}, subject: "dev:1", now: 1000 });
    first.queue.claim("x", 1000);
    expect(first.queue.all()[0]?.state).toBe("running");

    const second = PendingQueue.open(file, 2000);
    expect(second.recovered).toBe(1);
    const item = second.queue.all()[0];
    expect(item?.state).toBe("pending");
    expect(item?.attempts).toBe(1);
    expect(second.queue.due(2000).map((entry) => entry.id)).toEqual(["x"]);
  });

  it("ack 之后出队并落盘", () => {
    const file = tempFile();
    const { queue } = PendingQueue.open(file, 1000);
    queue.enqueue({ id: "y", toolId: "bili.ingest", input: {}, subject: "dev:1", now: 1000 });
    queue.ack("y", 1500);
    expect(queue.size).toBe(0);
    const reopened = PendingQueue.open(file, 2000);
    expect(reopened.queue.size).toBe(0);
  });

  it("失败退回 pending、尝试次数加一、按退避推迟", () => {
    const file = tempFile();
    const { queue } = PendingQueue.open(file, 1000);
    queue.enqueue({ id: "z", toolId: "bili.ingest", input: {}, subject: "dev:1", now: 1000 });
    queue.claim("z", 1000);
    queue.retryLater("z", 1000, 30_000);
    const item = queue.all()[0];
    expect(item?.state).toBe("pending");
    expect(item?.attempts).toBe(1);
    expect(queue.due(1000)).toHaveLength(0);
    expect(queue.due(31_000).map((entry) => entry.id)).toEqual(["z"]);
  });

  it("坏档当空队列处理，不抛错", () => {
    const file = tempFile();
    writeFileSync(file, "{broken", "utf8");
    const { queue, recovered } = PendingQueue.open(file, 1000);
    expect(queue.size).toBe(0);
    expect(recovered).toBe(0);
  });
});

describe("执行层 · 适配器元数据", () => {
  it("qq.send 是 at-most-once / external / 不可查询", () => {
    const spec = makeAdapter("qq.send", async () => "ok");
    expect(spec.idempotency).toBe("at-most-once");
    expect(spec.riskTier).toBe("external");
    expect(spec.queryable).toBe(false);
    expect(spec.dedupeTtlMs).toBe(60_000);
  });

  it("bili.fetch 可重复且是只读", () => {
    const spec = makeAdapter("bili.fetch", async () => []);
    expect(spec.idempotency).toBe("idempotent");
    expect(spec.riskTier).toBe("read");
  });

  it("元数据表覆盖 P0 的四条序列 + Phase 4 的发图/发语音", () => {
    expect(Object.keys(ADAPTER_META).sort()).toEqual([
      "bili.fetch",
      "bili.ingest",
      "qq.send",
      "qq.sendOneBot",
      "qq.sendOneBotImage",
      "qq.sendOneBotVoice",
    ]);
  });
});

describe("执行层 · 只读动作的去重回放", () => {
  it("幂等工具重复请求时回放上次结果，而不是给空", async () => {
    // 时间从 t=1000 开始，TTL 内再请求同一指纹
    let now = 1000;
    const dir = mkdtempSync(join(tmpdir(), "ase-replay-"));
    dirs.push(dir);
    const gw = new ExecutionGateway({
      now: () => now,
      eventsFile: join(dir, "events.ndjson"),
      idemFile: join(dir, "idem.json"),
    });
    gw.register(makeAdapter("bili.fetch", async (input: { keyword: string }) => [{ bvid: input.keyword }], (r) => `n=${String(r.length)}`));
    const first = await gw.execute("bili.fetch", { keyword: "AI助手" }, { subject: "bili:test" });
    expect(first.status).toBe("succeeded");
    now = 2000;
    const second = await gw.execute("bili.fetch", { keyword: "AI助手" }, { subject: "bili:test" });
    expect(second.status).toBe("deduplicated");
    expect(second.result).toEqual([{ bvid: "AI助手" }]);
  });
});

describe("落盘队列：人工取消", () => {
  it("pending 条目可取消，取消后不再出现在 due 里", () => {
    const file = tempFile();
    const { queue } = PendingQueue.open(file, 1000);
    queue.enqueue({ id: "a", toolId: "bili.ingest", input: {}, subject: "autonomy:1", now: 1000 });
    expect(queue.cancel("a", 1000)).toBe(true);
    expect(queue.due(1000)).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it("running 条目取消后，重新打开不会「恢复」回来", () => {
    const file = tempFile();
    const { queue } = PendingQueue.open(file, 1000);
    queue.enqueue({ id: "x", toolId: "bili.ingest", input: {}, subject: "autonomy:1", now: 1000 });
    queue.claim("x", 1000);
    expect(queue.cancel("x", 1000)).toBe(true);
    const again = PendingQueue.open(file, 2000);
    expect(again.recovered).toBe(0);
    expect(again.queue.all()).toEqual([]);
  });

  it("取消不存在的 id 返回 false", () => {
    const { queue } = PendingQueue.open(tempFile(), 1000);
    expect(queue.cancel("nope", 1000)).toBe(false);
  });
});
