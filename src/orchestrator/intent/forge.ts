/**
 * P4 能力层：效力探测 → 四级阶梯 → 造具计划 → 能力账本（纯逻辑；不写文件、不调模型、不读时钟）
 *
 * 规格来源：`docs/DESIGN.md` §11.4（probe→learn→rehearse→forge）、
 * §11.5（效力探测与能力地图）、§11.6.1（造具变更预算与审核矩阵，本文件只把计划**交给** review.ts 判级）。
 *
 * 这一层解决的是"她遇到没人写过答案的事"：
 *   静态 affordance 表只覆盖"我知道我能做什么"；覆盖不到的时候，正确的产物不是报错、也不是妄想，
 *   而是 (a) 一个乘积形式的能力缺口、(b) 一条逐级收紧的阶梯、(c) 一次按预算审核的造具。
 *
 * 本文件不决定"要不要动"（那是 drive/candidates 的事），只回答：
 *   1. 这个能力缺口是不是真的（declared 但 effectivity=0？还是根本没声明）？
 *   2. 现在该走哪一级（补闸：已试过什么、是否停滞、是否该放弃/求助）？
 *   3. 这一级要产出什么动作（组合/脚本/接入），以及它会不会被审核拦下？
 *   4. 造出来的东西记进账本后，什么时候从观察转正、什么时候退役？
 *
 * 诚实边界：账本是内存结构；落盘 WAL、`quarantined` 的 24h 观察时钟、失败回滚在装配点（P4 接线）。
 */

import {
  capabilityKindOf,
  nextLadderStep,
  shouldAskHelp,
  shouldGiveUp,
  type AskHelpInput,
  type CapabilityGap,
  type LadderStep,
} from "./capability.js";
import { classifyChangeSet, type ChangeSet, type ReviewDecision } from "./review.js";
import type { CapabilityKind, CapabilityRecord, CapabilityStatus, RiskLevel } from "./types.js";

// ── 效力探测（§11.5） ───────────────────────────────────────────────────

/** 一个工具"能不能用"的探测结果（缓存 5–10 min，由调用方决定；本文件不读时钟）。 */
export interface EffectivityEntry {
  readonly tool: string;
  /** YAML/工具表里声明了 */
  readonly declared: boolean;
  /** 探测通过（登录态/端口/额度都够） */
  readonly available: boolean;
  /** 0 = 不能用，0.5 = 能用但不稳/要登录，1 = 正常 */
  readonly effectivity: 0 | 0.5 | 1;
  readonly reason?: "no-login" | "rate-limited" | "port-down" | "unknown";
  readonly lastProbeAt: string;
}

export interface EffectivityTable {
  readonly entries: readonly EffectivityEntry[];
}

/** 探测结果校验：effectivity 只能是 0/0.5/1（写错成 0.7 不是"差不多"，而是必须报错）。 */
export function validateEffectivity(entry: EffectivityEntry): string[] {
  const errors: string[] = [];
  if (entry.tool.trim() === "") errors.push("tool 不能为空");
  if (entry.effectivity !== 0 && entry.effectivity !== 0.5 && entry.effectivity !== 1) {
    errors.push(`effectivity 只能是 0 / 0.5 / 1，收到 ${String(entry.effectivity)}`);
  }
  if (entry.available && entry.effectivity === 0) errors.push("available=true 却 effectivity=0（自相矛盾）");
  if (!entry.available && entry.effectivity === 1) errors.push("available=false 却 effectivity=1（自相矛盾）");
  if (Number.isNaN(Date.parse(entry.lastProbeAt))) errors.push("lastProbeAt 必须是 ISO 时间");
  return errors;
}

export function buildEffectivityTable(entries: readonly EffectivityEntry[]): { table: EffectivityTable; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    errors.push(...validateEffectivity(entry).map((message) => `${entry.tool}: ${message}`));
    if (seen.has(entry.tool)) errors.push(`${entry.tool}: 重复的探测条目`);
    seen.add(entry.tool);
  }
  return { table: { entries }, errors };
}

/**
 * 把"探测到的缺口"变成能力缺口原料（§11.5：`declared = true` 且 `effectivity = 0` 就是渴望的原料）。
 * - 声明了但不可用 → 缺口（这是最值得投入的一类：世上真有这功能，只是她够不到）；
 * - 根本没声明 → 也是缺口，但缺的是"知道世界上有这功能"（knowledge 类，先 learn）；
 * - effectivity = 0.5 → 不是缺口，是"能用但不稳"，应进 rehearse 而不是 forge。
 */
