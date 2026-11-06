/**
 * 检索调用侧的「线索重合」：把记忆**写时记下的情境指纹**乘到这一次召回的排序上。
 *
 * ## 为什么要放在调用侧，而不是 retrieve.ts 里
 *
 * VISION §5.1 的检索是两段式：先按「此刻的自我」筛，再让相似度 × 线索重合 × 基础激活
 * 一起决定顺序。`retrieve.ts` 的打分是 v5.3 冻结门禁（A33–A38b）的一部分——**动它等于
 * 动整个检索语义**，而且它对"此刻"一无所知（只看 query 和状态）。
 *
 * 所以这里只做调用侧的二次排序：调用方（QQ / 窗口）知道自己在哪个渠道、眼前是谁，
 * 把这几件事拼成"当前的线索指纹"，和记忆里 `encode_ctx.cue_fingerprint` 比一比，
 * 用 0.5–1.0 的乘数重排。没有指纹的老记忆**不罚**——没记下来不等于对不上。
 * `retrieve.ts` 一行不改。
 *
 * ## 为什么 0.5 是地板
 *
 * 规格字面是"相乘"：线索完全对不上 → 分数乘 0 → 这条记忆永远想不起来。
 * 那等于把遗忘做成了删除。所以地板保留一半：**"想不起来"和"不存在"不是一回事**。
 * 但乘数确实小于 1，让"此刻更贴得上"的记忆排前面——这是线索重合唯一该做的事。
 */

import { clamp01 } from "../../engine/state.js";
import {
  MISSING_FINGERPRINT_RATIO,
  SCORE_FLOOR_MULTIPLIER,
  affectOf,
  buildCueFingerprint,
  cueOverlap,
  placeForChannel,
  type AffectBucket,
  type CueFingerprint,
  type EpisodeWriteInput,
} from "./episode-write.js";

/** 拼当前线索要的输入：都是调用方已经有的事实，不在这里猜 */
export interface RecallCueInput {
  /** 渠道（qq / gui / wechat / bili / local…），用来推地点；缺省 `unknown:no-channel` */
  readonly channel?: string | undefined;
  /** 眼前有谁（主人视角一般 `["用户"]`）；缺省空数组=不知道 */
  readonly participants?: readonly string[] | undefined;
  /** 此刻的情绪底色（S 层 valence） */
  readonly valence: number;
  /** 话题域（有 tag 就传，没有留空） */
  readonly topicDomain?: string | undefined;
  /** 此刻正在追的意图 id（有就传，没有 null） */
  readonly goalId?: string | null | undefined;
  /**
   * 此刻的本地小时（0..23 整数），由调用方从时钟传入。
   * 本批（T1）不接线：检索调用方默认不传 → 当前 cue 的 timeOfDay 为 null。
   */
  readonly localHour?: number | undefined;
}

/** 当前线索指纹 + 一行来源说明（来源只给日志/测试看，不进提示词） */
export interface RecallCue {
  readonly fingerprint: CueFingerprint;
  readonly source: string;
}

function cueWriteInput(input: RecallCueInput): EpisodeWriteInput {
  return {
    text: "",
    source: "unknown",
    channel: input.channel ?? "",
    mode: "NORMAL",
    tags: input.topicDomain === undefined || input.topicDomain === "" ? [] : [input.topicDomain],
    valence: clamp01(input.valence),
    arousal: 0,
    createdAtMs: 0,
    ...(input.goalId === undefined || input.goalId === null ? {} : { goalId: input.goalId }),
    ...(input.localHour === undefined ? {} : { localHour: input.localHour }),
  };
}

/** 把调用方已知的几件事拼成"当前线索"；非法 valence 抛 RangeError（静默变 0.5 会掩盖 bug） */
export function buildRecallCue(input: RecallCueInput): RecallCue {
  if (!Number.isFinite(input.valence)) throw new RangeError("buildRecallCue：valence 必须是有限数字");
  const participants = [...(input.participants ?? [])].filter((p) => p !== "");
  const channel = input.channel ?? "";
  const fingerprint = buildCueFingerprint(cueWriteInput(input), participants, placeForChannel(channel));
  const source = `channel=${channel === "" ? "none" : channel} participants=${String(participants.length)} affect=${fingerprint.affect}`;
  return { fingerprint, source };
}

