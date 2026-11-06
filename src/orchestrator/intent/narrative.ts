/**
 * 意向引擎 P0 —— B3 自述层（VISION §4.4）：把候选/意图变成**第一人称的一句话**。
 *
 * 为什么 P0 就要有它：`composeDialogue` 在 P1 要拿"她想说什么"当输入，而不是让模型自由发挥。
 * 自述层如果等到 P1 才做，接线时就只能临时拼字符串——那正是 VISION 要修的"角色卡没有意图"旧病。
 *
 * P0 的形态：**纯模板、零模型调用、不写AI助手的文案**。这里只保证"机制上说得清"——我想做什么、
 * 为什么（逐维回链）、卡在哪、试过几次。语气与人设属于 persona 层，P1 由 `composeDialogue` 包装。
 *
 * 确定性：同一输入永远得到同一句（不选随机模板、不读时间），这是 golden replay 的一部分。
 */

import type { CandidateCause, Candidate, DriveVector, IntentionRecord, IntentKind, IntentionStatus } from "./types.js";

/** 七类意图的开场（中性机制文本，不含角色口吻）。 */
export const KIND_OPENERS: Readonly<Record<IntentKind, string>> = Object.freeze({
  reach_out: "我想找人说句话",
  continue_thread: "我想把上次没说完的事接上",
  explore: "有件事我还没弄明白，想去看一眼",
  create: "我想做点新的东西出来",
  repair: "我想把刚才弄僵的那点补回来",
  withdraw: "我想先退一步，自己待一会儿",
  idle: "此刻没什么特别想做的",
});

/** 状态词（自述时的"我现在在哪一步"）。 */
export const STATUS_PHRASES: Readonly<Record<IntentionStatus, string>> = Object.freeze({
  pending: "还没开始",
  active: "正在做",
  blocked: "被拦住了",
  held: "先不说了",
  done: "做完了",
  dropped: "放弃了",
});

const DRIVE_NAMES: Readonly<Record<keyof DriveVector, string>> = Object.freeze({
  energy: "累了",
  integrity: "有点憋着",
  connection: "想有人陪",
  competence: "怕做不好",
  novelty: "有点闷",
  coherence: "心里别扭",
});

export interface Narrative {
  /** 主体那一句 */
  line: string;
  /** 为什么：逐维回链（"因为想有人陪 +0.3、有点憋着 −0.1"） */
  whyLine: string;
  /** 状态句（可选） */
  statusLine?: string;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

/** 把 `Candidate.because` 排成"最想满足的那一维在前"的回链（稳定排序：gap 降序，其次维度名）。 */
export function rankCauses(why: readonly CandidateCause[]): CandidateCause[] {
  return [...why]
    .filter((cause) => Number.isFinite(cause.gap))
    .sort((a, b) => b.gap - a.gap || String(a.drive).localeCompare(String(b.drive)));
}

/**
 * 候选 → 自述。`drive_impact` 只用来拼"为什么"那一句；影响为 0 的维不进句（避免长句噪声）。
 * 不含随机、不含时间，同输入同输出。
 */
export function narrateCandidate(candidate: Candidate): Narrative {
  const opener = KIND_OPENERS[candidate.kind];
  // A10：自述会进提示词（由头/处境），带「缺口 0.52」「+0.31」这类数值就等于把机制泄漏给她，
  // 她很可能原样说出来。所以自述只保留人话：选最想满足的两维，说"因为想有人陪、怕做不好"。
  const causes = rankCauses(candidate.because)
    .slice(0, 2)
    .map((cause) => DRIVE_NAMES[cause.drive]);
  const whyLine = causes.length > 0 ? `因为${causes.join("、")}` : "因为说不出具体哪一维在推我";
  const goal = candidate.goal.trim().replace(/[。！？.]$/, "");
  const line = goal.length > 0 ? `${opener}——${goal}。` : `${opener}。`;
  const impacts = Object.entries(candidate.drive_impact)
    .filter(([, value]) => typeof value === "number" && value !== 0)
    .map(([key]) => DRIVE_NAMES[key as keyof DriveVector]);
  if (impacts.length === 0) return { line, whyLine };
  return { line, whyLine, statusLine: `它会让我${impacts.join("、")}。` };
}

/**
 * 意图记录 → 自述（B3 出口给 composeDialogue 的形态）。
 * `blocked_by` 有值时状态句写明是谁拦的——§4.5 #3 要求可审计，自述层不能把"被拦"说成"不想"。
 */
export function narrateIntention(record: IntentionRecord): Narrative {
  const opener = KIND_OPENERS[record.kind];
  const goal = record.goal.trim().replace(/[。！？.]$/, "");
  const line = goal.length > 0 ? `${opener}——${goal}。` : `${opener}。`;
  const status = STATUS_PHRASES[record.status];
  let statusLine = `现在${status}`;
  if (record.status === "blocked" && record.blocked_by) {
    statusLine = `现在被「${record.blocked_by}」拦住了`;
  }
  if (record.attempts.length > 0) {
    statusLine += `，已经试过 ${record.attempts.length} 次`;
  }
  statusLine += "。";
  return { line, whyLine: record.why, statusLine };
}

/** 被拦时的自述（P1 的 `shouldInitiate` 否决要能说清理由，而不是静默）。 */
export function narrateBlocked(record: IntentionRecord, blocker: string): Narrative {
  const base = narrateIntention({ ...record, status: "blocked", blocked_by: blocker });
  return base;
}

/** 求助的自述：必须带"我试过什么"（§11.6.2 的核心是别撒娇）。 */
export function narrateHelp(input: { missing: string; tried: readonly string[]; need: string }): Narrative {
  const tried = input.tried.map((item) => item.trim()).filter((item) => item.length > 0);
  const triedLine = tried.length > 0 ? `我试过${tried.join("、")}，都不行。` : "我还没找到办法。";
  return {
    line: `${triedLine}有件事想请你帮个忙：${input.missing.trim()}。`,
    whyLine: `我缺的是：${input.need.trim()}。`,
  };
}

/** 归因自述（结果出来后她自己怎么解释这次成败；"别人/世界"的句子不许抢功也不许全甩锅）。 */
export function narrateAttribution(input: {
  ok: boolean;
  target: "self" | "other" | "world" | "unclear";
  surprise: number;
}): string {
  const outcome = input.ok ? "成了" : "没成";
  const surprise = input.surprise > 0.5 ? "（比我预想的意外）" : "";
  switch (input.target) {
    case "self":
      return `这次${outcome}，主要在我${surprise}。`;
    case "other":
      return `这次${outcome}，和对方有关${surprise}。`;
    case "world":
      return `这次${outcome}，是环境不配合${surprise}。`;
    case "unclear":
      return `这次${outcome}，我一时说不清是谁的原因${surprise}。`;
  }
}