export function gapFromEffectivity(
  entry: EffectivityEntry,
  context: { blockedIntentionId: string; missing: string; learnCost?: number; selfEfficacy?: number },
): CapabilityGap | null {
  if (entry.effectivity === 1) return null;
  const reason = entry.reason ?? "unknown";
  const kind: CapabilityGap["kind"] =
    !entry.declared ? "knowledge" : reason === "no-login" ? "permission" : reason === "port-down" ? "api" : "skill";
  const progressEst = entry.effectivity === 0.5 ? 0.5 : 0.1;
  return {
    blockedIntentionId: context.blockedIntentionId,
    missing: context.missing,
    kind,
    affordancePresent: entry.declared ? 1 : 0,
    effectivity: entry.effectivity,
    empowermentGain: entry.declared ? 0.6 : 0.3,
    progressEst,
    selfEfficacy: context.selfEfficacy ?? 0.5,
    selfEfficacy_eff: (context.selfEfficacy ?? 0.5) * 1,
    learnCost: context.learnCost ?? 0.2,
    estimated: true,
  };
}

// ── 四级阶梯（§11.4） ───────────────────────────────────────────────────

export interface LadderProgress {
  readonly probed: boolean;
  readonly learned: boolean;
  readonly rehearsed: boolean;
  /** 已经试过几轮（跨阶段累计；用于放弃规则 attempts≥5） */
  readonly attempts: number;
  /** 最近两次 progressEst（用于判断"不再上升"） */
  readonly progressHistory: readonly number[];
}

export interface LadderDecision {
  /** 下一步该走哪级；null = 不再前进（放弃或求助） */
  readonly stage: LadderStep | null;
  readonly action: "probe" | "learn" | "rehearse" | "forge" | "ask_help" | "give_up" | "wait";
  readonly reason: string;
  /** 这一步是否必须走审核（forge 超预算时 true；其余 false） */
  readonly requiresReview: boolean;
}

/**
 * 阶梯推进：先按"已做到哪一步"给下一级，再叠加三条**停止规则**（规格明确要求的）：
 *   1. attempts ≥ 5 → 放弃（不再产生候选）；
 *   2. progressEst 不再上升 → 可以求助（ask_help，带 tried）；
 *   3. 到 forge 但超预算 → 不自己造，交审核（§11.6.1）。
 * 顺序是"停/求助 > 前进"，避免她一边停滞一边硬造。
 */
export function advanceLadder(
  progress: LadderProgress,
  context: {
    /** 组合/脚本级造具是否还在预算内（review.ts 的结论；probe/learn 阶段填 false 即可） */
    forgeWithinBudget: boolean;
    /** §11.6.2 的求助输入（attempts / 自评 / 赋权 / 今日次数都来自真实记录） */
    askHelp: AskHelpInput;
    stalled: boolean;
    /** 是否还没到能求助的门槛（attempts<2 时求助等于撒娇，规格明确） */
    helpEligible?: boolean;
  },
): LadderDecision {
  if (shouldGiveUp(progress.attempts)) {
    return { stage: null, action: "give_up", reason: `已试 ${String(progress.attempts)} 次（≥5），按规则放弃，不再产生候选`, requiresReview: false };
  }

  const helpEligible = context.helpEligible ?? progress.attempts >= 2;
  if (helpEligible && shouldAskHelp(context.askHelp, { stalled: context.stalled })) {
    if (context.stalled) {
      return {
        stage: null,
        action: "ask_help",
        reason: "试过 ≥2 次且进展停滞：按 §11.6.2 开口求助（必须带 tried），而不是继续硬试",
        requiresReview: false,
      };
    }
  }

  let stage: LadderStep;
  try {
    stage = nextLadderStep({
      probed: progress.probed,
      learned: progress.learned,
      rehearsed: progress.rehearsed,
      forgeWithinBudget: context.forgeWithinBudget,
    });
  } catch {
    // nextLadderStep 在"到 forge 但超预算"时抛错；这里把它翻译成"该走审核"，而不是让调用方接异常。
    return {
      stage: "forge",
      action: "forge",
      reason: "四级都走完了，但造具超出变更预算：交 review.ts 判级审核，不自己造",
      requiresReview: true,
    };
  }

  const reasons: Record<LadderStep, string> = {
    probe: "还没探测过：先 risk 0 只读地问清楚它是什么/要不要登录/有没有额度",
    learn: "已探测但还不会用：先学（读文档/搜索/写 L2 知识），进度不再上升就停",
    rehearse: "已学会但没验证：先沙箱练（不碰真实通道）",
    forge: "练过了且预算内：可以组合/写脚本，产物进 quarantined 观察 24h",
  };
  return { stage, action: stage, reason: reasons[stage], requiresReview: false };
}

