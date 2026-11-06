/**
 * OneBot WS 中继的宿主侧：Electron 主进程里的全局 WebSocket 已被宿主改写（连接必 TypeError），
 * 所以 WS 交给一个独立的 node 子进程（scripts/ws-relay.mjs），子进程把事件按行写 JSONL，
 * 这里轮询读文件并回调 onEvent。HTTP 发送仍走宿主 fetch（实测 200）。
 *
 * 生命周期（这里踩过坑，改动前先读）：
 *   - 子进程退出后按 1s/2s/5s/15s/30s 退避重启（`RELAY_BACKOFF_MS`），连续失败 5 次后放弃；
 *   - `stop()` 之后**不再**重启，而且定时器无条件先清——否则"已经 stopped 就直接 return"
 *     会把 400ms 轮询永久留在事件循环里，子进程死了还在跑；
 *   - **退出必须留痕**：`handleGone` 在 `stopped` 时也要写一行退出日志（带 pid/code/signal）。
 *     旧写法在这里静默 return，日志里就只剩"已启动"，看起来像子进程启动后凭空消失；
 *     实际排查时这行缺失正是把"中继一直活着"误判成"很快没了"的原因。启动了记 pid、
 *     停止了记原因、退出了记 code/signal——三层都要有。
 *   - `stop()` 先 SIGTERM，`RELAY_KILL_GRACE_MS` 内还没退出就补 SIGKILL（兜底：子进程
 *     不理信号时不留孤儿）；**只 kill 自己登记着的 child**：被同 outFile 的新实例顶掉的
 *     旧 handle 只退登记，不 kill、也不删新实例正在写的 JSONL；
 *   - 同一个 `outFile` 同时只允许一个中继（模块级 `liveRelays`）：新实例启动前先停掉
 *     旧实例。`ctx.effect` 的 disposer 是"正常卸载"路径，热重载/apply 重入时它不一定
 *     跑到；只靠它就会出现"旧子进程没死、新 apply 又起一个"的累积（多条 WS、入站事件重复）。
 *
 * 用哪个 node（`resolveRelayRuntime`）：显式 execPath → ACE_NODE_EXEC → 非 Electron 的
 * `process.execPath` → PATH 里的 node(.exe) → Electron 本体 + ELECTRON_RUN_AS_NODE=1。
 * 不能只 `spawn("node")`：宿主是 Electron，PATH 里不一定有 node。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface RelayOptions {
  readonly scriptPath: string;
  readonly wsUrl: string;
  readonly token: string;
  readonly outFile: string;
  readonly onEvent: (event: unknown) => void;
  readonly log?: (line: string) => void;
  readonly execPath?: string;
  readonly intervalMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** 注入点：默认 `spawn`；测试换掉它就不会真起子进程 */
  readonly spawnFn?: typeof spawn;
  /** 注入点：默认 `setInterval`；轮询读文件全走它 */
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
  /** 注入点：默认 `setTimeout`；退出后的退避重启全走它 */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

export interface RelayHandle {
  state(): "starting" | "running" | "stopped";
  /**
   * 停止中继：清定时器、退登记、SIGTERM（grace 后 SIGKILL 兜底）、删输出文件。
   * `reason` 只进日志（"宿主卸载"/"同 outFile 的新实例启动"），事后对着日志能看出
   * 每次"已启动"是被谁收掉的。只对**自己登记着的** child 动手。
   */
  stop(reason?: string): void;
}

export interface RelayChunk {
  readonly offset: number;
  readonly lines: readonly string[];
}

/** 从 offset 起读新增字节，按行切分；返回新 offset 与完整行（末行不完整时保留 offset 不动） */
export function drainLines(path: string, offset: number): RelayChunk {
  if (!existsSync(path)) return { offset, lines: [] };
  const size = statSync(path).size;
  if (size < offset) offset = 0; // 文件被重建
  if (size === offset) return { offset, lines: [] };
  const length = size - offset;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const cut = text.lastIndexOf("\n");
  if (cut === -1) return { offset, lines: [] };
  const complete = text.slice(0, cut + 1);
  const lines = complete.split("\n").filter((l) => l.trim() !== "");
  return { offset: offset + Buffer.byteLength(complete, "utf8"), lines };
}

/** 轮询间隔：400ms 足够快，又不至于把事件循环打满 */
export const RELAY_INTERVAL_MS = 400;
/**
 * 子进程退出后的重启退避（1s → 2s → 5s → 15s → 30s，最后一档封顶）。
 * 数组长度就是"连续失败几次后放弃"的次数。
 */
