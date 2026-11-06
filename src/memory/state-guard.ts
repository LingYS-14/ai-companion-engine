/**
 * 状态文件写入仲裁（三层审计 P0-4「单写者」的第一步，批次 2a）。
 *
 * 背景：同一份 `data/state-<char>.json` 有两个进程都可能写——
 *   · 常驻进程（daemon）：每拍 advance，写锁在它手里，是**主写者**；
 *   · DSH 插件（宿主）：QQ 接待回合、`soul_turn`/`soul_remember` 等工具也会写。
 * 两边都是"整份覆盖"（tmp + rename），谁后写谁赢——于是插件用一份**旧内存快照**
 * 覆盖掉 daemon 刚推进的状态，关系/情绪/回合数会静默倒退。审计 B.1 现场就是这么丢状态的。
 *
 * 这份模块只做一件纯事：给"这次还该不该写"一个可判定的答案。
 *   · 文件不存在 / 读不出 → 写（第一次落盘或文件被删，没什么可保护）；
 *   · 文件里的 updatedAt === 本进程上次看到的 updatedAt → 写（没人动过）；
 *   · 有人动过：
 *       - primary（daemon）→ 仍然写，但**要警告**：主写者不能因为别的进程写过就罢工，
 *         否则插件一次误写会让她的整个心跳停下来；警告让人能从日志里找到事故现场。
 *       - secondary（插件）→ 拒绝写：插件没有资格覆盖主写者的推进，拒绝并留日志。
 *
 * 这是"检测 + 降级"，不是分布式锁。真正的单写者是批次 2 的后续步骤：插件只读快照、
 * 写操作投递请求文件由 daemon 消费。那时 secondary 路径会整体消失。
 */

import { existsSync, readFileSync } from "node:fs";

/** 谁在写：daemon 是 primary，插件是 secondary */
export type StateWriterRole = "primary" | "secondary";

export type StateWriteDecision = "write" | "write-with-warning" | "reject-stale";

export interface StateWriteInput {
  /** 磁盘上看到的 updatedAt；null = 文件不存在或读不出（按"没人写过"处理，不阻塞） */
  readonly currentUpdatedAt: number | null;
  /** 本进程上次读/写时看到的 updatedAt（open 时读盘值，或上次 save 自己写的值） */
  readonly lastSeenUpdatedAt: number;
  readonly role: StateWriterRole;
}

/**
 * 判断这次 save 能不能落盘。
 *
 * 注意：`currentUpdatedAt === lastSeenUpdatedAt` 视为"没人动过"——包括**本进程自己上次写的**。
 * 所以调用方每次成功落盘后必须把 lastSeenUpdatedAt 更新成自己刚写的 updatedAt，
 * 否则会把自己上一次的写当成"别人改过"。
 */
export function decideStateWrite(input: StateWriteInput): StateWriteDecision {
  if (input.currentUpdatedAt === null) return "write";
  if (input.currentUpdatedAt === input.lastSeenUpdatedAt) return "write";
  return input.role === "primary" ? "write-with-warning" : "reject-stale";
}

/**
 * 读磁盘上的状态文件 updatedAt。任何读取/解析问题都返回 null——
 * 这里只做"版本探测"，不能因为探测失败让她的心跳停下来（读不出的文件后续 save 会直接覆盖）。
 */
export function readStateUpdatedAt(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { updatedAt?: unknown };
    return typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null;
  } catch {
    return null;
  }
}

/** save 落盘结果（给装配点打日志用；runtime 自己也会记一个最近一次决策） */
export interface StateSaveOutcome {
  readonly decision: StateWriteDecision;
  readonly written: boolean;
  readonly currentUpdatedAt: number | null;
}

export function describeStateSaveOutcome(outcome: StateSaveOutcome, role: StateWriterRole): string {
  if (outcome.written && outcome.decision === "write") return "state：已落盘";
  if (outcome.written) {
    return `state：已落盘（覆盖了别的进程写过的版本：${role === "primary" ? "主写者继续写，已记警告" : "不该发生"}）`;
  }
  return `state：拒绝覆盖（磁盘上的版本更新，本进程是 ${role}）`;
}
