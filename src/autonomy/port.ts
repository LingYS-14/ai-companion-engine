/**
 * 自主运行的动作端口。
 *
 * 循环只管「什么时候做」，端口负责「做什么」。把它抽成接口有两个好处：
 * 1. dry-run 可以用同一份接线跑一遍，只记录不写盘——证明节奏与装配是通的；
 * 2. 真正的 runtime 绑定（推进状态、学习、巩固、主动开口）等运行形态拍板后再接，
 *    届时只需实现这个接口，循环与规划一行都不用改。
 *
 * 每个方法返回一句摘要，循环会写进日志；抛错由循环捕获，单步失败不拖垮整轮。
 */

import type { LearningWebPlan } from "../ports/index.js";

export interface AdvanceOutcome {
  /** 推进了几轮 idle tick（引擎的 advance 以小时为单位，内部按 5 分钟步长跑） */
  readonly ticks: number;
}

export interface LearnOutcome {
  readonly topic: string;
  readonly keyword: string;
  /**
   * 这一拍真正深读了几条视频笔记（P3-3）。
   *
   * 装配层据实际入库数回报；脊髓层用它决定要不要扣 `learn_deep` 的 B 通道能耗。
   * 缺省/0 = 没深读（hot/search 档恒为 0）。
   */
  readonly deepReads?: number | undefined;
  /**
   * B 站搜索**真正执行且结果为空**（P4-2/W1 的触发口径）。
   *
   * 只有装配层亲眼看到 searchVideos 成功返回 0 条才置 true；hot/skip/未接线/抛错都
   * 不置（那些不是"没有新东西"，是"没去找"）。脊髓层用它决定要不要放网页搜索。
   */
  readonly biliEmpty?: boolean | undefined;
  /**
   * 网页学习计划（W1，spec v2.3 §5.3）：只有 full 档才会带。
   *
   * 脊髓只算"该不该查"；发网络、判 URL、碰额度都在装配层（R4），这里不 import `src/web`。
   */
  readonly webPlan?: LearningWebPlan | undefined;
}

/** `learn` 的入参（W1）：exploreNow 只由 explore-only 入口传，普通拍不传 */
export interface PortLearnInput {
  /** 这一拍是不是「用户/意图要求现在就去探索」——只有这时网页关键词才算学习计划 */
  readonly exploreNow?: boolean | undefined;
}

export interface LearningWebPlanInput {
  /** 能量档（full/search/hot/skip；脊髓层已判定） */
  readonly tier: string;
  readonly exploreNow: boolean;
  readonly biliEmpty: boolean;
  readonly keyword: string;
}

/**
 * 脊髓层的触发公式（纯函数、不发网络）：只有 full 档、且「现在去探索」或「B 站搜了但空」
 * 才允许查网页。关键词必须是这一拍的学习关键词本身——不许由调用方自由拼（隐私口径）。
 */
export function buildLearningWebPlan(input: LearningWebPlanInput): LearningWebPlan {
  const keyword = input.keyword.trim();
  const allowSearch =
    input.tier === "full" && (input.exploreNow || input.biliEmpty) && keyword.length > 0;
  return {
    allowSearch,
    querySource: input.exploreNow ? "learning-plan" : "hot-topic",
    keyword,
  };
}

/** `createPortActions` 的可选钩子：learn 成功后把 outcome 交给装配层（W1 的网页执行点） */
export interface PortActionHooks {
  /**
   * 学习动作完成之后调用（await）。装配层用它读 `out.webPlan` 决定要不要查网页。
   * 抛错由 `createPortActions` 的调用方（循环）捕获——单步失败不拖垮整轮。
   */
  readonly afterLearn?: ((out: LearnOutcome) => void | Promise<void>) | undefined;
}

/** 睡眠巩固之后那次洞见生成的结果（形状由宿主的主循环填） */
export interface InsightOutcome {
  /** 选中的簇；空字符串表示"没有候选" */
  readonly tag: string;
  readonly stored: boolean;
  readonly reason: string;
}

export interface ConsolidateOutcome {
  readonly accepted: number;
  readonly rejected: number;
  /** 睡眠巩固之后有没有顺手写一条洞见（v5.2 §7.3，模型调用） */
  readonly insight?: InsightOutcome | undefined;
  /** §5.4 再巩固：这一晚有没有把一条旧记忆重新解释一版（模型调用） */
  readonly reconsolidated?: ReconsolidateOutcome | undefined;
}

/** §5.4 再巩固写入口的结果（形状由宿主的主循环填） */
export interface ReconsolidateOutcome {
  /** 写进了几条版本补丁（0 = 没做，不报错） */
  readonly patched: number;
  /** 没做/失败的原因；空字符串表示成功且有补丁 */
  readonly reason: string;
  /** 被重新解释的那条记忆 id（有补丁时给） */
  readonly memoryId?: string | undefined;
}

