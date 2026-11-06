/**
 * 一轮「自言自语」：选材料 → 生成 → 判关系 → 落效应 → 写日志。
 *
 * 这是自主运行器里真正会碰记忆的唯一入口（写方 = 自主进程，单写者锁保证不与开发面并发）。
 * 效应严格按《自言自语与记忆》三条路径，且只动元数据：
 *   related   → 鲜活度↑、未解决松动、必要时改写情绪底色（不改内容/可信度）
 *   divergent → 鲜活度↓（干扰代价）
 *   unrelated → 不产生记忆效应
 */

import { knobNumber } from "../engine/config.js";
import type { EngineConfig } from "../engine/config.js";
import type { IntentNote } from "../dialogue/composer.js";
import type { MemoryStore } from "../memory/store.js";
import { thermalTier } from "../memory/thermal.js";
import { isSelfAuthored, SELF_AUTHORED_SOURCES } from "../memory/echo-sources.js";
import { echoScore, isEcho, takeLatestRefs, type EchoRefEntry } from "./echo-guard.js";
import { loadEchoPolicy } from "./echo-policy.js";
import {
  fallbackSelfTalk,
  planSelfTalk,
  relateSelfTalk,
  selfTalkEffects,
  type SelfTalkMood,
  type SelfTalkPlan,
  type SelfTalkSeed,
} from "./selftalk.js";
import {
  isRepeatText,
  SelftalkJournal,
  VOICE_DEDUP_WINDOW_MS,
  type JournalEntry,
} from "./selftalk-journal.js";

/** 判重逻辑已下沉到日记的写口（SelftalkJournal.wouldRepeat），这里保留旧导出给测试/调用点 */
export { isRepeatText };

export interface SelfTalkRunDeps {
  /** 只需这三个方法，便于用假 store 测效应 */
  readonly store: Pick<MemoryStore, "active" | "get" | "mutate" | "touch">;
  readonly journal: SelftalkJournal;
  readonly cfg: EngineConfig;
  readonly now: number;
  /** 现在的心境（只读投影；her runtime 的 valence/arousal） */
  readonly mood: SelfTalkMood;
  /** 模型调用；不传则用降级模板（保证循环不中断） */
  readonly generate?: (messages: readonly { role: "system" | "user"; content: string }[]) => Promise<string>;
  readonly personaName?: string;
  /**
   * 此刻的由头（意向引擎自述）。有它时提示词会多一段「我想做什么、为什么」。
   *
   * 只影响**生成时的由头**，不改语气/称呼/长度（那些仍由 persona 决定）；
   * 也不强制她说这件事——如果材料更近，允许照材料说。
   */
  readonly intentNote?: IntentNote;
  readonly log?: (line: string) => void;
}

export interface SelfTalkOutcome {
  readonly written: boolean;
  readonly kind: SelfTalkPlan["kind"];
  readonly relation: "related" | "divergent" | "unrelated";
  readonly text: string;
  readonly entry: JournalEntry | undefined;
  /** 这一轮为什么没写：目前只有「两次生成都与最近 24h 的话高度相似」 */
  readonly skipReason?: "repeat";
  /**
   * 这句话是不是**降级模板**（没有模型凭据 / 模型调用失败）。
   *
   * A9：降级模板只适合写进日记当"她一个人坐着时想的"，**不适合发给用户**——
   * 旧实现在没有 key 的夜里会把「忽然想起「…」了。就那么一下，又过去了。」真的发出去，
   * 看起来像系统提示而不是她。降级时保持日记如实落、但不发送。
   */
  readonly degraded?: boolean;
}

const SELF_TALK_SYSTEM = [
  "现在是没人跟你说话的时候。这些念头是你自己的，但你要把它们直接说出口，不是写旁白。",
  "写一句你真正会说给用户听的话：第一人称、口语、40 到 80 字。",
  "规则：只围绕给你的材料；材料是方向，不是给你抄的句子——不要逐字重复材料里的说法，用你自己的话，说出一处具体的细节；每一条换一个开头：不要总用「你回来了」「用户」「今天」起头，从动作、手里的东西、一个细节或半句没头没尾的念头起头，不要和上一条用同样的开头；材料里没有的细节不要编；不要提到「检索」「记忆库」「条目」这些词；不要总结今天做了什么；不要写「我在心里…」「刚刚想到…」「我心里念了一句…」这类描述自己内心过程的句子——直接把话说出来。",
].join("\n");

