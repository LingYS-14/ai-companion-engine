/**
 * §5.4 再巩固版本链的落盘形状（F201）。
 *
 * 守的是"历史不能被悄悄改"：
 *   - 同输入两次序列化逐字节相同、按 (memoryId, newVersion) 排序；
 *   - 解析 fail-closed：坏 JSON / 未知字段 / 版本不符 / 重复版本 / 断链 / 超上限 → 整份拒绝；
 *   - 追加只接受"接着链末"的版本，并自动把旧链末的 supersededBy 补上；
 *   - 重复、跳版、超上限一律拒绝并说明，不静默丢旧版。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PATCHES_PER_MEMORY,
  MAX_PATCHES_TOTAL,
  VERSION_FILE_VERSION,
  addReconsolidationPatch,
  describeReconsolidationFile,
  mergeReconsolidationFiles,
  parseReconsolidationFile,
  patchesForMemory,
  reconsolidationFilePath,
  serializeReconsolidationFile,
  type ReconsolidationFile,
} from "../src/orchestrator/intent/version-file.js";
import type { ReconsolidationPatch } from "../src/orchestrator/intent/version-chain.js";

const SAVED = 1_793_400_000_000;

function patch(memoryId: string, newVersion: number, prevVersion = newVersion - 1, reason = "聊完之后觉得没那么糟"): ReconsolidationPatch {
  return {
    memoryId,
    newVersion,
    prevVersion,
    changed: { interpretation: `第 ${String(newVersion)} 版看法`, valence: 0.1 },
    reason,
    source_ids: [`src-${String(newVersion)}`],
    supersededBy: null,
  };
}

function fileOf(patches: readonly ReconsolidationPatch[]): ReconsolidationFile {
  return { version: VERSION_FILE_VERSION, savedAtMs: SAVED, patches };
}

describe("序列化：稳定、可读、不静默丢字段", () => {
  it("按 (memoryId, newVersion) 排序，同输入两次逐字节相同", () => {
    const a = serializeReconsolidationFile([patch("m2", 1), patch("m1", 2), patch("m1", 1)], SAVED);
    const b = serializeReconsolidationFile([patch("m1", 2), patch("m2", 1), patch("m1", 1)], SAVED);
    expect(a).toBe(b);
    const ids = (JSON.parse(a) as { patches: { memoryId: string; newVersion: number }[] }).patches.map(
      (p) => `${p.memoryId}@${String(p.newVersion)}`,
    );
    expect(ids).toEqual(["m1@1", "m1@2", "m2@1"]);
  });

  it("非法 savedAtMs / 非法补丁 / 超总数都抛（不是写个坏文件进去）", () => {
    expect(() => serializeReconsolidationFile([], 0)).toThrow(RangeError);
    expect(() => serializeReconsolidationFile([patch("m1", 2, 5)], SAVED)).toThrow(RangeError);
    const many = Array.from({ length: MAX_PATCHES_TOTAL + 1 }, (_, i) => {
      const id = `m-${String(Math.floor(i / 20))}`;
      return patch(id, (i % 20) + 1);
    });
    expect(() => serializeReconsolidationFile(many, SAVED)).toThrow(RangeError);
  });
});

describe("解析：fail-closed，不给半份", () => {
  it("往返：序列化再解析得到同样内容", () => {
    const text = serializeReconsolidationFile([patch("m1", 1), patch("m1", 2)], SAVED);
    const parsed = parseReconsolidationFile(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.file?.patches.map((p) => p.newVersion)).toEqual([1, 2]);
    expect(parsed.file?.savedAtMs).toBe(SAVED);
  });

  it("坏 JSON / 顶层非对象 → file=null 且有理由", () => {
    expect(parseReconsolidationFile("{oops")).toEqual({ file: null, errors: ["不是合法 JSON"] });
    expect(parseReconsolidationFile("[]").file).toBeNull();
  });

  it("未知顶层字段 / 版本不符 → 整份拒绝", () => {
    const base = JSON.parse(serializeReconsolidationFile([patch("m1", 1)], SAVED)) as Record<string, unknown>;
    const withExtra = { ...base, extra: true };
    expect(parseReconsolidationFile(JSON.stringify(withExtra)).errors.join("；")).toContain("未知顶层字段");
    const oldVersion = { ...base, version: 0 };
    expect(parseReconsolidationFile(JSON.stringify(oldVersion)).errors.join("；")).toContain("版本不符");
  });

  it("重复版本 / 断链 → 整份拒绝（不返回能用的半份）", () => {
    const dup = JSON.parse(serializeReconsolidationFile([patch("m1", 1)], SAVED)) as {
      patches: ReconsolidationPatch[];
    };
    dup.patches.push(patch("m1", 1));
    const dupParsed = parseReconsolidationFile(JSON.stringify({ ...dup, version: VERSION_FILE_VERSION, savedAtMs: SAVED }));
    expect(dupParsed.file).toBeNull();
    expect(dupParsed.errors.join("；")).toContain("重复版本");

    const broken = { version: VERSION_FILE_VERSION, savedAtMs: SAVED, patches: [patch("m1", 2, 5)] };
    const brokenParsed = parseReconsolidationFile(JSON.stringify(broken));
    expect(brokenParsed.file).toBeNull();
  });

  it("单记忆版本数超过上限 → 整份拒绝", () => {
    const patches = Array.from({ length: MAX_PATCHES_PER_MEMORY + 1 }, (_, i) => patch("m1", i + 1));
    const parsed = parseReconsolidationFile(
      JSON.stringify({ version: VERSION_FILE_VERSION, savedAtMs: SAVED, patches }),
    );
    expect(parsed.file).toBeNull();
    expect(parsed.errors.join("；")).toContain("超过上限");
  });
});

describe("追加：只接着链末，自动补 supersededBy", () => {
  it("第一条从 0 起，第二条把旧链末指过去", () => {
    const first = addReconsolidationPatch(null, patch("m1", 1, 0), SAVED);
    expect(first.added).toBe(true);
    const second = addReconsolidationPatch(first.file, patch("m1", 2, 1), SAVED);
    expect(second.added).toBe(true);
    expect(second.file.patches.map((p) => p.supersededBy)).toEqual([2, null]);
    expect(parseReconsolidationFile(serializeReconsolidationFile(second.file.patches, SAVED)).file).not.toBeNull();
  });

  it("重复版本 / 跳版（prevVersion 不是链末）都拒绝，文件原样返回", () => {
    const base = addReconsolidationPatch(null, patch("m1", 1, 0), SAVED).file;
    const dup = addReconsolidationPatch(base, patch("m1", 1, 0), SAVED);
    expect(dup.added).toBe(false);
    expect(dup.file).toEqual(base);
    const skip = addReconsolidationPatch(base, patch("m1", 3, 2), SAVED);
    expect(skip.added).toBe(false);
    expect(skip.errors.join("；")).toContain("prevVersion 应为 1");
  });

  it("超过单记忆上限后拒绝追加（不静默丢最旧版本）", () => {
    let file: ReconsolidationFile | null = null;
    for (let version = 1; version <= MAX_PATCHES_PER_MEMORY; version += 1) {
      const step = addReconsolidationPatch(file, patch("m1", version), SAVED);
      expect(step.added).toBe(true);
      file = step.file;
    }
    const over = addReconsolidationPatch(file, patch("m1", MAX_PATCHES_PER_MEMORY + 1), SAVED);
    expect(over.added).toBe(false);
    expect(over.errors.join("；")).toContain("超过上限");
  });
});

describe("查询 / 合并 / 摘要", () => {
  it("patchesForMemory 只给这条记忆，按版本升序", () => {
    const file = fileOf([patch("m2", 1), patch("m1", 2), patch("m1", 1)]);
    expect(patchesForMemory(file, "m1").map((p) => p.newVersion)).toEqual([1, 2]);
    expect(patchesForMemory(file, "nope")).toEqual([]);
  });

  it("合并相同内容幂等；同版本不同内容拒绝", () => {
    const left = fileOf([patch("m1", 1)]);
    const right = fileOf([patch("m1", 1)]);
    expect(mergeReconsolidationFiles(left, right).errors).toEqual([]);
    expect(mergeReconsolidationFiles(left, right).file?.patches).toHaveLength(1);
    const conflict = mergeReconsolidationFiles(left, fileOf([patch("m1", 1, 0, "完全不同的理由啊")]));
    expect(conflict.file).toBeNull();
    expect(conflict.errors.join("；")).toContain("拒绝合并");
  });

  it("摘要：空 / 正常 / 文件路径规则", () => {
    expect(describeReconsolidationFile(fileOf([]))).toBe("再巩固版本链：空");
    expect(describeReconsolidationFile(fileOf([patch("m1", 1), patch("m1", 2), patch("m2", 1)]))).toBe(
      "再巩固版本链：3 条补丁 / 2 条记忆 / 最长 2 版",
    );
    expect(reconsolidationFilePath("X:/tmp/x", "assistant")).toBe("X:/tmp/x/data/reconsolidation-assistant.json");
    expect(reconsolidationFilePath("X:/tmp/x/", "assistant")).toBe("X:/tmp/x/data/reconsolidation-assistant.json");
  });
});
