/**
 * 工具目录（F266，审计 B.5 / P2-2 的收尾）：她能"实际调用"的工具清单与能力族。
 *
 * 为什么在这个文件、而不是 `src/ports/tool.ts`：
 *   - `ports/` 是**合同目录**，审计 P2-2 指出它曾同时装着运行时值和"只允许 import type"的规则，
 *     自相矛盾。F266 把运行时值（catalog / 工厂 / 记账函数）搬进大脑层的本文件，
 *     `src/ports/tool.ts` 只保留类型转出。
 *   - 这里属于大脑层（`src/contracts/`），装配点可以 import（assembly→brain），
 *     工具层只允许取类型（R3）。
 *
 * 本文件只做两件事：
 *   1. 描述工具（名字、能力族、风险、是否需要登录/限流、**可用性来源**、对应的执行层 adapter）；
 *   2. 把"此刻可用"的那部分交成 `Affordance[]`（意图引擎的输入形状）。
 *
 * 它**不执行**任何工具。执行仍走各自的装配点（QQ/ndjson/B 站/桌面），
 * 这样"能做什么"和"怎么做"分开，P4 的能力阶梯将来才有东西可挂。
 *
 * 纪律：不读时钟、不读盘（可用性由调用方按真实条件算好传进来）；纯数据 + 纯函数。
 * 加工具时改这里，而不是去 main.mjs / plugin 里再写一遍（F256/F266 两次都是这么收口的）。
 */

import type { Affordance, RiskLevel } from "../orchestrator/intent/types.js";

/** 能力族：与 `src/orchestrator/intent/candidates.ts:affordanceFamily` 的口径保持一致。 */
export type ToolFamily = "message" | "read" | "desktop" | "write" | "other";

/**
 * 可用性来源（声明式）：装配点只需提供几个事实，由 `availabilityOf` 统一换算。
 *   - always：本机能力，不需要外部条件；
 *   - qq-bridge：需要 QQ 桥在场；
 *   - desktop-script：需要桌面执行脚本存在（常驻进程默认没有，属文档化例外，见 execution-exceptions.json）。
 */
export type ToolAvailability = "always" | "qq-bridge" | "desktop-script";

export interface ToolDescriptor {
  /** 工具 id（与日志/能力清单同名，例如 `qq.send_text`） */
  readonly tool: string;
  /** 能力族：决定它能满足哪一类意图（发消息 / 读资料 / 操作桌面 / 写文件） */
  readonly family: ToolFamily;
  /** 风险档：0 = 只读观察，1 = 会对外产生痕迹，2–3 = 写文件/操作桌面等 */
  readonly risk: RiskLevel;
  /** 是否需要登录态才能用（登录失效时 unavailable） */
  readonly requiresLogin: boolean;
  /** 是否可能被限流 */
  readonly rateLimited: boolean;
  /** 此刻是否可用：由装配点按真实条件判断（没有 QQ 桥 / 没有登录态 / 没有语音依赖…） */
  readonly available: boolean;
}

export interface ToolPort {
  /** 此刻的工具清单（含不可用的，便于她理解"我有这个能力但现在用不了"） */
  capabilities(): readonly ToolDescriptor[];
}

/** 目录条目：比 ToolDescriptor 多"可用性来源"与"执行层 adapter id"（用于交叉校验）。 */
export interface ToolCatalogEntry extends Omit<ToolDescriptor, "available"> {
  readonly availability: ToolAvailability;
  /** 对应的执行层 adapter（`ADAPTER_META` 的键）；没有 adapter 的（只读本机）不填。 */
  readonly adapter?: string;
}

/** 装配点能提供的事实（都是布尔，不读盘、不读时钟）。 */
export interface ToolAvailabilityFacts {
  readonly qqBridge: boolean;
  readonly desktopScript: boolean;
}

