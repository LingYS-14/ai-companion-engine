/**
 * §8.3 隐私隔离的**公共面**（只有类型与两个常量，没有规则实现）。
 *
 * 为什么单独放 `src/ports/`：工具层（`src/plugin/tools.ts`）需要把「访客/主人」
 * 作为参数传给大脑，而边界门禁（`tools/lint/edges.mjs` 的 R3）**禁止工具层 import 大脑内部实现**；
 * `src/ports/` 是唯一被允许的公共面（`brainPublicPrefixes`）。
 * 规则本身不在这里——它在 `src/memory/visibility.ts`（大脑层），工具层只传"你是谁"，不判"能不能看"。
 */

/** 眼前这个人是谁：owner=主人本人；否则是访客（可带 contactId 用于"回他自己的话"） */
export interface Visitor {
  readonly owner: boolean;
  readonly contactId?: string;
}

/** 主人视角：全部可见（DSH 工具面、她自己的进程、用户本人的 QQ） */
export const OWNER_VISITOR: Visitor = { owner: true };

/** 一个没有任何特权的陌生访客 */
export const GUEST_VISITOR: Visitor = { owner: false };
