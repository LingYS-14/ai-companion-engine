/**
 * §6.5 里 `m.suppressed_by_stronger` 的**写入方**（G6-⑤）。
 *
 * ## 为什么这个文件是"自拟规则"
 *
 * 规格在 §6.5 `tick()` 里读 `m.suppressed_by_stronger`（读到就把 vividness 再乘一次衰减），
 * 在 §6.6 `rerank()` 里读它（读到就扣 `RETRIEVAL_PENALTIES.suppressed`），`suppression_strength`
 * 还给了初值 0.0 —— 但**全文没有任何地方写这两个字段**。也就是说规格描述了一个"被更强的记忆
 * 压下去"的现象，却把机制留空（记在 `docs/DESIGN.md` F27）。
 *
 * 用户已授权自拟。规则取最小可辩护集：
 *
 *   1. 强度 = 鲜活度 × 可信度（两个字段都在 §6.2 的 27 字段里，都是 0..1）；
 *   2. 只有**共享标签**的记忆才互相竞争（标签是"在说同一件事"的唯一现成依据）；
 *   3. 强度差必须跨过 `SUPPRESS_MARGIN` 才压制，否则两条都留着 —— 平手不该被随机淘汰；
 *   4. 压制是**可逆**的：败者后来被反复想起、变强了，就会解除压制。
 *      不可逆的压制等于永久删除，而规格只给了软遗忘（`forgotten`），不给硬压制。
 *
 * 这三个数字（margin 0.15、可逆阈值 margin/2、strength 的定义）是工程取值，不是规格值；
 * 它们只出现在这里一处，将来规格补真值时替换此文件即可。
 */

import type { MemoryRecord } from "./types.js";

/** 强度差小于它就视为平手，两条记忆都保持可见 */
export const SUPPRESS_MARGIN = 0.15;

/** 解除压制需要的反向优势（比压制门槛低，避免在门槛附近来回翻转） */
export const RELEASE_MARGIN = SUPPRESS_MARGIN / 2;

export interface SuppressionPatch {
  readonly id: string;
  readonly suppressed: boolean;
  readonly strength: number;
  readonly reason: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 一条记忆的"强度"：鲜活度 × 可信度。两者都在 schema 里，不引入新字段 */
export function memoryStrength(m: MemoryRecord): number {
  return clamp01(m.vividness) * clamp01(m.confidence);
}

function sharesTag(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.tags.length === 0 || b.tags.length === 0) return false;
  const set = new Set(a.tags);
  return b.tags.some((t) => set.has(t));
}

/**
 * 给定"刚刚写入的记录"与"库里其他活动记录"，算出需要落库的压制补丁。
 *
 * 纯函数：不写库，只返回 `SuppressionPatch[]`，由调用方经 `store.mutate()` 落盘。
 * 空数组 = 无需改动（最常见的情形）。
 */
export function reconcileSuppression(
  incoming: MemoryRecord,
  others: readonly MemoryRecord[],
): readonly SuppressionPatch[] {
  const patches: SuppressionPatch[] = [];
  const sIn = memoryStrength(incoming);

  for (const other of others) {
    if (other.id === incoming.id) continue;
    if (other.forgotten) continue;
    if (!sharesTag(incoming, other)) continue;
    const sOther = memoryStrength(other);
    const diff = sIn - sOther;

    // 新记录更强：压住旧的
    if (diff >= SUPPRESS_MARGIN) {
      if (!other.suppressed_by_stronger || other.suppression_strength === 0) {
        patches.push({
          id: other.id,
          suppressed: true,
          strength: clamp01((diff - SUPPRESS_MARGIN) / (1 - SUPPRESS_MARGIN)),
          reason: `共享标签上被更强的记忆压住（强度差 ${diff.toFixed(4)}）`,
        });
      }
      continue;
    }

    // 旧的更强：压住刚写进来的这条
    if (-diff >= SUPPRESS_MARGIN) {
      patches.push({
        id: incoming.id,
        suppressed: true,
        strength: clamp01((-diff - SUPPRESS_MARGIN) / (1 - SUPPRESS_MARGIN)),
        reason: `同标签已有更强记忆（强度差 ${(-diff).toFixed(4)}）`,
      });
      // 旧记录若曾因更弱而被压制，但现在已经反超，解除
      if (other.suppressed_by_stronger && -diff >= RELEASE_MARGIN) {
        patches.push({ id: other.id, suppressed: false, strength: 0, reason: "强度反超，解除压制" });
      }
      continue;
    }

    // 平手：都保留；若其中一条曾被压制且已不再显著更弱，解除
    if (other.suppressed_by_stronger && -diff >= RELEASE_MARGIN) {
      patches.push({ id: other.id, suppressed: false, strength: 0, reason: "强度已追平，解除压制" });
    }
  }

  return patches;
}
