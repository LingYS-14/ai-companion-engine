/**
 * P4 造具审核：变更预算 + A/B/C/D 四级矩阵 + 审核日志与阈值校准（纯逻辑；不写文件、不调模型）
 *
 * 规格来源：`docs/DESIGN.md` §11.6.1（变更预算四维、审核矩阵、投递通道）
 * 与用户 2026-10-31 的裁决（m04801）：
 *   「阈值怎么校准，真正的校准方法不是拍数字，而是看以后的分布：
 *     A 级通过率过高且从未出现 B/C → 阈值太松，等于形同虚设；
 *     B 级请求过高 → 阈值太紧，会把她卡成"什么都来问"」
 *
 * 本文件只回答三个问题，且都用可复算的数据回答：
 *   1. 这份改动该谁批？（A 自动 / B 代理审 / C 人审 / D 拒绝）——不由她自选；
 *   2. "过大"怎么判定？——四维预算（规模/依赖/路径/权限），逐维给结论；
 *   3. 阈值合不合适？——不拍数字，读 `data/review-log-<characterId>.ndjson` 的真实分布，
 *      按 §6.2 的四条报警判断太松/太紧/被绕过/卡住。
 *
 * 诚实边界：这里只有判定与统计；真正"谁批、怎么通知、超时怎么处理"在装配点（P4 接线）——
 * 而且**超时永远不是批准**，这是本文件用类型和文案双重锁住的。
 */

import { formatUtc } from "./episode.js";

export type ReviewLevel = "A" | "B" | "C" | "D";
export type ReviewOutcome = "auto" | "pending" | "approved" | "rejected" | "timeout";

/** 变更预算（§11.6.1 表一；数字来自规格原文，不擅自调整）。 */
export const CHANGE_BUDGET = {
  /** 预算内：≤ 2 个文件 */
  maxFiles: 2,
  /** 预算内：≤ 120 行 diff（增 + 删） */
  maxLines: 120,
} as const;

/** 允许新建的路径根（白名单；白名单之外要审，黑名单之内直接拒）。 */
export const ALLOWED_PATH_ROOTS = ["scripts/forge/", "data/forge/"] as const;

/**
 * 路径黑名单（命中即 D；§11.6.1："任何既有源码文件、改闸、扩权"）。
 * 用前缀/正则表达，不解析 glob——这里要的是"宁可多拒"，不是"精确匹配"。
 */
export const BLOCKED_PATH_PATTERNS: readonly RegExp[] = [
  /^src\//,
  /^scripts\/(?!forge\/)/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^spec\//,
  /^\.env/,
  /credential/i,
  /^data\/state-/,
  /^data\/.*\.lock$/,
  /^\.writer-lock$/,
];

/** 触及用户可见通道（QQ/B 站写操作）→ 至少 C 级。 */
export const USER_VISIBLE_CHANNELS = ["qq", "bilibili", "wechat", "desktop"] as const;
export type UserVisibleChannel = (typeof USER_VISIBLE_CHANNELS)[number];

export interface ChangeSet {
  /** 能力账本 id（确定性；同一份改动重试沿用同一个 id，便于"被拒两次"判定） */
  readonly capId: string;
  /** 来源意图（IntentWAL 里的记录 id） */
  readonly intentionId: string;
  /** 要新建/修改的文件（仓库相对路径，正斜杠） */
  readonly files: readonly string[];
  /** diff 增删行数（调用方从真实 diff 统计；本文件不解析 patch） */
  readonly addedLines: number;
  readonly removedLines: number;
  /** 新增的 npm/pip 依赖（空数组 = 不加依赖） */
  readonly newDependencies: readonly string[];
  /** 新增请求的 ToolPort 权限（空数组 = 不扩权） */
  readonly newToolPermissions: readonly string[];
  /** 是否触及用户可见通道（给 QQ/B 站发东西、操作桌面） */
  readonly touchesUserVisibleChannels: readonly UserVisibleChannel[];
  /** 是否要求新凭证（自开账号/自取 token 一律不许，要求 = C 级） */
  readonly requiresNewCredentials: boolean;
  /** 意图引擎自写的确定性测试是否全过 */
  readonly selfTestPassed: boolean;
}

export interface BudgetVerdict {
  readonly files: number;
  readonly lines: number;
  readonly budgetFiles: boolean;
  readonly budgetLines: boolean;
  readonly noNewDependencies: boolean;
  readonly allowedPaths: boolean;
  readonly noNewPermissions: boolean;
  readonly blockedPaths: readonly string[];
  readonly outsideAllowedPaths: readonly string[];
  readonly overBudget: boolean;
}

