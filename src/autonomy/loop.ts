/**
 * 常驻循环：只负责「按节奏把 brain 的计划交给 actions」，并持有单写者锁。
 *
 * 它不生成台词、不读人格卡、不改状态——那些在 actions 里。这样把「什么时候做」
 * 与「做什么」分开：节奏可以单测，动作可以按 QQ 开/关分别接线。
 */

import { renameSync, writeFileSync } from "node:fs";

import { acquireWriterLock, heartbeatWriterLock, releaseWriterLock, type WriterLock } from "./lock.js";
import { advanceHistory, EMPTY_HISTORY, planTick, type AutonomyAction, type TickHistory, type TickPlan } from "./tick-plan.js";
import type { AutonomyConfig } from "./config.js";
import { dayKey } from "./tick-plan.js";

export interface AutonomyActions {
  /** 推进 S 层与关系（不生成台词） */
  stateTick(now: number): void;
  /** 学一次：刷视频/搜索，写 L2 知识 */
  learn(now: number): Promise<void> | void;
  /** 睡眠巩固：L1 → L2 */
  consolidate(now: number): void | Promise<void>;
  /** 主动开口（真正的发送由 QQ 侧门控） */
  proactive(now: number): Promise<void> | void;
  /** 内部言语（自言自语）：写记忆元数据 + 日志；没有实现时跳过，不阻塞循环 */
  selftalk?(now: number): Promise<void> | void;
  /**
   * P1：意向引擎的一拍纯计算（投影 → 候选 → 累积器 → 浮现 → 硬闸）。
   *
   * 只有装配时注入了实现才会跑；它**不发消息、不调模型**，所以放在循环里不违反"循环只调度"。
   * 失败只记一行日志，不拖垮这一轮——意图是观测，不是她的生命线。
   */
  intentTick?(now: number): Promise<void> | void;
  log?(line: string): void;
}

export interface AutonomyLoopDeps {
  readonly config: AutonomyConfig;
  readonly actions: AutonomyActions;
  readonly lockPath: string;
  readonly pid: number;
  /** 毫秒时间戳；注入时钟便于测试 */
  readonly now: () => number;
  /** 本地小时 0–23（巩固与安静时段用） */
  readonly localHour: () => number;
  /** 本地时区偏移分钟数（东八区 = 480）；只用于 dayKey */
  readonly tzOffsetMinutes?: number;
  /** 心跳文件（给开发面判断"她还活着、状态归她写"用；不写也不影响循环） */
  readonly beatPath?: string | undefined;
  /**
   * 每拍结束是否释放写锁。默认 true（嵌在宿主里时，接待间隙要让宿主能写）。
   * 桥移交给常驻进程后传 false：锁由接待侧持有，循环只续心跳，不能把它删掉。
   */
  readonly releaseOnTick?: boolean | undefined;
}

export class AutonomyLoop {
  private readonly deps: AutonomyLoopDeps;
  private history: TickHistory = EMPTY_HISTORY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lock: WriterLock | null = null;
  /** F352（B1）：重入闸——上一拍没结束前不让下一拍进来（setInterval 不等 Promise）。 */
  private inFlight = false;

  constructor(deps: AutonomyLoopDeps) {
    this.deps = deps;
  }

  /** 跑一轮；返回实际执行的动作。加锁失败或未启用时返回空计划，不抛错。 */
  async runOnce(now = this.deps.now()): Promise<TickPlan> {
    // F352（B1）：setInterval 不保证上一拍的 await 完成才进下一拍。一拍里的
    // intentTick→proactive 共享 main() 作用域的 beatTemporal；重入会让后一拍把
    // 前一拍的快照清空/覆写，proactive 就可能记成旧快照或 undefined。
    // 重入闸保证「一拍结束才允许下一拍」，被跳过的一拍只记一行日志。
    if (this.inFlight) {
      this.deps.actions.log?.("[autonomy] 上一拍尚未结束，跳过这一拍");
      return { actions: [], reason: "busy" };
    }
    this.inFlight = true;
    try {
      return await this.runOnceBody(now);
    } finally {
      this.inFlight = false;
    }
  }