export const RELAY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];

/** 第 `attempt` 次重启要等多久（attempt 从 0 开始；越界按最后一档封顶，负数按第一档） */
export function relayBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), RELAY_BACKOFF_MS.length - 1);
  return RELAY_BACKOFF_MS[index] ?? 30_000;
}

/** 中继子进程的运行环境：用哪个可执行文件 + 需要附加的环境变量 */
export interface RelayRuntime {
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** true = 借用 Electron 本体以 ELECTRON_RUN_AS_NODE=1 跑 node（宿主 PATH 里没有 node 时的兜底） */
  readonly viaElectron: boolean;
}

/** 环境变量名在 Windows 上大小写不敏感，对象键却敏感：按不敏感方式取一个非空值 */
function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined && direct !== "") return direct;
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === lower && value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** 在 PATH 里找 node 可执行文件；找不到返回 null（不抛） */
function findNodeOnPath(env: NodeJS.ProcessEnv): string | null {
  const pathValue = readEnv(env, "PATH");
  if (pathValue === undefined) return null;
  // Windows 上 spawn 只认 .exe（.cmd/.bat 要 shell:true，反而多一层转义与安全问题）
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of pathValue.split(delimiter)) {
    // Windows 的 PATH 项可能是带引号的（"C:\Program Files\nodejs"）
    const clean = dir.trim().replace(/^"(.*)"$/u, "$1");
    if (clean === "") continue;
    for (const name of names) {
      const candidate = join(clean, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* 不可读的 PATH 项跳过 */
      }
    }
  }
  return null;
}

/**
 * 挑一个能跑 `ws-relay.mjs` 的 node。
 *
 * 旧实现直接 `spawn("node")`：宿主自己是 Electron 进程，只保证自己活着，不保证 PATH 里
 * 有 node；PATH 里没有时子进程起不来，日志只剩一句"启动失败"，很难看出是找不到 node。
 * 现在的顺序：显式 execPath → `ACE_NODE_EXEC` → 非 Electron 的 `process.execPath`
 * （就是 node 本体）→ PATH 里的 node(.exe) → Electron 本体 + `ELECTRON_RUN_AS_NODE=1`
 * （不依赖 PATH，也不依赖另装 node）。日志里只报路径，不报 env / token。
 */
export function resolveRelayRuntime(explicit?: string, injectedEnv?: NodeJS.ProcessEnv): RelayRuntime {
  const env: NodeJS.ProcessEnv = { ...(injectedEnv ?? process.env) };
  if (explicit !== undefined && explicit !== "") return { execPath: explicit, env, viaElectron: false };
  const override = readEnv(env, "ACE_NODE_EXEC");
  if (override !== undefined) return { execPath: override, env, viaElectron: false };
  // 非 Electron（node 直接跑、vitest）：process.execPath 就是 node 本体，最稳
  if (process.versions["electron"] === undefined) return { execPath: process.execPath, env, viaElectron: false };
  const onPath = findNodeOnPath(env);
  if (onPath !== null) return { execPath: onPath, env, viaElectron: false };
  // 兜底：Electron 本体就是 node（ELECTRON_RUN_AS_NODE=1），不依赖 PATH
  const withFlag: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  return { execPath: process.execPath, env: withFlag, viaElectron: true };
}

/** 日志里的 `（pid=123）`：没拿到 pid（spawn 还没回来）就什么都不加 */
function pidLabel(pid: number | undefined): string {
  return pid === undefined ? "" : `（pid=${String(pid)}）`;
}

/**
 * SIGTERM 之后等多久补 SIGKILL。
 * Windows 上 `kill()` 就是 TerminateProcess，这一档基本用不到；它是 POSIX 的兜底，
 * 以及"宿主/权限让 SIGTERM 没生效"这种极端情况的最后一道。
 */
export const RELAY_KILL_GRACE_MS = 1_500;

/** 同 outFile 的新实例顶掉旧实例时打的那行日志（排查"为什么还有旧中继"的锚点） */
export const RELAY_REPLACED_LOG = "[onebot] relay 旧实例已停止（重启）";

/**
 * 活着的实例，按 outFile 记账 —— 单实例守卫的数据源。
 *
 * 为什么要模块级：`ctx.effect` 的 disposer 只在宿主正常卸载时跑；热重载 / apply
 * 重入时旧实例可能没人 stop（这正是"热重载 4 次、4 个 ws-relay 子进程"的由来）。
 * 这里记一笔，新实例启动前先把旧的收掉，把"依赖宿主清理"换成"自己保证同一 outFile
 * 只有一个子进程"。模块级而不是 startWsRelay 内部：守卫要跨实例生效。
 */