export interface SelfTalkOutcome {
  readonly kind: "replay" | "wander" | "reflect";
  readonly relation: "related" | "divergent" | "unrelated";
  /** 这一轮的自言自语是否真的说出口了（内部言语 → 对外表达） */
  readonly spoke?: boolean;
}

export interface ProactiveOutcome {
  readonly opened: boolean;
  readonly reason: string;
  /**
   * 这一拍是否**真的调了模型**。
   *
   * 为什么需要它：主动开口的路径上有两种「没开口」——闸门没过（没花钱）和生成了但发送失败
   * （花了钱）。频率账本只该记后者；旧代码把整条 proactive 都不记账，于是她每 5 分钟
   * 生成一次台词、一小时 12 次，而账本里只有 learn/selftalk 的 2 次，峰时上限 6 形同虚设。
   */
  readonly generated?: boolean;
}

import type { AutonomyActions } from "./loop.js";

export interface AutonomyPort {
  /** 推进 S 层与关系（不生成台词） */
  advance(dtHours: number): AdvanceOutcome;
  /** 学习一拍；`input.exploreNow` 只由 explore-only 入口传（普通拍不传 → 旧行为） */
  learn(input?: PortLearnInput): Promise<LearnOutcome> | LearnOutcome;
  /** 睡眠巩固：可能带一次洞见生成（要调模型），所以允许异步 */
  consolidate(): ConsolidateOutcome | Promise<ConsolidateOutcome>;
  /** 主动开口：真正发不发由 QQ 侧的门控决定，这里只请求一次「要不要开口」 */
  proactive(): ProactiveOutcome | Promise<ProactiveOutcome>;
  /** 内部言语：想一句、落一条日志（可能调模型，所以允许异步） */
  selftalk(): Promise<SelfTalkOutcome> | SelfTalkOutcome;
  /** P1：意向引擎的一拍纯计算（可选；没接就跳过，接了也不发送、不调模型） */
  intentTick?(): void | Promise<void>;
}

/**
 * 把端口接到循环的动作上。
 *
 * `stateTick` 的入参只有 `now`，所以这里自己记「上次推进到什么时候」，
 * 换算成小时给 `advance`——真实端口（runtime.advance）就按这个单位收。
 */
export function createPortActions(
  port: AutonomyPort,
  log: (line: string) => void,
  hooks: PortActionHooks = {},
): AutonomyActions {
  let lastAdvanceAt: number | null = null;
  return {
    stateTick: (now: number): void => {
      const dtHours = lastAdvanceAt === null ? 0 : Math.max(0, (now - lastAdvanceAt) / 3_600_000);
      lastAdvanceAt = now;
      // 进程刚起来的第一拍没有「上一次」：直接只记录基准，不推进（advance 拒绝 0 小时）
      if (dtHours <= 0) return;
      const out = port.advance(dtHours);
      log(`[autonomy] advance dt=${dtHours.toFixed(2)}h ticks=${String(out.ticks)}`);
    },
    learn: async (): Promise<void> => {
      const out = await port.learn();
      // W1：网页执行的唯一入口（装配层注入）；普通拍不会带 exploreNow，所以旧行为不变
      await hooks.afterLearn?.(out);
      log(`[autonomy] learn ${out.topic} / ${out.keyword}`);
    },
    consolidate: async (): Promise<void> => {
      const out = await port.consolidate();
      log(`[autonomy] consolidate accepted=${String(out.accepted)} rejected=${String(out.rejected)}`);
    },
    proactive: async (): Promise<void> => {
      const out = await port.proactive();
      log(`[autonomy] proactive opened=${String(out.opened)} reason=${out.reason}`);
    },
    selftalk: async (): Promise<void> => {
      const out = await port.selftalk();
      log(`[autonomy] selftalk kind=${out.kind} relation=${out.relation}`);
    },
    ...(port.intentTick === undefined
      ? {}
      : {
          intentTick: async (): Promise<void> => {
            await port.intentTick?.();
          },
        }),
    log,
  };
}

/** dry-run 端口：只回答「如果真跑会怎样」，不改任何状态 */
export function createDryRunPort(): AutonomyPort {
  return {
    advance: (dtHours) => ({ ticks: Math.max(0, Math.round(dtHours * 12)) }),
    learn: () => ({ topic: "dry-run", keyword: "（未接真实学习）" }),
    consolidate: () => ({ accepted: 0, rejected: 0 }),
    proactive: () => ({ opened: false, reason: "dry-run" }),
    selftalk: () => ({ kind: "wander", relation: "unrelated" }),
  };
}
