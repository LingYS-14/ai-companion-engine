import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeClock } from "../src/engine/clock.js";
import { SoulRuntime, type SoulConfig } from "../src/plugin/runtime.js";
import {
  interpretationsFromRaw,
  interpretationsFilePathInDataDir,
  latestPatchOf,
  withInterpretation,
  withInterpretationRows,
} from "../src/orchestrator/intent/version-recall.js";
import { serializeReconsolidationFile, VERSION_FILE_VERSION } from "../src/orchestrator/intent/version-file.js";
import type { ReconsolidationPatch } from "../src/orchestrator/intent/version-chain.js";

const NOW = 1_793_500_000_000;

function patch(overrides: Partial<ReconsolidationPatch> = {}): ReconsolidationPatch {
  return {
    memoryId: "m1",
    newVersion: 1,
    changed: { interpretation: "原来我怕的是被丢下，不是怕海。" },
    reason: "同一件事的情绪底色翻了面",
    source_ids: ["m-old", "m-new"],
    prevVersion: 0,
    supersededBy: null,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-version-recall-"));
  dirs.push(dir);
  return dir;
}

describe("§5.4 再巩固的读取端：把最新解释带回召回文本（F207）", () => {
  it("从文件内容建最新解释表：同一记忆多版只留最新", () => {
    const file = {
      version: VERSION_FILE_VERSION,
      savedAtMs: NOW,
      patches: [
        patch(),
        patch({ newVersion: 2, prevVersion: 1, changed: { interpretation: "第二次的想法" } }),
      ],
    };
    const r = interpretationsFromRaw(serializeReconsolidationFile(file.patches, NOW));
    expect(r.errors).toEqual([]);
    expect(r.interpretations.get("m1")).toBe("第二次的想法");
  });

  it("没有解释的补丁不产生后记；坏文件返回空表 + 错误（宁可不加）", () => {
    const noText = patch({ changed: { valence: 0.1 } });
    const r1 = interpretationsFromRaw(serializeReconsolidationFile([noText], NOW));
    expect(r1.interpretations.size).toBe(0);
    const r2 = interpretationsFromRaw("{broken");
    expect(r2.interpretations.size).toBe(0);
    expect(r2.errors.length).toBeGreaterThan(0);
  });

  it("withInterpretation：空/空白解释原样返回，有解释单独一行", () => {
    expect(withInterpretation("原话", undefined)).toBe("原话");
    expect(withInterpretation("原话", "   ")).toBe("原话");
    expect(withInterpretation("原话", "后来我明白了")).toBe("原话\n（后来我想明白了：后来我明白了）");
  });

  it("withInterpretationRows：保持顺序、无解释的行原样、不改入参", () => {
    const rows = [
      { id: "a", content: "A" },
      { id: "b", content: "B" },
    ];
    const out = withInterpretationRows(rows, new Map([["b", "想通了"]]));
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]?.content).toBe("B\n（后来我想明白了：想通了）");
    expect(rows[1]?.content).toBe("B");
  });

  it("latestPatchOf：取最高版本；没有补丁返回 null", () => {
    const patches = [patch(), patch({ newVersion: 2, prevVersion: 1, changed: { interpretation: "最新" } })];
    expect(latestPatchOf(patches, "m1")).toEqual({ version: 2, interpretation: "最新" });
    expect(latestPatchOf(patches, "m2")).toBeNull();
  });

  it("线上路径：真的 recall 里带上后记（原文还在，追加一行）", async () => {
    const root = temp();
    const conf: SoulConfig = { characterId: "test", dataDir: root, trace: false };
    const clock = new FakeClock(NOW, 12);
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "用户说周末想去看海。", source: "player", tags: ["约定"] });
    const memory = rt.memoryStore().all()[0];
    expect(memory).toBeDefined();
    if (memory === undefined) return;

    const filePath = interpretationsFilePathInDataDir(root, conf.characterId);
    writeFileSync(
      filePath,
      serializeReconsolidationFile([patch({ memoryId: memory.id })], NOW),
      "utf8",
    );

    const rows = rt.recall("看海");
    expect(rows.length).toBe(1);
    expect(rows[0]?.content).toContain("用户说周末想去看海。");
    expect(rows[0]?.content).toContain("（后来我想明白了：原来我怕的是被丢下，不是怕海。）");
  });

  it("线上路径：没有再巩固文件时，文本与以前逐字一致", async () => {
    const root = temp();
    const conf: SoulConfig = { characterId: "test", dataDir: root, trace: false };
    const clock = new FakeClock(NOW, 12);
    const rt = await SoulRuntime.open(conf, clock);
    rt.remember({ content: "用户说周末想去看海。", source: "player", tags: ["约定"] });
    const rows = rt.recall("看海");
    expect(rows[0]?.content).toBe("用户说周末想去看海。");
  });
});
