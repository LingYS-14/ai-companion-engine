/**
 * 脊髓：对外通道的最小反射。
 *
 * 为什么需要它（2026-10-30 实测账单）：OneBot 端点断掉 4 小时半，大脑每个 tick
 * 都照常"想一句 → 发一次 → 撞墙"，结果 34 次模型调用、34 条重复台词，
 * 日志里 456 次重连刷屏。这些都不该进大脑——通道断是**局部故障**，应该在脊髓里
 * 被吸收：连续失败到阈值就熔断一段时间，熔断期间**不再往下走**（不生成、不发送），
 * 只向大脑上行一条"通道断了"，恢复时再上行一条"通道回来了"。
 *
 * 纪律（docs/大脑与脊髓.txt）：本模块不写 state / bond / 记忆，不读配置旋钮，
 * 也不调模型。它只认"发送成功/失败"这一个信号，纯函数式状态机，时间由调用方传入
 * （src 内禁止直接读系统时钟，统一走 engine/clock，见 tools/lint/writers.mjs）。
 */

export type SpineUplinkKind = "channel-down" | "channel-up";

export interface SpineUplink {
  readonly kind: SpineUplinkKind;
  readonly at: number;
  /** 触发这次上行时的连续失败次数 */
  readonly failures: number;
}

export interface SpineOptions {
  readonly now: () => number;
  readonly log?: (line: string) => void;
  /** 上行钩子：一次故障只调一次（down），一次恢复只调一次（up） */
  readonly onUplink?: (event: SpineUplink) => void;
  /** 状态变化钩子（失败计数变化/熔断/恢复/探针失败）：装配点用它落盘快照，health 才能看见 */
  readonly onChange?: (snapshot: SpineSnapshot) => void;
  /** 连续失败多少次熔断（默认 3） */
  readonly failThreshold?: number;
  /** 熔断时长（默认 10 分钟） */
  readonly cooldownMs?: number;
}

export interface SpineGate {
  /** 这一次发送是否该尝试（熔断期间返回 false；半开状态下只放一次探针） */
  canSend(at: number): boolean;
  /** 记录一次发送结果：成功复位，失败计数并在阈值处熔断 */
  recordSend(at: number, ok: boolean): void;
  /** 通道当前是否处于熔断中（用于"熔断期间不生成台词"这种前置判断） */
  isOpen(at: number): boolean;
  /** 当前连续失败次数（给 health / 日志用） */
  readonly failures: number;
  /** 此刻的可观测快照（B.6：熔断以前只在内存里，出问题全靠翻日志） */
  snapshot(at: number): SpineSnapshot;
}

export type SpineState = "closed" | "open" | "half-open";

/** 落盘用的快照：字段都是可序列化标量，没有函数/时间对象。 */
export interface SpineSnapshot {
  readonly version: 1;
  readonly atMs: number;
  readonly state: SpineState;
  readonly failures: number;
  readonly openUntilMs: number | null;
  readonly probeAtMs: number | null;
  readonly threshold: number;
  readonly cooldownMs: number;
}

export const SPINE_FAIL_THRESHOLD = 3;
export const SPINE_COOLDOWN_MS = 10 * 60_000;
/** 一条语音发送的结果（与执行层 SendResult 同形的最小结构）。 */
export interface SpinedVoiceResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * 语音的熔断前门（B.2）：熔断中直接不尝试；放行后**不**把语音结果记入熔断计数。
 *
 * 为什么语音失败不计：语音和文字共用一条通道，但语音链路还多出 TTS/编码/上传几步；
 * 一张坏语音不该把文字也熔断掉（和图片失败不 recordSend 同一条理由）。
 * 这一层只负责「通道断着就别再试」。
 */
export async function speakVoiceThroughSpine(
  spine: SpineGate,
  at: number,
  send: () => Promise<SpinedVoiceResult>,
): Promise<SpinedVoiceResult> {
  if (!spine.canSend(at)) {
    return { ok: false, detail: "spine: 熔断中（语音未尝试发送）" };
  }
  return send();
}

/** 半开探针的租约：放出去 60 秒没有结果，就允许下一次再探，避免探针永远卡住 */
export const SPINE_PROBE_LEASE_MS = 60_000;

export function createSpineGate(options: SpineOptions): SpineGate {
  const threshold = options.failThreshold ?? SPINE_FAIL_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? SPINE_COOLDOWN_MS;
  const log = options.log;
  const uplink = options.onUplink;
  const onChange = options.onChange;

  let failures = 0;
  /** null = 闭合（正常）；非 null = 熔断到该时刻 */
  let openUntil: number | null = null;
  /** 半开状态下已经放出去一次探针的时刻 */
  let probeAt: number | null = null;
  /** 本次故障是否已经上行过（一次故障只上行一条） */
  let announced = false;

  const emit = (kind: SpineUplinkKind, at: number): void => {
    const event: SpineUplink = { kind, at, failures };
    try {
      uplink?.(event);
    } catch (err) {
      log?.(`[spine] 上行回调失败（不影响熔断）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const buildSnapshot = (at: number): SpineSnapshot => {
    const state: SpineState = openUntil === null ? "closed" : at < openUntil ? "open" : "half-open";
    return {
      version: 1,
      atMs: at,
      state,
      failures,
      openUntilMs: openUntil,
      probeAtMs: probeAt,
      threshold,
      cooldownMs,
    };
  };

  /** 变化钩子：落盘失败不能让熔断状态机挂掉（可观测性不该反过来影响功能）。 */
  const notify = (at: number): void => {
    const snapshot = buildSnapshot(at);
    try {
      onChange?.(snapshot);
    } catch (err) {
      log?.(`[spine] 状态落盘失败（不影响熔断）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const gate: SpineGate = {
    canSend(at: number): boolean {
      if (openUntil === null) return true;
      if (at < openUntil) return false;
      // 半开：只放一次探针；探针超出租约还没结果，才允许再放
      if (probeAt !== null && at - probeAt < SPINE_PROBE_LEASE_MS) return false;
      probeAt = at;
      return true;
    },
    recordSend(at: number, ok: boolean): void {
      if (ok) {
        const wasOpen = openUntil !== null;
        const hadFailures = failures > 0;
        failures = 0;
        openUntil = null;
        probeAt = null;
        if (wasOpen) {
          announced = false;
          log?.("[spine] 对外通道恢复");
          emit("channel-up", at);
        }
        // 成功且此前没有失败 = 没有变化，不必落盘（正常发送不写盘）
        if (wasOpen || hadFailures) notify(at);
        return;
      }
      failures += 1;
      probeAt = null;
      if (openUntil === null && failures >= threshold) {
        openUntil = at + cooldownMs;
        log?.(
          `[spine] 对外通道连续失败 ${String(failures)} 次，熔断 ${String(Math.round(cooldownMs / 60_000))} 分钟` +
            "（期间不生成、不发送）",
        );
        if (!announced) {
          announced = true;
          emit("channel-down", at);
        }
        notify(at);
        return;
      }
      if (openUntil !== null) {
        // 半开探针也失败了：重新起算熔断，但不重复上行
        openUntil = at + cooldownMs;
        log?.(`[spine] 探针失败，继续熔断 ${String(Math.round(cooldownMs / 60_000))} 分钟`);
      }
      notify(at);
    },
    isOpen(at: number): boolean {
      return openUntil !== null && at < openUntil;
    },
    get failures(): number {
      return failures;
    },
    snapshot(at: number): SpineSnapshot {
      return buildSnapshot(at);
    },
  };
  return gate;
}