/**
 * 第一次撞上近重复时补一句重生成指令；仍然重复就放弃这一轮（不把同一句话再说一遍）。
 */
const MAX_GENERATE_ATTEMPTS = 2;
const RETRY_NOTE =
  "刚才那一句和最近说过的太像了。换一个开头、换一种说法再说一遍：仍然只围绕材料，不要把材料原句照抄。";

/**
 * 自言自语用的 system 提示词。
 *
 * 不给由头时**逐字节等于旧提示词**（老测试/老日志口径不变）；给了才追加一段
 * 「此刻的由头」，并明确允许她不围绕它说——否则每次思考都被意图引擎绑死。
 */
export function selfTalkSystem(personaName: string, note?: IntentNote): string {
  // F326 方案 A：名字只是 UI 标识，取不到就不提名字；不再回落到写死的旧名字。
  const name = personaName.trim();
  const base = name === "" ? SELF_TALK_SYSTEM : `你叫${name}。\n${SELF_TALK_SYSTEM}`;
  if (note === undefined) return base;
  const parts = [`【此刻的由头】${note.line}`, `为什么是这个由头：${note.whyLine}`];
  if (note.statusLine !== undefined) parts.push(note.statusLine);
  parts.push(
    "如果这个由头正是你现在想说的，就围绕它说；如果给你的材料更近，就照材料说。",
    "先说事情，不要复述这段说明，也不要提「意图」「引擎」「由头」这些词。",
  );
  return `${base}\n${parts.join("\n")}`;
}

function toSeed(
  rec: {
    id: string;
    content: string;
    tags: string[];
    vividness: number;
    unresolved_score: number;
    encode_state: Record<string, number>;
  },
  tier: SelfTalkSeed["tier"],
): SelfTalkSeed {
  const valence = rec.encode_state["valence"];
  return {
    id: rec.id,
    tags: rec.tags,
    vividness: rec.vividness,
    unresolved: rec.unresolved_score,
    tier,
    valence: typeof valence === "number" ? valence : 0.55,
    // 只给到 60 字：够她想起具体是什么事，又不至于把整段对话塞进提示词
    gist: (typeof rec.content === "string" ? rec.content : "").trim().slice(0, 60),
  };
}

/** 短到没有材料的记忆不当种子（「在吗」「嗯」这种只会让她说空话） */
const MIN_SEED_CHARS = 4;

/** 本轮材料里最值得回指的话题（给日志/诊断用） */
export function seedsFor(
  store: Pick<MemoryStore, "active">,
  now: number,
  cfg: EngineConfig,
  /** task-169 B：这些来源的记忆不当自言自语的材料（她自己说过的话） */
  excludeSources?: readonly string[],
): SelfTalkSeed[] {
  const out: SelfTalkSeed[] = [];
  const skip = new Set(excludeSources ?? []);
  for (const rec of store.active()) {
    if (skip.has(rec.source)) continue;
    // 只有「确实很短」才丢；旧测试夹具没有 content 字段，不能因此整批丢种子
    const text = typeof rec.content === "string" ? rec.content.trim() : "";
    if (text !== "" && text.length < MIN_SEED_CHARS) continue;
    out.push(toSeed(rec, thermalTier(rec, now, cfg)));
  }
  return out;
}

