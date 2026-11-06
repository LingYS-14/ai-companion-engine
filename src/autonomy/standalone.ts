/**
 * 真实端口：把自主循环接到「大脑端口」上（装配点负责递真实现，这里不认识具体类）。
 *
 * 与 dry-run 端口的区别只在「做不做」：这里会推进状态、写内部言语日志、学习知识、跑巩固。
 * 它不生成聊天台词（那是 composer + QQ 桥的事），也不发消息——QQ 桥关着时 proactive 永远不放行。
 *
 * 峰谷调度在这里落地：内部言语不是按固定 30 分钟，而是按「注册表基础间隔 × 峰谷缩放」；
 * 一小时内调用超上限就退避到峰时节奏并记审核（见 pricing.ts）。
 */

import type { EngineConfig } from "../engine/config.js";
import { dayKey } from "./tick-plan.js";
import { chatComplete, type FetchLike, type LlmConfig, formatUsageLog } from "./llm.js";
import type { AdvanceOutcome, AutonomyPort, ConsolidateOutcome, InsightOutcome, LearnOutcome, PortLearnInput, ProactiveOutcome, ReconsolidateOutcome, SelfTalkOutcome, SocialOutcome } from "./port.js";
import { buildLearningWebPlan } from "./port.js";
import { isRestDay, pacingFor, rateAlert, scaledIntervalMs, type WindowPacing } from "./pricing.js";
import { describeSpeechReserve, shouldYieldForSpeech } from "./speech-reserve.js";
import { loadUsage, recordUsage } from "./usage.js";
import { pendingReview, raiseReview, releaseReviewIfRecovered } from "./review.js";
import type { IntentNote } from "../dialogue/composer.js";
import { SelftalkJournal } from "../maintenance/selftalk-journal.js";
import { runSelfTalk, selfTalkIntervalMs } from "../maintenance/selftalk-runner.js";
import {
  humanize,
  selftalkMood,
  shouldSpeak,
  topicWasSpokenRecently,
} from "../maintenance/selftalk-voice.js";

/**
 * 主动开口时给别的动作留的额度。
 *
 * 峰时上限 6/h，而 brain 每 5 分钟就想主动说一句（12/h）——两件事叠在一起必然冲破上限，
 * 然后一张审核票据把她整小时哑掉。留 2 格给 learn/selftalk，主动开口只用到 cap-2，
 * 频率审核就不再被"正常节奏"触发（23:00 实测：7 次/小时全是部署重启内省，不是她乱刷）。
 */

/**
 * 她主动找人说话的静默时段（本地小时）：23–7 点不打扰，白天/晚上才可能开口。
 *
 * A6/D1：这与意图引擎的静默窗统一为 23–7（此前这里 0–7、引擎里 23–7，两份事实不一致）。
 * 唯一事实在 `src/contracts/quiet-hours.ts`（F268）；脊髓层按 R2 不能 import 大脑，
 * 所以这里保留字面量并导出，由 `test/quiet-hours.test.ts` 锁住两处相等。
 * 只在**旧机械门**（没有意图引擎拍板的路径，如 DSH 插件形态）上生效；
 * 常驻进程里意图引擎会把"现在几点"当情境给她，由她自己决定说还是先不说（HOLD）。
 */
export const SPEAK_QUIET_FROM = 23;
export const SPEAK_QUIET_TO = 7;
import type { MemoryStore } from "../memory/store.js";
import type { EnergyCostKind, SState } from "../engine/state.js";
import type { AdvanceSummary, ConsolidateSummary } from "../ports/index.js";
import { learnTierOf, learnTierReasonOf, type LearnTier } from "../learning/energy-budget.js";

/**
 * 脊髓需要的「大脑」面：只列它真的用到的三样。
 *
 * P0-3（审计 2026-10-31）：这里原来是拿装配点类的四个方法做切片——脊髓层直接指着装配点，
 * 等于端口只挡住了工具层。改成结构接口后，脊髓不 import `plugin/runtime.ts`，
 * 装配点只负责把 SoulRuntime 递进来；换实现（或测试里的假实现）不需要改这里。
 *
 * memoryStore/state 仍是大脑类型的直读（spine→brain 是允许方向），
 * 但它们被收进同一个窄接口，不再意味着"脊髓认识 SoulRuntime 这个类"。
 */
