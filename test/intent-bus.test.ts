import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACC_DECAY,
  EMIT_THETA,
  IntentionWAL,
  activate,
  addAttempt,
  allowedDuringVeto,
  dropIntention,
  driftFromWidening,
  emittedKinds,
  gapWidening,
  initialAccumulator,
  markBlocked,
  newIntention,
  secondCompetition,
  stepAccumulator,
  vetoWindowMs,
  withinVetoWindow,
} from "../src/orchestrator/intent/bus.js";
import { INTENT_KINDS, type DriveVector } from "../src/orchestrator/intent/types.js";

const DRIVE: DriveVector = {
  energy: 0.2,
  integrity: 0.3,
  connection: 0.7,
  competence: 0.4,
  novelty: 0.6,
  coherence: 0.5,
};

const tmpDirs: string[] = [];
function tempWal(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "intent-wal-"));
  tmpDirs.push(dir);
  return { dir, path: join(dir, "intent-assistant.ndjson") };
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("§4.3(b) 累积器：缺口扩大才憋不住", () => {
  it("初值为 0，七个类别齐全", () => {
    const acc = initialAccumulator();
    expect(Object.keys(acc).sort()).toEqual([...INTENT_KINDS].sort());
    expect(new Set(Object.values(acc))).toEqual(new Set([0]));
  });

  it("无 drift 时按 λ 指数衰减", () => {
    const prev = initialAccumulator();
    prev.reach_out = 0.8;
    const next = stepAccumulator(prev, { decay: ACC_DECAY });
    expect(next.reach_out).toBeCloseTo(0.8 * (1 - ACC_DECAY), 10);
    // λ 现在是"每小时忘 35%"，5 分钟拍上只有 ≈0.0355，所以下一拍应接近 0.772
    expect(next.reach_out).toBeCloseTo(0.7716, 3);
  });

  it("drift 加、噪声按尺度加入，结果夹在 [0,1]", () => {
    const prev = initialAccumulator();
    const next = stepAccumulator(prev, { drift: { reach_out: 0.5 }, noise: { reach_out: 2 }, noiseScale: 0.05 });
    expect(next.reach_out).toBeCloseTo(0.6, 10);
    const capped = stepAccumulator(prev, { drift: { reach_out: 5 } });
    expect(capped.reach_out).toBe(1);
  });

  it("非法衰减/噪声/非有限历史值当场抛", () => {
    const prev = initialAccumulator();
    expect(() => stepAccumulator(prev, { decay: 1.5 })).toThrow(RangeError);
    expect(() => stepAccumulator(prev, { decay: -0.1 })).toThrow(RangeError);
    expect(() => stepAccumulator(prev, { noise: { reach_out: Number.NaN } })).toThrow(RangeError);
    const dirty = initialAccumulator();
    dirty.explore = Number.POSITIVE_INFINITY;
    expect(() => stepAccumulator(dirty)).toThrow(RangeError);
  });

  it("gapWidening 逐维相减；driftFromWidening 只算正扩大", () => {
    const cur: DriveVector = { ...DRIVE, connection: 0.9, novelty: 0.4 };
    const widening = gapWidening(DRIVE, cur);
    expect(widening.connection).toBeCloseTo(0.2, 10);
    expect(widening.novelty).toBeCloseTo(-0.2, 10);
    const drift = driftFromWidening(widening, 1);
    expect(drift.reach_out).toBeCloseTo(0.2, 10); // connection 扩大
    expect(drift.explore).toBe(0); // novelty 缩小，不憋
    expect(drift.idle).toBe(0);
    expect(() => driftFromWidening(widening, -1)).toThrow(RangeError);
  });

  it("越阈即浮现：高于 θ 且同类无活跃；边界严格大于", () => {
    const values = initialAccumulator();
    values.reach_out = EMIT_THETA.reach_out;
    values.explore = EMIT_THETA.explore + 0.01;
    values.withdraw = 0.9;
    expect(emittedKinds(values, ["withdraw"])).toEqual(["explore"]); // 只在阈值上不浮现
    values.reach_out += 0.01;
    expect(emittedKinds(values, ["withdraw"])).toEqual(["reach_out", "explore"]);
    // 顺序固定按 INTENT_KINDS（reach_out 在 explore 前）
    expect(emittedKinds(values, [...INTENT_KINDS])).toEqual([]);
  });
});

describe("§4.3(b) veto 窗口：越急越短，结束时重赛", () => {
  it("T = clamp(180s·(1−urgency), 5s, 600s)", () => {
    expect(vetoWindowMs(0)).toBe(180_000);
    expect(vetoWindowMs(1)).toBe(5_000);
    expect(vetoWindowMs(0.5)).toBe(90_000);
    expect(vetoWindowMs(0.99)).toBe(5_000);
    expect(() => vetoWindowMs(-0.5)).toThrow(RangeError); // 负紧迫度是调用方错误，不静默夹住
  });

  it("非法 urgency/边界抛错", () => {
    expect(() => vetoWindowMs(Number.NaN)).toThrow(RangeError);
    expect(() => vetoWindowMs(-1)).toThrow(RangeError);
    expect(() => vetoWindowMs(0.5, { min: 10, max: 5 })).toThrow(RangeError);
  });

  it("窗口判定与 risk 0 例外", () => {
    expect(withinVetoWindow(0, 10)).toBe(true);
    expect(withinVetoWindow(9.99, 10)).toBe(true);
    expect(withinVetoWindow(10, 10)).toBe(false);
    expect(() => withinVetoWindow(-1, 10)).toThrow(RangeError);
    expect(allowedDuringVeto(0)).toBe(true);
    expect(allowedDuringVeto(1)).toBe(false);
    expect(allowedDuringVeto(3)).toBe(false);
  });

  it("二次竞争：挑战者严格更高才算赢，同分在位者留任（滞回）", () => {
    expect(secondCompetition(0.5, 0.6)).toBe("challenger");
    expect(secondCompetition(0.5, 0.5)).toBe("current");
    expect(secondCompetition(0.5, 0.4)).toBe("current");
    expect(() => secondCompetition(Number.NaN, 1)).toThrow(RangeError);
  });
});

