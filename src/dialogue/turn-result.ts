/**
 * 一轮对话的产出与召回行——**大脑层的 DTO**。
 *
 * 为什么从 `plugin/runtime.ts` 搬到这里：这两个类型描述的是「一轮发生了什么」，
 * 属于大脑层的事实；留在工具层会让每个要用它们的地方（端口、QQ 桥、测试）
 * 都反向依赖装配点，正是这次三层重构要拆掉的耦合。
 * `plugin/runtime.ts` 仍然 re-export，旧 import 不改。
 */

import type { Mode } from "../engine/modes.js";
import type { SState } from "../engine/state.js";
import type { Stage } from "../engine/bonds.js";
import type { composePrompt } from "./render.js";
import type { ExpressionHint } from "./expression.js";
import type { EventRegister } from "./event-style.js";
import type { StrategyChoice } from "../learning/bandit.js";
import type { Wonder } from "../psychology/wonder.js";

export interface TurnText {
  readonly mode: Mode;
  readonly stage: Stage | null;
  readonly bondProgress: number;
  readonly state: SState;
  readonly style: ReturnType<typeof composePrompt>;
  /** 表达层命中结果（quadrant × stage 的 16 格表；未命中时 source=fallback） */
  readonly expression: ExpressionHint;
  /** 事件级许可（F31）：这一轮发生了什么 → 允许/避免怎样的反应；认不出的事件为 null */
  readonly eventStyle: EventRegister | null;
  readonly memory: { readonly wrote: number; readonly rejected: number };
  /** 本轮策略建议（§7.4 UCB）；本轮没给 reaction 时只是建议，不构成学习 */
  readonly bandit: StrategyChoice & { readonly scored: boolean };
  /** 动机层：她此刻想说什么（见 src/psychology/wonder.ts）；只影响提示，不改状态 */
  readonly wonder: Wonder;
  /**
   * 这一轮被哪条记忆绊住了（§6.8 自动闯入）。
   *
   * 只在真闯进来时出现：pressure/rumination 已在这一轮生效（状态里看得到），
   * 这里给的是"是谁"——日志与面板要能回答"她刚才为什么突然沉下去"。
   */
  readonly intrusion?: { readonly memoryId: string; readonly prob: number };
  /**
   * 这一轮发生了「降级」（v5.2 §2 A26）：存储出错（记忆写不进 / 状态存不下）时，
   * 她**照样把这一轮走完**（状态已推进、话照样说），只是把失败写在这里。
   *
   * 规格原话是「MemoryStore 抛错 → Firewall deny → Orchestrator 降级」；实现里
   * Firewall 的 deny 本来就是返回值不是异常，所以降级点落在装配层：一次落盘失败
   * 不能让对方看到"她不说话了"——那是比丢一条记忆严重得多的故障。
   */
  readonly degraded?: string;
  /**
   * §7.2 落差：她预期「你这次会怎么对我」，与真实发生的强度差多少。
   * 没有这一层（比如主动开口）的路径就没有这个字段。
   */
  /**
   * §1.2 INV-2：这一轮的 trace id。拿它去 `tools/trace/query.mjs` 反查
   * 「当时什么状态、召回了什么、走了哪条策略、预期多少」。
   * 没开 trace（`trace:false`）的实例没有这个字段。
   */
  readonly traceId?: string;
  readonly expectation?: {
    readonly type: string;
    readonly predicted: number;
    readonly actual: number;
    readonly error: number;
    readonly learned: number;
  };
  /**
   * 这一轮走了一次「里程碑修复」（§7.1）：破裂之后的补偿动作把关系修回来一点。
   *
   * 只有当调用方显式给了 `eventIntensity` 且事件类型在 MILESTONE_TYPE_SET 里才会出现——
   * 事件强度在实现里没有天然来源（见 runtime.tryMilestone 的注释）。
   */
  readonly repair?: { readonly type: string; readonly deltaBond: number; readonly deltaTrust: number };
}

export interface RecallRow {
  readonly id: string;
  readonly score: number;
  /** §6.6 semantic 分量（0..1）——单独露出来，否则"分数变了但不知道为什么" */
  readonly semantic: number;
  readonly content: string;
  readonly tags: readonly string[];
  readonly underTaint: boolean;
  /**
   * 记忆来源（`MemoryRecord.source` 的透传）。
   *
   * task-169 A：主动开口要排除「她自己说出去的话」（proactive/selftalk/chat_reply），
   * 但测试里的假端口/旧快照可能没有这个字段——所以可选，缺省 = 不知道来源、不过滤。
   */
  readonly source?: string;
}
