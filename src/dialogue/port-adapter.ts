/**
 * 端口适配器：把大脑里那几样「嘴」的能力装进 `DialoguePort`。
 *
 * ## 为什么需要这一层
 *
 * `qq/bridge.ts` 与 `qq/onebot-bridge.ts` 都是工具层，按分层规则不许 import
 * `dialogue/*` 的实现（R3）。但桥确实需要组装提示词、清理输出、判断是否主动开口。
 * 解决办法不是让桥伸手去拿，而是**装配点把实现塞给桥**：
 *
 *   plugin/index.ts  ──►  createDialoguePort()  ──►  new QQBridge(…, { dialogue, … })
 *
 * 于是桥只认 `src/ports/dialogue.ts` 里的接口，测试塞个假的也能跑。
 *
 * ## 为什么以函数为单位、而不是塞整个模块
 *
 * 端口只暴露桥真正用到的七个能力（见 `DialoguePort`）。多暴露一项，
 * 工具层能碰到的脑内实现就多一块——分层门禁要挡的正是这个方向。
 *
 * ## 这个文件为什么在 `dialogue/` 而不是 `ports/`
 *
 * 它**有实现**（哪怕只是转发），`src/ports/` 的纪律是「只放类型」。
 * 放在大脑层、只 import 端口的类型，编译后端口那几行全消失，不产生任何边。
 */

import { detectImageIntent, stripImagePromise } from "./attachment.js";
import { filterTaboo } from "../engine/personality.js";
import { isJunkMemory, isSelfCheck } from "../maintenance/memory-hygiene.js";
import type { DialoguePort, LanguagePort } from "../ports/dialogue.js";
import type { Persona } from "./persona.js";
import { composeDialogue } from "./composer.js";
import { preprocessLanguageFeatures } from "./embodiment.js";
import { DEFAULT_PROACTIVE, decideProactive } from "./proactive.js";
import { inferReaction } from "./reaction.js";
import { usedKnowledgeIds } from "./recall.js";
import { cleanReply } from "./prompt.js";

/**
 * 造一个 `DialoguePort`。
 *
 * 纯转发，没有状态——所以每次装配都新建一个也没有代价，
 * 不需要缓存单例（缓存反而容易让测试之间串味）。
 */
export function createDialoguePort(persona: Persona | null = null): DialoguePort {
  // F326 方案 A：人格卡已删除，机械禁区清单没有来源了（清单为空、机制保留）。
  // 身份协议写在提示词里（prompt.ts 的 PROTOCOL_IDENTITY，4 条身份协议；2026-11-02 用户裁决把原 5 条安全条款去掉了），
  // 属于软约束而非代码硬过滤；不再从卡里读 `personality.a.taboos`。
  // 参数保留只为调用形状兼容（批量接线点不逐处改）。
  void persona;
  const taboos: readonly string[] = [];
  return {
    composeReply: (input) => composeDialogue(input),
    composeProactive: (input) => composeDialogue(input),
    cleanReply: (raw, maxChars, peerId) => cleanReply(raw, maxChars, peerId),
    vetoTaboo: (text) => filterTaboo(text, taboos),
    usedKnowledge: (reply, recall) => usedKnowledgeIds(reply, recall.knowledge, recall.knowledgeIds),
    isSelfCheck: (content) => isSelfCheck(content),
    isJunkMemory: (content) => isJunkMemory(content),
    decideProactive: (input) => decideProactive(input),
    wantsImage: (text) => detectImageIntent(text),
    stripImagePromise: (text) => stripImagePromise(text),
    inferReaction: (signals) => inferReaction(signals),
    defaultProactive: DEFAULT_PROACTIVE,
  };
}

/**
 * 造一个 `LanguagePort`：`psychology/appraisal-qq.ts`（F297 从 tools 层搬进大脑层） 要的 `LanguageFeatures` 特征提取。
 *
 * 同样是纯函数转发——工具层拿到的只是「这句子多长、有没有问号」这类数字。
 */
export function createLanguagePort(): LanguagePort {
  return {
    features: (text) => preprocessLanguageFeatures(text),
  };
}