export interface StandaloneRuntime {
  advance(hours: number): AdvanceSummary;
  consolidate(opts?: { minSize?: number }): ConsolidateSummary;
  memoryStore(): MemoryStore;
  readonly state: SState;
}

export interface StandaloneDeps {
  readonly runtime: StandaloneRuntime;
  readonly cfg: EngineConfig;
  readonly journal: SelftalkJournal;
  readonly now: () => number;
  readonly localHour: () => number;
  readonly tzOffsetMinutes?: number | undefined;
  /** 节假日表（YYYY-MM-DD），由脚本从 data/holidays.txt 读入 */
  readonly holidays?: readonly string[] | undefined;
  /** 调休上班日（周末但上班），由脚本从 data/workdays.txt 读入 */
  readonly workdays?: readonly string[] | undefined;
  /** 频率账本文件；给了就跨重启保留最近一小时的调用时刻（见 usage.ts） */
  readonly usageFile?: string | undefined;
  /** 审核队列文件；超速时落一条警报并停止模型调用，等人清（见 review.ts） */
  readonly reviewFile?: string | undefined;
  /** 有 key 才调模型；没有就降级模板（仍然自言自语，只是不花钱） */
  readonly llm?: LlmConfig | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly personaName?: string | undefined;
  /**
   * 学习通路由脚本注入（复用 bili + KnowledgeStore 的现成实现）；tier 由本层按能量判定。
   *
   * W1：第二个参数只在 explore-only 入口（`port.learn({exploreNow:true})`）时给；
   * 普通拍不传，装配点的实现必须按旧行为处理（不许从别处猜 explore）。
   */
  readonly learnImpl?: ((tier: LearnTier, input?: PortLearnInput) => Promise<LearnOutcome>) | undefined;
  /**
   * 睡眠巩固之后的洞见生成（v5.2 §7.3 的 extract_insight）。
   *
   * 由宿主接线：选簇、组提示词、调模型、校验、落库（四道闸在 `submitInsight` 里）。
   * 这里只负责"该不该现在做、做完记账"——模型与候选逻辑不进脊髓的动作层，
   * 否则这个函数就没法在不联网的测试里跑。
   */
  readonly insightImpl?: (() => Promise<InsightOutcome>) | undefined;
  /**
   * §5.4 再巩固：把「同一件事、现在的看法翻了面」的旧记忆重新解释一版（模型调用）。
   *
   * 用户 2026-10-31 裁决 A：允许调一次模型拿解释，但只写 `interpretation`，
   * 不改情绪数值、不删旧版（版本链在 `version-file.ts`）。由宿主接线：
   * 选候选、组提示词、调模型、校验、落盘；这里只负责"该不该现在做、做完记账"。
   */
  readonly reconsolidateImpl?: (() => Promise<ReconsolidateOutcome>) | undefined;
  /**
   * §10.1 第 5 段：把「睡眠缓冲」里昨晚攒下的开放世界候选真的写进知识库。
   *
   * 为什么放在巩固这一拍：规格要求"不当场写"——学习时只是看见，睡一觉才决定什么值得记住。
   * 由宿主接线（缓冲文件 + ingestVideos）；这里只负责"巩固完就消化、消化失败不拖垮巩固"。
   */
  readonly drainFunnel?: (() => { readonly drained: number; readonly ingested: number }) | undefined;
  /** 主动开口：QQ 桥关着时脚本不注入，端口就永远返回「未开放」 */
  readonly proactiveImpl?: (() => ProactiveOutcome | Promise<ProactiveOutcome>) | undefined;
  /**
   * 外部互动（B 站刷视频 / 弹幕 / 评论 / 点赞）。
   *
   * 这一层只管三件事：睡眠时跳过、有审核票据时退避、成功后扣 `social` 能耗。
   * 「今天还能发几条弹幕/评论」「这条视频点过赞没有」属于平台账本，由脚本的
   * socialImpl 自己读 `data/social-<id>.ndjson` 判定——脊髓层不认识 B 站。
   */
  readonly socialImpl?: (() => SocialOutcome | Promise<SocialOutcome>) | undefined;
  /**
   * P1：意向引擎的一拍纯计算（可选）。
   *
   * 装配时注入才会跑；没注入 = 完全回到旧行为。它**不发消息、不调模型**——
   * P1 先只做 shadow（把"她想说什么/被什么拦下"写进观测文件），切真要等用户点头。
   */
  readonly intentTickImpl?: (() => void | Promise<void>) | undefined;
  /**
   * P1：自言自语时的「此刻的由头」（可选）。
   *
   * 与 `intentTickImpl` 同源：脚本把同一拍的自述递进来，`runSelfTalk` 只在生成时把它
   * 多写进 system 提示词；不注入 = 旧提示词一个字不变。它**不强制**她说这件事。
   */
  readonly intentNoteImpl?: (() => IntentNote | undefined) | undefined;
  /**
   * 把「心里那句话」真的发出去（内部言语 → 对外表达）。
   * 脚本不注入时她只写日记、不打扰人——这是「会不会烦人」的总闸。
   */
  readonly speakImpl?: ((text: string) => Promise<{ readonly ok: boolean; readonly detail: string }>) | undefined;
  /**
   * P3-2b：睡眠相位（可选）。注入后 learn / proactive / selftalk 在 asleep 时硬跳过——
   * 这不是"她决定不说"，是调度层暂停；stateTick / advance / consolidate 照常跑。
   * 不注入 = 完全旧行为（测试与旧装配点不受影响）。
   */
  readonly sleepState?: (() => { readonly asleep: boolean; readonly phase: string }) | undefined;
  /**
   * P3-3：当前能量（可选）。注入后学习按能量分档（full/search/hot/skip）；
   * 不注入 = 按满电 1.0 处理，回到旧行为（full）。
   */
  readonly energy?: (() => number) | undefined;
  /**
   * P3-2b：B 通道扣能（可选）。由装配层注入 `runtime.spendEnergy` 的绑定。
   *
   * 为什么要注入而不是 import：脊髓层是 spine，按 R2 不能 import plugin/runtime；
   * 它只知道"发生了一次认知事件"，能耗单价与扣法留在大脑侧。
   */
  readonly spendEnergy?: ((kind: EnergyCostKind) => void) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface StandalonePort extends AutonomyPort {
  /** 最近一次峰谷判定的原因（诊断用） */
  pacing(): WindowPacing | undefined;
}

export function createStandalonePort(deps: StandaloneDeps): StandalonePort {
  let lastSelfTalkAt = 0;
  let callTimes: number[] = deps.usageFile === undefined ? [] : loadUsage(deps.usageFile, deps.now());
  let lastPacing: WindowPacing | undefined;
  /** 上次把节奏写进日志时的签名；只在相位/休息日/上限变化时记一行，避免每拍刷屏 */
  let lastPacingLogged = "";

  const prune = (now: number): void => {
    callTimes = callTimes.filter((t) => now - t < 3_600_000);
  };

  /** 记一次模型调用；有账本文件就同时落盘，重启后仍算数。 */
  /** 超速就落一条审核警报；返回 true 表示这一轮不许调模型 */
  const tripReview = (calls: number, maxCalls: number, reason: string): boolean => {
    if (deps.reviewFile === undefined) return false;
    const raised = raiseReview(deps.reviewFile, { at: deps.now(), reason, calls, maxCalls }, deps.now());
    if (raised !== null) deps.log?.(`[standalone] 已转入人工审核：${reason}`);
    return true;
  };

  /**
   * 有人工审核未清 → 模型调用一律停（状态 tick / 巩固仍可跑，它们不花钱）。
   * 但票据不是"判死刑"：如果最近一小时已经回落到上限以内（常见于部署/验证造成的尖峰），
   * 下一拍就自动解除，不把她整夜哑掉。
   */
  const suspended = (): boolean => {
    if (deps.reviewFile === undefined) return false;
    if (pendingReview(deps.reviewFile, deps.now()) === null) return false;
    prune(deps.now());
    const p = currentPacing();
    if (releaseReviewIfRecovered(deps.reviewFile, callTimes.length, p.maxCallsPerHour, deps.now())) {
      deps.log?.(`[standalone] 审核票据自动解除：窗口已回落到 ${String(callTimes.length)}/${String(p.maxCallsPerHour)}`);
      return false;
    }
    return true;
  };

  const recordCall = (): void => {
    const now = deps.now();
    callTimes = deps.usageFile === undefined ? [...callTimes, now] : recordUsage(deps.usageFile, callTimes, now);
  };

  const currentPacing = (): WindowPacing => {
    const now = deps.now();
    const local = dayKey(now, deps.tzOffsetMinutes ?? 0);
    const p = pacingFor({
      now,
      tzOffsetMinutes: deps.tzOffsetMinutes,
      restDay: isRestDay(local, deps.holidays ?? [], deps.workdays ?? []),
    });
    lastPacing = p;
    if (p.reason !== lastPacingLogged) {
      lastPacingLogged = p.reason;
      deps.log?.(`[standalone] 节奏 ${p.reason}`);
    }
    return p;
  };

  return {
    pacing: () => lastPacing,
    advance: (dtHours: number): AdvanceOutcome => {
      // 状态推进不花钱，但它是唯一每 5 分钟必跑的动作：顺便清掉已回落的审核票据，
      // 否则票据要等到下一次 learn（最长 45 分钟）才可能解除。
      suspended();
      const out = deps.runtime.advance(dtHours);
      deps.log?.(`[standalone] advance dt=${dtHours.toFixed(2)}h steps=${String(out.steps)} faded=${String(out.faded)}${out.taintCleared > 0 ? ` taintCleared=${String(out.taintCleared)}` : ""}`);
      return { ticks: out.steps };
    },
    learn: async (input?: PortLearnInput): Promise<LearnOutcome> => {
      // P3-2b：睡着时学习硬跳（不调模型、不花额度）——睡眠窗口内她不该有新的"看见"
      if (deps.sleepState?.().asleep === true) {
        deps.log?.("[standalone] learn 跳过：睡眠中（P3）");
        return { topic: "skipped", keyword: "睡眠中" };
      }
      // P3-3：能量决定这一拍还有多少力气——档位在脊髓判定，装配点只按档位接线（R4）
      const energy = deps.energy?.() ?? 1;
      const tier = learnTierOf(energy);
      if (tier === "skip") {
        deps.log?.(`[learn] ${learnTierReasonOf(energy, tier)} 跳过（低能量）`);
        // 完全休息：不调学习通路、不计频率账、不扣能、不推进轮转
        return { topic: "skipped", keyword: "低能量" };
      }
      deps.log?.(`[learn] ${learnTierReasonOf(energy, tier)}`);
      // P3-3（Lead task-72 裁定）：hot 档只拉热榜——1 次 HTTP、不调模型、不占额度，
      // 所以必须排在审核/频率门之前（规格 §5「热榜 >0.25 永远开」）。
      if (tier === "hot") {
        if (deps.learnImpl === undefined) return { topic: "skipped", keyword: "学习通路未接线" };
        // hot 档不算网页学习计划（只有 full 才可能查网页），input 也原样透传
        return await deps.learnImpl("hot", input);
      }
      // 常规 full/search：学习是模型/网络调用，计入频率审核；未注入就诚实说「未接线」
      if (suspended()) {
        deps.log?.("[standalone] learn 跳过：有人在等她这次审核（autonomy-review.json 还在）");
        return { topic: "skipped", keyword: "人工审核中" };
      }
      const p = currentPacing();
      prune(deps.now());
      const alert = rateAlert(callTimes.length, p);
      if (alert.alert) {
        tripReview(callTimes.length, p.maxCallsPerHour, alert.reason);
        deps.log?.(`[standalone] learn 跳过：${alert.reason}`);
        return { topic: "skipped", keyword: "频率审核中，退避" };
      }
      if (deps.learnImpl === undefined) return { topic: "skipped", keyword: "学习通路未接线" };
      recordCall();
      const learned = await deps.learnImpl(tier, input);
      // P3-3 计费：learn 只对真学习的 full/search 收；hot 是兜底路径，豁免
      if (learned.topic !== "skipped") {
        deps.spendEnergy?.("learn");
      }
      // 深读是额外认知成本：按实际深读条数收（统一在脊髓扣，装配点只回报数字，防双扣）
      if ((learned.deepReads ?? 0) > 0) deps.spendEnergy?.("learn_deep");
      // W1（spec v2.3 §5.3）：只有 full 档才带网页计划。plan 只回答「该不该查」；
      // 发网络/判 URL/碰额度都在装配层（R4），脊髓不 import `src/web`。
      const webPlan =
        tier === "full"
          ? buildLearningWebPlan({
              tier,
              exploreNow: input?.exploreNow === true,
              biliEmpty: learned.biliEmpty === true,
              keyword: learned.keyword,
            })
          : undefined;
      return webPlan === undefined ? learned : { ...learned, webPlan };
    },
    consolidate: async (): Promise<ConsolidateOutcome> => {
      const out = deps.runtime.consolidate();
      deps.log?.(
        `[standalone] consolidate clusters=${String(out.written)} refreshed=${String(out.refreshed ?? 0)}` +
          // §5.4 人格漂移只在"真的动了"时才有这一节：不动才是常态，别把噪声写成新闻。
          // §8.4 三重防护拒掉某些维度时，把拒因也带出来（不然只会看到"漂得比预期少"而不知道为什么）。
          (out.drift === undefined ? "" : ` drift=${out.drift.note}`) +
          (out.drift?.guarded === undefined ? "" : ` guarded=${out.drift.guarded}`),
      );
      const base = { accepted: out.accepted.length, rejected: out.rejected.length };

      // 睡眠缓冲在这里消化：先巩固睡眠簇，再把昨晚看见的候选写进知识库。
      // 顺序不能反——先写知识的话，同一晚的巩固会把还没消化的内容当成"今天的经历"再收一遍。
      if (deps.drainFunnel !== undefined) {
        try {
          const funnel = deps.drainFunnel();
          deps.log?.(`[standalone] funnel drained=${String(funnel.drained)} ingested=${String(funnel.ingested)}`);
        } catch (err) {
          // 消化失败不回滚巩固：知识晚一晚写进去没关系，别让她凌晨那次巩固白做
          deps.log?.(`[standalone] funnel 消化失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 洞见是模型调用，得和 learn 一样过审核与频率闸：它发生在凌晨 3 点那一拍，
      // 如果这一小时已经超速，就宁可不写（今晚不学，明天还有）。
      let outcome: ConsolidateOutcome = base;

      /**
       * 巩固之后的模型调用统一过闸：审核 → 额度 → 记账。
       *
       * 洞见和再巩固共用这一套，而不是各写一遍——两处各写一遍时，
       * 第二处忘记账就会把一个"每夜一次"的调用变成"不受额度约束的调用"（F126 的老毛病）。
       */
      const modelStep = async <T>(label: string, run: () => Promise<T>, onSkip: (reason: string) => T): Promise<T> => {
        if (suspended()) {
          const reason = "审核中（退避）";
          deps.log?.(`[standalone] ${label} 跳过：${reason}`);
          return onSkip(reason);
        }
        const p = currentPacing();
        prune(deps.now());
        // 用户 2026-10-31 裁决 A：后台活动给「开口/回信」留一次预算（speech-reserve.ts）。
        const yieldNote = shouldYieldForSpeech({ usedCalls: callTimes.length, maxCalls: p.maxCallsPerHour })
          ? describeSpeechReserve({ usedCalls: callTimes.length, maxCalls: p.maxCallsPerHour })
          : null;
        if (yieldNote !== null) {
          const reason = `${yieldNote ?? "给开口留额度"}（${label} 让路）`;
          deps.log?.(`[standalone] ${label} 跳过：${reason}`);
          return onSkip(reason);
        }
        if (callTimes.length + 1 > p.maxCallsPerHour) {
          const reason = `额度不够（已用 ${String(callTimes.length)}/${String(p.maxCallsPerHour)}）`;
          deps.log?.(`[standalone] ${label} 跳过：${reason}`);
          return onSkip(reason);
        }
        recordCall();
        try {
          return await run();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          deps.log?.(`[standalone] ${label} 失败：${reason}`);
          return onSkip(reason);
        }
      };

      const insightImpl = deps.insightImpl;
      if (insightImpl !== undefined) {
        const insight = await modelStep<InsightOutcome>("insight", () => insightImpl(), (reason) => ({
          tag: "",
          stored: false,
          reason,
        }));
        if (insight.tag === "") deps.log?.(`[standalone] insight 跳过：${insight.reason}`);
        else deps.log?.(`[standalone] insight tag=${insight.tag} stored=${String(insight.stored)}${insight.reason === "" ? "" : ` reason=${insight.reason}`}`);
        outcome = { ...outcome, insight };
      }

      // §5.4 再巩固：允许调一次模型拿「现在的我这么理解」，但写盘/上限/链指针都在
      // version-file 层，这里只负责"该不该现在做、做完记账"——失败只记日志，不拖垮本晚的巩固。
      const reconsolidateImpl = deps.reconsolidateImpl;
      if (reconsolidateImpl !== undefined) {
        const reconsolidated = await modelStep<ReconsolidateOutcome>("再巩固", () => reconsolidateImpl(), (reason) => ({
          patched: 0,
          reason,
        }));
        deps.log?.(
          `[standalone] 再巩固：patched=${String(reconsolidated.patched)}` +
            (reconsolidated.reason === "" ? "" : ` reason=${reconsolidated.reason}`),
        );
        outcome = { ...outcome, reconsolidated };
      }
      return outcome;
    },
    proactive: async (): Promise<ProactiveOutcome> => {
      // P3-2b：睡着时不开口——这是硬闸（比意图引擎的 HOLD 更早），不产生模型调用
      if (deps.sleepState?.().asleep === true) {
        deps.log?.("[standalone] proactive 跳过：睡眠中（P3）");
        return { opened: false, reason: "睡眠中" };
      }
      if (deps.proactiveImpl === undefined) {
        return { opened: false, reason: "QQ 桥未开（自主态只内省，不打扰）" };
      }
      // 主动开口也要过频率闸：它每次都调模型，之前却不记账，
      // 结果账本只数 learn/selftalk，峰时上限 6/h 被 12/h 的实际调用冲破。
      if (suspended()) {
        deps.log?.("[standalone] proactive 跳过：审核未解除");
        return { opened: false, reason: "审核中（退避）" };
      }
      const p = currentPacing();
      prune(deps.now());
      // 用户 2026-10-31 裁决 A：这一格是留给「开口」的，主动开口不再给后台让路；
      // 只有这一小时真的没有额度时才跳过（后台活动已由 speech-reserve 让路）。
      if (callTimes.length + 1 > p.maxCallsPerHour) {
        const reason = `额度不够（已用 ${String(callTimes.length)}/${String(p.maxCallsPerHour)}）`;
        deps.log?.(`[standalone] proactive 跳过：${reason}`);
        return { opened: false, reason };
      }
      const gate = rateAlert(callTimes.length, p);
      if (gate.alert) {
        tripReview(callTimes.length, p.maxCallsPerHour, gate.reason);
        deps.log?.(`[standalone] proactive 跳过：${gate.reason}`);
        return { opened: false, reason: gate.reason };
      }
      const out = await deps.proactiveImpl();
      if (out.generated === true) {
        recordCall();
        // P3-2b：B 通道——生成过台词（花过钱）才扣能
        deps.spendEnergy?.("proactive");
      }
      return out;
    },
    social: async (): Promise<SocialOutcome> => {
      // 睡眠是最硬的一道：连匿名浏览都不做（与 learn 的 P3 硬跳一致）
      if (deps.sleepState?.().asleep === true) {
        deps.log?.("[standalone] social 跳过：睡眠中（P3）");
        return { action: "skip", ok: false, reason: "睡眠中" };
      }
      if (deps.socialImpl === undefined) {
        return { action: "skip", ok: false, reason: "社交通路未接线" };
      }
      if (suspended()) {
        deps.log?.("[standalone] social 跳过：审核未解除");
        return { action: "skip", ok: false, reason: "审核中（退避）" };
      }
      const p = currentPacing();
      prune(deps.now());
      // 社交这一拍可能要调模型写弹幕/评论，所以先按「一次调用」占额度；
      // 实际只有 generated=true 时才记账（点赞不花模型额度）。
      if (callTimes.length + 1 > p.maxCallsPerHour) {
        const reason = `额度不够（已用 ${String(callTimes.length)}/${String(p.maxCallsPerHour)}）`;
        deps.log?.(`[standalone] social 跳过：${reason}`);
        return { action: "skip", ok: false, reason };
      }
      const gate = rateAlert(callTimes.length, p);
      if (gate.alert) {
        tripReview(callTimes.length, p.maxCallsPerHour, gate.reason);
        deps.log?.(`[standalone] social 跳过：${gate.reason}`);
        return { action: "skip", ok: false, reason: gate.reason };
      }
      let out: SocialOutcome;
      try {
        out = await deps.socialImpl();
      } catch (err) {
        // 平台侧失败已经在 socialImpl 里记账；这里兜底，绝不让一个网络错误打断循环
        const reason = err instanceof Error ? err.message : String(err);
        deps.log?.(`[standalone] social 失败：${reason}`);
        return { action: "skip", ok: false, reason };
      }
      if (out.generated === true) recordCall();
      // 只有真的落到对方站点（点赞/弹幕/评论）才扣能；watch/skip 不收费。
      if (out.ok && out.action !== "watch" && out.action !== "skip") deps.spendEnergy?.("social");
      return out;
    },
    selftalk: async (): Promise<SelfTalkOutcome> => {
      const now = deps.now();
      // P3-2b：睡着时内部言语硬跳（不调模型）；巩固仍然跑，由 consolidate 自己负责
      if (deps.sleepState?.().asleep === true) {
        deps.log?.("[standalone] selftalk 跳过：睡眠中（P3）");
        return { kind: "wander", relation: "unrelated" };
      }
      if (suspended()) {
        deps.log?.("[standalone] selftalk 跳过：审核未解除");
        return { kind: "wander", relation: "unrelated" };
      }
      const pacing = currentPacing();
      prune(now);
      const yieldNote = shouldYieldForSpeech({ usedCalls: callTimes.length, maxCalls: pacing.maxCallsPerHour })
        ? describeSpeechReserve({ usedCalls: callTimes.length, maxCalls: pacing.maxCallsPerHour })
        : null;
      if (yieldNote !== null) {
        deps.log?.(`[selftalk] 跳过生成：${yieldNote}`);
        return { kind: "wander", relation: "unrelated" };
      }
      const base = selfTalkIntervalMs(deps.cfg);
      const gate = rateAlert(callTimes.length, pacing);
      const interval = scaledIntervalMs(base, pacing) * (gate.alert ? gate.backoffScale : 1);
      if (lastSelfTalkAt !== 0 && now - lastSelfTalkAt < interval) {
        return { kind: "wander", relation: "unrelated" };
      }
      const blocked = gate.alert && tripReview(callTimes.length, pacing.maxCallsPerHour, gate.reason);
      if (gate.alert) {
        tripReview(callTimes.length, pacing.maxCallsPerHour, gate.reason);
        deps.log?.(`[standalone] 频率审核：${gate.reason}`);
      }

      const memory = deps.runtime.memoryStore() as MemoryStore;
      const state = deps.runtime.state as SState;
      const journal = deps.journal;
      const generate =
        blocked || deps.llm === null || deps.llm === undefined
          ? undefined
          : (messages: readonly { role: "system" | "user"; content: string }[]): Promise<string> =>
              chatComplete(deps.llm as LlmConfig, messages, {
                task: "selftalk",
                ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
              }).then((r) => {
                recordCall();
                const usageLine = formatUsageLog("selftalk", r);
                if (usageLine !== undefined) deps.log?.(usageLine);
                return r.text;
              });

      // 由头只影响提示词里的「想说什么」，不改变语气/称呼/长度；没有就退回旧提示词
      const intentNote = deps.intentNoteImpl === undefined ? undefined : deps.intentNoteImpl();
      if (intentNote !== undefined) deps.log?.("[selftalk] 由头已注入（P1）");
      const out = await runSelfTalk({
        store: memory,
        journal,
        cfg: deps.cfg,
        now,
        mood: { valence: state.valence, arousal: state.arousal },
        ...(generate === undefined ? {} : { generate }),
        ...(deps.personaName === undefined ? {} : { personaName: deps.personaName }),
        ...(intentNote === undefined ? {} : { intentNote }),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
      lastSelfTalkAt = now;
      // 可观测（F315）：skipReason 之前只有测试在消费；这里把它落进续航日志，
      // 便于发布后按「跳过原因」统计生成端的近重复拦截率。
      if (!out.written && out.skipReason !== undefined) {
        deps.log?.(`[selftalk] 本轮未产日记：skipReason=${out.skipReason}`);
      }
      // §内部言语→对外表达：心里那句话写进日记之后，才有资格说出口。
      // 三道过滤：humanize（改不成话就不发）→ shouldSpeak（时段/精力/配额/间隔）→ 真发送。
      let spoke = false;
      // A9：降级模板（没 key / 模型失败）只写日记，不发出去——宁可这一条不说。
      if (out.written && out.degraded === true) {
        deps.log?.("[voice] held：这一句是降级模板，不发送");
      } else if (out.written && deps.speakImpl !== undefined) {
        const tz = deps.tzOffsetMinutes ?? 0;
        const day = dayKey(now, tz);
        // 配额与间隔从**日记**里算，不用进程内计数：她一夜被重启十几次，
        // 内存计数每次都归零，23:37 / 23:52 / 23:57 连发三句就是这么来的。
        const spokenEntries = journal.recent(60).filter((e) => e.spoken === true);
        const spokenToday = spokenEntries.filter((e) => dayKey(e.at, tz) === day).length;
        const lastSpokeAt = spokenEntries.reduce((max, e) => (e.at > max ? e.at : max), 0);
        const justWritten = journal.recent(1)[0];
        const mood = selftalkMood({
          valence: state.valence,
          arousal: state.arousal,
          pressure: state.pressure,
          rumination: state.rumination,
          affection: state.affection,
          energy: state.energy,
        });
        const line = humanize(out.text);
        if (line === null) {
          deps.log?.("[voice] held：这句话不适合直接说（humanize=null）");
        } else if (justWritten !== undefined && topicWasSpokenRecently(justWritten.seeds, spokenEntries, now)) {
          deps.log?.("[voice] held：这个话题最近说过了");
        } else {
          const gate = shouldSpeak({
            nowMs: now,
            localHour: deps.localHour(),
            quietFrom: SPEAK_QUIET_FROM,
            quietTo: SPEAK_QUIET_TO,
            energy: state.energy,
            mood,
            spokenToday,
            lastSpokeAt,
          });
          if (!gate.speak) {
            deps.log?.(`[voice] held：${gate.reason}`);
          } else {
            const sent = await deps.speakImpl(line);
            spoke = sent.ok;
            if (spoke) journal.markLastSpoken();
            deps.log?.(
              `[voice] spoke=${String(sent.ok)} mood=${mood} text=${line.slice(0, 24)} detail=${sent.detail}`,
            );
          }
        }
      }
      // P3-2b：B 通道——真的产出了内部言语才扣能（间隔没到/被拦下时不收费）
      if (out.written) deps.spendEnergy?.("selftalk");
      return { kind: out.kind, relation: out.relation, spoke };
    },
    ...(deps.intentTickImpl === undefined
      ? {}
      : {
          intentTick: (): void | Promise<void> => deps.intentTickImpl?.(),
        }),
  };
}

