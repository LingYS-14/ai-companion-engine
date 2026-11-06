import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installLifecycle, SHUTDOWN_SIGNALS } from "../src/assembly/lifecycle.js";

/**
 * F293：常驻进程的生命周期（写 pid、收信号、按顺序停、落盘、退出）。
 *
 * 原实现埋在 `main()` 里，只能靠真进程 + 真信号测。这里用注入的 exit/now 与临时目录，
 * 把「顺序、幂等、出错也要退」三条行为钉住——这三条错一条都会留下"看起来活着、其实死了"
 * 或者"死了但 pid 文件还在"的状态，而两种都会骗过 health。
 */

const dirs: string[] = [];
const disposers: Array<() => void> = [];

function tempPidPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ase-assembly-lifecycle-"));
  dirs.push(dir);
  return join(dir, "autonomy-assistant.pid");
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readPid(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("常驻进程生命周期（F293）", () => {
  it("装上时写 pid 文件，字段与旧实现一致", () => {
    const pidPath = tempPidPath();
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 4242,
      now: () => 1_800_000_000_000,
      log: () => undefined,
      stopLoop: () => undefined,
      flush: () => undefined,
      exit: () => undefined,
    });
    disposers.push(life.dispose);
    expect(readPid(pidPath)).toEqual({ pid: 4242, startedAt: 1_800_000_000_000, characterId: "assistant" });
    expect(life.closed()).toBe(false);
  });

  it("退出顺序：停循环 → 停桥 → 关通道 → flush → 写 stoppedAt 文件", () => {
    const pidPath = tempPidPath();
    const calls: string[] = [];
    const exits: number[] = [];
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 7,
      now: () => Date.now(),
      log: () => undefined,
      stopLoop: () => calls.push("loop"),
      stopQq: () => calls.push("qq"),
      closeChannel: () => {
        calls.push("channel");
      },
      flush: () => calls.push("flush"),
      exit: (code) => exits.push(code),
    });
    disposers.push(life.dispose);
    life.shutdown("SIGTERM");
    expect(calls).toEqual(["loop", "qq", "channel", "flush"]);
    expect(exits).toEqual([0]);
    expect(life.closed()).toBe(true);
    expect(readPid(pidPath)).toMatchObject({ pid: 7, characterId: "assistant" });
    expect(typeof readPid(pidPath)["stoppedAt"]).toBe("number");
  });

  it("重复收到信号只走一次（SIGINT 后又 SIGTERM 很常见）", () => {
    const pidPath = tempPidPath();
    let flushes = 0;
    const exits: number[] = [];
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 7,
      now: () => Date.now(),
      log: () => undefined,
      stopLoop: () => undefined,
      flush: () => {
        flushes += 1;
      },
      exit: (code) => exits.push(code),
    });
    disposers.push(life.dispose);
    life.shutdown("SIGINT");
    life.shutdown("SIGTERM");
    expect(flushes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("flush 抛错：记一行「关机保护失败」，但仍写 stoppedAt 并退出（避免僵尸 pid）", () => {
    const pidPath = tempPidPath();
    const logs: string[] = [];
    const exits: number[] = [];
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 7,
      now: () => Date.now(),
      log: (line) => logs.push(line),
      stopLoop: () => undefined,
      flush: () => {
        throw new Error("磁盘满了");
      },
      exit: (code) => exits.push(code),
    });
    disposers.push(life.dispose);
    life.shutdown("SIGTERM");
    expect(logs.join("\n")).toContain("关机保护失败：磁盘满了");
    expect(exits).toEqual([0]);
    expect(typeof readPid(pidPath)["stoppedAt"]).toBe("number");
  });

  it("cleanup 在退出时被调用（清 keepAlive 定时器），且只调一次", () => {
    const pidPath = tempPidPath();
    let cleanups = 0;
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 7,
      now: () => Date.now(),
      log: () => undefined,
      stopLoop: () => undefined,
      flush: () => undefined,
      exit: () => undefined,
      cleanup: () => {
        cleanups += 1;
      },
    });
    disposers.push(life.dispose);
    life.shutdown("stop-file");
    life.shutdown("SIGTERM");
    expect(cleanups).toBe(1);
  });

  it("装的时候挂满三个信号；dispose 后监听数回到原样", () => {
    const pidPath = tempPidPath();
    const before = Object.fromEntries(SHUTDOWN_SIGNALS.map((sig) => [sig, process.listenerCount(sig)]));
    const life = installLifecycle({
      pidPath,
      characterId: "assistant",
      pid: 7,
      now: () => Date.now(),
      log: () => undefined,
      stopLoop: () => undefined,
      flush: () => undefined,
      exit: () => undefined,
    });
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(process.listenerCount(sig)).toBe((before[sig] ?? 0) + 1);
    }
    life.dispose();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(process.listenerCount(sig)).toBe(before[sig] ?? 0);
    }
  });
});
