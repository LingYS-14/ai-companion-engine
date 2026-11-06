import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireWriterLock, readWriterLock, releaseWriterLock } from "../src/autonomy/lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-lock-"));
  dirs.push(dir);
  return join(dir, ".writer-lock");
}
const NOW = 1_793_270_000_000;

describe("单写者锁", () => {
  it("没有锁时能拿到；同一进程重拿视为续心跳", () => {
    const path = file();
    const first = acquireWriterLock({ path, pid: 1234, owner: "host", now: NOW, staleMs: 60_000 });
    expect(first).not.toBeNull();
    const again = acquireWriterLock({ path, pid: 1234, owner: "host", now: NOW + 1000, staleMs: 60_000 });
    expect(again).not.toBeNull();
    expect(readWriterLock(path)?.heartbeatAt).toBe(NOW + 1000);
  });

  it("别的活进程持锁、心跳还新 → 拿不到（这一拍只能跳过）", () => {
    const path = file();
    // 父进程通常活着，用它模拟"另一个活着的进程"
    writeFileSync(path, JSON.stringify({ version: 2, pid: process.ppid, owner: "autonomy", heartbeatAt: NOW, note: "" }));
    expect(acquireWriterLock({ path, pid: process.pid, owner: "host", now: NOW + 1000, staleMs: 60_000 })).toBeNull();
  });

  it("心跳过期可以接管", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 2, pid: 1, owner: "autonomy", heartbeatAt: NOW, note: "" }));
    const got = acquireWriterLock({ path, pid: process.pid, owner: "host", now: NOW + 10 * 60_000, staleMs: 60_000 });
    expect(got?.owner).toBe("host");
  });

  it("持有者进程已经不在（被强杀）时，即使心跳很新也能接管", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ version: 2, pid: 999_999, owner: "autonomy", heartbeatAt: NOW, note: "" }));
    const got = acquireWriterLock({ path, pid: process.pid, owner: "host", now: NOW + 1000, staleMs: 60_000 });
    expect(got).not.toBeNull();
    expect(readWriterLock(path)?.pid).toBe(process.pid);
  });

  it("旧版锁（没有 version 字段）视为陈旧，可以直接接管", () => {
    const path = file();
    // 复现线上那一幕：宿主旧插件实例的长心跳定时器留下了无 version 的锁
    writeFileSync(path, JSON.stringify({ pid: process.ppid, owner: "host", heartbeatAt: NOW, note: "QQ 桥接待中" }));
    expect(readWriterLock(path)).toBeNull();
    const got = acquireWriterLock({ path, pid: process.pid, owner: "autonomy", now: NOW, staleMs: 60_000 });
    expect(got?.owner).toBe("autonomy");
  });

  it("释放后文件消失", () => {
    const path = file();
    const got = acquireWriterLock({ path, pid: process.pid, owner: "host", now: NOW, staleMs: 60_000 });
    expect(got).not.toBeNull();
    releaseWriterLock(got!);
    expect(readWriterLock(path)).toBeNull();
  });
});