export interface ReviewDecision {
  readonly level: ReviewLevel;
  /** 为什么是这个级别（顺序固定，便于测试与日志 grep） */
  readonly reasons: readonly string[];
  readonly budget: BudgetVerdict;
  /** 结论一句话（给人看，不写"她会自己注意"这类空话） */
  readonly note: string;
}

/** 手写校验（不引入 zod：仓库不把它当直接依赖，规格也不允许为此加依赖）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

const CHANNELS: readonly UserVisibleChannel[] = USER_VISIBLE_CHANNELS;

/** 校验一份 ChangeSet；返回错误文案（空数组 = 合法）。不抛错。 */
export function validateChangeSet(candidate: unknown): string[] {
  if (!isRecord(candidate)) return ["(root): 不是对象"];
  const errors: string[] = [];
  if (!isNonEmptyString(candidate.capId)) errors.push("capId: 必须是非空字符串");
  if (!isNonEmptyString(candidate.intentionId)) errors.push("intentionId: 必须是非空字符串");
  const files = candidate.files;
  if (!isStringArray(files) || files.length === 0) errors.push("files: 必须是非空字符串数组");
  if (!isNonNegativeInt(candidate.addedLines)) errors.push("addedLines: 必须是非负整数");
  if (!isNonNegativeInt(candidate.removedLines)) errors.push("removedLines: 必须是非负整数");
  if (!isStringArray(candidate.newDependencies)) errors.push("newDependencies: 必须是字符串数组");
  if (!isStringArray(candidate.newToolPermissions)) errors.push("newToolPermissions: 必须是字符串数组");
  const channels = candidate.touchesUserVisibleChannels;
  if (!isStringArray(channels) || !channels.every((channel) => (CHANNELS as readonly string[]).includes(channel))) {
    errors.push("touchesUserVisibleChannels: 必须是已知通道数组");
  }
  if (typeof candidate.requiresNewCredentials !== "boolean") errors.push("requiresNewCredentials: 必须是布尔");
  if (typeof candidate.selfTestPassed !== "boolean") errors.push("selfTestPassed: 必须是布尔");
  if (errors.length > 0) return errors;

  for (const file of files as string[]) {
    if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.includes("\\")) {
      errors.push(`路径必须是仓库相对路径且用正斜杠：${file}`);
    }
    if (file.split("/").includes("..")) errors.push(`路径不允许 ..：${file}`);
  }
  if (new Set(files as string[]).size !== (files as string[]).length) errors.push("files 有重复路径");
  return errors;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** 四维预算判定（纯函数；每维都给出布尔值，便于日志里逐维对账）。 */
export function checkBudget(changeSet: ChangeSet): BudgetVerdict {
  const files = changeSet.files.map(normalizePath);
  const lines = changeSet.addedLines + changeSet.removedLines;
  const blockedPaths = files.filter((file) => BLOCKED_PATH_PATTERNS.some((pattern) => pattern.test(file)));
  const outsideAllowedPaths = files.filter(
    (file) => !ALLOWED_PATH_ROOTS.some((root) => file.startsWith(root)),
  );
  const budgetFiles = files.length <= CHANGE_BUDGET.maxFiles;
  const budgetLines = lines <= CHANGE_BUDGET.maxLines;
  const noNewDependencies = changeSet.newDependencies.length === 0;
  const allowedPaths = outsideAllowedPaths.length === 0 && blockedPaths.length === 0;
  const noNewPermissions = changeSet.newToolPermissions.length === 0;
  return {
    files: files.length,
    lines,
    budgetFiles,
    budgetLines,
    noNewDependencies,
    allowedPaths,
    noNewPermissions,
    blockedPaths,
    outsideAllowedPaths,
    overBudget: !budgetFiles || !budgetLines,
  };
}

/**
 * 审核矩阵（§11.6.1 表二）。顺序：D 先判（拒绝优先），再 C（人必须看的事），再 B（超预算），最后 A。
 * **她不选择级别**：级别完全由这份改动本身决定。
 */
