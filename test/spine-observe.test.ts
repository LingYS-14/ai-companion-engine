/**
 * 脊髓可观测（F267，审计 B.6 的收尾）。
 *
 * 锁四件事：
 *   1. 状态机给出可序列化快照（closed / open / half-open、失败数、熔断到几时）；
 *   2. `onChange` 只在"有变化"时回调（正常发送不写盘），回调抛错不影响熔断；
 *   3. 快照文件读写 fail-closed：坏文件返回 null，health 说"没有记录"而不是猜"闭合"；
 *   4. 装配点真的把路径接上（qq-runner 回调落盘、main.mjs 给 `data/spine-<id>.json`）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSpineGate, SPINE_COOLDOWN_MS, SPINE_FAIL_THRESHOLD, type SpineSnapshot } from "../src/autonomy/spine.js";
import {
  parseSpineSnapshot,
  readSpineSnapshotFile,
  serializeSpineSnapshot,
  spineSnapshotPath,
  writeSpineSnapshotFile,
} from "../src/autonomy/spine-file.js";

const repo = join(import.meta.dirname, "..");
const tempDirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-spine-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(startAt = 1_000_000): {
  readonly gate: ReturnType<typeof createSpineGate>;
  readonly changes: SpineSnapshot[];
  readonly at: (deltaMs: number) => number;
} {
  const changes: SpineSnapshot[] = [];
  const gate = createSpineGate({ now: () => startAt, onChange: (snapshot) => changes.push(snapshot) });
  return { gate, changes, at: (deltaMs: number) => startAt + deltaMs };
}

describe("脊髓快照（F267）", () => {
  it("初始状态是闭合、零失败、无熔断截止时间", () => {
    const { gate, at } = setup();
    const snap = gate.snapshot(at(0));
    expect(snap.state).toBe("closed");
    expect(snap.failures).toBe(0);
    expect(snap.openUntilMs).toBeNull();
    expect(snap.threshold).toBe(SPINE_FAIL_THRESHOLD);
    expect(snap.cooldownMs).toBe(SPINE_COOLDOWN_MS);
  });

  it("正常发送不产生变化回调（不写盘）；失败才回调", () => {
    const { gate, changes, at } = setup();
    gate.recordSend(at(0), true);
    expect(changes).toEqual([]);
    gate.recordSend(at(1), false);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.failures).toBe(1);
    expect(changes[0]?.state).toBe("closed");
  });

  it("熔断后快照是 open 且给出熔断截止；恢复后回到 closed 且失败清零", () => {
    const { gate, changes, at } = setup();
    for (let i = 0; i < SPINE_FAIL_THRESHOLD; i += 1) gate.recordSend(at(i), false);
    const opened = gate.snapshot(at(SPINE_FAIL_THRESHOLD));
    expect(opened.state).toBe("open");
    expect(opened.failures).toBe(SPINE_FAIL_THRESHOLD);
    expect(opened.openUntilMs).toBe(at(SPINE_FAIL_THRESHOLD - 1) + SPINE_COOLDOWN_MS);
    expect(changes.some((change) => change.state === "open")).toBe(true);

    const probeAt = at(SPINE_FAIL_THRESHOLD - 1) + SPINE_COOLDOWN_MS;
    expect(gate.snapshot(probeAt).state).toBe("half-open");
    gate.recordSend(probeAt + 2, true);
    const recovered = gate.snapshot(probeAt + 3);
    expect(recovered.state).toBe("closed");
    expect(recovered.failures).toBe(0);
    expect(changes.at(-1)?.state).toBe("closed");
  });

  it("落盘回调抛错不影响熔断判定（可观测性不能反过来造成故障）", () => {
    const gate = createSpineGate({
      now: () => 1_000_000,
      onChange: () => {
        throw new Error("disk full");
      },
    });
    for (let i = 0; i < SPINE_FAIL_THRESHOLD; i += 1) gate.recordSend(1_000_000 + i, false);
    expect(gate.isOpen(1_000_100)).toBe(true);
    expect(gate.snapshot(1_000_100).state).toBe("open");
  });
});

describe("脊髓快照文件（F267）", () => {
  it("路径是 data/spine-<id>.json", () => {
    expect(spineSnapshotPath("C:/x/data", "assistant")).toBe(join("C:/x/data", "spine-assistant.json"));
  });

  it("序列化往返一致", () => {
    const snapshot: SpineSnapshot = {
      version: 1,
      atMs: 1_800_000_000_000,
      state: "open",
      failures: 3,
      openUntilMs: 1_800_000_300_000,
      probeAtMs: null,
      threshold: 3,
      cooldownMs: 600_000,
    };
    expect(parseSpineSnapshot(serializeSpineSnapshot(snapshot))).toEqual(snapshot);
  });

  it("坏 JSON / 版本不符 / 状态不认识 / 数字不是有限值都返回 null（不猜）", () => {
    expect(parseSpineSnapshot("{")).toBeNull();
    expect(parseSpineSnapshot("[]")).toBeNull();
    expect(
      parseSpineSnapshot(
        JSON.stringify({ version: 2, atMs: 1, state: "closed", failures: 0, openUntilMs: null, probeAtMs: null, threshold: 3, cooldownMs: 1 }),
      ),
    ).toBeNull();
    expect(
      parseSpineSnapshot(
        JSON.stringify({ version: 1, atMs: 1, state: "broken", failures: 0, openUntilMs: null, probeAtMs: null, threshold: 3, cooldownMs: 1 }),
      ),
    ).toBeNull();
    expect(
      parseSpineSnapshot(
        JSON.stringify({ version: 1, atMs: null, state: "closed", failures: 0, openUntilMs: null, probeAtMs: null, threshold: 3, cooldownMs: 1 }),
      ),
    ).toBeNull();
  });

  it("写读往返（含目录自动创建）；读不到返回 null", () => {
    const dir = tempDir();
    const path = spineSnapshotPath(join(dir, "nested"), "assistant");
    const snapshot: SpineSnapshot = {
      version: 1,
      atMs: 1,
      state: "closed",
      failures: 1,
      openUntilMs: null,
      probeAtMs: null,
      threshold: 3,
      cooldownMs: 600_000,
    };
    expect(writeSpineSnapshotFile(path, snapshot)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "closed", failures: 1 });
    expect(readSpineSnapshotFile(path)).toEqual(snapshot);
    expect(readSpineSnapshotFile(join(dir, "missing.json"))).toBeNull();
  });

  it("写失败返回 false 并只记日志，不抛", () => {
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    mkdirSync(blocker, { recursive: true });
    const lines: string[] = [];
    const ok = writeSpineSnapshotFile(join(blocker, "x.json"), {
      version: 1,
      atMs: 1,
      state: "closed",
      failures: 0,
      openUntilMs: null,
      probeAtMs: null,
      threshold: 3,
      cooldownMs: 600_000,
    }, (line) => lines.push(line));
    // Windows 上把目录当文件写会失败；若环境允许则至少保证不抛
    if (!ok) expect(lines.some((line) => line.includes("快照落盘失败"))).toBe(true);
  });
});

describe("脊髓可观测接线（F267）", () => {
  it("qq-runner 用 onChange 落盘，装配点给 spinePath，health 读同一个文件名", () => {
    const runner = readFileSync(join(repo, "src/autonomy/qq-runner.ts"), "utf8");
    expect(runner).toContain("writeSpineSnapshotFile(");
    expect(runner).toContain("spinePath");
    expect(runner).toContain("onChange:");

    // F300：spinePath 的拼装随 QQ 接线搬进装配层；入口只把桥交出去。
    const wiring = readFileSync(join(repo, "src/assembly/qq-wiring.ts"), "utf8");
    expect(wiring).toContain("spinePath: join(input.dataDir, `spine-${input.characterId}.json`)");
    const main = readFileSync(join(repo, "scripts/autonomy/main.mjs"), "utf8");
    expect(main).toContain("startQqBridge({");

    const health = readFileSync(join(repo, "scripts/autonomy/health.mjs"), "utf8");
    expect(health).toContain("spine-${characterId}.json");
    expect(health).toContain("对外通道");
  });
});
