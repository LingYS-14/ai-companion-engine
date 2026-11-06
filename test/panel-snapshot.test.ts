/**
 * 面板状态快照（F274）。
 *
 * 为什么要有这份文件：面板读的是**别的进程**每拍写的快照。它最容易坏在
 * "读不到就当成默认值"——那样用户看到的是一张安静的脸，而不是"现在读不到"。
 * 所以这里的断言分三类：① 构建的边界（坏数字不猜）；② 解析的 fail-closed；
 * ③ 读写往返与过期；再加一条装配锁，防止哪天有人把插件改回"读本进程 state"。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PANEL_SNAPSHOT_MAX_AGE_MS,
  PANEL_SNAPSHOT_VERSION,
  buildPanelStateSnapshot,
  panelStateSnapshotPath,
  parsePanelStateSnapshot,
  readPanelStateSnapshotFile,
  serializePanelStateSnapshot,
  writePanelStateSnapshotFile,
} from "../src/orchestrator/intent/panel-snapshot.js";

const NOW = 1_790_000_000_000;

function source(over: Partial<{ valence: number; energy: number; pressure: number; mask: number }> = {}) {
  return {
    state: {
      valence: over.valence ?? 0.7,
      energy: over.energy ?? 0.6,
      pressure: over.pressure ?? 0.2,
      maskIntegrity: over.mask ?? 0.9,
    },
    snapshot: { mode: "NORMAL", turns: 12 },
  };
}

describe("buildPanelStateSnapshot", () => {
  it("取四个量与 mode/turns，版本与时间照实写", () => {
    const snap = buildPanelStateSnapshot(source(), NOW);
    expect(snap).toEqual({
      version: PANEL_SNAPSHOT_VERSION,
      atMs: NOW,
      turns: 12,
      mode: "NORMAL",
      valence: 0.7,
      energy: 0.6,
      pressure: 0.2,
      maskIntegrity: 0.9,
    });
  });

  it("turns 不是有限数时按 0，不写 NaN", () => {
    const snap = buildPanelStateSnapshot({ ...source(), snapshot: { mode: "NORMAL", turns: Number.NaN } }, NOW);
    expect(snap.turns).toBe(0);
  });

  it("数值越界与 mode 空、atMs 非法都抛，不产出一份坏快照", () => {
    expect(() => buildPanelStateSnapshot(source({ valence: 1.2 }), NOW)).toThrow(RangeError);
    expect(() => buildPanelStateSnapshot(source({ energy: -0.1 }), NOW)).toThrow(RangeError);
    expect(() => buildPanelStateSnapshot({ ...source(), snapshot: { mode: "" } }, NOW)).toThrow(RangeError);
    expect(() => buildPanelStateSnapshot(source(), Number.NaN)).toThrow(RangeError);
  });
});

describe("parsePanelStateSnapshot", () => {
  it("往返之后相等", () => {
    const snap = buildPanelStateSnapshot(source(), NOW);
    expect(parsePanelStateSnapshot(serializePanelStateSnapshot(snap))).toEqual(snap);
  });

  it("坏 JSON、版本不符、字段缺失、mode 空、数值越界一律 null", () => {
    const raw = serializePanelStateSnapshot(buildPanelStateSnapshot(source(), NOW));
    expect(parsePanelStateSnapshot("{")).toBeNull();
    expect(parsePanelStateSnapshot(JSON.stringify({ ...JSON.parse(raw), version: 99 }))).toBeNull();
    expect(parsePanelStateSnapshot(JSON.stringify({ ...JSON.parse(raw), mode: "" }))).toBeNull();
    expect(parsePanelStateSnapshot(JSON.stringify({ ...JSON.parse(raw), valence: 2 }))).toBeNull();
    const { energy: _removed, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    expect(parsePanelStateSnapshot(JSON.stringify(rest))).toBeNull();
  });
});

describe("写读与过期", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "panel-snap-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("路径在 data/ 下，写进去能读回来", () => {
    const path = panelStateSnapshotPath(dir, "assistant");
    expect(path).toBe(join(dir, "panel-assistant.json"));
    const snap = buildPanelStateSnapshot(source(), NOW);
    expect(writePanelStateSnapshotFile(path, snap)).toBe(true);
    expect(readPanelStateSnapshotFile(path, { nowMs: NOW + 1000 })).toEqual(snap);
  });

  it("过期就返回 null，让面板退回旧值而不是拿一份陈旧快照充数", () => {
    const path = panelStateSnapshotPath(dir, "assistant");
    writePanelStateSnapshotFile(path, buildPanelStateSnapshot(source(), NOW));
    expect(readPanelStateSnapshotFile(path, { nowMs: NOW + PANEL_SNAPSHOT_MAX_AGE_MS + 1 })).toBeNull();
    expect(readPanelStateSnapshotFile(path, { nowMs: NOW + 1000 })).not.toBeNull();
  });

  it("文件不存在/内容坏/写失败都不抛", () => {
    const path = panelStateSnapshotPath(dir, "assistant");
    expect(readPanelStateSnapshotFile(path, { nowMs: NOW })).toBeNull();
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    expect(readPanelStateSnapshotFile(path, { nowMs: NOW })).toBeNull();
    expect(() => readPanelStateSnapshotFile(path, { nowMs: Number.NaN })).toThrow(RangeError);
    // 目标路径是个目录 → 原子写的 rename 失败，但不抛，只返回 false
    const blocked = join(dir, "blocked.json");
    mkdirSync(blocked, { recursive: true });
    expect(writePanelStateSnapshotFile(blocked, buildPanelStateSnapshot(source(), NOW), () => {})).toBe(false);
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("装配锁：快照由唯一写者写、插件只读（F274）", () => {
  it("daemon 每拍写快照（F275 起下沉到 tick-hooks），且失败只记日志不打断拍", () => {
    const main = read("scripts/autonomy/main.mjs");
    // F301：入口只递依赖，副作用执行在装配层
    expect(main).toMatch(/tickHooks: \{[^}]*dataDir[^}]*characterId[^}]*runtime[^}]*drainQueue/);
    const wrapper = read("src/assembly/action-wrapper.ts");
    expect(wrapper).toMatch(/runTickHooks\(name, input\.tickHooks, input\.now\(\)\)/);
    const hooks = read("src/assembly/tick-hooks.ts");
    expect(hooks).toMatch(/writePanelStateSnapshotFile\(/);
    expect(hooks).toMatch(/buildPanelStateSnapshot\(/);
    expect(hooks).toMatch(/状态快照写入失败（不影响这一拍）/);
  });

  it("插件读快照并把它作为第四个参数传给 panelPayload（F295 后由装配点组装）", () => {
    // F277 把 HTTP 细节搬到 plugin/web/handlers.ts；F295 又把面板数据层搬到 assembly，
    // 端点只收 buildPayload——所以这里锁的是"装配点把三样事实合成一页"。
    const plugin = read("src/plugin/index.ts");
    expect(plugin).toMatch(/readPanelStateSnapshotFile\(panelStateSnapshotPath\(conf\.dataDir, conf\.characterId\), \{ nowMs \}\)/);
    expect(plugin).toMatch(/readPanelFacts\(\{ dataDir: conf\.dataDir, characterId: conf\.characterId, nowMs \}\)/);
    expect(plugin).toMatch(/panelPayload\(runtime, conf, facts, fresh\)/);
    const handlers = read("src/plugin/web/handlers.ts");
    expect(handlers).toContain("buildPayload: () => unknown");
  });
});