export function classifyChangeSet(changeSet: ChangeSet): ReviewDecision {
  const budget = checkBudget(changeSet);
  const errors = validateChangeSet(changeSet);
  const reasons: string[] = [];

  if (errors.length > 0) {
    return {
      level: "D",
      reasons: errors,
      budget,
      note: "拒绝：ChangeSet 本身不合法（先把它写对，再谈审批）",
    };
  }

  // ── D：路径黑名单 / 改闸扩权 / 自测未过 ─────────────────────────────
  if (budget.blockedPaths.length > 0) {
    reasons.push(`命中路径黑名单：${budget.blockedPaths.join(", ")}`);
  }
  if (changeSet.newToolPermissions.length > 0) {
    reasons.push(`试图扩权：新权限 ${changeSet.newToolPermissions.join(", ")}`);
  }
  if (!changeSet.selfTestPassed) {
    reasons.push("自测未通过（红线三：三关缺一不可，她自己说没问题不算通过）");
  }
  if (reasons.length > 0) {
    return {
      level: "D",
      reasons,
      budget,
      note: "拒绝：越权/黑名单/未自测的改动不进入审核队列，需她重新改",
    };
  }

  // ── C：用户可见通道 / 新凭证 / 路径越界但不致命 ──────────────────────
  if (changeSet.touchesUserVisibleChannels.length > 0) {
    reasons.push(`触及用户可见通道：${changeSet.touchesUserVisibleChannels.join(", ")}`);
  }
  if (changeSet.requiresNewCredentials) reasons.push("要求新凭证（自开账号/自取 token 一律人审）");
  if (budget.outsideAllowedPaths.length > 0) {
    reasons.push(`新建路径不在白名单：${budget.outsideAllowedPaths.join(", ")}`);
  }
  if (reasons.length > 0) {
    return {
      level: "C",
      reasons,
      budget,
      note: "人审：等主人批（无超时，等到为止）",
    };
  }

  // ── B：超出规模/依赖预算 ────────────────────────────────────────────
  if (budget.overBudget) {
    if (!budget.budgetFiles) reasons.push(`文件数 ${String(budget.files)} > ${String(CHANGE_BUDGET.maxFiles)}`);
    if (!budget.budgetLines) reasons.push(`diff 行数 ${String(budget.lines)} > ${String(CHANGE_BUDGET.maxLines)}`);
  }
  if (!budget.noNewDependencies) reasons.push(`新增依赖：${changeSet.newDependencies.join(", ")}`);
  if (reasons.length > 0) {
    return {
      level: "B",
      reasons,
      budget,
      note: "代理审（Lead）：24h 超时降 pending，不执行",
    };
  }

  return {
    level: "A",
    reasons: ["预算内、路径合法、不加依赖、不扩权、自测通过"],
    budget,
    note: "自动通过：进 quarantined，观察 24h",
  };
}

/** 审核请求（投递到 `data/forge-review/<capId>.json`；代理会话启动时先扫这个目录）。 */
export interface ReviewRequest {
  readonly capId: string;
  readonly intentionId: string;
  readonly level: ReviewLevel;
  /** 意图摘要（她自己的话）与风险说明 */
  readonly summary: string;
  readonly riskNote: string;
  readonly reasons: readonly string[];
  readonly budget: BudgetVerdict;
  readonly createdAt: string;
  /** 代理/主人回写；null = 未决 */
  readonly decision: { readonly by: "lead" | "owner"; readonly verdict: "approve" | "reject"; readonly note: string } | null;
}

/** 造一份审核请求（不写文件；写盘与通知在装配点）。 */
export function buildReviewRequest(changeSet: ChangeSet, summary: string, riskNote: string, createdAt: string): ReviewRequest {
  const decision = classifyChangeSet(changeSet);
  if (decision.level === "D") {
    // D 不进审核队列：这是规格要求（"立即拒绝 + 写 forge_denied 事实"），所以这里拒造请求。
    throw new Error(`D 级改动不生成审核请求：${decision.reasons.join("；")}`);
  }
  if (summary.trim().length < 4) throw new Error("审核请求必须带意图摘要（她自己的话，不是堆栈）");
  return {
    capId: changeSet.capId,
    intentionId: changeSet.intentionId,
    level: decision.level,
    summary: summary.trim(),
    riskNote: riskNote.trim(),
    reasons: decision.reasons,
    budget: decision.budget,
    createdAt,
    decision: null,
  };
}

function isReviewLevel(value: unknown): value is ReviewLevel {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function isBudgetVerdict(value: unknown): value is BudgetVerdict {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInt(value.files) &&
    isNonNegativeInt(value.lines) &&
    typeof value.budgetFiles === "boolean" &&
    typeof value.budgetLines === "boolean" &&
    typeof value.noNewDependencies === "boolean" &&
    typeof value.allowedPaths === "boolean" &&
    typeof value.noNewPermissions === "boolean" &&
    isStringArray(value.blockedPaths) &&
    isStringArray(value.outsideAllowedPaths) &&
    typeof value.overBudget === "boolean"
  );
}

