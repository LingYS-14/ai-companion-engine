/**
 * §5.3 episode 五元组（P2 记忆改造的"只读/派生"那一半）
 *
 * 规格（docs/DESIGN.md/:392-394）要求 episode 与 fact 分表，
 * 且 episode 必带 `(t, place, participants, viewpoint, goal_at_time)` 五元组：
 * 少了它们，"我记得那次"与"我知道那件事"在数据上无法区分，人格连续性失去物质基础。
 *
 * 这个文件**不改记忆内核**（src/memory/* 属于 P2 的冻结门禁评审范围），只做三件事：
 *   1. 从已落盘的 MemoryRecord 派生五元组，并把"哪些字段是推断出来的"显式说出来
 *      （`missing` 数组）——补不出来的字段就是"这条不是真正的情景记忆"，不能假装有；
 *   2. 校验一条五元组是否合法（写入前用）；
 *   3. 提供具体的判断与具体性比例（§5.2 concreteness_ratio 的分子/分母）。
 *
 * 为什么不建 schema 字段：v5.2 的 27 字段是冻结的，加字段要走迁移与门禁评审；
 * 现有 `participants` 已经有，`place/viewpoint/goal_at_time` 可以经 `encode_ctx`
 * 承载。等 P2 评审通过再决定是否升格成正式字段（见 docs/DESIGN.md）。
 */

/** 五元组：时间、地点、在场者、第一人称视角/立场、当时想干什么。 */
export interface EpisodeQuintuple {
  /** 事件时间（毫秒时间戳）。 */
  readonly t: number;
  readonly place: string;
  readonly participants: readonly string[];
  /** 第一人称视角/当时立场（例如 "被丢下的那一边"）。 */
  readonly viewpoint: string;
  /** 当时的目标（不是现在的目标——这是 autonoetic 索引的关键）。 */
  readonly goalAtTime: string;
}

/** 五元组里可以缺省、由派生方给出推断值的字段。 */
export type EpisodeField = "place" | "viewpoint" | "goalAtTime";

export const EPISODE_FIELDS: readonly EpisodeField[] = Object.freeze(["place", "viewpoint", "goalAtTime"]);

/** 派生结果：值 + 哪些字段是推断的（不是记录里写着的）。 */
export interface DerivedQuintuple {
  readonly quintuple: EpisodeQuintuple;
  readonly missing: readonly EpisodeField[];
}

/** 判断"像不像情景"只需要情景细节，不需要时间；单独拆出来让工具函数不逼调用方造时间戳。 */
export interface EpisodeDetail {
  readonly participants?: readonly string[];
  readonly tags?: readonly string[];
  readonly encode_ctx?: Readonly<Record<string, unknown>>;
}

/** 派生五元组需要的只读视图；不 import MemoryRecord，避免把 orchestrator 绑到 memory 实现上。 */
export interface EpisodeSource extends EpisodeDetail {
  readonly created_at: number;
}

/** 从 `encode_ctx` 里读一个非空字符串；读不到返回 null（不猜）。 */
function ctxString(ctx: Readonly<Record<string, unknown>> | undefined, key: string): string | null {
  if (ctx === undefined) return null;
  const raw = ctx[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** 派生五元组。缺失字段走显式推断值，并在 `missing` 里记账。 */
export function deriveQuintuple(source: EpisodeSource): DerivedQuintuple {
  const missing: EpisodeField[] = [];

  const place = ctxString(source.encode_ctx, "place") ?? ctxString(source.encode_ctx, "location");
  if (place === null) missing.push("place");

  const viewpoint = ctxString(source.encode_ctx, "viewpoint");
  if (viewpoint === null) missing.push("viewpoint");

  const goal = ctxString(source.encode_ctx, "goal_at_time") ?? ctxString(source.encode_ctx, "goal");
  if (goal === null) missing.push("goalAtTime");

  const participants = (source.participants ?? []).map((p) => p.trim()).filter((p) => p !== "");

  return {
    quintuple: {
      t: source.created_at,
      // 推断值必须能一眼看出是推断的：前缀 "unknown:" 在回放与审计里都很好 grep。
      place: place ?? "unknown:place",
      participants,
      viewpoint: viewpoint ?? "unknown:viewpoint",
      goalAtTime: goal ?? "unknown:goal",
    },
    missing,
  };
}

/** 写入前的合法性校验；不抛错，返回错误清单（调用方决定记日志还是丢掉）。 */
export function validateQuintuple(q: EpisodeQuintuple): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(q.t) || q.t <= 0) errors.push("episode.t 必须是正有限数（毫秒时间戳）");
  if (typeof q.place !== "string" || q.place.trim() === "") errors.push("episode.place 不能为空");
  if (!Array.isArray(q.participants)) errors.push("episode.participants 必须是数组");
  else if (q.participants.some((p) => typeof p !== "string" || p.trim() === "")) {
    errors.push("episode.participants 里不能有空字符串");
  }
  if (typeof q.viewpoint !== "string" || q.viewpoint.trim() === "") errors.push("episode.viewpoint 不能为空");
  if (typeof q.goalAtTime !== "string" || q.goalAtTime.trim() === "") errors.push("episode.goal_at_time 不能为空");
  return errors;
}

