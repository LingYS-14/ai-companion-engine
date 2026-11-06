/**
 * dry-run：用**与真实循环相同的装配**跑一轮，只记录不写盘。
 *
 * 为什么不是「跳过循环直接打印计划」：那样证明不了 action 接线是通的。
 * 这里用 `createDryRunPort` + `createPortActions` 走完整路径（取锁 → 规划 → 依序执行
 * → 心跳 → 释放），唯一区别是端口不碰 runtime、不发消息、不写状态。
 */

import { existsSync } from "node:fs";
import type { AutonomyAction, TickPlan } from "./tick-plan.js";
import { resolveAutonomyConfig, type AutonomyConfig } from "./config.js";
import { AutonomyLoop } from "./loop.js";
import { createDryRunPort, createPortActions } from "./port.js";

export interface DryRunInput {
  readonly now: number;
  readonly localHour: number;
  readonly lockPath: string;
  readonly config?: Partial<AutonomyConfig> | undefined;
  readonly tzOffsetMinutes?: number | undefined;
  /** 默认用当前进程 pid，便于在日志里对上 */
  readonly pid?: number | undefined;
}

export interface DryRunResult {
  readonly plan: TickPlan;
  readonly ran: readonly AutonomyAction[];
  readonly log: readonly string[];
  /** 跑完后锁文件还在不在（正常应为 false） */
  readonly lockLeft: boolean;
}

export async function runDryTick(input: DryRunInput): Promise<DryRunResult> {
  const config: AutonomyConfig = { ...resolveAutonomyConfig(input.config), enabled: true };
  const log: string[] = [];
  const port = createDryRunPort();
  const actions = createPortActions(port, (line) => {
    log.push(line);
  });
  const loop = new AutonomyLoop({
    config,
    actions,
    lockPath: input.lockPath,
    pid: input.pid ?? process.pid,
    now: () => input.now,
    localHour: () => input.localHour,
    ...(input.tzOffsetMinutes === undefined ? {} : { tzOffsetMinutes: input.tzOffsetMinutes }),
  });
  const plan = await loop.runOnce(input.now);
  return { plan, ran: plan.actions, log, lockLeft: existsSync(input.lockPath) };
}
