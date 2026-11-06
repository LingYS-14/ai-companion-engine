/**
 * 「她手上真有哪张画面可以发」——从她自己的取帧目录里挑一张能发的。
 *
 * ## 为什么需要它
 *
 * F102 记过一次事故：她在日记里写「你看我今天拍的花…这张图给你」，
 * 但 OneBot 通道压根没有发图能力，这句承诺落地成空气。
 * 现在通道有了（`qq/onebot.ts` 的 `sendPrivateImage`），还缺一个**诚实的素材来源**：
 * 她不能说「给你看」却拿不出东西。
 *
 * ## 素材从哪来
 *
 * 只有一处：她自己看视频时真的裁下来存盘的帧（`data/frames/<bvid>/f1.jpg`…，见
 * `bili/notes.ts`）。不抓网图、不拿别人的图、不用素材库——**她给你看的就是她真看过的**。
 *
 * ## 挑选规则
 *
 * 只挑「最近 24 小时内取的、文件大小像真图的」那一张，取最新。理由：
 * - 时间太久的画面她已经想不起是哪个视频了，发出去等于骗人；
 * - 太小的文件多半是裁残的（目标 9–22KB，下限 4KB 兜底）。
 *
 * 任何目录/文件错误都返回 null（发文字就行），绝不因为找不到图而让回复失败。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ShareableImage {
  /** 绝对路径（OneBot `send_private_msg` 的 image 段可以从磁盘读，这里由发送器读成 base64） */
  readonly path: string;
  /** 来自哪个视频（写日志用，不发给对方） */
  readonly bvid: string;
  readonly mtimeMs: number;
  readonly bytes: number;
}

export interface PickShareableImageOptions {
  /** 取帧根目录（形如 `data/frames`） */
  readonly root: string;
  readonly nowMs: number;
  /** 只考虑这么新的（默认 24 小时） */
  readonly maxAgeMs?: number;
  /** 小于这个字节数当废帧（默认 4KB） */
  readonly minBytes?: number;
  /** 大于这个字节数当异常文件（默认 4MB） */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_BYTES = 4 * 1024;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const FRAME_FILE = /^f\d+\.jpe?g$/i;

/**
 * 挑一张可以发出去的画面；没有就返回 null。
 *
 * 纯读：不建目录、不写文件、不改顺序以外的任何状态。
 */
export function pickShareableImage(opts: PickShareableImageOptions): ShareableImage | null {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!existsSync(opts.root)) return null;

  let dirs: string[];
  try {
    dirs = readdirSync(opts.root);
  } catch {
    return null;
  }

  let best: ShareableImage | null = null;
  for (const dir of dirs) {
    // `.sprites` 是拼图缓存，不是她取的帧；其它以点开头的一律当内部目录
    if (dir.startsWith(".")) continue;
    const dirPath = join(opts.root, dir);
    let frames: string[];
    try {
      frames = readdirSync(dirPath).filter((name) => FRAME_FILE.test(name));
    } catch {
      continue;
    }
    for (const frame of frames) {
      const path = join(dirPath, frame);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const bytes = st.size;
      if (bytes < minBytes || bytes > maxBytes) continue;
      const age = opts.nowMs - st.mtimeMs;
      if (age < 0 || age > maxAgeMs) continue;
      if (best === null || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && path < best.path)) {
        best = { path, bvid: dir, mtimeMs: st.mtimeMs, bytes };
      }
    }
  }
  return best;
}
