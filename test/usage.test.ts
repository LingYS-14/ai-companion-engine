import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadUsage, pruneUsage, recordUsage, recordUsageOnce, saveUsage, USAGE_WINDOW_MS } from "../src/autonomy/usage.js";

const dirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ase-usage-"));
  dirs.push(dir);
  return join(dir, "usage.json");
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("usage ledger", () => {
  it("pruneUsage 只留最近一小时、有限且不晚于 now，并升序", () => {
    const now = 10_000_000;
    const out = pruneUsage([now - USAGE_WINDOW_MS, now - 1, now, now + 5, Number.NaN], now);
    expect(out).toEqual([now - 1, now]);
    expect(pruneUsage([], now)).toEqual([]);
  });

  it("文件缺失或损坏都当没记录（审核从严，不因坏文件清零）", () => {
    const file = tempFile();
    expect(loadUsage(file, 1_000)).toEqual([]);
    writeFileSync(file, "{not json", "utf8");
    expect(loadUsage(file, 1_000)).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 1, calls: "x" }), "utf8");
    expect(loadUsage(file, 1_000)).toEqual([]);
  });

  it("save/load 往返保留窗口内的时刻", () => {
    const file = tempFile();
    const now = 5_000_000;
    saveUsage(file, [now - 2, now - 4_000_000, now], now);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; calls: number[] };
    expect(raw.version).toBe(1);
    expect(loadUsage(file, now)).toEqual([now - 2, now]);
  });

  it("recordUsage 追加并落盘，重启后仍能读到", () => {
    const file = tempFile();
    const now = 7_000_000;
    let calls = loadUsage(file, now);
    calls = recordUsage(file, calls, now);
    calls = recordUsage(file, calls, now + 1_000);
    expect(calls).toEqual([now, now + 1_000]);
    expect(loadUsage(file, now + 1_000)).toEqual([now, now + 1_000]);
  });

  it("recordUsageOnce 自己读窗口再追加（装配点不用记得 load）", () => {
    const file = tempFile();
    const now = 9_000_000;
    recordUsageOnce(file, now);
    recordUsageOnce(file, now + 2_000);
    expect(loadUsage(file, now + 2_000)).toEqual([now, now + 2_000]);
    // 窗口外的老记录会被裁掉：这里不会因为"很久以前的那次"把额度算回来
    const later = now + USAGE_WINDOW_MS * 2;
    recordUsageOnce(file, later);
    expect(loadUsage(file, later)).toEqual([later]);
  });
});

describe("插件通道也要记账（审计 P0-2）", () => {
  const ROOT = join(import.meta.dirname, "..");

  it("plugin/index.ts 的宿主 generate 成功后会写同一个 usage 账本", () => {
    const text = readFileSync(join(ROOT, "src", "plugin", "index.ts"), "utf8");
    // 只要出现挂载点即可：真正的"生成成功才记"由 inline 代码顺序保证，这里锁住别被删掉。
    expect(text).toContain("recordUsageOnce");
    expect(text).toContain('"autonomy-usage.json"');
    expect(text).toMatch(/generate:\s*async\s*\(input\)\s*=>/);
  });
});
