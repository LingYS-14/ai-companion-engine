/**
 * 对话端口（DialoguePort）：工具层「要说一句话」时能用的大脑能力，**只有签名、没有实现**。
 *
 * ## 为什么单独一个文件
 *
 * `src/ports/index.ts` 收的是「推进她往前走」（turn / recall / 人格）这种轮次级入口；
 * 这里收的是**嘴**那一段：把素材组装成两段提示词、清理模型输出、判断该不该主动开口。
 * 窗口桥（`qq/bridge.ts`）与 OneBot 桥（`qq/onebot-bridge.ts`）都要这几样，
 * 而它们都是工具层——直接 import `dialogue/*` 就是 R3 违规（2026-11 起的 CI 门禁）。
 *
 * ## 真实现由谁接
 *
 * 装配点（`plugin/index.ts`、`autonomy/qq-runner.ts`）调 `createDialoguePort()`
 * （见 `src/dialogue/port-adapter.ts`）把真实现塞进 `QQDeps.dialogue` /
 * `OneBotBridgeDeps.dialogue`。工具层只认这个接口，测试给个假的就能跑。
 *
 * ## 边界纪律
 *
 * 本文件**只放类型**：`import type` / `export type`，不许出现任何运行时值。
 * 出现实现就等于给工具层开了后门，`tools/lint/edges.mjs` 的 R3 也就白设了。
 */

import type {
  ComposedDialogue,
  ProactiveComposeInput,
  ReplyComposeInput,
} from "../dialogue/composer.js";
import type { LanguageFeatures } from "../dialogue/embodiment.js";
import type { ProactiveDecision, ProactiveInput, ProactiveIntentContext, ProactiveOptions } from "../dialogue/proactive.js";
import type { ReactionSignals } from "../dialogue/reaction.js";
import type { DialogueRecall } from "../dialogue/recall.js";

/**
 * 「嘴」的端口。
 *
 * 刻意只收桥真正用到的七个能力。**不要图省事把 `dialogue/*` 的导出全抄进来**——
 * 端口越大，工具层能碰到的大脑内部就越多，这次分层就白做了。
 */
export interface DialoguePort {
  /**
   * 回信：人格 + 这一轮的状态层 + 记忆/知识 → `{ system, user }`。
   *
   * 桥只提供素材，**不再自己拼系统提示**——所有生成入口都必须经过这一个出口
   * （见 `src/dialogue/composer.ts` 的文件头注释）。
   */
  composeReply(input: ReplyComposeInput): ComposedDialogue;
  /** 主动开口：没有人来消息，只有人格 + 模式 + 话题（判据在 `dialogue/proactive.ts`） */
  composeProactive(input: ProactiveComposeInput): ComposedDialogue;
  /** 模型输出的清理：去称呼前缀、剥「」外壳、去 emoji、去 QQ 号、按字数截断 */
  cleanReply(raw: string, maxChars?: number, peerId?: number | string): string;
  /**
   * A 层否决（v5.2 §3）：这句生成结果踩了她的禁区吗，踩了就返回摘掉那句之后的版本。
   *
   * 工具层不需要知道禁区是什么、也不用懂 A 层——它只要把要外发的句子递进来，
   * 拿回"能不能发、发什么"。F326 方案 A 起人格卡已删除，禁区清单默认为空
   * （硬安全边界在协议层/系统规则，不在卡里）；装配点建端口时传清单。
   */
  vetoTaboo(text: string): { readonly text: string; readonly hits: readonly string[] };
  /**
   * 这一句回复里**原样用到**了召回知识里的哪几条（v5.2 §10.4 的第一问）。
   *
   * 只认标题级命中：宁可漏判，也不能把"她其实没提过"的知识记成用过了。
   */
  usedKnowledge(reply: string, recall: DialogueRecall): readonly string[];
  /**
   * 自检注入的消息：生成验完但不发送、不进历史。
   * 2026-10-29 那次「自检每跑一次就往他 QQ 里发一句在呀」的防线就是它。
   */
  isSelfCheck(content: string): boolean;
  /** 工程消息/自检消息：照常回，但不写进她的情景记忆 */
  isJunkMemory(content: string): boolean;
  /**
   * 该不该主动开口：压力/反刍/疲惫/状态门（energy/trust）都在大脑里判。
   * 桥只负责把快照里的数字递进去。
   */
  decideProactive(input: ProactiveInput): ProactiveDecision;
  /**
   * 从对方这句话推「上一轮话术的反应」（§7.4 bandit 记分用）。
   *
   * 读不出来返回 `null`——桥会原样把 null 转成「这一轮不打分」。
   * 工具层不需要知道阈值，也不该自己判。
   */
  inferReaction(signals: ReactionSignals): string | null;
  /**
   * 她这句话是不是在说「我给你看张图」。
   *
   * 用途只有一个：真发图之前在**同一个出口**判一次，别让工具层自己写正则。
   * 判据是纯模式匹配（`dialogue/attachment.ts`），不理解语义——所以桥拿到的
   * 只是「要不要找一张图附上」，找不到图就照常只发文字。
   */
  wantsImage(text: string): boolean;
  /**
   * 没图就别空口承诺（F102 欠账）：把她这句话里提到图/照片的句子摘掉。
   *
   * 为什么和 `wantsImage` 分开两条：`wantsImage` 回答"要不要找张图附上"，
   * 这一条回答"找不到图时这句话还能不能原样发"。两条判据不同——
   * 前者只认递图动作，后者要把所有提图的句子都摘掉（没图时它们都是空话）。
   */
  stripImagePromise(text: string): { readonly text: string; readonly removed: readonly string[] };
  /** 缺省主动开口阈值（`enabled` / `minGapMs` / `maxPerDay` / 静默时段） */
  readonly defaultProactive: ProactiveOptions;
}

/**
 * 语言特征端口：把一句话拆成 §4.10 的 `LanguageFeatures`（纯函数，没有状态）。
 *
 * `psychology/appraisal-qq.ts` 是大脑层的启发式估计器（F297 搬移），它需要大脑层的分词/长度特征；
 * 直接 import `dialogue/embodiment.ts` 会违规，所以由装配点把函数塞进 deps。
 */
export interface LanguagePort {
  /** 纯函数：同一句话永远得到同一份特征 */
  features(text: string): LanguageFeatures;
}

/** 召回结果（`dialogue/recall.ts` 的形状）：桥把「她记得的事 / 最近学到的东西」递进提示词 */
export type { DialogueRecall } from "../dialogue/recall.js";
export type { ProactiveInput, ProactiveDecision, ProactiveOptions, ProactiveIntentContext } from "../dialogue/proactive.js";
export type {
  ComposedDialogue,
  ProactiveComposeInput,
  ReplyComposeInput,
} from "../dialogue/composer.js";
export type { LanguageFeatures } from "../dialogue/embodiment.js";
