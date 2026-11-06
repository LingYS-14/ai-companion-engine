import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  lastContactMinutes,
  readSituationSignals,
  type SituationSignalDeps,
} from "../src/assembly/situation-signals.js";

/**
 * F291：外部事实收集从入口搬到装配层。
 *
 * 这些用例锁的是「读文件时的降级语义」——她安静的时候，最怕系统把"没读到"
 * 悄悄变成"他不在/刚聊过"。所以：读不到 → null/0，不猜；DSH 手工信号优先于键鼠事实。
 */

const DIR = mkdtempSync(join(tmpdir(), "signals-"));
const CHARACTER = "assistant";
const REPO = join(DIR, "repo");
const TZ = 480; // 东八区

const NOW = Date.UTC(2026, 10, 1, 2, 30, 0); // 本地 10:30

function deps(overrides: Partial<SituationSignalDeps> = {}): SituationSignalDeps {
  return {
    dataDir: DIR,
    characterId: CHARACTER,
    repo: REPO,
    nowMs: NOW,
    tzOffsetMinutes: TZ,
    probeInput: () => null,
    ...overrides,
  };
}

function writeQq(extra: Record<string, unknown>): void {
  writeFileSync(join(DIR, `qq-${CHARACTER}.json`), JSON.stringify({ lastContactAt: NOW - 10 * 60_000, ...extra }));
}

function writePresence(dir: string, value: unknown): void {
  writeFileSync(join(dir, `presence-${CHARACTER}.json`), JSON.stringify(value));
}

