/**
 * 执行层的公共类型（P0）。
 *
 * 为什么要有这一层：她现在能发 QQ、抓 B 站、写知识库，但每个动作都是「谁想用就直接调」——
 * 没有统一的幂等、失败分类、落盘与重放。执行层把「意图」与「动作怎么落」分开：
 * 大脑只提交一个请求，执行层负责去重、限速、调用、分类失败、记录。
 *
 * 这不是教科书里的脊髓，是一个**窄而硬**的适配器层：只有参数调制，没有逻辑注入。
 */

/** 动作的风险等级：read 只读；reversible 可撤销；external 出站且外部可见；irreversible 不可撤回 */
export type RiskTier = "read" | "reversible" | "external" | "irreversible";

/**
 * 幂等语义。
 * - idempotent：重复执行结果一致，重试安全；
 * - at-most-once：**宁可失败也不重复**（发消息、发评论），失败必须上报；
 * - at-least-once：至少一次（抓取/入库），允许重复但要去重。
 */
export type Idempotency = "idempotent" | "at-most-once" | "at-least-once";

/** 失败分类：决定能不能重试、要不要人看 */
export type FailureClass = "TRANSIENT" | "PERMANENT" | "PARTIAL" | "INDETERMINATE";

export interface ToolAdapterSpec<TInput, TResult> {
  readonly toolId: string;
  readonly idempotency: Idempotency;
  readonly riskTier: RiskTier;
  /** 外部系统是否支持查询动作结果（QQ 窗口发送不可查 → INDETERMINATE） */
  readonly queryable: boolean;
  readonly timeoutMs: number;
  readonly maxPerMinute: number;
  /** 幂等窗口：同一指纹在这段时间内只执行一次 */
  readonly dedupeTtlMs: number;
  readonly call: (input: TInput) => Promise<TResult>;
  /** 结果摘要（落日志用；不能含凭据） */
  readonly digest?: (result: TResult) => string;
}

export interface ExecutionFailure {
  readonly class: FailureClass;
  readonly message: string;
  /** at-most-once 失败后是否允许「人工确认后重试」 */
  readonly retryable: boolean;
}

export type ExecutionStatus = "succeeded" | "deduplicated" | "failed" | "rate-limited";

export interface ExecutionOutcome<TResult = unknown> {
  readonly requestId: string;
  readonly toolId: string;
  readonly status: ExecutionStatus;
  readonly result?: TResult;
  readonly failure?: ExecutionFailure;
  readonly attemptCount: number;
  readonly deduplicated: boolean;
  readonly durationMs: number;
}

export interface ExecuteOptions {
  /** 谁发起的：`qq:<peer>`、`autonomy:<tick>`、`dev:<session>` */
  readonly subject: string;
  /** 动作落到谁身上（对 QQ 是 peer）；参与指纹，避免不同对象互相去重 */
  readonly target?: string;
  /** 外部指定（重放时用）；缺省则执行层生成 */
  readonly requestId?: string;
}
