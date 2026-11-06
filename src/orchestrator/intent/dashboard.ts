/**
 * P3 指标看板（纯拼装；不读文件、不跑消融、不读时钟）
 *
 * P3 的验收要"指标看板"，但看板最容易变成"好看的空话"：一屏数字、没有来源、没有样本量、
 * 没有"这一项没测"的坦白。本文件只做一件事：把已经有了的三样东西（六指标、消融报告、样本来源）
 * 拼成一页**能追到来源、能看出哪里没测**的纸面，并且把"这是离线样本、不代表真实运行时"写在页脚。
 *
 * 真正的取数在 `tools/intent/dashboard.mjs`；接进早报/面板属于 P3 接线，等用户点头后再做。
 */

import type { AblationReport } from "./ablation.js";
import type { MetricsReport } from "./metrics.js";

/** 少于这个样本数，指标只当作"有数"而不是"稳定"（与 metrics.ts 的口径一致，不另立阈值）。 */
export const DASHBOARD_MIN_TICKS = 20;

export interface DashboardInput {
  readonly generatedAt: string;
  /** 数据来源（文件名/命令），必填——没有来源的看板不可信 */
  readonly source: string;
  readonly ticks: number;
  readonly metrics: MetricsReport;
  /** 消融报告可以为空：没跑过就明说，不假装 */
  readonly ablation: AblationReport | null;
  /** 记忆—行为因果性的说明（来自 metrics.causality，单独拎出来给读者） */
  readonly causalityNote?: string;
}

export interface Dashboard {
  readonly lines: readonly string[];
  /** 用于日志/台账的提醒（样本不足、未测项） */
  readonly warnings: readonly string[];
}

/** 拼一页纸。顺序：头部（时间/来源/样本）→ 六指标 → 消融 → 说明与边界。 */
export function buildDashboard(input: DashboardInput): Dashboard {
  if (input.generatedAt.trim() === "") throw new RangeError("buildDashboard: generatedAt 不能为空");
  if (input.source.trim() === "") throw new RangeError("buildDashboard: source 不能为空（没有来源的看板不可信）");
  if (!Number.isInteger(input.ticks) || input.ticks < 0) {
    throw new RangeError(`buildDashboard: ticks 必须是非负整数：${String(input.ticks)}`);
  }
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push("意向引擎指标看板");
  lines.push(`生成：${input.generatedAt}｜来源：${input.source}｜样本：${String(input.ticks)} 条 tick`);
  if (input.ticks < DASHBOARD_MIN_TICKS) {
    warnings.push(`样本只有 ${String(input.ticks)} 条（< ${String(DASHBOARD_MIN_TICKS)}）：比例类数字只能当"有数"，不能当"稳定"`);
  }
  lines.push("");
  lines.push("【六指标】");
  lines.push(...input.metrics.lines);
  lines.push("");
  lines.push("【结构性消融】");
  if (input.ablation === null) {
    warnings.push("消融没跑：因果性仍然是「未测」，不要用别的指标代替它");
    lines.push("未跑。先执行：npm run intent:ablation");
  } else {
    lines.push(`样本 ${String(input.ablation.samples)} 个（结论至少 ${String(input.ablation.minSamples)} 个）`);
    for (const row of input.ablation.rows) {
      const rate = row.changedRate === null ? "—" : `${(row.changedRate * 100).toFixed(1)}%`;
      lines.push(`- ${row.component}（${row.label}）：行为改变 ${String(row.changed)}/${String(row.samples)}（${rate}）｜排序改变 ${String(row.rankingChanged)}｜${row.verdict}`);
    }
    lines.push(`结论：${input.ablation.verdict}`);
    if (input.ablation.samples < input.ablation.minSamples) {
      warnings.push("消融样本不足：结论只报计数，不当作因果成立");
    }
  }
  lines.push("");
  lines.push("【读法】");
  lines.push("1. 「未测」就是没测，不是 0：跨会话一致性与能力解锁率需要真实运行数据，空样本一律不填 0。");
  const causalityNote = input.causalityNote
    ?? (input.ablation === null
      ? input.metrics.causality.note
      : "见上节【结构性消融】：它说明摘掉某个记忆组件后行为是否变化；是否算「显著」由评审判断，本页不自动下结论");
  lines.push(`2. 记忆—行为因果性只认结构性消融，当前：${causalityNote}`);
  lines.push("3. 先验压制比高说明「她想动但被闸拦」多——这是设计（守规矩）还是太紧（变木），要和用户的实际观感对照再调。");
  lines.push("");
  lines.push("【边界】");
  lines.push("本页来自离线样本（shadow/ablation），不代表她真实运行时行为；live 数据要等她进程带开关重启后才有。");
  lines.push("本页不评价她「做得好不好」：指标不是打分，是证据。");
  return { lines, warnings };
}

/** 一页纸转成单字符串（CLI 直接 print）。 */
export function renderDashboard(dashboard: Dashboard): string {
  return dashboard.lines.join("\n");
}
