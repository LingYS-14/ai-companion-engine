/**
 * 执行网关（P0/P1 内核）：注册适配器 → 指纹去重 → 限速 → 调用 → 分类失败 → 落日志。
 *
 * 设计取舍（见 docs/ARCHITECTURE.md / docs/ARCHITECTURE.md）：
 * - **不做重试**：at-most-once 动作重复即事故；重试由上层门控在拿到 failed 结果后决定；
 * - **不写大脑状态**：这里只有动作，没有 state/bond/m 的写入权限；
 * - **不猜结果**：不可查询的通道失败后只能报 INDETERMINATE，不许假装成功。
 */

import { appendExecutionEvent, digestInput, type ExecutionEvent } from "./log.js";
import { IdempotencyStore } from "./idempotency.js";
import { classifyFailure, retryableFor } from "./failure.js";
import { RateLimiter } from "./rate-limit.js";
import { requestFingerprint } from "./hash.js";
import type {
  ExecuteOptions,
  ExecutionFailure,
  ExecutionOutcome,
  FailureClass,
  ToolAdapterSpec,
} from "./types.js";

export interface GatewayDeps {
  readonly now: () => number;
  readonly eventsFile: string;
  readonly idemFile: string;
  readonly log?: (line: string) => void;
}

export interface DispatchResult {
  readonly status: "executed" | "skipped" | "rate-limited" | "failed";
  readonly requestId: string;
  readonly detail: string;
  readonly outcome?: ExecutionOutcome;
}

