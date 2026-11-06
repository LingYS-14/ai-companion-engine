import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/engine/config.js";
import { makeMemory, type MemoryRecord } from "../src/memory/types.js";
import { Wal } from "../src/memory/wal.js";
import { MemoryStore, type Firewall } from "../src/memory/store.js";
import { rejectCandidates, shouldClearTaint, taintWindowMs, type InsightCandidate } from "../src/memory/taint.js";

const cfg = loadConfig();
const TMP = fileURLToPath(new URL("../.tmp/memory", import.meta.url));
mkdirSync(TMP, { recursive: true });
const tmpFile = () => join(TMP, `${randomUUID()}.ndjson`);

const allowAll: Firewall = () => ({ keep: true, reason: "test" });

function rec(id: string, extra: Partial<Parameters<typeof makeMemory>[0]> = {}): MemoryRecord {
  return makeMemory({ id, content: `content-${id}`, source: "player", created_at: 1_700_000_000_000, ...extra });
}

describe("NDJSON WAL：只追加 + 回放 + 坏行不致命", () => {
  it("写入后重新打开（进程重启等价）仍在", () => {
    const path = tmpFile();
    const a = MemoryStore.open(path, allowAll, cfg);
    a.write(rec("m1"), 1);
    a.write(rec("m2"), 2);
    const b = MemoryStore.open(path, allowAll, cfg);
    expect(b.all().map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(b.stats().replayed).toBe(2);
  });

  it("坏行只计数，不毁存档", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(rec("m1"), 1);
    appendFileSync(path, "{ this is not json }\n", "utf8");
    const reopened = MemoryStore.open(path, allowAll, cfg);
    expect(reopened.get("m1")).toBeDefined();
    expect(reopened.stats().corrupt).toBe(1);
  });

  it("删行以 tombstone 表达，回放后消失", () => {
    const path = tmpFile();
    const wal = new Wal(path);
    wal.put(rec("m1"));
    wal.remove("m1");
    expect(wal.size()).toBe(0);
    const reopened = new Wal(path).open();
    expect(reopened.size()).toBe(0);
  });

  it("compact 后行数 = 快照数，且内容不变", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(rec("m1"), 1);
    s.write(rec("m2"), 2);
    s.write(rec("m1"), 3); // upsert，产生第二行
    s.compact();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const reopened = MemoryStore.open(path, allowAll, cfg);
    expect(reopened.all().map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("MemoryStore：防火墙在写路径上（INV-1）", () => {
  it("拒绝的来源不落盘，但留下拒绝原因", () => {
    const path = tmpFile();
    const firewall: Firewall = (r, cfg2) => {
      const untrusted = cfg2.knobs["UNTRUSTED_SOURCES"]!.value as string[];
      return untrusted.includes(r.source)
        ? { keep: false, reason: `来源 ${r.source} 不可信` }
        : { keep: true, reason: "ok" };
    };
    const s = MemoryStore.open(path, firewall, cfg);
    const r = s.write(rec("m1", { source: "web" }), 10);
    expect(r.stored).toBe(false);
    expect(s.all()).toHaveLength(0);
    expect(s.rejections()[0]?.reason).toContain("不可信");
    expect(s.isUntrustedSource("web")).toBe(true);
    expect(s.isUntrustedSource("player")).toBe(false);
  });

  it("构造时必须给 firewall", () => {
    // @ts-expect-error 故意省略，验证类型与运行时双保险
    expect(() => MemoryStore.open(tmpFile(), undefined, cfg)).toThrow(/firewall/);
  });

  it("firewall 可以把记忆标成污点编码（记忆层永久标记）", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, () => ({ keep: true, reason: "tainted ctx", markTainted: true }), cfg);
    s.write(rec("m1"), 1);
    expect(s.get("m1")?.retrieved_under_taint).toBe(true);
  });

  it("active() 排除被遗忘与被压制的记忆", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(rec("m1"), 1);
    s.write(rec("m2"), 1);
    s.write({ ...rec("m3"), suppressed_by_stronger: true }, 1);
    s.forget("m1");
    expect(s.active().map((m) => m.id)).toEqual(["m2"]);
  });

  it("touch 递增 access_count 并写回 WAL", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(rec("m1"), 100);
    s.touch("m1", 200);
    const reopened = MemoryStore.open(path, allowAll, cfg);
    expect(reopened.get("m1")?.access_count).toBe(1);
    expect(reopened.get("m1")?.last_accessed).toBe(200);
  });
});

