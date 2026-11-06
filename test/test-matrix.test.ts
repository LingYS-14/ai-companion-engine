/**
 * 测试矩阵台账的规则测试（M11-01，F163）。
 *
 * 这里测两份东西：
 *   1. 真实仓库的 `spec/config/test-matrix.json` 是否自洽（78 条编号、证据路径真实存在、
 *      missing 都有理由、与基线不倒退）；
 *   2. 检查器本身——**坏台账必须被抓住**，否则它就是另一块装饰门（F117/F138 同类）。
 *      每个用例只改一处坏，确保错误码指向真正的原因。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BASELINE_PATH,
  MATRIX_PATH,
  SPEC_IDS,
  checkBaseline,
  loadBaseline,
  loadMatrix,
  summarize,
  validateMatrix,
} from "../tools/lint/test-matrix.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ALL_IDS = Object.values(SPEC_IDS).flat();

let dir: string;

/** 造一个"全部 missing、理由都写清"的最小合法台账，供逐条注入坏数据。 */
function fixtureLedger() {
  const entries = ALL_IDS.map((id) => ({
    id,
    group: id.charAt(0),
    title: `占位标题 ${id}`,
    status: "missing",
    evidence: [],
    note: "尚未覆盖：这是测试夹具里的一行占位说明",
  }));
  return { version: 1, statuses: ["covered", "partial", "missing"], groups: { T: 8, P: 12, L: 10, O: 5, A: 26, B: 17 }, entries };
}

function writeFixture(ledger: unknown, baseline?: unknown) {
  mkdirSync(join(dir, "spec", "config"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "placeholder.test.ts"), "// 夹具里的证据文件\n", "utf8");
  writeFileSync(join(dir, MATRIX_PATH), JSON.stringify(ledger, null, 2), "utf8");
  writeFileSync(
    join(dir, BASELINE_PATH),
    JSON.stringify(baseline ?? { version: 1, counts: { covered: 0, partial: 0, missing: ALL_IDS.length } }, null, 2),
    "utf8",
  );
}

function codes(errors: { code: string }[]): string[] {
  return errors.map((e) => e.code);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "soul-matrix-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("测试矩阵：真实仓库的台账", () => {
  it("78 条编号齐全，分组计数与 §11 一致，证据路径都真实存在", () => {
    const loaded = loadMatrix(ROOT);
    expect(loaded.ok, "台账必须能读").toBe(true);
    if (!loaded.ok) return;
    const checked = validateMatrix(loaded.ledger, ROOT);
    expect(checked.errors.map((e) => `[${e.code}] ${e.message}`)).toEqual([]);
    expect(checked.stats?.total).toBe(78);
    expect(checked.stats?.byGroup).toEqual({ T: 8, P: 12, L: 10, O: 5, A: 26, B: 17 });
    expect(checked.stats?.counts.covered).toBeGreaterThan(0);
  });

  it("missing 的 13 条都写清了为什么缺（不许空口说缺）", () => {
    const loaded = loadMatrix(ROOT);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const stats = summarize(loaded.ledger);
    // F164 审计后：原有 10 条 + A03（无 flag 载体）/ A23（无 temperature_fn 旋钮）/ B3-D（无并发读测试）
    expect(stats.gaps).toEqual([
      "T7", "P1", "P3", "P10", "L8", "O3",
      "A03", "A14", "A16", "A23", "A24", "A25",
      "B3-D",
    ]);
    for (const entry of loaded.ledger.entries.filter((e: { status: string }) => e.status === "missing")) {
      expect(String(entry.note).trim().length, `${entry.id} 的 note 太短`).toBeGreaterThanOrEqual(8);
    }
  });

  it("与基线一致时棘轮通过（covered 31 / partial 34 / missing 13，F164 审计后）", () => {
    const loaded = loadMatrix(ROOT);
    const baseline = loadBaseline(ROOT);
    expect(loaded.ok && baseline.ok).toBe(true);
    if (!loaded.ok || !baseline.ok) return;
    const stats = summarize(loaded.ledger);
    expect(stats.counts).toEqual({ covered: 31, partial: 34, missing: 13 });
    expect(checkBaseline(stats, baseline.baseline).ok).toBe(true);
  });
});

