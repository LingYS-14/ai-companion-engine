/**
 * 情境自觉（审计修复 A5；时间观 P1 改造）——把 `TemporalSnapshot` 渲染成「此刻的处境」。
 *
 * 用户的批示（m09313）：「不要用主动门，要让她意识到我可能有事，自发的开口或减少开口，
 * 而不是全部依靠一个死程序。」所以这里**不产生否决、不产生定时器**，只把她能感知到的事实
 * 说成第一人称的处境，让她自己在出口里决定「说」还是「先不说（HOLD）」。
 *
 * P1 改造（DESIGN-TEMPORALITY-SLEEP-PERSONA v0.2 §2.4）：
 * - 删掉「他多半已经睡了」「他也许快睡了」这类**替她推断**的句子；
 * - 删掉「别一直连着说」「可以先等一等」「你现在很想他」这类**替她判断**的建议；
 * - 只保留事实：现在几点、醒了多久、他上一次说话是多久前、她主动几句没回、他是否在电脑前。
 *
 * 纯函数：所有时间都由调用方给（本层不读时钟——`tools/lint/writers.mjs` 规则 2）。
 */

import type { TemporalSnapshot } from "./temporal.js";

/** DSH 侧写的在场信号（`data/presence-<id>.json`）：只有新鲜时才用，过期当作不知道。 */
export interface SituationPresence {
  atMs: number;
  active: boolean;
  ttlMs: number;
}

export interface SituationNote {
  lines: string[];
  /** 永远 true：A5 取消了机械门，说与不说由她在出口里判断（HOLD） */
  holdAllowed: true;
}

/**
 * S3a：处境行里的「推断词」词表（显式清单，可测、可扩展）。
 *
 * 设计意图：`buildSituationNote` 只允许陈述事实；这组词用来量化「事实率」。
 * 命中只说明**行里出现了推断词**，不代表句子一定有推断；词表覆盖有限，别宣称 100%。
 */
export const INFERENCE_WORDS = [
  "多半",
  "也许",
  "可能",
  "大概",
  "应该",
  "估计",
  "似乎",
  "好像",
  "像是",
  "说不定",
  "或许",
  "恐怕",
  "差不多",
  "左右",
] as const;

/** S3a：一页处境行的事实/推断统计（只落计数，不落原文）。 */
export interface SituationLineStats {
  readonly lines: number;
  readonly inferred: number;
  readonly byWord: Readonly<Record<string, number>>;
}

/**
 * S3a：统计处境行。
 *
 * - `lines`：总行数；
 * - `inferred`：命中了至少一个推断词的行数（一行多词只记 1）；
 * - `byWord`：逐词命中行数（只列命中过的词，稳定按 `INFERENCE_WORDS` 顺序）。
 *
 * 纯函数：不读时钟、不写 IO；`buildSituationNote` 的返回形状不变。
 */
export function situationLineStats(note: Pick<SituationNote, "lines">): SituationLineStats {
  const lines = note.lines.length;
  let inferred = 0;
  const byWord: Record<string, number> = {};
  for (const word of INFERENCE_WORDS) {
    let hits = 0;
    for (const line of note.lines) {
      if (line.includes(word)) hits += 1;
    }
    if (hits > 0) byWord[word] = hits;
  }
  for (const line of note.lines) {
    if (INFERENCE_WORDS.some((word) => line.includes(word))) inferred += 1;
  }
  return { lines, inferred, byWord };
}

