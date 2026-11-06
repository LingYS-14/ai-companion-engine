/**
 * Clock —— 补 AUDIT P1-3（v5.0 的 F3 遗留）。
 *
 * 为什么必须抽象：
 *   §10.3 的 03:00 睡眠窗、§8.2 的 86400s 洗白窗口、§6.6 的 days_since_last_recall、
 *   §4.5 的 dt 衰减、A11 跨睡眠夹具、§12.1 的 <10s 回归 —— 全部依赖"现在几点"。
 *   直接调 Date.now() 使这些全部不可测。
 *
 * 硬规则（CI 强制）：src/engine/** 与 src/plugin/** 不得出现 Date.now() / new Date()。
 */

export interface Clock {
  /** epoch ms */
  now(): number;
  /** 本地小时 0-23，用于睡眠窗判定 */
  localHour(): number;
  /** 距今日 03:00 的毫秒数（可为负 = 已过），用于离线维护触发 */
  msUntilHour(hour: number): number;
  /** 仅测试时钟可推进；生产实现必须抛错，防止误用 */
  advance(ms: number): void;
  /**
   * 是否是可推进的模拟时钟。
   * 只有为 true 时插件层的 `soul_advance` 才会自己推时间——
   * 生产环境的 SystemClock 不该被写移，因为真实时间本来就在走。
   */
  readonly simulated?: boolean;
}

/** 生产时钟：只读系统时间，不可推进 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  localHour(): number {
    return new Date(this.now()).getHours();
  }

  msUntilHour(hour: number): number {
    const d = new Date(this.now());
    const target = new Date(d);
    target.setHours(hour, 0, 0, 0);
    if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime() - d.getTime();
  }

  advance(_ms: number): void {
    throw new Error("SystemClock cannot be advanced; inject FakeClock in tests");
  }
}

/**
 * 测试时钟：可设定起点与本地小时。
 *
 * 注意 localHour 与 now 是两条独立轴：测试常常需要"时间流逝 1 小时但仍是凌晨 2 点"，
 * 这样的夹具才能覆盖 A11 的跨睡眠周期场景。
 */
export class FakeClock implements Clock {
  readonly simulated = true;
  private epochMs: number;
  private hourOverride: number | null;

  constructor(epochMs = Date.UTC(2026, 0, 1, 0, 0, 0), hourOverride: number | null = null) {
    this.epochMs = epochMs;
    this.hourOverride = hourOverride;
  }

  now(): number {
    return this.epochMs;
  }

  localHour(): number {
    if (this.hourOverride !== null) return this.hourOverride;
    return new Date(this.epochMs).getHours();
  }

  setLocalHour(hour: number): this {
    if (hour < 0 || hour > 23) throw new RangeError(`hour out of range: ${hour}`);
    this.hourOverride = hour;
    return this;
  }

  /** 推进时间；跨过 03:00 时自动把 localHour 归到推进后的真实小时 */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError("FakeClock cannot move backwards");
    this.epochMs += ms;
    if (this.hourOverride !== null) {
      this.hourOverride = (this.hourOverride + ms / 3_600_000) % 24;
    }
  }

  msUntilHour(hour: number): number {
    const diff = ((hour - this.localHour() + 24) % 24) * 3_600_000;
    return diff === 0 ? 24 * 3_600_000 : diff;
  }
}
