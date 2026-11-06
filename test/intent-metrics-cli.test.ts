import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findShadowFile,
  parseArgs,
  readShadowFile,
  toMetricTicks,
} from "../tools/intent/metrics.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "metrics-cli-"));
}

describe("tools/intent/metrics.mjs", () => {
  it("解析参数：默认值、--file/--root/--json，未知参数抛错", () => {
    const base = parseArgs([]);
    expect(base.file).toBeNull();
    expect(base.json).toBe(false);
    expect(base.root).toBe(REPO);

    const args = parseArgs(["--file", "a.ndjson", "--json", "--root", "/tmp/x"]);
    expect(args.file).toBe("a.ndjson");
    expect(args.json).toBe(true);
    expect(args.root).toBe(path.resolve("/tmp/x"));

    expect(() => parseArgs(["--nope"])).toThrow(/未知参数/);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("读 ndjson：坏行跳过并计数，不因一行坏掉整份样本", () => {
    const dir = tmpDir();
    const file = path.join(dir, "x.ndjson");
    fs.writeFileSync(file, '{"a":1}\n\nnot json\n{"a":2}\n', "utf8");
    const { records, corrupt } = readShadowFile(file);
    expect(records).toHaveLength(2);
    expect(corrupt).toBe(1);
  });

  it("在线记录直接用 gate/wouldSpeak，不标近似", () => {
    const { ticks, approximated } = toMetricTicks([
      { at: "2026-10-31T00:00:00Z", emitted: ["reach_out"], candidates: [1, 2], gate: { allowed: false }, wouldSpeak: false },
    ]);
    expect(approximated).toBe(0);
    expect(ticks[0]).toMatchObject({ emitted: ["reach_out"], candidates: 2, gateAllowed: false, wouldSpeak: false });
  });

  it("离线样本没有 gate 时按硬闸近似，并显式计数近似条数", () => {
    const { ticks, approximated, notes } = toMetricTicks([
      { i: 1, localHour: 23, hardBlocks: ["quiet_hours"], topKind: "reach_out", candidates: [{}, {}] },
      { i: 2, localHour: 9, hardBlocks: [], topKind: "explore", candidates: [{}] },
    ]);
    expect(approximated).toBe(2);
    expect(notes[0]).toContain("approximated=2");
    expect(ticks[0]).toMatchObject({ gateAllowed: false, wouldSpeak: false, emitted: ["reach_out"] });
    expect(ticks[1]).toMatchObject({ gateAllowed: true, wouldSpeak: true, candidates: 1 });
  });

  it("自动找最新一份 shadow 文件；目录不存在时返回 null", () => {
    const root = tmpDir();
    expect(findShadowFile(root)).toBeNull();
    fs.mkdirSync(path.join(root, "data"));
    const oldFile = path.join(root, "data", "intent-shadow-x.ndjson");
    const newFile = path.join(root, "data", "intent-live-shadow-x.ndjson");
    fs.writeFileSync(oldFile, "", "utf8");
    fs.writeFileSync(newFile, "", "utf8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, past, past);
    expect(findShadowFile(root)).toBe(newFile);
  });
});