// ── 造具计划（§11.4 三级：组合 / 脚本 / 接入） ─────────────────────────────

export type ForgeKind = "composition" | "script" | "integration";

export interface ForgePlan {
  readonly kind: ForgeKind;
  /** 组合级：用到的已有工具（顺序即调用链）；其余为空数组 */
  readonly chain: readonly string[];
  /** 脚本级：新建的文件（必须在 scripts/forge/ 下；动作由调用方真正写盘） */
  readonly files: readonly string[];
  /** 脚本/组合都需要的自测清单；全部 passed 才能进审核 */
  readonly selfTests: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
  /** 接入级永远要新凭证 → C 级人审 */
  readonly requiresNewCredentials: boolean;
  readonly newToolPermissions: readonly string[];
  readonly addedLines: number;
  readonly removedLines: number;
  readonly newDependencies: readonly string[];
  readonly touchesUserVisibleChannels: readonly ("qq" | "bilibili" | "wechat" | "desktop")[];
}

/**
 * 规划一次造具。原则（规格原文）：
 *   绝大多数覆盖不到的情况在**组合**这一级就解决——渴望的默认产物是"换个用法"，不是"写新代码"；
 *   只有组合不了才写脚本；接新平台永远要人。
 */
export function planForge(input: {
  gap: CapabilityGap;
  /** 现有可用工具（affordance 表里的工具名） */
  availableTools: readonly string[];
  /** 组合方案：调用链；为空表示组合不出来 */
  chain?: readonly string[];
  /** 脚本方案：文件路径（必须在 scripts/forge/ 下）；没想好就不给 */
  scriptFile?: string;
  /** 脚本草稿的增删行数（没有脚本时为 0） */
  scriptLines?: { added: number; removed: number };
  /** 自测清单（缺一项都进不了 A 级） */
  selfTests?: ReadonlyArray<{ name: string; passed: boolean }>;
  /** 组合/脚本是否需要扩权（规格：不得扩权，所以通常为空；非空会被 review 判 D） */
  newToolPermissions?: readonly string[];
  /** 是否需要新凭证（接入级必填 true） */
  requiresNewCredentials?: boolean;
  /** 是否触及用户可见通道（组合里含发消息/发图/桌面操作时必须标记） */
  touchesUserVisibleChannels?: readonly ("qq" | "bilibili" | "wechat" | "desktop")[];
}): ForgePlan {
  const chain = input.chain ?? [];
  const unknownTools = chain.filter((tool) => !input.availableTools.includes(tool));
  if (chain.length > 0 && unknownTools.length > 0) {
    throw new Error(`组合方案里用了当前不可用的工具：${unknownTools.join(", ")}（先 probe，不要假设）`);
  }

  if (input.requiresNewCredentials === true) {
    return {
      kind: "integration",
      chain,
      files: [],
      selfTests: input.selfTests ?? [],
      requiresNewCredentials: true,
      newToolPermissions: input.newToolPermissions ?? [],
      addedLines: 0,
      removedLines: 0,
      newDependencies: [],
      touchesUserVisibleChannels: input.touchesUserVisibleChannels ?? [],
    };
  }

  if (chain.length > 0) {
    return {
      kind: "composition",
      chain,
      files: [],
      selfTests: input.selfTests ?? [],
      requiresNewCredentials: false,
      newToolPermissions: input.newToolPermissions ?? [],
      addedLines: 0,
      removedLines: 0,
      newDependencies: [],
      touchesUserVisibleChannels: input.touchesUserVisibleChannels ?? [],
    };
  }

  if (input.scriptFile === undefined) {
    throw new Error("既没有组合方案、也不打算写脚本：这不是造具，应该去求助（ask_help）");
  }
  if (!input.scriptFile.startsWith("scripts/forge/")) {
    throw new Error(`脚本只能新建在 scripts/forge/ 下（§11.6.1 路径预算），收到 ${input.scriptFile}`);
  }
  return {
    kind: "script",
    chain: [],
    files: [input.scriptFile],
    selfTests: input.selfTests ?? [],
    requiresNewCredentials: false,
    newToolPermissions: input.newToolPermissions ?? [],
    addedLines: input.scriptLines?.added ?? 0,
    removedLines: input.scriptLines?.removed ?? 0,
    newDependencies: [],
    touchesUserVisibleChannels: input.touchesUserVisibleChannels ?? [],
  };
}