describe("IntentRecord 状态迁移（纯函数）", () => {
  const base = () =>
    newIntention({
      id: "in-1",
      at: "2026-10-31T14:00:00.000Z",
      kind: "reach_out",
      goal: "想找用户说句话",
      why: "好久没说话了",
      sourceIds: ["m-1"],
    });

  it("新建默认 pending，数组是副本", () => {
    const rec = base();
    expect(rec.status).toBe("pending");
    expect(rec.survival).toBe(0);
    expect(rec.blocked_by).toBeNull();
    expect(rec.trigger).toBeNull();
    expect(rec.source_ids).toEqual(["m-1"]);
  });

  it("被闸拦下：blocked + blocked_by，不丢弃，survival 涨", () => {
    const blocked = markBlocked(base(), "quiet_hours");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by).toBe("quiet_hours");
    expect(blocked.survival).toBe(1);
    expect(() => markBlocked(base(), "")).toThrow(RangeError);
  });

  it("activate 不能复活已结束的意图", () => {
    expect(activate(base()).status).toBe("active");
    const done = { ...base(), status: "done" as const };
    expect(() => activate(done)).toThrow(RangeError);
    expect(() => activate(dropIntention(base()))).toThrow(RangeError);
  });

  it("addAttempt：ok→done，fail/noop→pending，agency 越界抛", () => {
    const rec = activate(base());
    const done = addAttempt(rec, { at: "2026-10-31T14:05:00.000Z", act: "qq.send_text", outcome: "ok", agency: 0.7 });
    expect(done.status).toBe("done");
    expect(done.attempts).toHaveLength(1);
    expect(done.survival).toBe(rec.survival + 1);
    const failed = addAttempt(rec, { at: "2026-10-31T14:05:00.000Z", act: "qq.send_text", outcome: "fail", agency: 0.1 });
    expect(failed.status).toBe("pending");
    expect(() => addAttempt(rec, { at: "x", act: "a", outcome: "ok", agency: 1.2 })).toThrow(RangeError);
  });
});

describe("§4.5 #3 意图 WAL：append-only，坏行不致命", () => {
  it("同 id 多版本：读到最后一条；不同 id 并存", () => {
    const { path } = tempWal();
    const wal = new IntentionWAL(path);
    expect(wal.read().versions).toEqual([]); // 文件不存在 = 空
    const rec = newIntention({ id: "in-1", at: "t1", kind: "explore", goal: "g", why: "w" });
    wal.append(rec);
    wal.append({ ...rec, status: "active", survival: 1 });
    wal.append(newIntention({ id: "in-2", at: "t2", kind: "idle", goal: "g2", why: "w2" }));
    const { versions, current, corrupt } = wal.read();
    expect(versions).toHaveLength(3);
    expect(corrupt).toBe(0);
    expect(current.size).toBe(2);
    expect(current.get("in-1")?.status).toBe("active");
    expect(current.get("in-1")?.survival).toBe(1);
  });

  it("坏行只计数，不影响其余版本；结构不符也算坏行", () => {
    const { path } = tempWal();
    const wal = new IntentionWAL(path);
    const rec = newIntention({ id: "in-1", at: "t", kind: "repair", goal: "g", why: "w" });
    wal.append(rec);
    writeFileSync(path, `${readFileSync(path, "utf8")}{broken json\n{"id":42}\n`, "utf8");
    const { versions, corrupt } = wal.read();
    expect(versions).toHaveLength(1);
    expect(corrupt).toBe(2);
  });

  it("audit 统计：版本数/当前数/状态/类别/有尝试占比", () => {
    const { path } = tempWal();
    const wal = new IntentionWAL(path);
    const a = newIntention({ id: "a", at: "t", kind: "explore", goal: "g", why: "w" });
    const b = newIntention({ id: "b", at: "t", kind: "explore", goal: "g", why: "w" });
    wal.append(a);
    wal.append(addAttempt(activate(b), { at: "t2", act: "x", outcome: "ok", agency: 0.5 }));
    const audit = wal.audit();
    expect(audit.versions).toBe(2);
    expect(audit.current).toBe(2);
    expect(audit.corrupt).toBe(0);
    expect(audit.byStatus.pending).toBe(1);
    expect(audit.byStatus.done).toBe(1);
    expect(audit.byStatus.active).toBe(0);
    expect(audit.byKind.explore).toBe(2);
    expect(audit.withAttempts).toBeCloseTo(0.5, 10);
  });

  it("append 前校验结构；目录会自动建", () => {
    const { dir } = tempWal();
    const nested = join(dir, "nested", "deeper", "intent.ndjson");
    const wal = new IntentionWAL(nested);
    wal.append(newIntention({ id: "x", at: "t", kind: "idle", goal: "g", why: "w" }));
    expect(wal.read().current.size).toBe(1);
    expect(() => wal.append({ id: 42 } as never)).toThrow(RangeError);
    expect(nested).toContain("intent.ndjson");
  });
});