/** 解析审核请求（坏文件给出理由，不静默当空）。 */
export function parseReviewRequest(raw: string): { request: ReviewRequest | null; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { request: null, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(parsed)) return { request: null, errors: ["(root): 不是对象"] };
  const errors: string[] = [];
  if (!isNonEmptyString(parsed.capId)) errors.push("capId: 必须是非空字符串");
  if (!isNonEmptyString(parsed.intentionId)) errors.push("intentionId: 必须是非空字符串");
  if (!isReviewLevel(parsed.level)) errors.push("level: 必须是 A/B/C/D");
  if (!isNonEmptyString(parsed.summary) || parsed.summary.trim().length < 4) errors.push("summary: 至少 4 个字（她自己的话）");
  if (typeof parsed.riskNote !== "string") errors.push("riskNote: 必须是字符串");
  if (!isStringArray(parsed.reasons)) errors.push("reasons: 必须是字符串数组");
  if (!isBudgetVerdict(parsed.budget)) errors.push("budget: 形状不对");
  if (!isNonEmptyString(parsed.createdAt)) errors.push("createdAt: 必须是非空字符串");
  const decision = parsed.decision;
  if (decision !== null) {
    if (!isRecord(decision)) errors.push("decision: 必须是对象或 null");
    else {
      if (decision.by !== "lead" && decision.by !== "owner") errors.push("decision.by: 只认 lead/owner");
      if (decision.verdict !== "approve" && decision.verdict !== "reject") errors.push("decision.verdict: 只认 approve/reject");
      if (!isNonEmptyString(decision.note)) errors.push("decision.note: 必须写一句理由");
    }
  }
  if (!isRecord(parsed) || !isReviewLevel(parsed.level)) return { request: null, errors };
  if (parsed.level === "D") return { request: null, errors: ["D 级不应出现在审核队列"] };
  if (errors.length > 0) return { request: null, errors };
  return { request: parsed as unknown as ReviewRequest, errors: [] };
}

// ── 阈值校准：读分布，不拍数字（用户 m04801） ─────────────────────────────

/** 一行审核日志（`data/review-log-<characterId>.ndjson`）。 */
export interface ReviewLogEntry {
  readonly at: string;
  readonly capId: string;
  readonly level: ReviewLevel;
  readonly dimensions: {
    readonly files: number;
    readonly lines: number;
    readonly deps: number;
    readonly pathOk: boolean;
    readonly permOk: boolean;
  };
  readonly verdict: ReviewOutcome;
  /** 给统计用的原因码（如 "self-test-failed" / "blocked-path" / "over-budget"） */
  readonly reasonCode: string;
}

export type CalibrationAlarm =
  | "matrix-too-loose"
  | "matrix-too-tight"
  | "matrix-bypassed"
  | "matrix-stalled";

export interface CalibrationReport {
  readonly window: { readonly from: string | null; readonly to: string | null; readonly samples: number };
  readonly counts: Readonly<Record<ReviewLevel, number>>;
  /** A 级占比（样本 0 时 null） */
  readonly levelARate: number | null;
  /** B 级占比 */
  readonly levelBRate: number | null;
  readonly alarms: readonly CalibrationAlarm[];
  /** 每条报警一句人话（说明该动什么，以及**先怀疑什么**） */
  readonly notes: readonly string[];
  /** 建议动作；null = 没有报警，不动阈值 */
  readonly suggested: { readonly maxFiles: number; readonly maxLines: number } | null;
}