export class ExecutionGateway {
  private readonly specs = new Map<string, ToolAdapterSpec<unknown, unknown>>();
  private readonly limiter = new RateLimiter();
  private readonly idem: IdempotencyStore;
  private readonly deps: GatewayDeps;
  /** 生成 requestId 的序号：不用 Math.random（src 内被 lint 禁止，且随机会让重放不可复现） */
  private seq = 0;
  /**
   * 只读动作的去重结果缓存：幂等（idempotent）工具在 TTL 内被重复请求时，
   * 直接回放上一次的结果，而不是"去重但没数据"——否则 bili.fetch 十秒内搜同一个词会拿到空。
   */
  private readonly replay = new Map<string, { at: number; result: unknown; ttlMs: number }>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.idem = IdempotencyStore.open(deps.idemFile);
  }

  register<TInput, TResult>(spec: ToolAdapterSpec<TInput, TResult>): void {
    if (this.specs.has(spec.toolId)) {
      throw new Error(`执行层：适配器重复注册 ${spec.toolId}`);
    }
    if (!(spec.maxPerMinute > 0) || !Number.isFinite(spec.maxPerMinute)) {
      throw new Error(`执行层：${spec.toolId} 的 maxPerMinute 非法`);
    }
    this.specs.set(spec.toolId, spec as ToolAdapterSpec<unknown, unknown>);
  }

  private pruneReplay(now: number): void {
    if (this.replay.size < 64) return;
    for (const [key, entry] of this.replay) {
      if (now - entry.at > entry.ttlMs) this.replay.delete(key);
    }
  }

  specsList(): readonly string[] {
    return [...this.specs.keys()];
  }

  async execute<TInput, TResult>(
    toolId: string,
    input: TInput,
    options: ExecuteOptions,
  ): Promise<ExecutionOutcome<TResult>> {
    const spec = this.specs.get(toolId) as ToolAdapterSpec<TInput, TResult> | undefined;
    if (spec === undefined) {
      const failure: ExecutionFailure = {
        class: "PERMANENT",
        message: `执行层：未注册的适配器 ${toolId}`,
        retryable: false,
      };
      return {
        requestId: options.requestId ?? "unregistered",
        toolId,
        status: "failed",
        failure,
        attemptCount: 0,
        deduplicated: false,
        durationMs: 0,
      };
    }

    const now = this.deps.now();
    this.seq += 1;
    const requestId = options.requestId ?? `req-${String(now)}-${String(this.seq)}`;
    const fingerprint = requestFingerprint({
      toolId,
      ...(options.target === undefined ? {} : { target: options.target }),
      payload: input,
    });

    // 1) 幂等：命中窗口内记录 → 不执行
    const reserve = this.idem.reserve({
      fingerprint,
      requestId,
      toolId,
      now,
      ttlMs: spec.dedupeTtlMs,
    });
    if (!reserve.acquired) {
      const entry = reserve.entry;
      const replay = spec.idempotency === "idempotent" ? this.replay.get(fingerprint) : undefined;
      const replayed = replay !== undefined && now - replay.at <= replay.ttlMs ? (replay.result as TResult) : undefined;
      const deduplicated: ExecutionOutcome<TResult> = {
        requestId: entry?.requestId ?? requestId,
        toolId,
        status: "deduplicated",
        ...(replayed === undefined ? {} : { result: replayed }),
        ...(entry?.state === "failed"
          ? { failure: { class: "PERMANENT" as FailureClass, message: "同一请求此前已失败（at-most-once）", retryable: false } }
          : {}),
        attemptCount: 0,
        deduplicated: true,
        durationMs: 0,
      };
      this.emit({ now, requestId, fingerprint, toolId, options, status: "deduplicated", attempt: 0, durationMs: 0 });
      this.deps.log?.(`[exec] 去重 tool=${toolId} fp=${fingerprint.slice(0, 8)}`);
      return deduplicated;
    }

    // 2) 限速（内存窗口，重启后归零——这是软限制，峰谷账本是另一套硬限制）
    if (!this.limiter.tryAcquire(toolId, spec.maxPerMinute, now)) {
      this.idem.release(fingerprint, now);
      this.emit({ now, requestId, fingerprint, toolId, options, status: "rate-limited", attempt: 0, durationMs: 0 });
      return {
        requestId,
        toolId,
        status: "rate-limited",
        failure: { class: "TRANSIENT", message: `超过每分钟上限 ${String(spec.maxPerMinute)}`, retryable: retryableFor("TRANSIENT") },
        attemptCount: 0,
        deduplicated: false,
        durationMs: 0,
      };
    }

    // 3) 调用
    const started = now;
    this.emit({
      now,
      requestId,
      fingerprint,
      toolId,
      options,
      status: "start",
      attempt: 1,
      durationMs: 0,
      inputDigest: digestInput(input),
    });
    try {
      const result = await this.withTimeout(spec.call(input), spec.timeoutMs, toolId);
      const finished = this.deps.now();
      this.idem.complete(fingerprint, finished);
      if (spec.idempotency === "idempotent") {
        this.replay.set(fingerprint, { at: finished, result, ttlMs: spec.dedupeTtlMs });
        this.pruneReplay(finished);
      }
      const digest = spec.digest?.(result);
      this.emit({
        now: finished,
        requestId,
        fingerprint,
        toolId,
        options,
        status: "succeeded",
        attempt: 1,
        durationMs: finished - started,
        ...(digest === undefined ? {} : { resultDigest: digest }),
      });
      return {
        requestId,
        toolId,
        status: "succeeded",
        result,
        attemptCount: 1,
        deduplicated: false,
        durationMs: finished - started,
      };
    } catch (err) {
      const finished = this.deps.now();
      const failureClass = classifyFailure(err, { idempotency: spec.idempotency, queryable: spec.queryable });
      if (spec.idempotency === "idempotent") {
        this.idem.release(fingerprint, finished);
      } else {
        this.idem.fail(fingerprint, finished, failureClass);
      }
      const message = err instanceof Error ? err.message : String(err);
      const failure: ExecutionFailure = {
        class: failureClass,
        message,
        retryable: retryableFor(failureClass) && spec.idempotency !== "at-most-once",
      };
      this.emit({
        now: finished,
        requestId,
        fingerprint,
        toolId,
        options,
        status: "failed",
        attempt: 1,
        durationMs: finished - started,
        failureClass,
      });
      this.deps.log?.(`[exec] 失败 tool=${toolId} class=${failureClass} msg=${message}`);
      return {
        requestId,
        toolId,
        status: "failed",
        failure,
        attemptCount: 1,
        deduplicated: false,
        durationMs: finished - started,
      };
    }
  }

  /** 超时即失败：不许无限等（QQ 窗口卡住会把整条执行链拖死）。 */
  private async withTimeout<TResult>(work: Promise<TResult>, timeoutMs: number, toolId: string): Promise<TResult> {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${toolId} 超时（${String(timeoutMs)}ms）`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private emit(event: {
    readonly now: number;
    readonly requestId: string;
    readonly fingerprint: string;
    readonly toolId: string;
    readonly options: ExecuteOptions;
    readonly status: ExecutionEvent["status"];
    readonly attempt: number;
    readonly durationMs: number;
    readonly failureClass?: string;
    readonly inputDigest?: string;
    readonly resultDigest?: string;
  }): void {
    const record: ExecutionEvent = {
      at: event.now,
      requestId: event.requestId,
      fingerprint: event.fingerprint,
      toolId: event.toolId,
      subject: event.options.subject,
      ...(event.options.target === undefined ? {} : { target: event.options.target }),
      status: event.status,
      attempt: event.attempt,
      durationMs: event.durationMs,
      ...(event.failureClass === undefined ? {} : { failureClass: event.failureClass }),
      ...(event.inputDigest === undefined ? {} : { inputDigest: event.inputDigest }),
      ...(event.resultDigest === undefined ? {} : { resultDigest: event.resultDigest }),
    };
    appendExecutionEvent(this.deps.eventsFile, record);
  }
}
