import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { autonomyAlive, autonomyOwnsLock, devWriteAuthorized, devWriteBlocked } from "../src/autonomy/readonly.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", `readonly-${process.pid}`);

function freshDir(tag: string): string {
  const dir = join(TMP, tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLock(dir: string, record: Record<string, unknown>): void {
  writeFileSync(join(dir, ".writer-lock"), JSON.stringify(record), "utf8");
}

const NOW = 1_793_000_000_000;

describe("开发面只读闸", () => {
  it("没有写锁也没有心跳时不拦", () => {
    const dir = freshDir("no-lock");
    expect(autonomyOwnsLock(dir, NOW)).toBe(false);
    expect(autonomyAlive(dir, "assistant", NOW)).toBe(false);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();
    expect(devWriteAuthorized(dir)).toBe(false);
  });

  it("自主进程持有新鲜写锁时拒绝写，并给出授权办法", () => {
    const dir = freshDir("autonomy");
    writeLock(dir, { pid: process.pid, owner: "autonomy", heartbeatAt: NOW - 1_000 });
    expect(autonomyOwnsLock(dir, NOW)).toBe(true);
    const blocked = devWriteBlocked(dir, "assistant", NOW);
    expect(blocked).toContain("只读");
    expect(blocked).toContain("dev-write.on");
  });

  it("授权文件存在时放行", () => {
    const dir = freshDir("authorized");
    writeLock(dir, { pid: process.pid, owner: "autonomy", heartbeatAt: NOW });
    writeFileSync(join(dir, "dev-write.on"), "", "utf8");
    expect(devWriteAuthorized(dir)).toBe(true);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();
  });

  it("无 version 的旧格式锁：心跳新鲜就 fail-closed，不让人写", () => {
    const dir = freshDir("legacy-lock");
    writeLock(dir, { pid: process.pid, owner: "host", heartbeatAt: NOW - 1_000, note: "QQ 桥接待中" });
    expect(autonomyOwnsLock(dir, NOW)).toBe(true);
    expect(devWriteBlocked(dir, "assistant", NOW)).toContain("只读");
  });

  it("心跳过期不拦（陈旧锁不该锁住人）", () => {
    const dir = freshDir("stale");
    writeLock(dir, { pid: process.pid, owner: "autonomy", heartbeatAt: NOW - 11 * 60_000 });
    expect(autonomyOwnsLock(dir, NOW)).toBe(false);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();
  });

  it("持有者进程已死也不拦", () => {
    const dir = freshDir("dead");
    writeLock(dir, { pid: 0, owner: "autonomy", heartbeatAt: NOW });
    expect(autonomyOwnsLock(dir, NOW)).toBe(false);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();
  });

  it("宿主持锁时也拦：同一份状态只给一个写者", () => {
    const dir = freshDir("host");
    writeLock(dir, { version: 2, pid: process.pid, owner: "host", heartbeatAt: NOW });
    expect(autonomyOwnsLock(dir, NOW)).toBe(true);
    expect(devWriteBlocked(dir, "assistant", NOW)).toContain("只读");
  });

  it("心跳新鲜时（锁已释放的间隙）也拒绝写", () => {
    const dir = freshDir("beat");
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: NOW - 5_000 }), "utf8");
    expect(autonomyAlive(dir, "assistant", NOW)).toBe(true);
    expect(devWriteBlocked(dir, "assistant", NOW)).toContain("只读");
  });

  it("心跳超时或进程已死时不拦", () => {
    const dir = freshDir("beat-stale");
    writeFileSync(join(dir, "autonomy-assistant.beat"), JSON.stringify({ pid: process.pid, at: NOW - 16 * 60_000 }), "utf8");
    expect(autonomyAlive(dir, "assistant", NOW)).toBe(false);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();

    const dead = freshDir("beat-dead");
    writeFileSync(join(dead, "autonomy-assistant.beat"), JSON.stringify({ pid: 0, at: NOW }), "utf8");
    expect(autonomyAlive(dead, "assistant", NOW)).toBe(false);
    expect(devWriteBlocked(dead, "assistant", NOW)).toBeNull();
  });

  it("锁文件坏掉按没有锁处理", () => {
    const dir = freshDir("broken");
    writeFileSync(join(dir, ".writer-lock"), "{not json", "utf8");
    expect(autonomyOwnsLock(dir, NOW)).toBe(false);
    expect(devWriteBlocked(dir, "assistant", NOW)).toBeNull();
  });
});
