import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * F287：能力清单的「一份事实」现在跨三层，所以用测试把四张表钉在一起。
 *
 * 背景（审计 B.5）：能力清单曾经有 5 份、三套命名（catalog 8 条、main.mjs 手抄 8 键、
 * adapters 6 条、两处注册表各 3 条、27 个 soul_* 工具面）。F266 把「能做什么」收进
 * `src/contracts/tool-catalog.ts`，但**执行层**的 `ADAPTER_META` 与两个注册点仍在别处——
 * 分层规则不允许大脑 import 脊髓（R1），所以物理上没法合成一个文件；
 * 能做到的是：任何一处改了而别处没跟，CI 立刻红。
 */

const ROOT = process.cwd();
const META_FILE = "src/execution/adapters.ts";
const CATALOG_FILE = "src/contracts/tool-catalog.ts";
const REGISTRATION_FILES = ["src/plugin/index.ts", "src/autonomy/qq-runner.ts"];

/** 只有人侧（DSH 插件宿主）注册、自主进程不直接调用的 adapter。 */
const HOST_ONLY_ADAPTER_IDS = ["bili.ingest", "qq.send"] as const;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => String(m[1] ?? ""));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function adapterMetaIds(): string[] {
  const text = read(META_FILE);
  const start = text.indexOf("export const ADAPTER_META = {");
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf("} as const satisfies Record<string, AdapterMeta>", start);
  expect(end).toBeGreaterThan(start);
  return uniqueSorted(matchAll(text.slice(start, end), /^\s{2}"([a-z][A-Za-z.]*)": \{/gm));
}

function makeAdapterIds(): string[] {
  const ids: string[] = [];
  for (const rel of REGISTRATION_FILES) {
    // 泛型参数里可能带分号/圆括号，所以用「makeAdapter 之后一小段窗口里第一个 id 字符串」。
    ids.push(...matchAll(read(rel), /makeAdapter[\s\S]{0,200}?\(\s*"([a-z][A-Za-z.]*)"/g));
  }
  return uniqueSorted(ids);
}

function catalogAdapterIds(): string[] {
  return uniqueSorted(matchAll(read(CATALOG_FILE), /adapter: "([^"]+)"/g));
}

describe("能力清单单一事实（F287）", () => {
  it("执行层 ADAPTER_META 恰好 6 条，幂等/风险等级都在枚举内", () => {
    const text = read(META_FILE);
    expect(adapterMetaIds()).toEqual([
      "bili.fetch",
      "bili.ingest",
      "qq.send",
      "qq.sendOneBot",
      "qq.sendOneBotImage",
      "qq.sendOneBotVoice",
    ]);
    const idempotency = matchAll(text, /idempotency: "([a-z-]+)"/g);
    expect(idempotency.length).toBe(6);
    expect(idempotency.every((v) => ["at-most-once", "at-least-once", "idempotent"].includes(v))).toBe(true);
    const risk = matchAll(text, /riskTier: "([a-z]+)"/g);
    expect(risk.length).toBe(6);
    expect(risk.every((v) => ["external", "reversible", "read"].includes(v))).toBe(true);
  });

  it("每个 ADAPTER_META 都有人注册，没有「声明了没人实现」的 adapter", () => {
    expect(makeAdapterIds()).toEqual(adapterMetaIds());
  });

  it("自主进程 catalog 声称的 adapter 都存在于执行层，且没有多余的", () => {
    expect(catalogAdapterIds()).toEqual([
      "bili.fetch",
      "qq.sendOneBot",
      "qq.sendOneBotImage",
      "qq.sendOneBotVoice",
    ]);
    expect(catalogAdapterIds().every((id) => adapterMetaIds().includes(id))).toBe(true);
  });

  it("catalog 的 adapter + 宿主专用 adapter 恰好覆盖执行层全部 6 条", () => {
    expect(uniqueSorted([...catalogAdapterIds(), ...HOST_ONLY_ADAPTER_IDS])).toEqual(adapterMetaIds());
  });

  it("desktop 能力是登记在案的旁路，不许偷偷进 catalog 的 adapter", () => {
    const catalog = read(CATALOG_FILE);
    expect(catalog).not.toMatch(/"desktop\.(screen|windows)"[\s\S]{0,120}?adapter:/);
    const exceptions = JSON.parse(read("spec/config/execution-exceptions.json")) as {
      exceptions: Array<{ tool: string; status: string }>;
      invariants: string[];
    };
    expect(exceptions.exceptions.map((e) => e.tool).sort()).toEqual(["desktop.screen", "desktop.windows"]);
    expect(exceptions.exceptions.every((e) => e.status === "documented-bypass")).toBe(true);
    expect(exceptions.invariants.join("\n")).toContain("desktop");
  });

  it("没有第二个地方手抄工具 id 清单：装配点只从 catalog 派生", () => {
    const main = read("scripts/autonomy/main.mjs");
    expect(main).toContain("AUTONOMY_TOOL_CATALOG");
    expect(main).toContain("availabilityOf(entry, availabilityFacts)");
    // 旧的幽灵能力不许回来
    for (const rel of [CATALOG_FILE, "scripts/autonomy/main.mjs"]) {
      expect(read(rel)).not.toContain("local.write_file");
    }
  });

  it("27 个 soul_* 与 capability-map 的并集仍是 27（清单没被拆成两半）", () => {
    const map = JSON.parse(read("spec/config/capability-map.json")) as {
      capabilities: Array<{ soulTools: string[] }>;
      hostOnly: Array<{ tool: string }>;
    };
    const reachable = map.capabilities.flatMap((c) => c.soulTools);
    const hostOnly = map.hostOnly.map((h) => h.tool);
    expect(uniqueSorted([...reachable, ...hostOnly]).length).toBe(27);
    // 一个工具可以同时属于多个 capability（例如 soul_qq_send 同时服务文字/图片/语音），
    // 所以「可达工具」去重后 + hostOnly 才等于 27；这里断言去重后没有超集。
    expect(uniqueSorted(reachable).length + hostOnly.length).toBe(27);
    expect(catalogAdapterIds()).toEqual(uniqueSorted(catalogAdapterIds()));
  });
});
