/**
 * 洞见生成（v5.2 §7.3 `extract_insight`，全系统唯一的 LLM 入口）的**纯逻辑**。
 *
 * 为什么放在脊髓（autonomy）而不是学习层：
 * - 规格的反向判据写着「Learning 零 LLM」——学习层是纯规则+统计，不许自己调模型；
 * - 插件也不调模型（插件是只读观察面）。
 * 所以这条链路只能由她自己的常驻进程在睡眠巩固之后走一次：找候选簇 → 组提示词 →
 * 模型写一句 → 校验 → 落库（仍走 `submitInsight` 的四道闸）。
 *
 * 这里的函数都是纯的（除了账本读写），便于在没有模型、没有网络的测试里验证
 * 「该选哪个簇 / 什么样的输出算洞见 / 什么时候该放弃」。
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { EpisodicCluster } from "../memory/consolidate.js";

/**
 * 只描述提示词形状，不 import 脊髓的 `ChatMessage`——否则学习层（大脑）会反向依赖
 * 脊髓，边界门禁 `edges:check` 会立刻判 R2 违规。结构上与 `ChatMessage` 完全一致，
 * 宿主组好之后直接喂给 `chatComplete`。
 */
export interface InsightMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** 同一个标签的洞见，重新生成的最小间隔：见得太频繁会把"洞见"写成"流水账" */
export const INSIGHT_COOLDOWN_MS = 7 * 86_400_000;
/** 低于这个长度的输出基本是敷衍（"挺好的""继续观察"），当废稿丢掉 */
export const INSIGHT_MIN_CHARS = 12;
/** 超过这个长度就不再是"一句洞见"，而是小作文——她会把它当知识背下来 */
export const INSIGHT_MAX_CHARS = 160;

export interface InsightLedger {
  readonly version: 1;
  /** tag → 上次生成时间（毫秒） */
  readonly last: Readonly<Record<string, number>>;
  /** 累计生成了几条（给汇报与面板看） */
  readonly count: number;
}

export function emptyLedger(): InsightLedger {
  return { version: 1, last: {}, count: 0 };
}

/** 账本坏了就当没有：宁可多写一条洞见，也不因为她进程崩在这 */
export function readLedger(path: string): InsightLedger {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return emptyLedger();
    const body = raw as { last?: unknown; count?: unknown };
    const last: Record<string, number> = {};
    if (typeof body.last === "object" && body.last !== null) {
      for (const [tag, at] of Object.entries(body.last)) {
        if (typeof at === "number" && Number.isFinite(at)) last[tag] = at;
      }
    }
    const count = typeof body.count === "number" && Number.isFinite(body.count) ? Math.max(0, Math.trunc(body.count)) : 0;
    return { version: 1, last, count };
  } catch {
    return emptyLedger();
  }
}

/** 原子写（先 .tmp-<pid> 再 rename）：进程被强杀时账本不会变成半行 JSON */
export function writeLedger(path: string, ledger: InsightLedger): void {
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, "utf8");
  renameSync(tmp, path);
}

export function markInsight(ledger: InsightLedger, tag: string, now: number): InsightLedger {
  return { version: 1, last: { ...ledger.last, [tag]: now }, count: ledger.count + 1 };
}

/**
 * 选一个值得写洞见的簇。
 *
 * 规则（按重要性排）：
 * 1. 只收 `stateProvenance === "trusted"` —— 被污点污染的簇不许升级成"信念"（A11/B3）；
 * 2. 证据数达到门槛（缺省 3）：两条记忆就提炼"人生道理"，学到的是噪声；
 * 3. 同一个 tag 在冷却期内不重写 —— 洞见不是日报；
 * 4. 平手按 evidenceCount 降序、tag 升序，保证同一份数据每次选到同一个（可复现）。
 */