describe("测试矩阵：坏台账必须被抓住", () => {
  it("规格外的编号 → bad-id", () => {
    const ledger = fixtureLedger();
    ledger.entries.push({ id: "T99", group: "T", title: "伪造", status: "missing", evidence: [], note: "不该存在的编号占位说明" });
    writeFixture(ledger);
    const checked = validateMatrix(ledger, dir);
    expect(codes(checked.errors)).toContain("bad-id");
  });

  it("重复编号 → duplicate-id", () => {
    const ledger = fixtureLedger();
    ledger.entries.push({ ...ledger.entries[0] });
    writeFixture(ledger);
    expect(codes(validateMatrix(ledger, dir).errors)).toContain("duplicate-id");
  });

  it("漏掉一条编号 → missing-id", () => {
    const ledger = fixtureLedger();
    ledger.entries = ledger.entries.filter((e: { id: string }) => e.id !== "A05");
    writeFixture(ledger);
    const errors = validateMatrix(ledger, dir).errors;
    expect(codes(errors)).toContain("missing-id");
    expect(errors.some((e) => e.message.includes("A05"))).toBe(true);
  });

  it("分组字段写错 → bad-group", () => {
    const ledger = fixtureLedger();
    ledger.entries[0].group = "P";
    writeFixture(ledger);
    expect(codes(validateMatrix(ledger, dir).errors)).toContain("bad-group");
  });

  it("标 covered 却不给证据 → missing-evidence", () => {
    const ledger = fixtureLedger();
    ledger.entries[0] = { ...ledger.entries[0], status: "covered", evidence: [], note: "" };
    writeFixture(ledger);
    expect(codes(validateMatrix(ledger, dir).errors)).toContain("missing-evidence");
  });

  it("证据路径不存在 → missing-path（防「我写了就有覆盖」）", () => {
    const ledger = fixtureLedger();
    ledger.entries[0] = { ...ledger.entries[0], status: "covered", evidence: ["test/不存在.test.ts"], note: "" };
    writeFixture(ledger);
    const errors = validateMatrix(ledger, dir).errors;
    expect(codes(errors)).toContain("missing-path");
    expect(errors.some((e) => e.message.includes("不存在"))).toBe(true);
  });

  it("标 missing 却不写理由 → missing-note", () => {
    const ledger = fixtureLedger();
    ledger.entries[0] = { ...ledger.entries[0], note: "" };
    writeFixture(ledger);
    expect(codes(validateMatrix(ledger, dir).errors)).toContain("missing-note");
  });

  it("状态写成自造值 → bad-status", () => {
    const ledger = fixtureLedger();
    ledger.entries[0].status = "done";
    writeFixture(ledger);
    expect(codes(validateMatrix(ledger, dir).errors)).toContain("bad-status");
  });
});

describe("测试矩阵：棘轮（不许悄悄降覆盖）", () => {
  it("covered 比基线少 → coverage-regress", () => {
    const ledger = fixtureLedger();
    ledger.entries[0] = { ...ledger.entries[0], status: "covered", evidence: ["test/placeholder.test.ts"], note: "" };
    const stats = summarize(ledger);
    const result = checkBaseline(stats, { version: 1, counts: { covered: 2, partial: 0, missing: 77 } });
    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain("coverage-regress");
  });

  it("missing 比基线多 → coverage-regress（新增未覆盖项要显式接受）", () => {
    const ledger = fixtureLedger();
    const stats = summarize(ledger);
    const result = checkBaseline(stats, { version: 1, counts: { covered: 0, partial: 0, missing: 70 } });
    expect(result.ok).toBe(false);
  });

  it("只增不减（covered 变多）→ 通过", () => {
    const ledger = fixtureLedger();
    ledger.entries[0] = { ...ledger.entries[0], status: "covered", evidence: ["test/placeholder.test.ts"], note: "" };
    const stats = summarize(ledger);
    expect(checkBaseline(stats, { version: 1, counts: { covered: 0, partial: 0, missing: 78 } }).ok).toBe(true);
  });
});

describe("测试矩阵：CLI", () => {
  it("--gaps 打印未覆盖项并以 0 退出（missing 是事实不是失败）", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "tools", "lint", "test-matrix.mjs"), "--gaps"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("missing T7");
    expect(result.stdout).toContain("missing A25");
  });

  it("坏台账 → 退出码 1", () => {
    mkdirSync(join(dir, "spec", "config"), { recursive: true });
    writeFileSync(join(dir, MATRIX_PATH), "{ 不是 JSON", "utf8");
    const result = spawnSync(process.execPath, [join(ROOT, "tools", "lint", "test-matrix.mjs"), "--root", dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("matrix-bad-json");
  });
});
