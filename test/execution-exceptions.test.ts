import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const CFG = join(ROOT, "spec", "config", "execution-exceptions.json");

interface Exception {
  tool: string;
  file: string;
  marker: string;
  reason: string;
  status: string;
}

interface ExceptionsCfg {
  version: number;
  why: string;
  exceptions: Exception[];
  invariants: string[];
}

function load(): ExceptionsCfg {
  return JSON.parse(readFileSync(CFG, "utf8")) as ExceptionsCfg;
}

describe("执行层例外清单（审计 B.5 / D6）", () => {
  const cfg = load();

  it("形状：版本、why、例外数组、每条有理由与标记", () => {
    expect(cfg.version).toBe(1);
    expect(cfg.why.length).toBeGreaterThan(30);
    expect(Array.isArray(cfg.exceptions)).toBe(true);
    expect(cfg.exceptions.length).toBeGreaterThanOrEqual(2);
    for (const e of cfg.exceptions) {
      expect(e.tool.trim().length).toBeGreaterThan(3);
      expect(e.file.trim().length).toBeGreaterThan(3);
      expect(e.marker.trim().length).toBeGreaterThan(2);
      expect(e.reason.trim().length).toBeGreaterThan(20);
      expect(e.status).toBe("documented-bypass");
    }
  });

  it("例外只许是 desktop.* 一族（qq/bili/knowledge 不许登记成例外）", () => {
    for (const e of cfg.exceptions) {
      expect(e.tool.startsWith("desktop."), `不允许的例外工具：${e.tool}`).toBe(true);
    }
    const tools = cfg.exceptions.map((e) => e.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("每条声明的文件存在，且文件里真有 marker（例外还活着）", () => {
    for (const e of cfg.exceptions) {
      const path = join(ROOT, e.file);
      expect(existsSync(path), `文件不存在：${e.file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `${e.tool} 的 marker 不在 ${e.file}`).toContain(e.marker);
    }
  });

  it("desktop.screen 与 desktop.windows 都在清单里（审计点名的两个能力）", () => {
    const tools = cfg.exceptions.map((e) => e.tool);
    expect(tools).toContain("desktop.screen");
    expect(tools).toContain("desktop.windows");
  });

  it("不变量写清楚了：只有 desktop 例外，且 marker 消失即失败", () => {
    const text = cfg.invariants.join("\n");
    expect(text).toContain("desktop.*");
    expect(text).toContain("gateway");
    expect(cfg.invariants.length).toBeGreaterThanOrEqual(3);
  });
});
