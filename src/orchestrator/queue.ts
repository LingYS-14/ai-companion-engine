/**
 * §4.9 / D5：入站事件队列。
 *
 * 规格把阶段 0 的第一个条件写成 `event_queue.is_empty()`，D5 裁决把它定义成
 * **"当前有没有还没处理完的入站事件"**：入站 push、处理完 pop、出站不入队、重启后为空。
 *
 * 为什么要它：如果没有这道门，proactive 的定时检查可能在她正在读消息/生成回复时插一句，
 * 观感上是"抢话"，而且会把两条回复的先后顺序打乱。队列只做"忙不忙"的信号，不缓存文本
 * （缓存了就得决定重复/乱序/丢失策略，那是另一个坑）。
 */

export class EventQueue {
  private pending = 0;

  /** 入站事件开始处理 */
  push(): void {
    this.pending += 1;
  }

  /** 处理完毕（异常路径也要调，否则"忙"会永远为真） */
  pop(): void {
    if (this.pending > 0) this.pending -= 1;
  }

  get isEmpty(): boolean {
    return this.pending === 0;
  }

  get size(): number {
    return this.pending;
  }
}
