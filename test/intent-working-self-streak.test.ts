import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  advanceWorkingSelfState,
  CONCRETENESS_FLOOR,
  describeWorkingSelfState,
  initialWorkingSelfState,
  parseWorkingSelfState,
  readWorkingSelfState,
  serializeWorkingSelfState,
  WORKING_SELF_STATE_VERSION,
  workingSelfStatePath,
  workingSelfStatePathInDataDir,
  writeWorkingSelfState,
  type WorkingSelfState,
} from "../src/orchestrator/intent/working-self-streak.js";

const NOW = 1_793_400_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-ws-streak-"));
  dirs.push(dir);
  return dir;
}

describe("§5.2 具体性 streak：跨回合记住「连续几次只记得结论」", () => {
  it("文件路径固定在 data/ 下，跟角色走", () => {
    expect(workingSelfStatePath("C:/ase", "assistant")).toBe(join("C:/ase", "data", "working-self-assistant.json"));
    expect(workingSelfStatePathInDataDir("C:/ase/data", "assistant")).toBe(
      join("C:/ase/data", "working-self-assistant.json"),
    );
  });

  it("初值：0 次、没有最近值、没有备注", () => {
    expect(initialWorkingSelfState(NOW)).toEqual({
      version: WORKING_SELF_STATE_VERSION,
      savedAtMs: NOW,
      lowConcretenessStreak: 0,
      lastConcreteness: null,
      lastAlarm: null,
      relaxFactor: 1,
    });
  });

  it("序列化键序固定，往返一致", () => {
    const state = advanceWorkingSelfState(initialWorkingSelfState(NOW), {
      concreteness: 0.2,
      alarmNote: "具体性低",
      nowMs: NOW + 1000,
    });
    const text = serializeWorkingSelfState(state);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      "version",
      "savedAtMs",
      "lowConcretenessStreak",
      "lastConcreteness",
      "lastAlarm",
      "relaxFactor",
    ]);
    const parsed = parseWorkingSelfState(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.state).toEqual(state);
  });

  it("坏文件一律拒绝（不静默从零开始）", () => {
    expect(parseWorkingSelfState("not json").state).toBeNull();
    expect(parseWorkingSelfState("[]").state).toBeNull();
    expect(parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), extra: 1 })).errors).toEqual(
      expect.arrayContaining([expect.stringContaining("未知字段")]),
    );
    expect(parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), version: 2 })).state).toBeNull();
    expect(
      parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), lowConcretenessStreak: -1 })).state,
    ).toBeNull();
    expect(
      parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), lowConcretenessStreak: 1.5 })).state,
    ).toBeNull();
    expect(parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), lastConcreteness: 1.5 })).state).toBeNull();
    expect(parseWorkingSelfState(JSON.stringify({ ...initialWorkingSelfState(NOW), lastAlarm: 42 })).state).toBeNull();
  });

  it("低于阈值累加、够具体清零、没命中保持原样", () => {
    const base = initialWorkingSelfState(NOW);
    const a = advanceWorkingSelfState(base, { concreteness: 0.3, nowMs: NOW + 1 });
    expect(a.lowConcretenessStreak).toBe(1);
    const b = advanceWorkingSelfState(a, { concreteness: 0.49, nowMs: NOW + 2 });
    expect(b.lowConcretenessStreak).toBe(2);
    const reset = advanceWorkingSelfState(b, { concreteness: CONCRETENESS_FLOOR, nowMs: NOW + 3 });
    expect(reset.lowConcretenessStreak).toBe(0);
    const none = advanceWorkingSelfState(b, { concreteness: null, nowMs: NOW + 4 });
    expect(none.lowConcretenessStreak).toBe(2);
    expect(none.lastConcreteness).toBe(0.49);
    expect(none.savedAtMs).toBe(NOW + 4);
  });

  it("alarmNote 给 null 会清掉上次备注，缺省则保留", () => {
    const withNote = advanceWorkingSelfState(initialWorkingSelfState(NOW), {
      concreteness: 0.1,
      alarmNote: "具体性低",
      nowMs: NOW + 1,
    });
    const kept = advanceWorkingSelfState(withNote, { concreteness: 0.1, nowMs: NOW + 2 });
    expect(kept.lastAlarm).toBe("具体性低");
    const cleared = advanceWorkingSelfState(kept, { concreteness: 0.9, alarmNote: null, nowMs: NOW + 3 });
    expect(cleared.lastAlarm).toBeNull();
  });

  it("不改入参；非法参数抛 RangeError（不静默夹取）", () => {
    const base = initialWorkingSelfState(NOW);
    advanceWorkingSelfState(base, { concreteness: 0.1, nowMs: NOW + 1 });
    expect(base.lowConcretenessStreak).toBe(0);
    expect(() => advanceWorkingSelfState(base, { concreteness: 0.1, nowMs: 0 })).toThrow(RangeError);
    expect(() => advanceWorkingSelfState(base, { concreteness: Number.NaN, nowMs: NOW })).toThrow(RangeError);
    expect(() => advanceWorkingSelfState(base, { concreteness: -0.1, nowMs: NOW })).toThrow(RangeError);
    expect(() => advanceWorkingSelfState(base, { concreteness: 1.1, nowMs: NOW })).toThrow(RangeError);
  });

  it("读：文件不存在给初值且不算错；坏文件给初值 + 错误", () => {
    const path = join(tmp(), "missing.json");
    const missing = readWorkingSelfState(path, NOW);
    expect(missing.existed).toBe(false);
    expect(missing.errors).toEqual([]);
    expect(missing.state.lowConcretenessStreak).toBe(0);

    const badPath = join(tmp(), "bad.json");
    writeFileSync(badPath, "{", "utf8");
    const bad = readWorkingSelfState(badPath, NOW);
    expect(bad.existed).toBe(true);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.state.savedAtMs).toBe(NOW);
  });

  it("写→读往返一致，且不留下 .tmp- 文件", () => {
    const path = join(tmp(), "data", "working-self-test.json");
    const state = advanceWorkingSelfState(initialWorkingSelfState(NOW), {
      concreteness: 0.1,
      alarmNote: "具体性低",
      nowMs: NOW + 10,
    });
    writeWorkingSelfState(path, state);
    const loaded = readWorkingSelfState(path, NOW);
    expect(loaded.existed).toBe(true);
    expect(loaded.state).toEqual(state);
    expect(readdirSync(join(path, "..")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("一行摘要：数字可读，没有最近值写 none", () => {
    expect(describeWorkingSelfState(initialWorkingSelfState(NOW))).toBe("working-self streak=0 last=none");
    const one = advanceWorkingSelfState(initialWorkingSelfState(NOW), { concreteness: 0.25, nowMs: NOW + 1 });
    expect(describeWorkingSelfState(one)).toBe("working-self streak=1 last=0.25");
  });

  it("连续 20 轮低具体性后放宽一档，streak 归零并记 self_note", () => {
    let state = initialWorkingSelfState(NOW);
    for (let i = 0; i < 19; i += 1) state = advanceWorkingSelfState(state, { concreteness: 0.1, nowMs: NOW + i });
    expect(state.relaxFactor).toBe(1);
    state = advanceWorkingSelfState(state, { concreteness: 0.1, nowMs: NOW + 19 });
    expect(state.relaxFactor).toBe(1.2);
    expect(state.lowConcretenessStreak).toBe(0);
    expect(state.lastAlarm).toBe("我最近只记得结论，不记得事情了。");
    expect(describeWorkingSelfState(state)).toContain("relax=1.2");
  });

  it("具体性恢复到 0.8 以上就收回放宽；中间值保持不放宽也不收回", () => {
    const relaxed: WorkingSelfState = { ...initialWorkingSelfState(NOW), relaxFactor: 1.2, lowConcretenessStreak: 3 };
    const mid = advanceWorkingSelfState(relaxed, { concreteness: 0.6, nowMs: NOW + 1 });
    expect(mid.relaxFactor).toBe(1.2);
    const recovered = advanceWorkingSelfState(relaxed, { concreteness: 0.9, nowMs: NOW + 1 });
    expect(recovered.relaxFactor).toBe(1);
    expect(recovered.lowConcretenessStreak).toBe(0);
  });

  it("没有命中（null）时放宽档位原样保留", () => {
    const relaxed: WorkingSelfState = { ...initialWorkingSelfState(NOW), relaxFactor: 1.2 };
    const next = advanceWorkingSelfState(relaxed, { concreteness: null, nowMs: NOW + 1 });
    expect(next.relaxFactor).toBe(1.2);
    expect(next.lowConcretenessStreak).toBe(relaxed.lowConcretenessStreak);
  });

  it("旧文件没有 relaxFactor 时按 1 读（不升版本、不判坏）", () => {
    const raw = JSON.stringify({
      version: WORKING_SELF_STATE_VERSION,
      savedAtMs: NOW,
      lowConcretenessStreak: 2,
      lastConcreteness: 0.25,
      lastAlarm: null,
    });
    const parsed = parseWorkingSelfState(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.state?.relaxFactor).toBe(1);
  });

  it("relaxFactor 非法（<1 / NaN / 字符串）判坏文件", () => {
    for (const bad of [0.5, Number.NaN, "1.2"]) {
      const raw = JSON.stringify({
        version: WORKING_SELF_STATE_VERSION,
        savedAtMs: NOW,
        lowConcretenessStreak: 0,
        lastConcreteness: null,
        lastAlarm: null,
        relaxFactor: bad,
      });
      expect(parseWorkingSelfState(raw).state).toBeNull();
    }
  });

  it("目录不存在时会建目录（第一次写盘不崩）", () => {
    const nested = join(tmp(), "deep", "data");
    mkdirSync(nested, { recursive: true });
    const path = join(nested, "working-self-x.json");
    writeWorkingSelfState(path, initialWorkingSelfState(NOW));
    expect(readWorkingSelfState(path, NOW).existed).toBe(true);
  });
});