describe("§8.2 污点清洗：2a→2b→2c→2d 顺序", () => {
  const baseCtx = () => ({
    now: 1_700_000_000_000,
    drivenByUntrusted: false,
    candidates: [] as InsightCandidate[],
    varState: { state: "tainted" as const, since: 1_700_000_000_000 - taintWindowMs(cfg) - 1, sources: ["web"] },
    windowMs: taintWindowMs(cfg),
  });

  it("2a 仍由不可信来源驱动 → 不清", () => {
    expect(shouldClearTaint("jealousy", { ...baseCtx(), drivenByUntrusted: true }).code).toBe("2a");
  });

  it("2b 有未消费的可信候选 → 不清", () => {
    const ctx = baseCtx();
    ctx.candidates = [{ id: "c1", source_vars: ["jealousy"], state_provenance: "trusted", consumed: false }];
    expect(shouldClearTaint("jealousy", ctx).code).toBe("2b");
  });

  it("2c 观察窗未满 → 不清", () => {
    const ctx = { ...baseCtx(), varState: { state: "tainted" as const, since: 1_700_000_000_000 - 3600_000, sources: ["web"] } };
    expect(shouldClearTaint("jealousy", ctx).code).toBe("2c");
  });

  it("2d 全部满足 → 清", () => {
    const d = shouldClearTaint("jealousy", baseCtx());
    expect(d.clear).toBe(true);
    expect(d.code).toBe("2d");
  });

  it("死锁回归：被污染的未消费候选**不**阻断清洗（A11 原版死锁）", () => {
    const ctx = baseCtx();
    ctx.candidates = [{ id: "c1", source_vars: ["jealousy"], state_provenance: "tainted", consumed: false }];
    expect(shouldClearTaint("jealousy", ctx).clear).toBe(true);
  });

  it("reject 就地置 consumed，候选不再挡路", () => {
    const candidates: InsightCandidate[] = [
      { id: "c1", source_vars: ["jealousy"], state_provenance: "trusted", consumed: false },
    ];
    expect(shouldClearTaint("jealousy", { ...baseCtx(), candidates }).code).toBe("2b");
    expect(rejectCandidates(candidates, "c1")).toBe(true);
    expect(shouldClearTaint("jealousy", { ...baseCtx(), candidates }).clear).toBe(true);
  });
});

describe("清理临时目录不污染仓库", () => {
  it("测试文件都在 .tmp/memory 下", () => {
    expect(TMP).toContain(".tmp");
    rmSync(join(TMP, "..no-such"), { force: true });
  });
});

describe("v5.4-P1 §4.2：touch 抬升激活 + 旧档迁移（D2）", () => {
  it("touch 同时更新 access_count / last_accessed / base_activation", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(rec("m1"), 100);
    const t = s.touch("m1", 200);
    expect(t?.access_count).toBe(1);
    expect(t?.last_accessed).toBe(200);
    expect(t?.base_activation).toBeCloseTo(Math.log(2), 10);
  });

  it("迁移：旧档没有 base_activation 也不会算出 NaN，且值被夹在 [-1, 0]", () => {
    const path = tmpFile();
    const legacy = { ...rec("old"), last_accessed: 1_700_000_000_000 };
    delete (legacy as { base_activation?: number }).base_activation;
    appendFileSync(path, `${JSON.stringify({ op: "put", rec: legacy })}
`, "utf8");
    const s = MemoryStore.open(path, allowAll, cfg);
    const migrated = s.migrateActivation(1_700_000_000_000 + 5 * 86_400_000);
    expect(migrated).toBe(1);
    const m = s.get("old");
    expect(Number.isFinite(m?.base_activation)).toBe(true);
    expect(m?.base_activation).toBeGreaterThanOrEqual(-1);
    expect(m?.base_activation).toBeLessThanOrEqual(0);
    // 迁移结果立即落盘：重开不会重复迁移
    const reopened = MemoryStore.open(path, allowAll, cfg);
    expect(reopened.migrateActivation(1_700_000_000_000 + 6 * 86_400_000)).toBe(0);
  });
});

describe("v5.4-P1 §4.3：写入即分配记忆宫殿格子（幂等）", () => {
  it("同通道同主标签进同 path：前两条同槽，第三条进下一槽", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(makeMemory({ id: "a", content: "x", source: "player", created_at: 1, tags: ["月亮"], encode_ctx: { channel: "qq" } }), 1);
    s.write(makeMemory({ id: "b", content: "y", source: "player", created_at: 1, tags: ["月亮"], encode_ctx: { channel: "qq" } }), 1);
    s.write(makeMemory({ id: "c", content: "z", source: "player", created_at: 1, tags: ["月亮"], encode_ctx: { channel: "qq" } }), 1);
    const a = s.get("a")!;
    const b = s.get("b")!;
    const c = s.get("c")!;
    expect(a.loci_path_id).toBe(b.loci_path_id);
    expect(a.loci_order).toBe(0);
    expect(b.loci_order).toBe(0);
    expect(c.loci_order).toBe(1);
  });

  it("不同主标签 → 不同 path；重写同一条不改格子", () => {
    const path = tmpFile();
    const s = MemoryStore.open(path, allowAll, cfg);
    s.write(makeMemory({ id: "a", content: "x", source: "player", created_at: 1, tags: ["月亮"] }), 1);
    s.write(makeMemory({ id: "b", content: "y", source: "player", created_at: 1, tags: ["雪"] }), 1);
    expect(s.get("a")!.loci_path_id).not.toBe(s.get("b")!.loci_path_id);
    const before = s.get("a")!.loci_order;
    s.write(s.get("a")!, 2);
    expect(s.get("a")!.loci_order).toBe(before);
  });
});

