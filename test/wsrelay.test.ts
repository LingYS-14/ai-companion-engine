/**
 * WS 中继（`src/qq/wsrelay.ts`）的生命周期回归测试。
 *
 * 不起真子进程、不用真定时器：`spawn`/`setInterval`/`setTimeout` 都是注入的，
 * 所以"退出后 1s 退避重启"、"stop 之后不再重启"这种时间相关的性质可以当场断言。
 *
 * 钉住五件会坏事的地方：
 *   1. `stop()` 必须先把 400ms 轮询清掉再判状态（旧写法"已 stopped 就 return"
 *      会把定时器永久留在事件循环里，子进程死了还在空转）；
 *   2. 子进程退出后按 1s/2s/5s/15s/30s 退避重启，连续失败 5 次后放弃；
 *   3. `stop()` 先 SIGTERM，`RELAY_KILL_GRACE_MS` 后补 SIGKILL；子进程真退了就取消兜底；
 *   4. `stop()` 之后一律不再 spawn；
 *   5. 同一个 `outFile` 只有一个活实例：新实例启动前先收掉旧的（宿主热重载不跑
 *      disposer 时也不会累积成多个中继 → 多条 WS、入站事件重复）。
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RELAY_KILL_GRACE_MS,
  RELAY_REPLACED_LOG,
  relayBackoffMs,
  resolveRelayRuntime,
  startWsRelay,
  type RelayHandle,
  type RelayOptions,
} from "../src/qq/wsrelay.js";

type SpawnFn = typeof import("node:child_process").spawn;

interface FakeChild {
  readonly ee: EventEmitter;
  /** 假 pid：日志里"（pid=…）"的来源 */
  readonly pid: number;
  /** `kill()` 被调了几次（不论信号） */
  kills: number;
  /** 依次收到的信号（SIGTERM / SIGKILL） */
  signals: (string | undefined)[];
  /** 假进程的"活没活"：收到信号就当它退了 */
  alive: boolean;
}