  private async runOnceBody(now: number): Promise<TickPlan> {
    const { config, actions } = this.deps;
    if (!config.enabled) return { actions: [], reason: "disabled" };
    const lock = acquireWriterLock({
      path: this.deps.lockPath,
      pid: this.deps.pid,
      owner: "autonomy",
      now,
      staleMs: config.lockStaleMs,
      note: "autonomy loop",
    });
    if (lock === null) {
      actions.log?.("[autonomy] 另一进程持有写锁，跳过这一轮");
      return { actions: [], reason: "locked" };
    }
    this.lock = lock;
    const localDay = dayKey(now, this.deps.tzOffsetMinutes ?? 0);
    const plan = planTick({
      now,
      localHour: this.deps.localHour(),
      localDay,
      history: this.history,
      config,
    });

    // A7：意图节拍移到**计划动作之前**。
    // 以前 plan（含 proactive/selftalk）先跑、intentTick 后跑，于是同一条主动消息拿到的是
    // **上一拍**的由头/处境；重启后的第一条更是 intent=none（日志里印过）。
    // 现在先算这一拍她"想做什么、看见什么"，再由 proactive/selftalk 用同一拍的事实决定怎么说。
    // 仍然是纯计算（不发送、不调模型），失败只记一行——不能因为它让这一轮白跑。
    if (typeof actions.intentTick === "function") {
      try {
        await actions.intentTick(now);
      } catch (err) {
        actions.log?.(`[autonomy] intentTick 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ran: AutonomyAction[] = [];
    try {
      for (const action of plan.actions) {
        try {
          if (action === "tick") actions.stateTick(now);
          else if (action === "learn") await actions.learn(now);
          else if (action === "consolidate") await actions.consolidate(now);
          else if (action === "selftalk") {
            if (actions.selftalk === undefined) actions.log?.("[autonomy] selftalk 未接线，跳过");
            else await actions.selftalk(now);
          } else await actions.proactive(now);
          ran.push(action);
        } catch (err) {
          actions.log?.(`[autonomy] ${action} 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      heartbeatWriterLock(lock, now, `ran=${ran.join("+")}`);
      this.writeBeat(now, ran);
    } finally {
      if (this.deps.releaseOnTick === false) {
        heartbeatWriterLock(lock, now, `ran=${ran.join("+")}`);
      } else {
        releaseWriterLock(lock);
      }
      this.lock = null;
    }
    this.history = advanceHistory(this.history, ran, now, localDay);
    return { actions: ran, reason: plan.reason };
  }

  /** 起循环：基础节拍取 stateIntervalMs，保证巩固/主动的检查不会比配置更稀 */
  start(): void {
    if (!this.deps.config.enabled || this.timer !== null) return;
    const period = this.deps.config.stateIntervalMs;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.deps.actions.log?.(`[autonomy] tick 异常：${err instanceof Error ? err.message : String(err)}`);
      });
    }, period);
    // 常驻进程里这是唯一的活动句柄：不要让定时器阻止退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lock !== null) {
      releaseWriterLock(this.lock);
      this.lock = null;
    }
  }

  /** 心跳落盘：`{pid, at, ran}`；失败不致命（只读闸会退回看写锁） */
  private writeBeat(now: number, ran: readonly AutonomyAction[]): void {
    const path = this.deps.beatPath;
    if (path === undefined) return;
    try {
      const tmp = `${path}.tmp-${String(this.deps.pid)}`;
      writeFileSync(tmp, `${JSON.stringify({ pid: this.deps.pid, at: now, ran })}
`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* 心跳只是给只读闸看的，写不进去不该让这一轮失败 */
    }
  }

  /** 只读快照（给面板/诊断用） */
  snapshot(): { history: TickHistory; running: boolean } {
    return { history: this.history, running: this.timer !== null };
  }
}
