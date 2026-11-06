/** 执行层对外出口：大脑只应依赖这里，不直接碰适配器。 */

export * from "./types.js";
export { requestFingerprint, stableStringify } from "./hash.js";
export { IdempotencyStore } from "./idempotency.js";
export { ExecutionGateway, type GatewayDeps, type DispatchResult } from "./gateway.js";
export { appendExecutionEvent, digestInput, type ExecutionEvent } from "./log.js";
export { PendingQueue, type PendingItem } from "./queue.js";
export { ADAPTER_META, makeAdapter, type AdapterId, type AdapterMeta } from "./adapters.js";
