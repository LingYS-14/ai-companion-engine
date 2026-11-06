/**
 * 知识使用反馈（v5.2 §10.4 `on_knowledge_used`）。
 *
 * ## 为什么需要它
 *
 * 她的知识库里有 260 多条「在 B 站看到…」，但**她学到的知识和「讲出来有没有效果」
 * 之间没有任何回路**：同一条冷知识可以这周讲、下周还讲，哪怕对方每次都转移话题。
 * 规格 §10.4 给了一个很小的闭环：
 *
 *   knowledge.social_freshness  ——  ignored −0.1 / engaged +0.2
 *
 * 也就是说：她讲出去的东西，对方接住了，它就更"新"（更值得再提）；
 * 对方不接，它就更"旧"（下次检索时自然往后排，直到睡眠巩固时被 recompute 压低）。
 *
 * ## 边界
 *
 * 这里只做「反应 → 增减量」的**纯计算**：谁被用到、什么时候结算，都在调用方
 * （`plugin/runtime.ts` 记 pending，`qq/onebot-bridge.ts` 报"这句用到了哪条"）。
 * 不读盘、不碰时钟、不判断语义之外的东西——好在测试里穷举。
 *
 * 只认两种结局：`engaged`（正向回应）与 `ignored`（明确的冷处理）。
 * 读不出来的反应返回 `null`，**不猜**——把「没看懂」当成「无视」会无端压低她自己的知识。
 */

/** 对方接住了：这条知识值得再提（§10.4 engaged +0.2） */
export const SOCIAL_ENGAGED_DELTA = 0.2;

/** 对方不接：这条知识该往后排（§10.4 ignored −0.1） */
export const SOCIAL_IGNORED_DELTA = -0.1;

export type SocialReaction = "engaged" | "ignored";

/**
 * 把 bandit 那套反应标签（`dialogue/reaction.ts` 的 ImplicitReaction 与人工传入的自然语言）
 * 折成 §10.4 的两桶。
 *
 * - 升温 / 安抚 / 亲近 → engaged
 * - 冷战 / 离开 / 无视 → ignored
 * - 其他（含空串、看不懂）→ null，调用方保持 pending 不动
 */
export function classifySocialReaction(reaction: string): SocialReaction | null {
  const t = reaction.trim();
  if (t === "") return null;
  if (/升温|安抚|亲近|喜欢|谢谢|抱抱|想你/u.test(t)) return "engaged";
  if (/冷战|离开|无视|不理|冷淡/u.test(t)) return "ignored";
  return null;
}

/** 本次反应对应的 social_freshness 增减量 */
export function socialDelta(reaction: SocialReaction): number {
  return reaction === "engaged" ? SOCIAL_ENGAGED_DELTA : SOCIAL_IGNORED_DELTA;
}

/** 施加增减量并夹到 0..1（social_freshness 是比例，不能越界） */
export function applySocialDelta(social: number, reaction: SocialReaction): number {
  const next = social + socialDelta(reaction);
  if (Number.isNaN(next)) return social;
  return Math.min(1, Math.max(0, next));
}
