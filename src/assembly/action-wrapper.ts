/**
 * 动作包装（F301，批次 3「入口下沉」第十刀）。
 *
 * 作用：每一拍在真正执行动作之前，做两件与动作本身无关的固定事——
 *   1. 看一眼模型凭据（`refreshModel`，内部有 30 分钟节流）；
 *   2. 跑这一拍的固定副作用（队列补偿 / 面板快照 / 3 点数据快照 / 6 点早报，见 `tick-hooks.ts`）。
 *
 * 为什么放在这里而不是入口：
 *   - 它是**策略**（顺序、每拍都要做、只对"常驻循环的动作"生效），不是环境装配；
 *   - 入口脚本在层扫描面之外，写的策略没有单测；搬上来之后可以钉住"先刷新凭据、再跑副作用、
 *     最后才是动作"和"onTick 才跑、其它动作只刷新凭据"这两条顺序。
 *
 * 边界：不自己取时间（`now` 由调用方给）、不重试、不吞错（动作失败仍要冒给 loop 记日志）。
 */

import { runTickHooks, type TickHooksDeps } from "./tick-hooks.js";

export interface ActionWrapperInput {
  /** 原始动作表（`createPortActions` 的产物；非函数项会被丢掉） */
  readonly actions: Readonly<Record<string, unknown>>;
  /** 凭据刷新（节流在实现里；失败照常抛，让这一拍记失败） */
  readonly refreshModel: () => Promise<void>;
  /** 这一拍固定副作用的依赖（F275/F276 已收进 tick-hooks） */
  readonly tickHooks: TickHooksDeps;
  /** 时钟（入口给，装配层不自己取） */
  readonly now: () => number;
}

/** 包装后的动作表：同名、抛错行为不变，只多了"先刷新凭据 + 跑固定副作用"。 */
export type WrappedActions = Record<string, (...args: unknown[]) => Promise<unknown>>;

export function wrapActions(input: ActionWrapperInput): WrappedActions {
  const entries = Object.entries(input.actions).filter(
    (entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === "function",
  );
  return Object.fromEntries(
    entries.map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        await input.refreshModel();
        // `runTickHooks` 自己按名字决定跑哪些副作用（只有心跳拍全跑，其它动作只刷新凭据）。
        await runTickHooks(name, input.tickHooks, input.now());
        return fn(...args);
      },
    ]),
  );
}
