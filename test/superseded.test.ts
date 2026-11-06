import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error 门禁脚本是 .mjs，无类型声明；这里要的是可测性，不是类型
import { formatReport, listLedger, loadLedger, validateLedger } from "../tools/lint/superseded.mjs";

/**
 * 「谁取代了谁」台账（spec/config/superseded.json）的校验测试。
 *
 * 这是审计 M12-04 的落地：台账必须机器可读、引用必须可解析、证据必须指得到行。
 * 测法两条：
 *   ① 真实仓库：台账必须零问题（回归保护）
 *   ② 临时夹具：逐条把坏形状喂给 validateLedger，断言错误码（防「校验器只会通过」）
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "tools", "lint", "superseded.mjs");

interface LintError {
  code: string;
  id?: string;
  detail: string;
}
interface LintResult {
  errors: LintError[];
  warnings: string[];
  stats: null | { entries: number; byKind: Record<string, number>; byStatus: Record<string, number>; registryKnobs: number };
}

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "old-thing",
    kind: "spec-section",
    status: "removed",
    supersededBy: ["test:test/x.test.ts"],
    reason: "旧规则被新规则取代，具体见证据行",
    evidence: ["docs/a.md:2"],
    since: "v5.0",
    ...over,
  };
}

/** 造一个最小仓库：注册表 + overlay + 引用文件 + 台账 */
function makeRoot(entries: unknown[], extra?: { engine?: Record<string, unknown>; overlay?: Record<string, unknown> }) {
  const root = mkdtempSync(join(tmpdir(), "soul-superseded-"));
  mkdirSync(join(root, "spec", "config"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "spec", "config", "engine.json"), JSON.stringify(extra?.engine ?? { knobs: { K1: { kind: "number" } } }));
  writeFileSync(join(root, "spec", "config", "v54.overlay.json"), JSON.stringify({ knobs: extra?.overlay ?? {} }));
  writeFileSync(join(root, "docs", "a.md"), "# a\nline2\nline3\nline4\nline5\n");
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "test", "x.test.ts"), "export const t = 1;\n");
  writeFileSync(
    join(root, "spec", "config", "superseded.json"),
    JSON.stringify({ version: 1, updatedAt: "2026-01-01", entries }),
  );
  return root;
}