describe("WAL 自动压实", () => {
  it("反复 put 同一批记录不会把文件撑爆，冷启动读回的是最后版本", () => {
    const path = tmpFile();
    const wal = new Wal(path).open();
    const base = makeMemory({ id: randomUUID(), content: "压实测试", tags: ["t"] });
    for (let i = 0; i < 600; i++) wal.put({ ...base, access_count: i });
    const lines = readFileSync(path, "utf8").trim().split("\n").length;
    expect(lines).toBeLessThan(600);
    const reopened = new Wal(path).open();
    expect(reopened.snapshot()).toHaveLength(1);
    expect(reopened.get(base.id)?.access_count).toBe(599);
  });

  it("压实不丢删除：del 之后压实，重开也没有该条", () => {
    const path = tmpFile();
    const wal = new Wal(path).open();
    const victim = makeMemory({ id: randomUUID(), content: "要删的", tags: ["t"] });
    wal.put(victim);
    wal.remove(victim.id);
    for (let i = 0; i < 500; i++) wal.put(makeMemory({ id: randomUUID(), content: `填充 ${String(i)}`, tags: ["t"] }));
    const reopened = new Wal(path).open();
    expect(reopened.get(victim.id)).toBeUndefined();
    expect(reopened.size()).toBe(500);
  });
});

describe("WAL 打开时压实", () => {
  it("历史文件行数远超记录数时，open() 直接压实到一行一条", () => {
    const path = tmpFile();
    const one = makeMemory({ id: randomUUID(), content: "同一个", tags: ["t"] });
    const LF = String.fromCharCode(10);
    // 直接造一个「膨胀的历史文件」：1200 行 upsert 同一条记录
    const lines = Array.from({ length: 1200 }, (_, i) =>
      JSON.stringify({ op: "put", rec: { ...one, access_count: i } }),
    );
    writeFileSync(path, lines.join(LF) + LF, "utf8");
    expect(readFileSync(path, "utf8").trim().split(LF).length).toBe(1200);
    const reopened = new Wal(path).open();
    expect(reopened.size()).toBe(1);
    expect(reopened.get(one.id)?.access_count).toBe(1199);
    expect(readFileSync(path, "utf8").trim().split(LF).length).toBe(1);
  });
});

describe("写路径去重：同一句话 24 小时内只记一次", () => {
  const HOUR = 3_600_000;
  const T0 = 1_800_000_000_000;

  it("同内容 24 小时内重复 → 不新建，只抬激活", () => {
    const store = MemoryStore.open(tmpFile(), allowAll, cfg);
    const first = store.write(rec("m1", { content: "在吗？我回来了。", created_at: T0 }), T0);
    expect(first.stored).toBe(true);
    const again = store.write(rec("m2", { content: "在吗？我回来了。", created_at: T0 + HOUR }), T0 + HOUR);
    expect(again.stored).toBe(false);
    expect(again.reason).toBe("duplicate");
    expect(store.all().map((m) => m.id)).toEqual(["m1"]);
    // 合并的效果是「又想起一次」：访问计数 +1、last_accessed 推到这一次
    expect(store.get("m1")?.access_count).toBe(1);
    expect(store.get("m1")?.last_accessed).toBe(T0 + HOUR);
  });

  it("标点/空白不同也算同一句；不同内容各存一条", () => {
    const store = MemoryStore.open(tmpFile(), allowAll, cfg);
    store.write(rec("m1", { content: "在吗？我回来了", created_at: T0 }), T0);
    expect(store.write(rec("m2", { content: "在吗 我回来了!", created_at: T0 + 1 }), T0 + 1).stored).toBe(false);
    expect(store.write(rec("m3", { content: "今天也想跟你多聊一会儿", created_at: T0 + 2 }), T0 + 2).stored).toBe(true);
    expect(store.all()).toHaveLength(2);
  });

  it("超过 24 小时的同内容算新的一次", () => {
    const store = MemoryStore.open(tmpFile(), allowAll, cfg);
    store.write(rec("m1", { content: "我回来了", created_at: T0 }), T0);
    const later = T0 + 25 * HOUR;
    expect(store.write(rec("m2", { content: "我回来了", created_at: later }), later).stored).toBe(true);
    expect(store.all()).toHaveLength(2);
  });
});