/** 把造具计划翻成 ChangeSet，交给 review.ts 判级（本文件不自己判 A/B/C/D）。 */
export function toChangeSet(plan: ForgePlan, ids: { capId: string; intentionId: string }): ChangeSet {
  return {
    capId: ids.capId,
    intentionId: ids.intentionId,
    files:
      plan.kind === "composition"
        ? ["scripts/forge/composition.mjs"]
        : plan.kind === "integration"
          ? ["scripts/forge/integration.json"]
          : plan.files,
    addedLines: plan.addedLines,
    removedLines: plan.removedLines,
    newDependencies: plan.newDependencies,
    newToolPermissions: plan.newToolPermissions,
    touchesUserVisibleChannels: plan.touchesUserVisibleChannels,
    requiresNewCredentials: plan.requiresNewCredentials,
    selfTestPassed: plan.selfTests.length > 0 && plan.selfTests.every((test) => test.passed),
  };
}

/** 造具计划的审核结论（组合级也是"新建文件"，所以同样要过 review；只会是 A/B/C）。 */
export function reviewForgePlan(plan: ForgePlan, ids: { capId: string; intentionId: string }): ReviewDecision {
  return classifyChangeSet(toChangeSet(plan, ids));
}

// ── 能力账本（§11.6.1 红线五：一切落账本，可一键停用） ─────────────────────

export interface CapabilityStats {
  readonly total: number;
  readonly quarantined: number;
  readonly active: number;
  readonly retired: number;
  /** 转正率：active / (active + retired)；没有记录时 null */
  readonly promotionRate: number | null;
  /** 效力提升为正的记录数（effectivityAfter > effectivityBefore） */
  readonly improved: number;
}

export const QUARANTINE_MS = 24 * 60 * 60 * 1000;

const CAPABILITY_STATUSES: readonly CapabilityStatus[] = ["quarantined", "active", "retired"];

export function validateCapabilityRecord(record: CapabilityRecord): string[] {
  const errors: string[] = [];
  if (record.capId.trim() === "") errors.push("capId 不能为空");
  if (!["tool", "script", "integration", "knowledge"].includes(record.kind)) errors.push(`kind 未知：${String(record.kind)}`);
  if (!CAPABILITY_STATUSES.includes(record.status)) errors.push(`status 未知：${String(record.status)}`);
  if (!Number.isFinite(record.effectivityBefore) || record.effectivityBefore < 0 || record.effectivityBefore > 1) {
    errors.push("effectivityBefore 必须在 [0,1]");
  }
  if (!Number.isFinite(record.effectivityAfter) || record.effectivityAfter < 0 || record.effectivityAfter > 1) {
    errors.push("effectivityAfter 必须在 [0,1]");
  }
  if (record.riskCeiling !== 0 && record.riskCeiling !== 1 && record.riskCeiling !== 2 && record.riskCeiling !== 3) {
    errors.push(`riskCeiling 必须是 0–3，收到 ${String(record.riskCeiling)}`);
  }
  if (Number.isNaN(Date.parse(record.createdAt))) errors.push("createdAt 必须是 ISO 时间");
  return errors;
}

/**
 * 能力账本（内存；落盘在装配点）。
 * 一条记录的生命周期：`quarantined`（观察 24h）→ `active`（转正）或 `retired`（退役/失败）。
 * **不自动转正**：`promoteDue` 只给出"哪些到期可以转正"，转正动作由调用方显式执行。
 */
export class CapabilityLedger {
  private readonly records: CapabilityRecord[] = [];

  static from(records: readonly CapabilityRecord[]): CapabilityLedger {
    const ledger = new CapabilityLedger();
    for (const record of records) ledger.add(record);
    return ledger;
  }

  /** 追加（同 capId 视为同一条记录的新版本，替换旧值；账本不保留历史——历史在 WAL 里）。 */
  add(record: CapabilityRecord): void {
    const errors = validateCapabilityRecord(record);
    if (errors.length > 0) throw new Error(`能力记录不合法：${errors.join("；")}`);
    const index = this.records.findIndex((item) => item.capId === record.capId);
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }

  /** 退役（"一键停用"的落点）：幂等；找不到记录时抛错（静默成功会让停用变成假的）。 */
  retire(capId: string): CapabilityRecord {
    const record = this.records.find((item) => item.capId === capId);
    if (record === undefined) throw new Error(`账本里没有 ${capId}，不能退役`);
    const next: CapabilityRecord = { ...record, status: "retired" };
    this.add(next);
    return next;
  }

  /** 观察期满且效力确实提升的 quarantined 记录（只读查询，不自动改状态）。 */
  promoteDue(nowMs: number): readonly CapabilityRecord[] {
    return this.records.filter((record) => {
      if (record.status !== "quarantined") return false;
      const created = Date.parse(record.createdAt);
      if (Number.isNaN(created)) return false;
      return nowMs - created >= QUARANTINE_MS && record.effectivityAfter > record.effectivityBefore;
    });
  }

  get(capId: string): CapabilityRecord | null {
    return this.records.find((record) => record.capId === capId) ?? null;
  }

  all(): readonly CapabilityRecord[] {
    return [...this.records];
  }

  active(): readonly CapabilityRecord[] {
    return this.records.filter((record) => record.status === "active");
  }

  stats(): CapabilityStats {
    const total = this.records.length;
    const quarantined = this.records.filter((record) => record.status === "quarantined").length;
    const active = this.records.filter((record) => record.status === "active").length;
    const retired = this.records.filter((record) => record.status === "retired").length;
    const improved = this.records.filter((record) => record.effectivityAfter > record.effectivityBefore).length;
    return {
      total,
      quarantined,
      active,
      retired,
      promotionRate: active + retired === 0 ? null : active / (active + retired),
      improved,
    };
  }
}

/** 从 WAL 行解析能力记录（坏行跳过并计数；不静默当空——调用方要把 corrupt 显示出来）。 */
export function parseCapabilityLines(lines: readonly string[]): {
  records: CapabilityRecord[];
  corrupt: number;
  errors: string[];
} {
  const records: CapabilityRecord[] = [];
  const errors: string[] = [];
  let corrupt = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    const candidate = (parsed as { record?: unknown }).record ?? parsed;
    const errorsForRecord = validateCapabilityRecord(candidate as CapabilityRecord);
    if (errorsForRecord.length > 0) {
      corrupt += 1;
      errors.push(...errorsForRecord);
      continue;
    }
    records.push(candidate as CapabilityRecord);
  }
  return { records, corrupt, errors };
}

/** 一行摘要（日志/台账用；不写"她很能干"这类自评）。 */
export function describeLedgerStats(stats: CapabilityStats): string {
  const rate = stats.promotionRate === null ? "未测" : `${(stats.promotionRate * 100).toFixed(1)}%`;
  return `能力账本：共 ${String(stats.total)} 条（观察 ${String(stats.quarantined)} / 在用 ${String(stats.active)} / 停用 ${String(stats.retired)}），转正率 ${rate}，有效力提升 ${String(stats.improved)} 条`;
}

/** 由造具计划生成一条初始记录（quarantined；效力提升由观察期后的真实测量填）。 */
export function initialCapabilityRecord(
  plan: ForgePlan,
  context: {
    capId: string;
    intentionId: string;
    effectivityBefore: number;
    effectivityAfter: number;
    riskCeiling: RiskLevel;
    createdAt: string;
  },
): CapabilityRecord {
  const kind: CapabilityKind = plan.kind === "composition" ? "tool" : plan.kind === "script" ? "script" : "integration";
  const tool = plan.kind === "composition" && plan.chain.length > 0 ? (plan.chain[0] ?? null) : null;
  return {
    capId: context.capId,
    kind,
    tool,
    sourceIntentionId: context.intentionId,
    effectivityBefore: context.effectivityBefore,
    effectivityAfter: context.effectivityAfter,
    tests: plan.selfTests.map((test) => ({ name: test.name, passed: test.passed })),
    riskCeiling: context.riskCeiling,
    status: "quarantined",
    createdAt: context.createdAt,
  };
}

/** 供 capability.ts 的 gapFromEffectivity 与 kinds 对齐（避免两处各写一套映射）。 */
export function capabilityKindForGap(gap: CapabilityGap): CapabilityKind {
  return capabilityKindOf(gap);
}
