/**
 * 常驻进程的生命周期接线（装配层，F293）。
 *
 * 入口原来自己管这些：写 pid 文件、收信号、按顺序停循环/桥/写通道、flush、把 pid 文件改成
 * `stoppedAt`、退出。放在 `main()` 里有两个问题——不能单测（要真进程、真信号），而且入口继续变厚。
 *
 * 这里只编排顺序；真正的停止动作由调用方注入。两个行为细节保留原样：
 * 1. **幂等**：重复收到信号只走一次（SIGINT 后又来 SIGTERM 很常见）；
 * 2. **出错也要退**：flush 抛错只记日志，pid 文件仍改成 stoppedAt 再 `exit(0)`，否则会留下"僵尸 pid"。
 */

import { writeFileSync } from "node:fs";

/** Node 里能收到的终止信号（Windows 上主要是 SIGINT/SIGBREAK，SIGTERM 来自 stop.ps1）。 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

export interface LifecycleHooks {
  /** 每收到一次信号/退出请求时都会调用一次（日志用） */
  readonly log: (line: string) => void;
  /** 停掉自主循环 */
  readonly stopLoop: () => void;
  /** 停掉 QQ 桥（没有就不传） */
  readonly stopQq?: () => void;
  /** 关写通道（异步，不等待；原实现就是 `void close()`） */
  readonly closeChannel?: () => void | Promise<void>;
  /** 落盘状态 */
  readonly flush: () => void;
  /** 进程退出（注入便于测试；默认 `process.exit`） */
  readonly exit?: (code: number) => void;
}

export interface InstallLifecycleInput extends LifecycleHooks {
  readonly pidPath: string;
  readonly characterId: string;
  readonly pid: number;
  readonly now: () => number;
  /** 额外清理：比如清掉 keepAlive 定时器 */
  readonly cleanup?: () => void;
}

export interface LifecycleHandle {
  /** 手动触发一次退出流程（stop 文件、测试都用它） */
  shutdown(reason: string): void;
  /** 是否已经走过退出流程 */
  closed(): boolean;
  /** 摘掉信号监听（测试与"进程内重启"用） */
  dispose(): void;
}

function writePidFile(pidPath: string, payload: Record<string, unknown>): void {
  writeFileSync(pidPath, `${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * 写 pid 文件并挂上信号处理，返回一个可手动关闭的句柄。
 *
 * 注意：调用前主循环应已创建好；本函数只负责"启动后的善后"，不负责启动循环。
 */
export function installLifecycle(input: InstallLifecycleInput): LifecycleHandle {
  const exit = input.exit ?? ((code: number) => process.exit(code));
  writePidFile(input.pidPath, { pid: input.pid, startedAt: input.now(), characterId: input.characterId });

  let stopping = false;
  const listeners: Array<{ signal: string; handler: () => void }> = [];

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    input.log(`[autonomy] 收到 ${reason}：flush 状态并释放锁`);
    try {
      input.stopLoop();
      input.stopQq?.();
      const closed = input.closeChannel?.();
      // 原实现就是"关通道不等待"；这里保持，但把 rejected promise 吞掉，避免 unhandledRejection
      if (closed !== undefined && typeof (closed as Promise<void>).catch === "function") {
        (closed as Promise<void>).catch(() => undefined);
      }
      input.flush();
    } catch (err) {
      input.log(`[autonomy] 关机保护失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        writePidFile(input.pidPath, { pid: input.pid, stoppedAt: input.now(), characterId: input.characterId });
      } catch {
        // 忽略：进程都要退了
      }
      input.cleanup?.();
      exit(0);
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      input.cleanup?.();
      shutdown(signal);
    };
    listeners.push({ signal, handler });
    process.on(signal, handler);
  }

  return {
    shutdown,
    closed: () => stopping,
    dispose: () => {
      for (const { signal, handler } of listeners) process.off(signal, handler);
      listeners.length = 0;
    },
  };
}
