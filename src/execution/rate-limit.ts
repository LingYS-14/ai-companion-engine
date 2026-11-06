/**
 * 每分钟限速（P2 从 gateway 内联抽出）：软限制，只防"一拍里刷爆工具"。
 *
 * 与 `src/autonomy/pricing.ts` 的峰谷账本不是一回事：那个是钱，这个是手感。
 * 进程重启后窗口归零，这是有意的——软限制不值得落盘。
 */

export class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly windowMs: number = 60_000) {}

  /** 当前窗口内已用次数（只读，供观测） */
  count(key: string, now: number): number {
    return this.prune(key, now).length;
  }

  /** 占一个名额；超限返回 false 且不占名额 */
  tryAcquire(key: string, maxPerWindow: number, now: number): boolean {
    const window = this.prune(key, now);
    if (window.length >= maxPerWindow) {
      this.windows.set(key, window);
      return false;
    }
    window.push(now);
    this.windows.set(key, window);
    return true;
  }

  private prune(key: string, now: number): number[] {
    const window = (this.windows.get(key) ?? []).filter((at) => now - at < this.windowMs);
    this.windows.set(key, window);
    return window;
  }
}