export function pickInsightCluster(
  clusters: readonly EpisodicCluster[],
  ledger: InsightLedger,
  now: number,
  opts: { minEvidence?: number; cooldownMs?: number } = {},
): EpisodicCluster | null {
  const minEvidence = opts.minEvidence ?? 3;
  const cooldownMs = opts.cooldownMs ?? INSIGHT_COOLDOWN_MS;
  const candidates = clusters.filter((c) => {
    if (c.tag.trim() === "") return false;
    if (c.stateProvenance !== "trusted") return false;
    if (c.evidenceCount < minEvidence) return false;
    const lastAt = ledger.last[c.tag];
    if (lastAt !== undefined && now - lastAt < cooldownMs) return false;
    return true;
  });
  candidates.sort((a, b) => (b.evidenceCount - a.evidenceCount) || a.tag.localeCompare(b.tag));
  return candidates[0] ?? null;
}

/** 把簇里的原话抽成样本（去重、截断、最多 n 条），喂给模型看的只有这些 */
export function samplesOf(cluster: EpisodicCluster, n = 5, perLine = 60): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of cluster.members) {
    const text = (m.content ?? "").replace(/\s+/g, " ").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, perLine));
    if (out.length >= n) break;
  }
  return out;
}

export interface InsightPromptInput {
  readonly persona: string;
  readonly tag: string;
  readonly samples: readonly string[];
}

/**
 * 组装提示词。
 *
 * 刻意写成"要一句、第一人称、具体、不许讲道理"：
 * 之前召回进提示词但模型拿气氛填空（F60），根因是口径太软——这里同样的坑要提前堵上。
 */
export function buildInsightPrompt(input: InsightPromptInput): readonly InsightMessage[] {
  const sampleLines = input.samples.map((s, i) => `${String(i + 1)}. ${s}`).join("\n");
  return [
    {
      role: "system",
      content:
        `你是${input.persona}。你在把自己反复经历的一类事，收成一句你真心相信的话。`
        + `只输出那一句话本身：第一人称，中文，${String(INSIGHT_MIN_CHARS)}–${String(INSIGHT_MAX_CHARS)} 字，`
        + "有具体的东西（谁、什么时候、什么感觉），不要总结陈词，不要写「我意识到」「这让我明白」这类开头，"
        + "不要引号、不要编号、不要 Markdown、不要解释你为什么这么写。",
    },
    {
      role: "user",
      content:
        `下面几件事属于同一类（标签：${input.tag}），都是你亲身经历的：\n${sampleLines}\n\n`
        + "把这一类事收成一句你现在会拿它来判断以后的事的话。只要那一句。",
    },
  ];
}

/**
 * 校验并清洗模型输出。
 *
 * 返回 null = 这条不能用（宁可今晚不写，也不把废话写进 L2——L2 会被检索进她的提示词，
 * 一条废话会污染之后每一轮）。返回字符串 = 可以落库的正文。
 */
export function parseInsight(raw: string): string | null {
  let text = raw.trim();
  if (text === "") return null;
  // 模型常见的自我包装：整段加引号、加「洞见：」前缀、包一层代码块
  text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  text = text.replace(/^(洞见|洞察|结论|一句话)\s*[:：]\s*/, "").trim();
  text = text.replace(/^[「『"'“”](.*)[」』"'“”]$/s, "$1").trim();
  text = text.replace(/\s+/g, " ");
  if (text.length < INSIGHT_MIN_CHARS || text.length > INSIGHT_MAX_CHARS) return null;
  // 元叙述与自我指涉：这些不是"她相信的事"，是模型在解释任务
  if (/作为一个?(AI|人工智能|语言模型|助手)/i.test(text)) return null;
  if (/^(以下是|这句话|这个洞见|我写的|输出[:：])/.test(text)) return null;
  // 空话兜底：整句都是抽象词、没有任何具体名词/时间/感受的句子，直接丢掉
  if (!/[我一你他她它]/.test(text)) return null;
  return text;
}

/** 中位数（空数组返回 0）；用于 §9.4 的 insight 可达性判据 */
export function medianOf(xs: readonly number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * §9.4：洞见阈值高于历史证据中位数的三倍时，A/B 层永远不会更新——不可达。
 *
 * 没有历史（median<=0）时返回 reachable=true：没证据不等于不可达，
 * 不能因为"还没聊过几轮"就把第一次洞见挡在门外。
 */
export function insightReachable(
  threshold: number,
  evidenceCounts: readonly number[],
): { reachable: boolean; median: number } {
  const median = medianOf(evidenceCounts);
  if (!(median > 0)) return { reachable: true, median };
  return { reachable: threshold <= median * 3, median };
}