/** 五元组是否可用于"真正的情景记忆"：三个推断字段都在就说明有据可查。 */
export function isConcreteQuintuple(derived: DerivedQuintuple): boolean {
  return derived.missing.length === 0;
}

/**
 * 这条记录像不像 episode（而不是 fact）。
 *
 * 这是**过渡期的启发式**，不是规格定义：现有 27 字段里没有 `memory_kind`，
 * 所以只能按"有没有情景细节"判断。判据按可信度排序：
 *   - 有 `participants`（在场者）或 `encode_ctx.scene` 非空 → 情景；
 *   - tags 里有 "episode"/"事件"/"聊天" 之类显式标记 → 情景；
 *   - 其余按 fact 计（语义记忆）。
 * 规格要求分表，但分表需要 schema 变更；在那之前，宁可少判 episode 也不多判。
 */
const EPISODE_TAG_HINTS: readonly string[] = Object.freeze(["episode", "事件", "聊天", "见面", "对话"]);

export function looksLikeEpisode(source: EpisodeDetail): boolean {
  if ((source.participants ?? []).some((p) => p.trim() !== "")) return true;
  const scene = source.encode_ctx?.["scene"];
  if (typeof scene === "string" && scene.trim() !== "") return true;
  const tags = source.tags ?? [];
  return tags.some((tag) => EPISODE_TAG_HINTS.includes(tag.trim().toLowerCase()));
}

/**
 * §5.2 的 `concreteness_ratio = 命中条目中带事件细节的 episode 数 / 命中条目总数`。
 * 分母为 0 时返回 null——"没有检索"不是"具体性为 0"，不能拿它去触发报警。
 */
export function concretenessRatio(hits: readonly EpisodeDetail[]): number | null {
  if (hits.length === 0) return null;
  const concrete = hits.filter((h) => looksLikeEpisode(h)).length;
  return concrete / hits.length;
}

/** 情景条目里的 affordance 三元组（§5.1 第 10 条）：可行动作 / 实际动作 / 后果。 */
export interface AffordanceTriple {
  readonly possible: readonly string[];
  readonly actual: string | null;
  readonly consequence: string | null;
}

/** 从 `encode_ctx.affordances` 读三元组；读不到就是空三元组（不编）。 */
export function deriveAffordances(source: EpisodeDetail): AffordanceTriple {
  const raw = source.encode_ctx?.["affordances"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { possible: [], actual: null, consequence: null };
  }
  const obj = raw as Record<string, unknown>;
  const possible = Array.isArray(obj["possible"])
    ? obj["possible"].filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];
  const actual = typeof obj["actual"] === "string" && obj["actual"].trim() !== "" ? obj["actual"].trim() : null;
  const consequence =
    typeof obj["consequence"] === "string" && obj["consequence"].trim() !== "" ? obj["consequence"].trim() : null;
  return { possible, actual, consequence };
}

/** 把毫秒时间戳格式化成 UTC 字符串（不读系统时钟：这里只是换算，不是取"现在"）。 */
export function formatUtc(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86_400);
  const rem = sec - days * 86_400;
  const hour = Math.floor(rem / 3_600);
  const minute = Math.floor((rem % 3_600) / 60);
  const second = rem % 60;
  // Howard Hinnant 的 civil_from_days：epoch 起算，纯算术，无时区状态。
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${p2(month)}-${p2(day)}T${p2(hour)}:${p2(minute)}:${p2(second)}Z`;
}

/** 供日志/审计的一行摘要：五元组 + 缺了哪些字段。 */
export function describeQuintuple(derived: DerivedQuintuple): string {
  const q = derived.quintuple;
  const who = q.participants.length === 0 ? "（没有在场者）" : q.participants.join("、");
  const missing = derived.missing.length === 0 ? "完整" : `推断字段=${derived.missing.join(",")}`;
  return `${formatUtc(q.t)} 在 ${q.place}，和 ${who}，视角=${q.viewpoint}，当时想=${q.goalAtTime}（${missing}）`;
}