export async function runSelfTalk(deps: SelfTalkRunDeps): Promise<SelfTalkOutcome> {
  // task-169 B：选材先排除「她自己说出去的话」——否则会把自己以前的主动发言/
  // 自言自语/网页回复当材料，再生成一遍（回声室）。
  const policy = loadEchoPolicy({ read: (name) => knobNumber(deps.cfg, name) });
  const all = seedsFor(deps.store, deps.now, deps.cfg, SELF_AUTHORED_SOURCES);
  // 最近 24h 想过的种子先让一让（与写口去重窗口对齐）：旧版只看最近 3 条，
  // 同一批种子会一轮轮重播、生成出同一句话——写口现在会挡，但那样等于一整天白转。
  const recentEntries = deps.journal.entriesSince(deps.now - VOICE_DEDUP_WINDOW_MS);
  const recentSeeds = recentEntries.flatMap((e) => e.seeds ?? []);
  const avoid = [...new Set(recentSeeds)];
  const plan = planSelfTalk({
    seeds: all,
    mood: deps.mood,
    cfg: deps.cfg,
    avoid,
    recent: recentSeeds,
    variant: deps.journal.size(),
    // task-169 B：把最近日记正文交给选材做多样性判断（同一件事换一个材料讲）。
    recentTexts: recentEntries.map((e) => e.text),
  });
  // task-169 C：回声自检的参照文本 = 最近日记 + 她自己说出去的话（memory 自述来源）。
  // 只在生成侧判重时用，不进提示词（提示词材料仍由 plan.frame 决定）。
  // task-170 B1：三个来源拼接顺序不代表时间顺序，必须按 atMs 排序后再取最新 lookback 条；
  // 否则总量 > lookback 时最新一条会被截掉，闸门漏检最近输出。
  const echoFloorMs = deps.now - policy.windowMs;
  // task-172：参照只取「已发生」的日记（上界挡掉时钟回拨写进来的未来条目）；
  // recentTexts 的多样性窗口保持原样，不跟着收窄。
  const recentEchoEntries = recentEntries.filter((entry) => entry.at >= echoFloorMs && entry.at <= deps.now);
  const memoryRefs: EchoRefEntry[] = deps.store
    .active()
    .filter((rec) => isSelfAuthored(rec.source))
    .filter((rec) => rec.created_at >= echoFloorMs && rec.created_at <= deps.now)
    .map((rec) => ({ text: typeof rec.content === "string" ? rec.content : "", atMs: rec.created_at }));
  const echoRefs = takeLatestRefs(
    [
      ...recentEchoEntries.map((entry) => ({ text: entry.text, atMs: entry.at })),
      ...memoryRefs,
    ],
    policy.lookback,
  );
  // 可观测：这一轮选了哪条材料、为什么（F311：旧实现没有任何选材日志，只能靠事后猜）
  deps.log?.(
    `[selftalk] 选材 ${plan.pick ?? "fresh"}：${plan.seeds.length > 0 ? plan.seeds.join(",") : "无材料"}（${plan.note ?? ""}）excluded=self`,
  );
  const seedsById = new Map(all.map((s) => [s.id, s]));
  const chosen = plan.seeds.map((id) => seedsById.get(id)).filter((s): s is SelfTalkSeed => s !== undefined);

  let text: string;
  // 降级模板也是「从种子长出来的」，不是跑偏；只有模型真的离题才该吃干扰代价
  let degraded = deps.generate === undefined;
  let attempts = 0;
  if (deps.generate === undefined) {
    text = fallbackSelfTalk(plan);
  } else {
    // F326 方案 A：不再回落到写死的人名；装配层传 displayName 时才有名字。
    const name = deps.personaName ?? "";
    let current: string | undefined;
    let failure: string | undefined;
    for (attempts = 1; attempts <= MAX_GENERATE_ATTEMPTS; attempts += 1) {
      const messages: { role: "system" | "user"; content: string }[] = [
        { role: "system", content: selfTalkSystem(name, deps.intentNote) },
        { role: "user", content: plan.frame },
      ];
      if (attempts > 1) {
        messages.push({ role: "user", content: RETRY_NOTE });
        deps.log?.(`[selftalk] 近重复：换开头重生成（第 ${String(attempts)} 次）`);
      }
      try {
        current = await deps.generate(messages);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        current = undefined;
        break;
      }
      const journalRepeat = deps.journal.wouldRepeat(current, deps.now);
      const echoHit = !journalRepeat && isEcho(current, echoRefs, policy.threshold);
      if (echoHit) {
        deps.log?.(
          `[selftalk] 回声自检：与近期输出相似（Dice=${echoScore(current, echoRefs).toFixed(2)}），` +
            `换一句重生成（第 ${String(attempts)} 次）`,
        );
      }
      if (!journalRepeat && !echoHit) break;
    }
    if (current === undefined) {
      deps.log?.(`[selftalk] 生成失败，用降级模板：${failure ?? ""}`);
      degraded = true;
      text = fallbackSelfTalk(plan);
    } else {
      text = current;
    }
  }

  // 重复抑制：同一句（或高度相似）不再写、不再说。窗口是 24h 时间窗（=审计的扫描窗），
  // 不再是「最近 6 条」——那样只覆盖约 4 小时，14 小时后的同句会漏过去（F92 真事故）。
  // 判重在日记的写口（SelftalkJournal.wouldRepeat）；这里先问一次，好让记忆效应不落空。
  // F311：撞上近重复不再直接放弃——先换开头重生成一次；两次都像才跳过这一轮。
  const finalRepeat = deps.journal.wouldRepeat(text, deps.now);
  const finalEcho = !finalRepeat && isEcho(text, echoRefs, policy.threshold);
  if (finalRepeat || finalEcho) {
    deps.log?.(
      finalEcho
        ? `[selftalk] 跳过：与近期自身输出高度相似（Dice=${echoScore(text, echoRefs).toFixed(2)}，生成 ${String(Math.min(attempts, MAX_GENERATE_ATTEMPTS))} 次）text=${text.slice(0, 24)}`
        : `[selftalk] 跳过：与最近 24h 的话高度相似（生成 ${String(Math.min(attempts, MAX_GENERATE_ATTEMPTS))} 次）text=${text.slice(0, 24)}`,
    );
    return {
      written: false,
      kind: plan.kind,
      relation: "unrelated",
      text: "",
      entry: undefined,
      skipReason: "repeat",
    };
  }

  const relation = degraded ? (chosen.length > 0 ? "related" : "unrelated") : relateSelfTalk(text, chosen);
  const effects = selfTalkEffects(relation, chosen, deps.mood, deps.cfg);

  // 效应：只动元数据，且都夹在合法区间
  for (const [id, delta] of effects.vividness) {
    const rec = deps.store.get(id);
    if (rec === undefined) continue;
    const next = Math.max(0, Math.min(1, rec.vividness + delta));
    deps.store.mutate(id, { vividness: next });
    // 回指也是一次取用：按 ACT-R 抬激活（只对加成的路径）
    if (delta > 0) deps.store.touch(id, deps.now);
  }
  if (effects.unresolvedRelief > 0) {
    for (const id of plan.seeds) {
      const rec = deps.store.get(id);
      if (rec === undefined) continue;
      deps.store.mutate(id, { unresolved_score: Math.max(0, rec.unresolved_score - effects.unresolvedRelief) });
    }
  }
  if (effects.rewrite !== undefined) {
    const rec = deps.store.get(effects.rewrite.id);
    if (rec !== undefined) {
      const before = rec.encode_state["valence"];
      const base = typeof before === "number" ? before : 0.55;
      const next = Math.max(0, Math.min(1, base + effects.rewrite.valenceShift));
      deps.store.mutate(effects.rewrite.id, { encode_state: { ...rec.encode_state, valence: next } });
    }
  }

  const entry: JournalEntry = {
    id: `st_${String(deps.now)}_${plan.seeds.join("").slice(0, 8)}`,
    at: deps.now,
    kind: plan.kind,
    seeds: plan.seeds,
    text,
    relation,
    vividness: effects.vividness,
    unresolvedRelief: effects.unresolvedRelief,
    rewrite: effects.rewrite,
    source: "autonomy",
    ...(degraded ? { degraded: true } : {}),
  };
  // 写口还有第二道闸（同一句不论走哪条路径都不进日记）；被挡下就当这一轮没发生。
  if (!deps.journal.append(entry, deps.cfg)) {
    deps.log?.(`[selftalk] 写口去重挡下 text=${text.slice(0, 24)}`);
    return { written: false, kind: plan.kind, relation: "unrelated", text: "", entry: undefined };
  }
  deps.log?.(
    `[selftalk] ${plan.kind}/${relation} seeds=${String(plan.seeds.length)} try=${String(attempts)} text=${text.slice(0, 40)}`,
  );

  return { written: true, kind: plan.kind, relation, text, entry, ...(degraded ? { degraded: true } : {}) };
}

/** 供自主进程读取间隔（SELFTALK_INTERVAL_MS），并被注册表检查视为消费点 */
export function selfTalkIntervalMs(cfg: EngineConfig): number {
  const raw = knobNumber(cfg, "SELFTALK_INTERVAL_MS");
  return Math.max(300_000, Math.min(10_800_000, Math.floor(raw)));
}
