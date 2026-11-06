/**
 * 验收卡：把 PLAN §7 的六条验收标准变成**机器可判**的一页纸。
 *
 * 为什么单独做一个模块：PLAN 里六条验收标准（意图可达 / 出口有因果 / 她知道分寸 /
 * 旧门不存在 / 不退化 / DSH 桥可用）目前散在"我对着日志看过""我数过 22 条"这类
 * 人工叙述里。人工叙述会数错（F251 就数错过：10/10/2+2/2 合计 24，实际 22），
 * 而且无法区分「已经满足」和「窗口还没满」。
 *
 * 三条纪律：
 *   1. 纯函数：数据由调用方读好传进来（可测试、可复算），不读盘、不读时钟。
 *   2. 三态：`met`（有证据满足）/ `pending`（窗口没满或样本不够，还不该下结论）/
 *      `fail`（有证据不满足）。**不允许把 pending 写成 met**——那是在验收上撒谎。
 *   3. 每条都给"证据"一句，指出是哪个文件/哪个数支撑了判定。
 */

export type AcceptanceStatus = "met" | "pending" | "fail";

export interface AcceptanceDay {
  /** 本地日，例如 "10-31" */
  readonly day: string;
  readonly ticks: number;
  /** 这一天 emitted 非空的拍数 */
  readonly emittedTicks: number;
}

export interface AcceptanceSends {
  readonly total: number;
  readonly byIntent: number;
  /** 由 speak 出口决定的那几条里，带 kind 的条数（F252 之后才有） */
  readonly withKind: number;
  readonly byNonSpeakOutlet: number;
  readonly byGateOnly: number;
  readonly byLegacy: number;
}

export interface AcceptanceInput {
  readonly generatedAtMs: number;
  /** 按本地日汇总的节拍（至少包含今天） */
  readonly days: readonly AcceptanceDay[];
  readonly sends: AcceptanceSends;
  /** 23:00–07:00 之间真发出的条数（按日志时间；没有数据时传 null） */
  readonly nightSends: number | null;
  /** 她最近 24h 是否真的读到过 presence（日志里出现"在场："行） */
  readonly presenceObserved: boolean;
  /** DSH 回程是否跑通过（facts 文件存在且非空） */
  readonly dshRoundTripObserved: boolean;
  /**
   * 是否观察到她在走引擎路径（有 shadow 节拍 = 引擎开、A4 守卫生效）。
   *
   * 为什么不直接 grep "minGap"：旧机械门代码**刻意保留**在 `src/dialogue/proactive.ts`，
   * 供 `ACE_INTENT_ENGINE=0` 回滚用（这是 PLAN 的回滚条款，不是退化）。真正的判据是
   * "这一拍走的是哪条路径"——引擎路径给 bridge 的是 `intentGate`（四条否决），外加
   * 用户 2026-11-01 裁定的**温和兜底**（`shouldInitiate` 在 intentGate 放行后判
   * gap 30 分钟 / daily 10 条）；仍不看 energy，也不把 quiet 当否决（A6）。
   */
  readonly engineOnPathObserved: boolean;
  /**
   * 门禁是否刚跑过且全绿（`npm run gate`）。`null` = 没跑/不知道。
   *
   * 为什么不让本工具自己去跑门禁：`npm run gate` 会跑整个测试套件，而验收卡的
   * CLI 测试就在那个套件里——工具跑门禁会递归自己。所以这一项是"你刚跑过就告诉我"。
   */
  readonly gateGreen: boolean | null;
}

export interface AcceptanceItem {
  readonly id: string;
  readonly title: string;
  readonly status: AcceptanceStatus;
  readonly evidence: string;
}

export interface AcceptanceReport {
  readonly items: readonly AcceptanceItem[];
  readonly counts: { readonly met: number; readonly pending: number; readonly fail: number };
  readonly conclusion: string;
}

/** §7.1：连续 48h 内 emitted ≥1 次/天。至少要有两天样本才能谈"连续"。 */
const REACH_DAYS_REQUIRED = 2;

