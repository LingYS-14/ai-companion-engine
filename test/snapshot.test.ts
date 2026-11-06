import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localDay, snapshotData, snapshotDone } from "../src/autonomy/snapshot.js";

const NOW = 1_800_000_000_000;
const tmp = (): string => mkdtempSync(join(tmpdir(), "snapshot-"));

describe("每日数据快照", () => {
  it("把指定文件复制到日期目录并写 manifest", () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "memory-assistant.ndjson"), "{\"op\":\"put\"}\n", "utf8");
    writeFileSync(join(dataDir, "knowledge-assistant.ndjson"), "{\"op\":\"put\"}\n", "utf8");
    const r = snapshotData({ dataDir, now: NOW, tzOffsetMinutes: 480, files: ["memory-assistant.ndjson", "knowledge-assistant.ndjson", "missing.json"] });
    expect(r.dir).not.toBeNull();
    expect(r.copied).toEqual(["memory-assistant.ndjson", "knowledge-assistant.ndjson"]);
    const day = localDay(NOW, 480);
    expect(r.dir?.endsWith(day)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dataDir, "archive", "snapshots", day, "manifest.json"), "utf8"));
    expect(manifest.day).toBe(day);
    expect(manifest.entries).toHaveLength(2);
    expect(snapshotDone(dataDir, NOW, 480)).toBe(true);
  });

  it("同一天第二次调用直接跳过", () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "a.ndjson"), "x\n", "utf8");
    const first = snapshotData({ dataDir, now: NOW, files: ["a.ndjson"] });
    const second = snapshotData({ dataDir, now: NOW + 60_000, files: ["a.ndjson"] });
    expect(first.dir).not.toBeNull();
    expect(second.dir).toBeNull();
    expect(second.skippedReason).toBe("already-done");
  });

  it("一个文件都没有时不留空目录", () => {
    const dataDir = tmp();
    const r = snapshotData({ dataDir, now: NOW, files: ["nope.json"] });
    expect(r.dir).toBeNull();
    expect(r.skippedReason).toBe("nothing-copied");
    expect(existsSync(join(dataDir, "archive", "snapshots", localDay(NOW, 0)))).toBe(false);
  });

  it("超过保留天数的旧快照被清理，非日期目录不动", () => {
    const dataDir = tmp();
    writeFileSync(join(dataDir, "a.ndjson"), "x\n", "utf8");
    const oldDay = localDay(NOW - 20 * 86_400_000, 0);
    mkdirSync(join(dataDir, "archive", "snapshots", oldDay), { recursive: true });
    mkdirSync(join(dataDir, "archive", "snapshots", "keep-me"), { recursive: true });
    const r = snapshotData({ dataDir, now: NOW, keepDays: 7, files: ["a.ndjson"] });
    expect(r.pruned).toContain(oldDay);
    const left = readdirSync(join(dataDir, "archive", "snapshots"));
    expect(left).not.toContain(oldDay);
    expect(left).toContain("keep-me");
  });
});