describe("装配层的外部事实（F291）", () => {
  it("什么都没有：不猜——接触 0 分钟、没有在场信号、没有键鼠事实", () => {
    const s = readSituationSignals(deps({ dataDir: mkdtempSync(join(tmpdir(), "empty-")) }));
    expect(s.sinceLastContactMin).toBe(0);
    expect(s.proactiveSinceLastContact).toBe(0);
    expect(s.presence).toBeNull();
    expect(s.inputActivity).toBeNull();
    expect(s.lastProactiveAtMs).toBeNull();
    expect(s.minutesSinceLastProactive).toBeNull();
    expect(s.lastPeerEventAtMs).toBeNull();
    expect(s.sinceLastPeerMsgMin).toBeNull();
    expect(s.proactiveSinceLastPeerEvent).toBe(0);
  });

  it("QQ 状态：真实来往时间 + 上次联系后的主动次数（只数晚于上次联系的）", () => {
    const dir = mkdtempSync(join(tmpdir(), "qq-"));
    const d = deps({ dataDir: dir });
    writeFileSync(
      join(dir, `qq-${CHARACTER}.json`),
      JSON.stringify({
        onebotLastEventAt: NOW - 10 * 60_000,
        lastReplyAt: NOW - 12 * 60_000,
        lastProactiveAt: NOW - 30 * 60_000,
        proactiveAt: [NOW - 40 * 60_000, NOW - 5 * 60_000, NOW - 2 * 60_000],
      }),
    );
    const s = readSituationSignals(d);
    expect(s.sinceLastContactMin).toBe(10);
    expect(s.proactiveSinceLastContact).toBe(2);
    expect(s.minutesSinceLastProactive).toBe(30);
  });

  it("peer-only：他上一次说话 ≠ 她刚回复的那一秒（监督者 blocking 的回归锁）", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-"));
    const d = deps({ dataDir: dir });
    writeFileSync(
      join(dir, `qq-${CHARACTER}.json`),
      JSON.stringify({
        // 他 30 分钟前说的；她 6 分钟前回了一句 → 来往时间被回复刷新，但他说话时间不变
        onebotLastEventAt: NOW - 30 * 60_000,
        lastReplyAt: NOW - 6 * 60_000,
        lastProactiveAt: NOW - 5 * 60_000,
        proactiveAt: [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000],
      }),
    );
    const s = readSituationSignals(d);
    // 来往口径（含她的回复）：6 分钟
    expect(s.sinceLastContactMin).toBe(6);
    expect(s.proactiveSinceLastContact).toBe(1);
    // peer-only 口径（只算他发来的消息）：30 分钟，且这之后她主动说了 3 句
    expect(s.lastPeerEventAtMs).toBe(NOW - 30 * 60_000);
    expect(s.sinceLastPeerMsgMin).toBe(30);
    expect(s.proactiveSinceLastPeerEvent).toBe(3);
  });

  it("peer-only：没有他的消息记录时给 null/0，不拿心跳或她的回复冒充", () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-empty-"));
    writeFileSync(
      join(dir, `qq-${CHARACTER}.json`),
      JSON.stringify({ lastReplyAt: NOW - 3 * 60_000, proactiveAt: [NOW - 60_000] }),
    );
    writeFileSync(join(dir, `state-${CHARACTER}.json`), JSON.stringify({ updatedAt: NOW - 60_000 }));
    const s = readSituationSignals(deps({ dataDir: dir }));
    expect(s.sinceLastPeerMsgMin).toBeNull();
    expect(s.lastPeerEventAtMs).toBeNull();
    // 没有基准时间时按 0 计：她主动说过的话仍算"没被回应"
    expect(s.proactiveSinceLastPeerEvent).toBe(1);
  });

  it("DSH 侧在场信号新鲜时优先于键鼠事实", () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"));
    const d = deps({ dataDir: dir, probeInput: () => ({ idleSeconds: 600, atMs: NOW }) });
    writePresence(dir, { atMs: NOW - 30_000, active: true, ttlMs: 300_000 });
    const s = readSituationSignals(d);
    expect(s.presence?.active).toBe(true);
  });

  it("DSH 信号缺失时退到键鼠事实（10 分钟没输入 → 不在）", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const d = deps({ dataDir: dir, probeInput: () => ({ idleSeconds: 660, atMs: NOW }) });
    const s = readSituationSignals(d);
    expect(s.presence?.active).toBe(false);
    expect(s.inputActivity?.idleSeconds).toBe(660);
  });

  it("在场文件形状坏了：当不知道，不用坏数据下判断", () => {
    const dir = mkdtempSync(join(tmpdir(), "bad-"));
    const d = deps({ dataDir: dir, probeInput: () => null });
    writePresence(dir, { active: "yes" });
    const s = readSituationSignals(d);
    expect(s.presence).toBeNull();
  });

  it("本地小时按传进来的时区算（同一时刻东八区 ≠ UTC）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tz-"));
    const shanghai = readSituationSignals(deps({ dataDir: dir, tzOffsetMinutes: 480 }));
    const utc = readSituationSignals(deps({ dataDir: dir, tzOffsetMinutes: 0 }));
    expect(shanghai.localHour).toBe(10);
    expect(utc.localHour).toBe(2);
  });

  it("QQ 文件读不到时退回心跳文件算接触时间", () => {
    const dir = mkdtempSync(join(tmpdir(), "beat-"));
    writeFileSync(join(dir, `state-${CHARACTER}.json`), JSON.stringify({ updatedAt: NOW - 7 * 60_000 }));
    expect(lastContactMinutes({ dataDir: dir, characterId: CHARACTER, nowMs: NOW })).toBe(7);
  });

  it("QQ 状态里的接触时间坏掉时退回心跳，而不是当成「刚聊过」", () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    writeFileSync(join(dir, `qq-${CHARACTER}.json`), JSON.stringify({ lastContactAt: "yesterday" }));
    writeFileSync(join(dir, `state-${CHARACTER}.json`), JSON.stringify({ updatedAt: NOW - 25 * 60_000 }));
    expect(lastContactMinutes({ dataDir: dir, characterId: CHARACTER, nowMs: NOW })).toBe(25);
  });
});