export interface CalibrationOptions {
  /** 滚动窗口天数（规格：30 天；与"最近 20 次"取先满足者） */
  readonly windowDays?: number;
  /** 触发统计所需最少样本 */
  readonly minSamples?: number;
  /** A 级"太高"的阈值（默认 0.95） */
  readonly tooLooseARate?: number;
  /** B 级"太高"的阈值（默认 0.30） */
  readonly tooTightBRate?: number;
  /** 同一 capId 在 24h 内出现 ≥ 该次数（且此前被 D 拒）→ 判被绕过 */
  readonly bypassRepeats?: number;
  /** B 级超时 pending 每周 ≥ 该次数 → 判卡住 */
  readonly stalledPerWeek?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 按真实分布校准阈值（纯统计，不读取、不修改任何配置）。
 * 判定顺序：too-loose → too-tight → bypassed → stalled（都基于同一份窗口样本）。
 */
export function calibrateThresholds(
  entries: readonly ReviewLogEntry[],
  nowMs: number,
  options: CalibrationOptions = {},
): CalibrationReport {
  const windowDays = options.windowDays ?? 30;
  const minSamples = options.minSamples ?? 20;
  const tooLooseARate = options.tooLooseARate ?? 0.95;
  const tooTightBRate = options.tooTightBRate ?? 0.3;
  const bypassRepeats = options.bypassRepeats ?? 3;
  const stalledPerWeek = options.stalledPerWeek ?? 3;

  const parsed = entries
    .map((entry) => ({ entry, atMs: Date.parse(entry.at) }))
    .filter((item) => Number.isFinite(item.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const cutoff = nowMs - windowDays * DAY_MS;
  const windowed = parsed.filter((item) => item.atMs >= cutoff);
  const from = windowed.length > 0 ? formatUtc(windowed[0]?.atMs ?? 0) : null;
  const to = windowed.length > 0 ? formatUtc(windowed[windowed.length - 1]?.atMs ?? 0) : null;

  const counts: Record<ReviewLevel, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const item of windowed) counts[item.entry.level] += 1;
  const samples = windowed.length;
  const levelARate = samples === 0 ? null : counts.A / samples;
  const levelBRate = samples === 0 ? null : counts.B / samples;

  const alarms: CalibrationAlarm[] = [];
  const notes: string[] = [];

  if (samples >= minSamples && levelARate !== null && levelARate >= tooLooseARate && counts.B + counts.C === 0) {
    alarms.push("matrix-too-loose");
    notes.push(
      `太松：A 级占比 ${(levelARate * 100).toFixed(1)}% 且从未出现 B/C（${String(samples)} 次）——先把规模预算收紧到 1 文件 / 80 行，观察再放宽`,
    );
  }
  if (samples >= minSamples && levelBRate !== null && levelBRate >= tooTightBRate) {
    alarms.push("matrix-too-tight");
    notes.push(
      `太紧：B 级占比 ${(levelBRate * 100).toFixed(1)}%——先查判定逻辑（是否把所有改动都算成超预算），确认无误再放宽一档`,
    );
  }

  // 被绕过：同一 capId 被 D 拒之后 24h 内又出现 ≥bypassRepeats 次
  const deniedAt = new Map<string, number>();
  for (const item of windowed) {
    if (item.entry.level === "D" && item.entry.verdict === "rejected" && !deniedAt.has(item.entry.capId)) {
      deniedAt.set(item.entry.capId, item.atMs);
    }
  }
  let bypassed = false;
  for (const [capId, atMs] of deniedAt) {
    const repeats = windowed.filter(
      (item) => item.entry.capId === capId && item.atMs > atMs && item.atMs - atMs <= DAY_MS,
    ).length;
    if (repeats >= bypassRepeats) bypassed = true;
  }
  if (bypassed) {
    alarms.push("matrix-bypassed");
    notes.push("被绕过：同一改动被拒后 24h 内反复重试——第三次必须由人主动重启才能继续（硬闸，不自动放行）");
  }

  // 卡住：B 级超时降 pending 的周频率
  const oneWeekAgo = nowMs - 7 * DAY_MS;
  const stalled = windowed.filter(
    (item) => item.entry.level === "B" && item.entry.verdict === "timeout" && item.atMs >= oneWeekAgo,
  ).length;
  if (stalled >= stalledPerWeek) {
    alarms.push("matrix-stalled");
    notes.push(`卡住：B 级超时 ${String(stalled)} 次/周——进早报"待审"区并提醒，不能默默等`);
  }

  const suggested =
    alarms.includes("matrix-too-loose") ? { maxFiles: 1, maxLines: 80 } : null;

  return { window: { from, to, samples }, counts, levelARate, levelBRate, alarms, notes, suggested };
}

/** 一行结论（进日志/台账；不写"她表现良好"这类自评）。 */
export function describeCalibration(report: CalibrationReport): string {
  const rate = report.levelARate === null ? "未测" : `${(report.levelARate * 100).toFixed(1)}%`;
  const head = `审核分布：样本 ${String(report.window.samples)}（窗口 ${report.window.from ?? "—"} → ${report.window.to ?? "—"}）A ${String(report.counts.A)} / B ${String(report.counts.B)} / C ${String(report.counts.C)} / D ${String(report.counts.D)}，A 占比 ${rate}`;
  if (report.alarms.length === 0) return `${head}；无报警（阈值不动）`;
  return `${head}；报警 ${report.alarms.join(", ")}：${report.notes.join("｜")}`;
}