const liveRelays = new Map<string, RelayHandle>();

export function startWsRelay(opts: RelayOptions): RelayHandle {
  const intervalMs = opts.intervalMs ?? RELAY_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  const spawnFn = opts.spawnFn ?? spawn;
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ??
    ((handle: unknown): void => {
      if (handle !== null) clearInterval(handle as ReturnType<typeof setInterval>);
    });
  const setTimeoutFn =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ??
    ((handle: unknown): void => {
      if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const outFile = opts.outFile;
  const runtime = resolveRelayRuntime(opts.execPath, opts.env);
  const execPath = runtime.execPath;
  // 把"这次用哪个 node 起"写进日志：以后遇到 ENOENT / Cannot find module，先看这一行
  log(`[onebot] relay 启动器=${execPath}${runtime.viaElectron ? "（ELECTRON_RUN_AS_NODE=1）" : ""}`);

  // 脚本不存在时 spawn 只会得到一句 "Cannot find module"，再退避 5 次才放弃；
  // 启动前先看一眼，日志能直接指到"安装不完整"，也不用白起 5 次子进程。
  // 注意别动旧实例：新安装缺脚本时，宁可让还在工作的旧中继继续跑着。
  if (!existsSync(opts.scriptPath)) {
    log(`[onebot] relay 脚本不存在：${opts.scriptPath}（中继不会启动；检查插件安装是否完整）`);
    return { state: () => "stopped", stop: () => {} };
  }

  // 单实例守卫：同一个 outFile 已经有活着的实例，先停掉旧的再起新的。
  // 没有这一步，热重载（宿主没跑 disposer）会让旧子进程活下来，新 apply 再 spawn 一个：
  // 多个中继同时连 WS → 入站事件重复，只能靠下游去重兜着。
  const previous = liveRelays.get(outFile);
  if (previous !== undefined) {
    // 先看再停：已经 stopped 的实例（正常卸载后再启动）不该打"重启"日志
    const wasLive = previous.state() !== "stopped";
    previous.stop("同 outFile 的新实例启动");
    if (wasLive) log(RELAY_REPLACED_LOG);
  }

  let state: "starting" | "running" | "stopped" = "starting";
  /** 用户显式 stop 过：此后一律不再 spawn / 不再重启 */
  let stopped = false;
  let offset = 0;
  /** 连续失败次数：只有"真读到事件"才清零，所以起来就崩的子进程会一路退避到放弃 */
  let failures = 0;
  let child: ChildProcess | null = null;
  let pollTimer: unknown = null;
  let retryTimer: unknown = null;
  /** SIGKILL 兜底定时器：SIGTERM 之后 grace 时间还在就补一刀 */
  let killTimer: unknown = null;

  const removeOutFile = (): void => {
    try {
      unlinkSync(outFile);
    } catch {
      /* 不存在就算了 */
    }
  };

  const stopPoll = (): void => {
    if (pollTimer === null) return;
    clearIntervalFn(pollTimer);
    pollTimer = null;
  };
  const stopRetry = (): void => {
    if (retryTimer === null) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  };
  /** 子进程真的退出了就取消 SIGKILL 兜底：别在 1.5s 后对一个死进程再 kill 一次 */
  const stopKillTimer = (): void => {
    if (killTimer === null) return;
    clearTimeoutFn(killTimer);
    killTimer = null;
  };

  const drain = (): void => {
    const chunk = drainLines(outFile, offset);
    offset = chunk.offset;
    // 真收到事件 = 中继活着，之前的连续失败清零
    if (chunk.lines.length > 0) failures = 0;
    for (const line of chunk.lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (rec["kind"] === "relay") {
        // 子进程自报的 pid 是"它真的起来了"的独立证据：进程表查不到时（沙箱 / 权限 /
        // 别的用户会话），这行日志仍然能证明中继活着，不用再靠 Get-CimInstance。
        if (rec["at"] === "start") {
          const pid = typeof rec["pid"] === "number" ? rec["pid"] : undefined;
          log(`[onebot] relay 子进程已就绪${pidLabel(pid)}`);
        }
        continue;
      }
      if (rec["kind"] === "event" && typeof rec["data"] === "string") {
        try {
          opts.onEvent(JSON.parse(rec["data"]));
        } catch {
          /* 坏事件帧忽略 */
        }
      }
    }
  };

  const startPoll = (): void => {
    stopPoll();
    pollTimer = setIntervalFn(drain, intervalMs);
  };

  const scheduleRestart = (why: string): void => {
    if (stopped) return;
    if (failures >= RELAY_BACKOFF_MS.length) {
      state = "stopped";
      log(`[onebot] relay 放弃重启（连续失败 ${failures} 次）：${why}`);
      return;
    }
    const delay = relayBackoffMs(failures);
    failures += 1;
    state = "starting";
    log(`[onebot] ${why}；${delay}ms 后重启 relay（第 ${failures} 次）`);
    stopRetry();
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      launch();
    }, delay);
  };

  function launch(): void {
    if (stopped) return;
    state = "starting";
    removeOutFile();
    offset = 0;
    let next: ChildProcess;
    try {
      next = spawnFn(execPath, [opts.scriptPath, opts.wsUrl, opts.token, outFile], {
        // cwd 对准脚本目录：以后脚本若改成相对路径 import，不会因宿主 cwd 不同而炸
        cwd: dirname(opts.scriptPath),
        env: { ...runtime.env },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      scheduleRestart(`relay 启动失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    child = next;
    /** 同一个子进程只处理一次"没了"：error→exit 会连发，重复排重启会翻倍 */
    let gone = false;
    const handleGone = (why: string): void => {
      if (gone) return;
      gone = true;
      // 关键：子进程没了就先停轮询，否则会留下一个永远读不到新内容的定时器
      stopPoll();
      // 同一个子进程已经退了：兜底那一刀没必要再等
      stopKillTimer();
      if (child === next) child = null;
      const detail = `${why}${pidLabel(next.pid)}`;
      if (stopped) {
        // stop() 之后才退出，是正常卸载的最后一幕。旧代码在这里静默 return，日志里
        // 只剩"已启动"，排查时会被误读成"子进程启动后凭空消失"。这里无条件留一条。
        log(`[onebot] ${detail}；已停止，不再重启`);
        return;
      }
      state = "stopped";
      scheduleRestart(detail);
    };

    next.stderr?.setEncoding("utf8");
    next.stderr?.on("data", (chunk: string) => {
      const text = chunk.replace(/access_token=[^&\s]+/g, "access_token=***").trim();
      if (text !== "") log(`[onebot] relay: ${text}`);
    });
    next.on("spawn", () => {
      // stop() 抢在 spawn 事件之前跑掉的场景：状态已经是 stopped，别再翻回 running
      if (stopped) return;
      state = "running";
      log(`[onebot] relay 子进程已启动${pidLabel(next.pid)}`);
    });
    next.on("error", (err: Error) => {
      log(`[onebot] relay 启动失败：${err.message}`);
      handleGone("relay 启动失败");
    });
    next.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      handleGone(`relay 退出（code=${String(code)}, signal=${signal ?? "none"}）`);
    });
    startPoll();
  }

  const handle: RelayHandle = {
    state: () => state,
    stop: (reason?: string) => {
      // 无条件先清定时器，再判状态：旧的"已 stopped 就 return"会让 400ms 轮询留在事件循环里
      stopPoll();
      stopRetry();
      // 所有权：只有"现在登记着的那个 handle"才准 kill 子进程、删输出文件。
      // 被同 outFile 的新实例顶掉的旧 handle（比如宿主晚到的 disposer）只退自己的登记——
      // 否则会误杀新实例刚起的中继、删掉它正在写的 JSONL。
      const owned = liveRelays.get(outFile) === handle;
      if (owned) liveRelays.delete(outFile);
      if (stopped) return;
      stopped = true;
      state = "stopped";
      const why = reason === undefined || reason === "" ? "调用方停止" : reason;
      if (!owned) {
        log(`[onebot] relay 停止：已被同 outFile 的新实例接管，不 kill（${why}）`);
        return;
      }
      const current = child;
      child = null;
      stopKillTimer();
      if (current !== null) {
        log(`[onebot] relay 正在停止${pidLabel(current.pid)}：${why}`);
        try {
          current.kill("SIGTERM");
        } catch {
          /* 已退出 */
        }
        // 兜底：SIGTERM 没带走它（忽略信号 / 权限不足）就在 grace 后补 SIGKILL
        killTimer = setTimeoutFn(() => {
          killTimer = null;
          try {
            current.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
        }, RELAY_KILL_GRACE_MS);
        // 别为了一个兜底定时器把进程钉在事件循环里（Node 的 Timeout 才有 unref）
        (killTimer as { unref?: () => void }).unref?.();
      }
      removeOutFile();
    },
  };
  liveRelays.set(outFile, handle);
  launch();
  return handle;
}