/** 假 spawn：返回一个 EventEmitter 冒充子进程，手工 emit `spawn` / `error` / `exit` */
function fakeSpawn(): {
  children: FakeChild[];
  spawnFn: SpawnFn;
  /** 还活着的子进程数（apply→dispose→apply 之后必须只剩 1） */
  liveCount: () => number;
} {
  const children: FakeChild[] = [];
  const spawnFn = ((): ChildProcess => {
    const ee = new EventEmitter();
    const fake: FakeChild = { ee, pid: 9000 + children.length, kills: 0, signals: [], alive: true };
    // EventEmitter 冒充子进程：`on`/`emit` 本来就有，补上 stderr、pid 与 kill
    Object.assign(ee, {
      stderr: null,
      pid: fake.pid,
      kill: (signal?: string): boolean => {
        fake.kills += 1;
        fake.signals.push(signal);
        fake.alive = false;
        return true;
      },
    });
    children.push(fake);
    return ee as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { children, spawnFn, liveCount: () => children.filter((c) => c.alive).length };
}

/** 假定时器：interval 与 timeout 分开记账，能看"还剩几个"和"排了多长" */
function fakeTimers() {
  const intervals: { id: number; fn: () => void }[] = [];
  /** `ms` 用来区分"退避重启"和"SIGKILL 兜底"两档定时器 */
  const timeouts: { id: number; fn: () => void; ms: number }[] = [];
  /** 按顺序记下排过的每一档退避（被触发/取消也留着，用来断言 1s→…→30s 序列） */
  const retryHistory: number[] = [];
  let seq = 0;
  const isKillTimer = (item: { ms: number }): boolean => item.ms === RELAY_KILL_GRACE_MS;
  return {
    retryHistory,
    setIntervalFn: (fn: () => void, ms: number): unknown => {
      void ms;
      seq += 1;
      intervals.push({ id: seq, fn });
      return seq;
    },
    clearIntervalFn: (handle: unknown): void => {
      const index = intervals.findIndex((item) => item.id === handle);
      if (index >= 0) intervals.splice(index, 1);
    },
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      seq += 1;
      if (ms !== RELAY_KILL_GRACE_MS) retryHistory.push(ms);
      timeouts.push({ id: seq, fn, ms });
      return seq;
    },
    clearTimeoutFn: (handle: unknown): void => {
      const index = timeouts.findIndex((item) => item.id === handle);
      if (index >= 0) timeouts.splice(index, 1);
    },
    pendingIntervals: (): number => intervals.length,
    pendingTimeouts: (): number => timeouts.length,
    /** 排队中的退避重启各等了多长（不含 SIGKILL 兜底那一档） */
    retryDelays: (): number[] => timeouts.filter((item) => !isKillTimer(item)).map((item) => item.ms),
    /** 还有几个 SIGKILL 兜底没触发、也没被取消 */
    killTimers: (): number => timeouts.filter(isKillTimer).length,
    /** 走一次轮询 */
    tick: (): void => {
      for (const item of [...intervals]) item.fn();
    },
    /** 触发已排队的重启 */
    fireRetry: (): void => {
      const index = timeouts.findIndex((item) => !isKillTimer(item));
      if (index < 0) return;
      const [item] = timeouts.splice(index, 1);
      item?.fn();
    },
    /** 触发已排队的 SIGKILL 兜底 */
    fireKillTimer: (): void => {
      const index = timeouts.findIndex(isKillTimer);
      if (index < 0) return;
      const [item] = timeouts.splice(index, 1);
      item?.fn();
    },
  };
}

let dir = "";
let outFile = "";
let scriptPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-relay-"));
  outFile = join(dir, "onebot-relay.jsonl");
  // 现在的启动路径会先检查脚本在不在：stub 一个就够了（假 spawn 永远不会执行它）
  scriptPath = join(dir, "ws-relay.mjs");
  writeFileSync(scriptPath, "// stub\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(overrides: Partial<RelayOptions> = {}) {
  const t = fakeTimers();
  const s = fakeSpawn();
  const logs: string[] = [];
  const events: unknown[] = [];
  // 单次 relay() 还可以再覆盖一次（比如"新实例脚本缺失"要沿用同一个 outFile）
  const relay = (extra: Partial<RelayOptions> = {}): RelayHandle =>
    startWsRelay({
      scriptPath,
      wsUrl: "ws://127.0.0.1:3001",
      token: "tk",
      outFile,
      onEvent: (event) => {
        events.push(event);
      },
      spawnFn: s.spawnFn,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
      setTimeoutFn: t.setTimeoutFn,
      clearTimeoutFn: t.clearTimeoutFn,
      log: (line) => {
        logs.push(line);
      },
      ...overrides,
      ...extra,
    });
  return { t, s, logs, events, relay };
}

describe("WS 中继的生命周期", () => {
  it("stop() 清掉 400ms 轮询；重复 stop 不再重复 kill", () => {
    const h = harness();
    const handle = h.relay();
    expect(handle.state()).toBe("starting");
    expect(h.t.pendingIntervals()).toBe(1);

    handle.stop();
    expect(handle.state()).toBe("stopped");
    // 关键断言：定时器真的被清了（旧写法会把它留下）
    expect(h.t.pendingIntervals()).toBe(0);
    expect(h.s.children[0]?.kills).toBe(1);
    // 停子进程走的是 SIGTERM，SIGKILL 只是 1.5s 后的兜底
    expect(h.s.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(h.t.killTimers()).toBe(1);

    // 幂等：第二次 stop 什么都不做，也不排重启、不重复排兜底
    handle.stop();
    expect(h.s.children[0]?.kills).toBe(1);
    expect(h.t.pendingIntervals()).toBe(0);
    expect(h.t.killTimers()).toBe(1);
    expect(h.t.retryDelays()).toEqual([]);
  });

  it("轮询把 JSONL 里的 event 帧交给 onEvent；同一行不重复投递", () => {
    const h = harness();
    const handle = h.relay();
    const line = JSON.stringify({ kind: "event", data: JSON.stringify({ post_type: "message", n: 1 }) });
    writeFileSync(outFile, `${line}\n`, "utf8");

    h.t.tick();
    expect(h.events).toEqual([{ post_type: "message", n: 1 }]);
    // 没有新字节就不再投递
    h.t.tick();
    expect(h.events.length).toBe(1);

    handle.stop();
  });

  it("子进程退出后按 1s→2s→5s→15s→30s 退避重启", () => {
    const h = harness();
    const handle = h.relay();
    expect(h.s.children.length).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      h.s.children[i]?.ee.emit("exit", 1);
      expect(h.t.pendingTimeouts()).toBe(1);
      h.t.fireRetry();
      expect(h.s.children.length).toBe(i + 2);
    }
    expect(h.t.retryHistory).toEqual([1_000, 2_000, 5_000, 15_000, 30_000]);
    // 每次重启都重新起轮询，且始终只有一个
    expect(h.t.pendingIntervals()).toBe(1);

    // 纯函数口径：0/负数从 1s 起，越界按 30s 封顶
    expect(relayBackoffMs(0)).toBe(1_000);
    expect(relayBackoffMs(-2)).toBe(1_000);
    expect(relayBackoffMs(99)).toBe(30_000);

    // 真读到事件 = 中继活着，连续失败清零：下一次退出重新从 1s 起
    writeFileSync(outFile, `${JSON.stringify({ kind: "event", data: "{}" })}\n`, "utf8");
    h.t.tick();
    h.s.children[5]?.ee.emit("exit", 1);
    expect(h.t.retryHistory.at(-1)).toBe(1_000);

    handle.stop();
  });

  it("stop() 之后子进程退出也不再重启", () => {
    const h = harness();
    const handle = h.relay();
    handle.stop();

    h.s.children[0]?.ee.emit("exit", 1);
    expect(h.t.pendingTimeouts()).toBe(0);
    expect(h.t.retryDelays()).toEqual([]);
    expect(h.s.children.length).toBe(1);
    expect(handle.state()).toBe("stopped");
  });

  it("连续失败 5 次后放弃重启并记一条日志", () => {
    const h = harness();
    const handle = h.relay();
    for (let i = 0; i < 5; i += 1) {
      h.s.children[i]?.ee.emit("exit", 1);
      h.t.fireRetry();
    }
    expect(h.s.children.length).toBe(6);

    // 第 5 次重启后又挂：不再排下一轮，并留一条可查的放弃日志
    h.s.children[5]?.ee.emit("exit", 1);
    expect(h.t.pendingTimeouts()).toBe(0);
    expect(h.s.children.length).toBe(6);
    expect(handle.state()).toBe("stopped");
    expect(h.logs.some((line) => line.includes("[onebot] relay 放弃重启"))).toBe(true);
  });

  it("stop() 后 SIGTERM 没生效：RELAY_KILL_GRACE_MS 后兜底补 SIGKILL", () => {
    const h = harness();
    h.relay().stop();
    expect(h.s.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(h.t.killTimers()).toBe(1);

    // 子进程没退（没 emit exit）：走兜底定时器
    h.t.fireKillTimer();
    expect(h.s.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.t.killTimers()).toBe(0);
  });

  it("stop() 后子进程老实退出：取消 SIGKILL 兜底，也不再重启", () => {
    const h = harness();
    const handle = h.relay();
    handle.stop();
    expect(h.t.killTimers()).toBe(1);

    // 子进程真退了：兜底没必要再等，取消它，别对一个死进程再 kill 一次
    h.s.children[0]?.ee.emit("exit", null);
    expect(h.t.killTimers()).toBe(0);
    expect(h.s.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(h.t.pendingTimeouts()).toBe(0);
    expect(h.s.children.length).toBe(1);
  });
});

describe("WS 中继的单实例守卫", () => {
  it("同一 outFile 再 start：旧实例先被停掉，只剩一个活子进程", () => {
    const h = harness();
    const first = h.relay();
    expect(h.s.liveCount()).toBe(1);

    const second = h.relay();
    expect(h.s.children.length).toBe(2);
    expect(first.state()).toBe("stopped");
    expect(h.s.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(h.s.liveCount()).toBe(1);
    expect(second.state()).toBe("starting");
    // 旧实例的 400ms 轮询不能留下：只剩新实例那一个
    expect(h.t.pendingIntervals()).toBe(1);
    expect(h.logs.filter((line) => line === RELAY_REPLACED_LOG)).toHaveLength(1);

    second.stop();
  });

  it("apply→dispose→apply（宿主正常卸载）：不重复停旧实例，也不多打日志", () => {
    const h = harness();
    const first = h.relay();
    first.stop(); // dispose 跑了：旧实例已经 stopped
    const second = h.relay();

    expect(h.s.children.length).toBe(2);
    expect(first.state()).toBe("stopped");
    expect(h.s.children[0]?.kills).toBe(1);
    expect(h.s.liveCount()).toBe(1);
    expect(h.t.pendingIntervals()).toBe(1);
    // 已经停过的旧实例不该再走一遍"重启"清理，也不打让人误会的日志
    expect(h.logs.filter((line) => line === RELAY_REPLACED_LOG)).toEqual([]);

    second.stop();
  });

  it("dispose 没跑到（热重载泄漏）：下一次 apply 顶掉旧实例，仍然只剩一个", () => {
    const h = harness();
    h.relay(); // apply #1，宿主没跑 disposer
    h.relay(); // apply #2
    h.relay(); // apply #3

    expect(h.s.children.length).toBe(3);
    // 这是"4 个 ws-relay 进程"的复现口径：不管 apply 几次，活着的只能有一个
    expect(h.s.liveCount()).toBe(1);
    expect(h.t.pendingIntervals()).toBe(1);
    // 被顶掉的旧实例只排了 SIGKILL 兜底，不会排重启（否则会再长出新中继）
    expect(h.t.retryDelays()).toEqual([]);
    expect(h.logs.filter((line) => line === RELAY_REPLACED_LOG)).toHaveLength(2);
  });
});

describe("退出留痕：不再出现『已启动后凭空消失』", () => {
  it("stop() 之后子进程才退出：仍写一条带 code/signal/pid 的日志，且不再重启", () => {
    const h = harness();
    const handle = h.relay();
    // 旧代码在这里静默 return：日志停在"已启动"，看起来就像子进程蒸发了
    handle.stop("宿主卸载（回归测试）");
    h.s.children[0]?.ee.emit("exit", 0, "SIGTERM");

    const exitLine = h.logs.find((line) => line.includes("relay 退出"));
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain("code=0");
    expect(exitLine).toContain("signal=SIGTERM");
    expect(exitLine).toContain("pid=9000");
    expect(exitLine).toContain("已停止，不再重启");
    // 正常卸载不是故障：不排重启
    expect(h.t.retryDelays()).toEqual([]);
    expect(h.t.pendingTimeouts()).toBe(0);
  });

  it("没 stop 就退出：日志照样有 code/signal/pid，并进入退避重启", () => {
    const h = harness();
    const handle = h.relay();
    h.s.children[0]?.ee.emit("exit", 1, null);

    const exitLine = h.logs.find((line) => line.includes("relay 退出"));
    expect(exitLine).toContain("code=1");
    expect(exitLine).toContain("signal=none");
    expect(exitLine).toContain("pid=9000");
    expect(h.t.retryDelays()).toEqual([1_000]);
    handle.stop();
  });

  it("启动前先记一条『用哪个 node』，启动后记 pid", () => {
    const h = harness();
    const handle = h.relay();
    expect(h.logs.some((line) => line.includes("relay 启动器="))).toBe(true);
    h.s.children[0]?.ee.emit("spawn");
    expect(h.logs.some((line) => line.includes("relay 子进程已启动") && line.includes("pid=9000"))).toBe(true);
    handle.stop();
  });
});

describe("stop() 的所有权：只收拾自己登记的那个子进程", () => {
  it("被新实例顶掉的旧 handle 再 stop：不 kill 新子进程、不删新实例的 JSONL", () => {
    const h = harness();
    const first = h.relay();
    const second = h.relay(); // 顶掉 first：first 被 stop，second 成为登记实例
    expect(h.s.children[1]?.kills).toBe(0);

    // 宿主晚到的 disposer 又对旧 handle 调了一次 stop
    writeFileSync(outFile, `${JSON.stringify({ kind: "event", data: "{}" })}\n`, "utf8");
    first.stop("宿主晚到的 disposer");
    expect(h.s.children[1]?.kills).toBe(0);
    // 新实例正在写的文件不能被旧 handle 顺手 unlink
    expect(existsSync(outFile)).toBe(true);
    expect(second.state()).toBe("starting");

    second.stop();
  });

  it("中继脚本不存在：不 spawn、不排重启，日志直指安装不完整", () => {
    const h = harness({ scriptPath: join(dir, "missing-relay.mjs") });
    const handle = h.relay();

    expect(h.s.children.length).toBe(0);
    expect(handle.state()).toBe("stopped");
    expect(h.logs.some((line) => line.includes("relay 脚本不存在") && line.includes("missing-relay.mjs"))).toBe(true);
    expect(h.t.pendingIntervals()).toBe(0);
    expect(h.t.pendingTimeouts()).toBe(0);
  });

  it("新实例脚本缺失：不动已在工作的旧中继（别把唯一活着的杀了）", () => {
    const h = harness();
    const first = h.relay();
    const second = h.relay({ scriptPath: join(dir, "missing-relay.mjs") });

    expect(second.state()).toBe("stopped");
    // 旧子进程没被 kill，旧实例的轮询也还在
    expect(h.s.children.length).toBe(1);
    expect(h.s.children[0]?.kills).toBe(0);
    expect(first.state()).toBe("starting");
    expect(h.t.pendingIntervals()).toBe(1);
    first.stop();
  });

  it("stop() 抢在 spawn 事件之前：状态不会被再翻回 running", () => {
    const h = harness();
    const handle = h.relay();
    handle.stop();
    h.s.children[0]?.ee.emit("spawn");

    expect(handle.state()).toBe("stopped");
    expect(h.logs.some((line) => line.includes("relay 子进程已启动"))).toBe(false);
  });

  it("子进程自报 pid 的 start 记录会写成『已就绪』日志", () => {
    const h = harness();
    const handle = h.relay();
    writeFileSync(outFile, `${JSON.stringify({ kind: "relay", at: "start", pid: 4321 })}\n`, "utf8");
    h.t.tick();

    expect(h.logs.some((line) => line.includes("relay 子进程已就绪") && line.includes("pid=4321"))).toBe(true);
    handle.stop();
  });
});

describe("resolveRelayRuntime：不依赖 PATH 里恰好有 node", () => {
  it("显式 execPath 优先于 ACE_NODE_EXEC", () => {
    const runtime = resolveRelayRuntime("/opt/node", { ACE_NODE_EXEC: "/other/node" });
    expect(runtime.execPath).toBe("/opt/node");
    expect(runtime.viaElectron).toBe(false);
  });

  it("没有显式值时用 ACE_NODE_EXEC", () => {
    expect(resolveRelayRuntime(undefined, { ACE_NODE_EXEC: "/other/node" }).execPath).toBe("/other/node");
  });

  it("非 Electron（vitest）默认用 process.execPath 本体，不需要 ELECTRON_RUN_AS_NODE", () => {
    expect(process.versions["electron"]).toBeUndefined();
    const runtime = resolveRelayRuntime(undefined, {});
    expect(runtime.execPath).toBe(process.execPath);
    expect(runtime.viaElectron).toBe(false);
    expect(runtime.env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
  });
});
