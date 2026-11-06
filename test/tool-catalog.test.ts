/**
 * 工具目录单一来源（F266，审计 B.5 / P2-2 的收尾）。
 *
 * 锁三件事：
 *   1. `src/ports/tool.ts` 只剩类型——运行时值（catalog / 工厂）在大脑层 `contracts`；
 *   2. catalog 的可用性来源是**声明式**的，`availabilityOf` 是唯一换算实现，装配点不再自写 if 链；
 *   3. catalog 声称的 adapter 必须真的存在于执行层 `ADAPTER_META`（不写不存在的能力）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADAPTER_META } from "../src/execution/adapters.js";
import {
  AUTONOMY_TOOL_CATALOG,
  availabilityOf,
  type ToolAvailability,
} from "../src/contracts/tool-catalog.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const AVAILABILITIES: readonly ToolAvailability[] = ["always", "qq-bridge", "desktop-script"];

describe("ToolPort 类型面（F266）：ports 目录里不再藏可执行代码", () => {
  it("src/ports/tool.ts 只有类型转出，没有运行时值", () => {
    const text = read("src/ports/tool.ts");
    expect(text).toContain("export type");
    expect(text).toContain("../contracts/tool-catalog.js");
    // 运行时值必须不在 ports：出现 export const / export function 就说明搬回去了一半。
    expect(text).not.toMatch(/export\s+const\s/);
    expect(text).not.toMatch(/export\s+function\s/);
    // 只允许 type-only import（`import type` 或 `export type { … } from`）。
    expect(text).not.toMatch(/^import\s+\{/m);
  });

  it("catalog 住在 contracts（大脑层），且每个条目都声明了可用性来源", () => {
    expect(AUTONOMY_TOOL_CATALOG.length).toBe(7);
    const ids = AUTONOMY_TOOL_CATALOG.map((entry) => entry.tool);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of AUTONOMY_TOOL_CATALOG) {
      expect(AVAILABILITIES).toContain(entry.availability);
    }
  });

  it("catalog 声称的 adapter 必须在执行层真实存在（不写不存在的能力）", () => {
    const known = new Set(Object.keys(ADAPTER_META));
    for (const entry of AUTONOMY_TOOL_CATALOG) {
      if (entry.adapter !== undefined) {
        expect(known.has(entry.adapter), `${entry.tool} → ${entry.adapter} 不在 ADAPTER_META`).toBe(true);
      }
    }
  });
});

describe("可用性声明换算（F266）：装配点只给事实", () => {
  it("always 与 facts 无关；qq-bridge / desktop-script 各自只看对应事实", () => {
    const facts = { qqBridge: false, desktopScript: false };
    for (const entry of AUTONOMY_TOOL_CATALOG) {
      const off = availabilityOf(entry, facts);
      const on = availabilityOf(entry, { qqBridge: true, desktopScript: true });
      if (entry.availability === "always") {
        expect(off).toBe(true);
        expect(on).toBe(true);
      } else if (entry.availability === "qq-bridge") {
        expect(off).toBe(false);
        expect(on).toBe(true);
      } else {
        expect(off).toBe(false);
        expect(on).toBe(true);
      }
    }
  });

  it("两件事实互不串用（只有 QQ 桥不能把桌面能力打开）", () => {
    const qqOnly = { qqBridge: true, desktopScript: false };
    const desktopOnly = { qqBridge: false, desktopScript: true };
    const qq = AUTONOMY_TOOL_CATALOG.find((entry) => entry.tool === "qq.send_text");
    const desktop = AUTONOMY_TOOL_CATALOG.find((entry) => entry.tool === "desktop.screen");
    expect(qq === undefined ? null : availabilityOf(qq, qqOnly)).toBe(true);
    expect(desktop === undefined ? null : availabilityOf(desktop, desktopOnly)).toBe(true);
    expect(qq === undefined ? null : availabilityOf(qq, desktopOnly)).toBe(false);
    expect(desktop === undefined ? null : availabilityOf(desktop, qqOnly)).toBe(false);
  });

  it("装配点不再自写可用性 if 链（单一实现）", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).toContain("availabilityOf(entry, availabilityFacts)");
    expect(main).toContain("qqBridge:");
    expect(main).toContain("desktopScript:");
    expect(main).not.toContain("const declaredAvailability =");
    expect(main).not.toContain("dist/ports/tool.js");
  });
});