export function evaluateAcceptance(input: AcceptanceInput): AcceptanceReport {
  const items: AcceptanceItem[] = [];

  // §7.1 意图可达
  const days = input.days.filter((day) => Number.isFinite(day.ticks) && day.ticks > 0);
  const reachableDays = days.filter((day) => day.emittedTicks > 0);
  if (days.length < REACH_DAYS_REQUIRED) {
    items.push({
      id: "reachable",
      title: "意图可达（48h 内 emitted≥1 次/天）",
      status: "pending",
      evidence: `只有 ${String(days.length)} 天样本（需要 ≥${String(REACH_DAYS_REQUIRED)} 天）；已观测：${describeDays(days)}`,
    });
  } else if (reachableDays.length === days.length) {
    items.push({
      id: "reachable",
      title: "意图可达（48h 内 emitted≥1 次/天）",
      status: "met",
      evidence: `${describeDays(days)}，每天都有 emitted 非空的拍`,
    });
  } else {
    items.push({
      id: "reachable",
      title: "意图可达（48h 内 emitted≥1 次/天）",
      status: "fail",
      evidence: `${describeDays(days)}；其中有 ${String(days.length - reachableDays.length)} 天一次都没到阈值`,
    });
  }

  // §7.2 出口有因果：每条主动消息都能回溯到 kind；非 speak 类别不触发发送
  if (input.sends.byIntent === 0) {
    items.push({
      id: "causal",
      title: "出口有因果（消息可回溯 kind；非 speak 不发）",
      status: "pending",
      evidence: `窗口内还没有「由 speak 出口决定」的消息（真发出 ${String(input.sends.total)} 条）`,
    });
  } else if (input.sends.byNonSpeakOutlet > 0 || input.sends.byLegacy > 0) {
    items.push({
      id: "causal",
      title: "出口有因果（消息可回溯 kind；非 speak 不发）",
      status: "fail",
      evidence: `由意图决定 ${String(input.sends.byIntent)} 条，但仍有非 speak 出口 ${String(input.sends.byNonSpeakOutlet)} 条 / 旧路径 ${String(input.sends.byLegacy)} 条`,
    });
  } else if (input.sends.withKind < input.sends.byIntent) {
    items.push({
      id: "causal",
      title: "出口有因果（消息可回溯 kind；非 speak 不发）",
      status: "pending",
      evidence: `由意图决定 ${String(input.sends.byIntent)} 条，其中带 kind 的只有 ${String(input.sends.withKind)} 条（F252 之前的旧行）`,
    });
  } else {
    items.push({
      id: "causal",
      title: "出口有因果（消息可回溯 kind；非 speak 不发）",
      status: "met",
      evidence: `由意图决定 ${String(input.sends.byIntent)} 条，全部带 kind；无非 speak 出口、无旧路径`,
    });
  }

  // §7.3 她知道分寸：不深夜轰炸、不连发（连发只能看日志是否有同小时多条；不给假证据）
  if (input.nightSends === null) {
    items.push({
      id: "restraint",
      title: "她知道分寸（深夜不轰炸、不连发）",
      status: "pending",
      evidence: "还没有夜间（23:00–07:00）样本",
    });
  } else if (input.nightSends > 0) {
    items.push({
      id: "restraint",
      title: "她知道分寸（深夜不轰炸、不连发）",
      status: "fail",
      evidence: `夜间真发出 ${String(input.nightSends)} 条（硬静默 23:00–07:00 应挡住）`,
    });
  } else {
    items.push({
      id: "restraint",
      title: "她知道分寸（深夜不轰炸、不连发）",
      status: "met",
      evidence: "夜间 0 条发送；连发由 F246 的 10 分钟静默 + 处境自述处理（日志可查）",
    });
  }

  // §7.4 旧机械门只在回滚路径；引擎路径换成用户裁定的温和兜底（30 分钟 / 每天 10 条）
  items.push({
    id: "old-gate",
    title: "旧机械门只在回滚路径（引擎路径是温和兜底：至少隔 30 分钟、每天最多 10 条）",
    status: input.engineOnPathObserved ? "met" : "pending",
    evidence: input.engineOnPathObserved
      ? "有引擎节拍：这一拍交给 bridge 的是 intentGate（额度/静默/单写者/信任四条否决）+ 温和兜底（gap 30 分钟 / daily 10 条）；旧机械门只在 ACE_INTENT_ENGINE=0 的回滚路径里"
      : "最近没有引擎节拍，无法确认当前走的是哪条路径（旧门是否还在用不确定）",
  });

  // §7.5 DSH 桥可用（presence 被她读到 + 回程跑通）
  if (input.presenceObserved && input.dshRoundTripObserved) {
    items.push({
      id: "dsh-bridge",
      title: "DSH 桥可用（她读得到 presence，回执能落成事实）",
      status: "met",
      evidence: "日志有「在场：」行；DSH 回执有日志行（或 dsh-facts 落盘事实）",
    });
  } else if (!input.presenceObserved && !input.dshRoundTripObserved) {
    items.push({
      id: "dsh-bridge",
      title: "DSH 桥可用（她读得到 presence，回执能落成事实）",
      status: "pending",
      evidence: "两半都还没跑过：没有「在场：」日志，也没有 dsh-facts 事实",
    });
  } else {
    items.push({
      id: "dsh-bridge",
      title: "DSH 桥可用（她读得到 presence，回执能落成事实）",
      status: "pending",
      evidence: input.presenceObserved
        ? "presence 已读到；回程还没有落盘事实"
        : "回程已跑通；presence 还没有被读到的日志",
    });
  }

  // §7.5 不退化（门禁全绿；写入正常由 F189/F199 的测试覆盖）
  items.push({
    id: "no-regression",
    title: "不退化（gate 全绿；记忆/知识写入正常）",
    status: input.gateGreen === true ? "met" : input.gateGreen === false ? "fail" : "pending",
    evidence:
      input.gateGreen === true
        ? "你刚跑过 npm run gate 且全绿"
        : input.gateGreen === false
          ? "npm run gate 有失败项"
          : "还没跑门禁：先 npm run gate，全绿后加 --gate-green 再跑一次本工具",
  });

  const counts = { met: 0, pending: 0, fail: 0 };
  for (const item of items) counts[item.status] += 1;
  const conclusion =
    counts.fail > 0
      ? `有 ${String(counts.fail)} 条不满足——先看证据行`
      : counts.pending > 0
        ? `没有失败项；${String(counts.pending)} 条等窗口/等样本，现在还不能算通过`
        : "六条验收标准都有证据支撑（门禁是否全绿见 npm run gate）";

  return { items, counts, conclusion };
}

function describeDays(days: readonly AcceptanceDay[]): string {
  if (days.length === 0) return "没有节拍样本";
  return days.map((day) => `${day.day} ${String(day.emittedTicks)}/${String(day.ticks)} 拍`).join("；");
}

export function renderAcceptance(report: AcceptanceReport): string {
  const lines: string[] = [];
  for (const item of report.items) {
    const mark = item.status === "met" ? "✓" : item.status === "pending" ? "…" : "✗";
    lines.push(`${mark} [${item.status}] ${item.title}`);
    lines.push(`    ${item.evidence}`);
  }
  lines.push(`结论：${report.conclusion}`);
  return lines.join("\n");
}
