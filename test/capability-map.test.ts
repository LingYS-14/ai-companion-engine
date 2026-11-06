/**
 * 能力清单对照（F256，审计 L1/P1-3 的收尾）。
 *
 * 背景：审计指出"她能做什么"有两套词表——意图引擎读的 `AUTONOMY_TOOL_CATALOG`（7 条）
 * 与宿主暴露的 25 个 `soul_*` 工具——中间没有映射。后果是能力缺口算不准：
 * 她说"我没有做某事的工具"，而人侧其实有对应工具；反之某个工具只是诊断面，
 * 却被当成她的自主能力。
 *
 * 这里锁四件事：
 *   1. `spec/config/capability-map.json` 的 capability id **与 catalog 完全相等**；
 *   2. 15 个"能对上"的 soul_* 工具 + 12 个 hostOnly 工具，并集 = 27 个真实工具；
 *   3. 两边不重叠、hostOnly 每条都有理由、每个 capability 至少有一个可达工具；
 *   4. 装配点真的从 catalog 派生（不再手抄），以及 F256 删掉的幽灵能力不会回来。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUTONOMY_TOOL_CATALOG } from "../src/contracts/tool-catalog.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

interface CapabilityEntry {
  readonly id: string;
  readonly soulTools: readonly string[];
}

interface HostOnlyEntry {
  readonly tool: string;
  readonly why: string;
}

interface CapabilityMap {
  readonly version: number;
  readonly source: string;
  readonly capabilities: readonly CapabilityEntry[];
  readonly hostOnly: readonly HostOnlyEntry[];
}

const map = JSON.parse(readFileSync(join(ROOT, "spec", "config", "capability-map.json"), "utf8")) as CapabilityMap;
const toolsSource = readFileSync(join(ROOT, "src", "plugin", "tool-definitions.ts"), "utf8");
const mainSource = readFileSync(join(ROOT, "scripts", "autonomy", "main.mjs"), "utf8");
const qqRunnerSource = readFileSync(join(ROOT, "src", "autonomy", "qq-runner.ts"), "utf8");

/** `plugin/tool-definitions.ts` 里真实注册的工具名（F289 后定义在数据层，不靠手抄清单）。 */
const realSoulTools = new Set(
  [...toolsSource.matchAll(/name:\s*"(soul_[a-z0-9_]+)"/gu)].map((match) => match[1] as string),
);

describe("能力清单对照（F256）：两套词表必须能互相对上", () => {
  it("capability id 与 AUTONOMY_TOOL_CATALOG 完全相等（既不多也不漏）", () => {
    const ids = new Set(map.capabilities.map((entry) => entry.id));
    const catalog = new Set(AUTONOMY_TOOL_CATALOG.map((entry) => entry.tool));
    expect([...ids].sort()).toEqual([...catalog].sort());
    expect(map.capabilities).toHaveLength(catalog.size);
  });

  it("从源码里真的解析出 27 个 soul_* 工具（防止正则失效后测试假绿）", () => {
    expect(realSoulTools.size).toBe(27);
  });

  it("capabilities ∪ hostOnly = 全部 27 个真实工具，且没有多出来的名字", () => {
    const mapped = new Set<string>();
    for (const entry of map.capabilities) {
      for (const tool of entry.soulTools) {
        expect(realSoulTools.has(tool), `映射里有源码中不存在的工具：${tool}`).toBe(true);
        mapped.add(tool);
      }
    }
    for (const entry of map.hostOnly) {
      expect(realSoulTools.has(entry.tool), `hostOnly 里有源码中不存在的工具：${entry.tool}`).toBe(true);
      mapped.add(entry.tool);
    }
    expect([...mapped].sort()).toEqual([...realSoulTools].sort());
  });

  it("两边不重叠；hostOnly 每条都写了理由；capability 至少有一个可达工具", () => {
    const reachable = new Set(map.capabilities.flatMap((entry) => [...entry.soulTools]));
    for (const entry of map.hostOnly) {
      expect(reachable.has(entry.tool), `${entry.tool} 既在能力映射又在 hostOnly`).toBe(false);
      expect(entry.why.trim().length).toBeGreaterThan(8);
    }
    for (const entry of map.capabilities) {
      expect(entry.soulTools.length).toBeGreaterThan(0);
      expect(new Set(entry.soulTools).size).toBe(entry.soulTools.length);
    }
  });

  it("F256：local.write_file 幽灵能力不会回来（catalog 与映射都不许出现）", () => {
    expect(AUTONOMY_TOOL_CATALOG.some((entry) => entry.tool === "local.write_file")).toBe(false);
    expect(JSON.stringify(map)).not.toContain("local.write_file");
  });

  it("装配点从 catalog 派生 declaredTools，不再手抄第二份清单", () => {
    expect(mainSource).toContain("AUTONOMY_TOOL_CATALOG.map(");
    // F266：可用性换算也收进 contracts，装配点只提供事实（不再自写 if 链）。
    expect(mainSource).toContain("availabilityOf(entry, availabilityFacts)");
    expect(mainSource).not.toContain('"local.write_file": true');
    // 探测的风险档也必须来自 catalog（旧实现是按名字猜 risk）
    expect(mainSource).toContain("risk: entry.risk");
  });

  it("qq-runner 的模型调用有记账（P0-2：QQ 回复也要占额度）", () => {
    expect(qqRunnerSource).toContain("recordUsageOnce");
    expect(qqRunnerSource).toContain("autonomy-usage.json");
    expect(qqRunnerSource).toContain("记账失败（不影响回复）");
  });
});
