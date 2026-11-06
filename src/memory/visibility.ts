/**
 * §8.3 隐私隔离：**这一条记忆，眼前这个人有没有资格听**。
 *
 * 规格的原文（v5.2 §8.3）是一个按渠道过滤的 `retrieve_scoped`：
 *
 *     visible = (source == current_channel)
 *            | (source == "shared_self" and layer == "L2" and is_shared_self_valid(source))
 *
 * 本仓库把它映射成两层（因为这里没有 `current_channel` 这种运行时概念，
 * 记忆上真正有的字段是 `source`、`participants`、和新增的 `allow_share`）：
 *
 *   1. **主人**（用户本人 / DSH 宿主 / 她自己的进程）看得到全部——她是为一个人活的，
 *      连"她怎么想"都给这个人看；这条不是宽松，是产品定义。
 *   2. **访客**（将来群里/别的联系人）只看到两类：
 *      a. `allow_share === true` 的记忆——规格里的 `shared_self`：她**明确愿意分享**的；
 *      b. `participants` 里有这个人的对话记录——他自己的话，回给他不算泄露。
 *      其余一律不可见，包括 `selftalk`（她自己的内心话不当众说）。
 *
 * 为什么"不可见"要落在检索层而不是提示词层：提示词里删掉一段，模型仍然可能
 * 从别处拼出来；检索层根本不把它取回来，才叫隔离。
 */

import type { Visitor } from "../ports/visitor.js";
import type { MemoryRecord } from "./types.js";

/** 公共面在 src/ports/visitor.ts（工具层要能用，但不能 import 大脑内部实现） */
export type { Visitor } from "../ports/visitor.js";

/** 一条记忆能不能给这个访客看（规则见文件头；纯函数，便于测） */
export function isVisibleTo(
  rec: Pick<MemoryRecord, "source" | "participants" | "allow_share">,
  visitor: Visitor,
): boolean {
  if (visitor.owner) return true;
  // 她自己的内心话，永远不对访客说（即使被误打了 allow_share 也不放行）
  if (rec.source === "selftalk") return false;
  // shared_self：她明确愿意分享的（只有用户能给她打上这个标，见 soul_remember 的 allow_share）
  if (rec.allow_share === true) return true;
  // 回他自己的话：participants 里有他，不算泄露
  const contactId = visitor.contactId;
  if (contactId !== undefined && contactId !== "" && rec.participants.includes(contactId)) return true;
  return false;
}

/** 按访客过滤一批记录（顺序保持不变：检索的顺序是有意义的） */
export function visibleTo<T extends Pick<MemoryRecord, "source" | "participants" | "allow_share">>(
  records: readonly T[],
  visitor: Visitor,
): T[] {
  if (visitor.owner) return [...records];
  return records.filter((rec) => isVisibleTo(rec, visitor));
}