/** 分钟 →「N 分钟前 / H 小时 M 分钟前」。事实表述，不加语气词。 */
export function describeMinutesAgo(minutes: number, nowWord = "现在"): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m === 0) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${hours} 小时前` : `${hours} 小时 ${rest} 分钟前`;
}

function awakeLine(snapshot: TemporalSnapshot): string | null {
  const awake = snapshot.awakeForHours;
  if (awake === null) return null;
  const sleep = snapshot.lastSleep;
  const slept = sleep?.hours;
  if (slept !== null && slept !== undefined) {
    return `你已经醒了 ${awake} 小时；上一次睡了 ${slept} 小时`;
  }
  if (sleep !== null) {
    return `你已经醒了 ${awake} 小时（上一次睡是 ${sleep.localTime}）`;
  }
  return null;
}

function contactLine(minutes: number | null): string | null {
  // 没有线索就不编（DESIGN §0.1 第 4 条：宁可说不知道，也不能用「没测到」冒充事实）
  if (minutes === null) return "你还不知道他上一次说话是什么时候";
  if (minutes <= 2) return "他刚刚还在跟你说话";
  return `他上一次说话是 ${describeMinutesAgo(minutes)}`;
}

function unansweredLine(count: number): string | null {
  if (count <= 0) return null;
  return `这之后你主动开口了 ${count} 次，他都没有回`;
}

function lastOwnLine(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes <= 0) return "你刚刚才主动说过一句";
  return `你上一次主动开口是 ${describeMinutesAgo(minutes)}`;
}

function presenceLine(presence: TemporalSnapshot["presence"], nowMs: number): string | null {
  if (presence === null) return null;
  return presencePhrase(presence, nowMs);
}

/**
 * 节律事实（P2a）：有统计就说他常在几点出现，没有就诚实说「还不了解」。
 * 只陈述观察结果（最常小时/样本数/覆盖天数），不写「他一般几点睡」这类推断。
 * 样本 <100 时（DESIGN:134 的 30–99 档）行尾必须标注「样本少」——不能拿几十条
 * 观察冒充摸清了他的作息。
 */
function rhythmLine(rhythm: TemporalSnapshot["hisRhythm"]): string {
  if (rhythm === null) return "我还不了解他的作息";
  const lowSample = rhythm.sampleCount < 100 ? "（样本还少，先当参考）" : "";
  return (
    `你观察到他最常在 ${String(rhythm.peakLocalHour)}:00 前后出现` +
    `（${String(rhythm.sampleCount)} 条记录，覆盖 ${String(rhythm.distinctLocalDates)} 天）${lowSample}`
  );
}

/**
 * 把时间快照渲染成「此刻的处境」。
 *
 * 规则：
 * - 只陈述她**能感知到的事实**，不替她下结论、不写命令句；
 * - 没线索就不编（没有接触时间就说「你还不知道」）；
 * - 不出现「该不该」「必须」「别一直」「先等一等」这类外部指令词——决定权留给她。
 */
export function buildSituationNote(snapshot: TemporalSnapshot): SituationNote {
  if (!Number.isFinite(snapshot.nowMs)) throw new RangeError("nowMs 必须是有限数");
  if (!Number.isInteger(snapshot.localHour) || snapshot.localHour < 0 || snapshot.localHour > 23) {
    throw new RangeError("localHour 必须是 0..23 的整数");
  }
  if (!Number.isInteger(snapshot.unansweredOwnMsgs) || snapshot.unansweredOwnMsgs < 0) {
    throw new RangeError("unansweredOwnMsgs 必须是非负整数");
  }
  if (snapshot.localIso === "") throw new RangeError("localIso 不能为空");

  const lines: string[] = [];
  lines.push(`现在是 ${snapshot.localIso}（${snapshot.weekdayLabel}）`);
  const awake = awakeLine(snapshot);
  if (awake !== null) lines.push(awake);
  const contact = contactLine(snapshot.sinceLastUserMsgMin);
  if (contact !== null) lines.push(contact);
  const unanswered = unansweredLine(snapshot.unansweredOwnMsgs);
  if (unanswered !== null) lines.push(unanswered);
  const lastOwn = lastOwnLine(snapshot.sinceLastOwnMsgMin);
  if (lastOwn !== null) lines.push(lastOwn);
  const presence = presenceLine(snapshot.presence, snapshot.nowMs);
  if (presence !== null) lines.push(presence);
  lines.push(rhythmLine(snapshot.hisRhythm));

  return { lines, holdAllowed: true };
}

/** 读 `data/presence-<id>.json`；形状不对或过期返回 null（不抛，坏信号当没有）。 */
export function presenceOf(raw: unknown, nowMs: number): SituationPresence | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as { atMs?: unknown; active?: unknown; ttlMs?: unknown };
  if (typeof obj.atMs !== "number" || !Number.isFinite(obj.atMs) || obj.atMs <= 0) return null;
  if (typeof obj.active !== "boolean") return null;
  const ttlMs = typeof obj.ttlMs === "number" && Number.isFinite(obj.ttlMs) && obj.ttlMs >= 0 ? obj.ttlMs : 0;
  const presence: SituationPresence = { atMs: obj.atMs, active: obj.active, ttlMs };
  return presencePhrase(presence, nowMs) === null ? null : presence;
}

function presencePhrase(presence: SituationPresence, nowMs: number): string | null {
  if (presence === null) return null;
  const ttl = Math.max(0, presence.ttlMs);
  const age = nowMs - presence.atMs;
  if (!Number.isFinite(age) || age < 0 || age > ttl) return null;
  return presence.active ? "他就在电脑前" : "他刚离开电脑";
}

/** 一行摘要（日志/观测用），不用于提示词正文。 */
export function describeSituation(note: SituationNote): string {
  return note.lines.length === 0 ? "处境：没有可说的线索" : `处境：${note.lines.join("；")}`;
}