/** 按工具名判断能力族（与 candidates.affordanceFamily 同口径；不一致由测试锁）。 */
export function familyOf(tool: string): ToolFamily {
  if (tool.startsWith("qq.") || tool.startsWith("wechat.")) return "message";
  if (tool.startsWith("bili.") || tool.startsWith("web.") || tool.startsWith("knowledge.") || tool.startsWith("memory.")) {
    return "read";
  }
  if (tool.startsWith("desktop.")) return "desktop";
  if (tool.startsWith("local.") || tool.startsWith("file.")) return "write";
  return "other";
}

/**
 * 自主进程**真实拥有**的工具清单（名字与执行层一致）。
 *
 * 这里是"她能做的事"的权威来源。`available` 不在这里定，由 `availabilityOf` 按事实换算。
 */
export const AUTONOMY_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { tool: "knowledge.read", family: "read", risk: 0, requiresLogin: false, rateLimited: false, availability: "always" },
  { tool: "bili.read", family: "read", risk: 0, requiresLogin: false, rateLimited: false, availability: "always", adapter: "bili.fetch" },
  {
    tool: "qq.send_text",
    family: "message",
    risk: 1,
    requiresLogin: false,
    rateLimited: false,
    availability: "qq-bridge",
    adapter: "qq.sendOneBot",
  },
  {
    tool: "qq.send_image",
    family: "message",
    risk: 1,
    requiresLogin: false,
    rateLimited: false,
    availability: "qq-bridge",
    adapter: "qq.sendOneBotImage",
  },
  {
    tool: "qq.send_voice",
    family: "message",
    risk: 1,
    requiresLogin: false,
    rateLimited: false,
    availability: "qq-bridge",
    adapter: "qq.sendOneBotVoice",
  },
  {
    tool: "desktop.screen",
    family: "desktop",
    risk: 0,
    requiresLogin: false,
    rateLimited: false,
    availability: "desktop-script",
  },
  {
    tool: "desktop.windows",
    family: "desktop",
    risk: 0,
    requiresLogin: false,
    rateLimited: false,
    availability: "desktop-script",
  },
];

/** 声明 → 事实的换算（单一实现；装配点不再各写一份 if 链）。未知来源一律返回 false。 */
export function availabilityOf(entry: ToolCatalogEntry, facts: ToolAvailabilityFacts): boolean {
  switch (entry.availability) {
    case "always":
      return true;
    case "qq-bridge":
      return facts.qqBridge;
    case "desktop-script":
      return facts.desktopScript;
    default:
      return false;
  }
}

/** 装配点：给定"哪些工具此刻可用"，拼出一个 ToolPort。 */
export function createToolPort(
  availability: Readonly<Record<string, boolean>>,
  catalog: readonly ToolCatalogEntry[] = AUTONOMY_TOOL_CATALOG,
): ToolPort {
  const descriptors: ToolDescriptor[] = catalog.map((entry) => ({
    tool: entry.tool,
    family: entry.family,
    risk: entry.risk,
    requiresLogin: entry.requiresLogin,
    rateLimited: entry.rateLimited,
    available: availability[entry.tool] === true,
  }));
  return { capabilities: () => descriptors };
}

/** 交给她（意图引擎）的"此刻可做"清单：只保留可用的，形状是 Affordance。 */
export function availableAffordances(port: ToolPort): Affordance[] {
  return port
    .capabilities()
    .filter((tool) => tool.available)
    .map((tool) => ({
      tool: tool.tool,
      risk: tool.risk,
      requiresLogin: tool.requiresLogin,
      rateLimited: tool.rateLimited,
    }));
}

/** 一行给日志看的摘要：`可用 4/7（message 1 / read 2 / desktop 1）` */
export function describeToolPort(port: ToolPort): string {
  const all = port.capabilities();
  const usable = all.filter((tool) => tool.available);
  const byFamily = new Map<ToolFamily, number>();
  for (const tool of usable) byFamily.set(tool.family, (byFamily.get(tool.family) ?? 0) + 1);
  const parts = [...byFamily.entries()].map(([family, count]) => `${family} ${String(count)}`).join(" / ");
  return `可用 ${String(usable.length)}/${String(all.length)}${parts === "" ? "" : `（${parts}）`}`;
}