function check(entries: unknown[], extra?: Parameters<typeof makeRoot>[1]): LintResult {
  const root = makeRoot(entries, extra);
  try {
    const loaded = loadLedger(root);
    expect(loaded.error).toBeUndefined();
    const result = validateLedger(loaded.ledger, { root }) as LintResult;
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const codes = (result: LintResult) => result.errors.map((e) => e.code);

describe("superseded 台账校验", () => {
  it("真实仓库的台账零问题", () => {
    const loaded = loadLedger(ROOT);
    expect(loaded.error).toBeUndefined();
    const result = validateLedger(loaded.ledger, { root: ROOT }) as LintResult;
    expect(result.errors).toEqual([]);
    // 台账不是空壳：至少 10 条，且真的登记了这次审计里最典型的一条
    expect(result.stats?.entries).toBeGreaterThanOrEqual(10);
    const ids = (loaded.ledger.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain("DECAY_RATE");
    expect(ids).toContain("boredom-drive");
    // 注册表规模跟着真仓库走（engine 93 + overlay 34，允许重叠）
    expect(result.stats?.registryKnobs).toBeGreaterThanOrEqual(93);
  });

  it("好条目通过，并且能给出按状态/种类的统计", () => {
    const result = check([baseEntry()]);
    expect(result.errors).toEqual([]);
    expect(result.stats?.entries).toBe(1);
    expect(result.stats?.byStatus.removed).toBe(1);
    expect(result.stats?.byKind["spec-section"]).toBe(1);
  });

  it("knob 引用必须真的在注册表里", () => {
    expect(codes(check([baseEntry({ supersededBy: ["knob:NOPE"] })]))).toContain("unknown-knob");
    expect(check([baseEntry({ supersededBy: ["knob:K1"] })]).errors).toEqual([]);
  });

  it("overlay 里出现的旋钮也算注册表成员", () => {
    const result = check([baseEntry({ supersededBy: ["knob:FROM_OVERLAY"] })], { overlay: { FROM_OVERLAY: { kind: "number" } } });
    expect(result.errors).toEqual([]);
  });

  it("文件引用不存在时报 missing-path，不许指空气", () => {
    expect(codes(check([baseEntry({ supersededBy: ["doc:docs/nope.md"] })]))).toContain("missing-path");
  });

  it("ledger 引用必须指向真实条目", () => {
    expect(codes(check([baseEntry({ supersededBy: ["ledger:ghost"] })]))).toContain("dangling-ledger");
  });

  it("不许指向自己", () => {
    expect(codes(check([baseEntry({ supersededBy: ["ledger:old-thing"] })]))).toContain("self-reference");
  });

  it("链成环要被抓到", () => {
    const a = baseEntry({ id: "a", supersededBy: ["ledger:b"] });
    const b = baseEntry({ id: "b", status: "replaced", supersededBy: ["ledger:a"] });
    expect(codes(check([a, b]))).toContain("cycle");
  });

  it("链停在已删除条目上要报错（那等于没说现在变成什么）", () => {
    const a = baseEntry({ id: "a", supersededBy: ["ledger:b"] });
    const b = baseEntry({ id: "b", status: "removed", supersededBy: ["test:test/x.test.ts"] });
    expect(codes(check([a, b]))).toContain("chain-hits-removed");
  });

  it("链能正常终止时不报错（a→b→test）", () => {
    const a = baseEntry({ id: "a", supersededBy: ["ledger:b"] });
    const b = baseEntry({ id: "b", status: "replaced", supersededBy: ["test:test/x.test.ts"] });
    expect(check([a, b]).errors).toEqual([]);
  });

  it("证据文件必须存在，行号不能超出文件行数", () => {
    expect(codes(check([baseEntry({ evidence: ["docs/nope.md:1"] })]))).toContain("missing-evidence");
    expect(codes(check([baseEntry({ evidence: ["docs/a.md:999"] })]))).toContain("bad-evidence-line");
    expect(check([baseEntry({ evidence: ["docs/a.md:5"] })]).errors).toEqual([]);
  });

  it("证据路径不许是绝对路径或带 ..", () => {
    expect(codes(check([baseEntry({ evidence: ["C:/tmp/x.md:1"] })]))).toContain("bad-evidence-format");
    expect(codes(check([baseEntry({ evidence: ["../x.md:1"] })]))).toContain("bad-evidence-format");
  });

  it("id 重复 / 形状不对要报错", () => {
    expect(codes(check([baseEntry(), baseEntry()]))).toContain("duplicate-id");
    expect(codes(check([baseEntry({ id: "带空格 的 id" })]))).toContain("bad-id");
  });

  it("kind/status 必须在枚举里，reason 不能敷衍", () => {
    expect(codes(check([baseEntry({ kind: "nonsense" })]))).toContain("bad-kind");
    expect(codes(check([baseEntry({ status: "gone" })]))).toContain("bad-status");
    expect(codes(check([baseEntry({ reason: "旧" })]))).toContain("short-reason");
  });

  it("supersededBy 不能为空，since 不能为空", () => {
    expect(codes(check([baseEntry({ supersededBy: [] })]))).toContain("empty-superseded-by");
    expect(codes(check([baseEntry({ since: " " })]))).toContain("missing-since");
  });

  it("顶层形状不对要报错（version / entries）", () => {
    const root = makeRoot([]);
    try {
      const loaded = loadLedger(root);
      expect((validateLedger({ version: 2, entries: [baseEntry()] }, { root }) as LintResult).errors.map((e) => e.code)).toContain(
        "ledger-shape",
      );
      expect((validateLedger({ version: 1, entries: [] }, { root }) as LintResult).errors.map((e) => e.code)).toContain("ledger-shape");
      expect(loaded.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("台账文件缺失时 loadLedger 给出 ledger-missing（不是抛异常）", () => {
    const root = mkdtempSync(join(tmpdir(), "soul-superseded-empty-"));
    try {
      const loaded = loadLedger(root);
      expect(loaded.error?.code).toBe("ledger-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formatReport / listLedger 是人读的输出，不含 undefined", () => {
    const ok = check([baseEntry()]);
    expect(formatReport(ok)).toContain("✓ superseded 台账");
    const loaded = loadLedger(ROOT);
    expect(listLedger(loaded.ledger)).toContain("DECAY_RATE");
  });
});

describe("superseded CLI", () => {
  it("真实仓库 exit 0", () => {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
    expect(out).toContain("✓ superseded 台账");
  });

  it("--json 可解析，且列出每条错误码", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--json"], { cwd: ROOT, encoding: "utf8" });
    const parsed = JSON.parse(out) as { ok: boolean; errors: LintError[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("坏夹具 exit 1，缺台账 exit 2", () => {
    const root = makeRoot([baseEntry({ supersededBy: ["knob:NOPE"] })]);
    try {
      let code = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", stdio: "pipe" });
      } catch (err) {
        code = Number((err as { status?: number }).status);
      }
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const empty = mkdtempSync(join(tmpdir(), "soul-superseded-nofile-"));
    try {
      let code = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, "--root", empty], { encoding: "utf8", stdio: "pipe" });
      } catch (err) {
        code = Number((err as { status?: number }).status);
      }
      expect(code).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