/** 记忆里存下的指纹：形状不对就当"没有指纹"，不抛（旧记忆本来就可能有各种形状） */
export function readCueFingerprint(memory: { readonly encode_ctx?: Readonly<Record<string, unknown>> }): CueFingerprint | null {
  const raw = memory.encode_ctx?.["cue_fingerprint"];
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const topicDomain = obj["topicDomain"];
  const participants = obj["participants"];
  const place = obj["place"];
  const affect = obj["affect"];
  const goalId = obj["goalId"];
  const timeOfDayRaw = obj["timeOfDay"];
  if (typeof topicDomain !== "string" || typeof place !== "string") return null;
  if (!Array.isArray(participants) || participants.some((p) => typeof p !== "string")) return null;
  if (affect !== "positive" && affect !== "neutral" && affect !== "negative") return null;
  if (!(goalId === null || typeof goalId === "string")) return null;
  // 旧记录没有这个键 = 不知道（null，不罚）；写了就必须是合法四值之一，否则当"没有指纹"
  let timeOfDay: CueFingerprint["timeOfDay"] = null;
  if (timeOfDayRaw !== undefined && timeOfDayRaw !== null) {
    if (timeOfDayRaw !== "late_night" && timeOfDayRaw !== "morning" && timeOfDayRaw !== "afternoon" && timeOfDayRaw !== "evening") {
      return null;
    }
    timeOfDay = timeOfDayRaw;
  }
  return {
    topicDomain,
    participants: participants as string[],
    place,
    affect: affect as AffectBucket,
    timeOfDay,
    goalId: goalId as string | null,
  };
}

/** 乘数：没有指纹 → 1（不罚），有 → 0.5–1.0 */
export function cueMultiplier(
  memory: { readonly encode_ctx?: Readonly<Record<string, unknown>> },
  cue: RecallCue,
): { readonly multiplier: number; readonly ratio: number; readonly hasFingerprint: boolean } {
  const written = readCueFingerprint(memory);
  if (written === null) return { multiplier: MISSING_FINGERPRINT_RATIO, ratio: 1, hasFingerprint: false };
  const overlap = cueOverlap(written, cue.fingerprint);
  const ratio = clamp01(overlap.ratio);
  return {
    multiplier: SCORE_FLOOR_MULTIPLIER + (1 - SCORE_FLOOR_MULTIPLIER) * ratio,
    ratio,
    hasFingerprint: true,
  };
}

/** 重排结果：只重算分数与顺序，不动调用方传进来的数组 */
export interface CueRankedRow {
  readonly id: string;
  readonly baseScore: number;
  readonly score: number;
  readonly ratio: number;
  readonly hasFingerprint: boolean;
}

/** 按线索重合重排（分降序；同分保持原顺序——稳定排序，别让同分因为 Map 顺序抖动） */
export function rankByCue(
  rows: readonly { readonly id: string; readonly score: number }[],
  memoriesById: ReadonlyMap<string, { readonly encode_ctx?: Readonly<Record<string, unknown>> }>,
  cue: RecallCue,
): readonly CueRankedRow[] {
  const indexed = rows.map((row, index) => {
    const memory = memoriesById.get(row.id);
    const mult =
      memory === undefined
        ? { multiplier: MISSING_FINGERPRINT_RATIO, ratio: 1, hasFingerprint: false }
        : cueMultiplier(memory, cue);
    return { index, row, ...mult };
  });
  indexed.sort((a, b) => {
    const weightedA = a.row.score * a.multiplier;
    const weightedB = b.row.score * b.multiplier;
    if (weightedA !== weightedB) return weightedB - weightedA;
    return a.index - b.index;
  });
  return indexed.map((item) => ({
    id: item.row.id,
    baseScore: item.row.score,
    score: item.row.score * item.multiplier,
    ratio: item.ratio,
    hasFingerprint: item.hasFingerprint,
  }));
}

/** 一行诊断：给日志看，不进提示词（"为什么这条排前面"要能解释） */
export function describeCueRanking(rows: readonly CueRankedRow[]): string {
  if (rows.length === 0) return "cue(none)";
  const withFp = rows.filter((row) => row.hasFingerprint).length;
  const top = rows[0];
  const topText = top === undefined ? "none" : `${top.id}×${top.ratio.toFixed(2)}`;
  return `cue(top=${topText} fp=${String(withFp)}/${String(rows.length)} 地板=${String(SCORE_FLOOR_MULTIPLIER)})`;
}

/** 当前渠道对应的地点（复用同一份映射，避免两处口径漂移） */
export function cuePlaceOf(channel: string | undefined): string {
  return placeForChannel(channel ?? "");
}

export { affectOf };
