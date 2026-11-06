import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { diffConfig, type ConfigSnapshot } from "../src/engine/config-diff.js";

function knob(value: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { value, valueText: String(value), kind: typeof value === "number" ? "number" : "text", ...extra };
}

function snap(
  engine: Record<string, unknown> = {},
  overlay: Record<string, unknown> = {},
): ConfigSnapshot {
  return { engine, overlay };
}

describe("config-diff：对齐与分类", () => {
  it("无变化 → 空结果 + 明确的 summary", () => {
    const s = snap({ A: knob(1), B: knob("x") });
    const r = diffConfig(s, s);
    expect(r.entries).toEqual([]);
    expect(r.summary).toContain("无变化");
  });

  it("新增/删除/修改各自计数，值用 value（不是 valueText）比较", () => {
    const base = snap({ A: knob(1), B: knob(2), C: knob("旧") });
    const head = snap({ A: knob(1), B: knob(3), D: knob(4), C: knob({ valueText: "旧", value: "新" }) });
    const r = diffConfig(base, head);
    expect([r.added, r.removed, r.changed]).toEqual([1, 0, 2]);
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    expect(byName.get("D")?.status).toBe("added");
    expect(byName.get("C")?.status).toBe("changed");
    expect(byName.get("B")?.status).toBe("changed");
  });

  it("overlay 覆盖 engine 时生效源是 overlay，并记录 owner/readers", () => {
    const base = snap({ A: knob(1) });
    const head = snap(
      { A: knob(1) },
      { A: knob(2, { owner: "MemoryStore", readers: ["MemoryStore", "Orchestrator"] }) },
    );
    const r = diffConfig(base, head);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    expect(e.name).toBe("A");
    expect(e.status).toBe("changed");
    expect(e.source).toBe("overlay");
    expect(e.owner).toBe("MemoryStore");
    expect(e.readers).toBe(2);
    expect(e.flags).toEqual(["shadow"]); // engine 与 overlay 同名（text 占位升级之外算冲突，注册表检查另行报）
  });

  it("overlay 新键缺 owner → unregistered；readers 空 → dead", () => {
    const head = snap({}, { X: knob(1), Y: knob(2, { owner: "MemoryStore", readers: [] }) });
    const r = diffConfig(snap(), head);
    expect(r.entries.map((e) => e.name)).toEqual(["X", "Y"]);
    expect(r.entries[0]?.flags).toContain("unregistered");
    expect(r.entries[1]?.flags).toContain("dead");
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain("没有登记 owner");
  });

  it("engine 基线没有 owner/readers 不算问题（v5.3 附录 A 形态）", () => {
    const r = diffConfig(snap({ A: knob(1) }), snap({ A: knob(2) }));
    expect(r.entries[0]?.flags).toEqual([]);
    expect(r.owner).toBeUndefined();
    expect(r.problems).toEqual([]);
  });

  it("浮点抖动不算修改，字符串/对象按结构比较", () => {
    const base = snap({ F: knob(0.1 + 0.2), O: knob({ a: 1, b: [1, 2] }) });
    const head = snap({ F: knob(0.3), O: knob({ b: [1, 2], a: 1 }) });
    expect(diffConfig(base, head).entries).toEqual([]);
  });

  it("行文本带上 owner/readers/来源，便于 10 秒扫一眼", () => {
    const r = diffConfig(snap(), snap({}, { K: knob(1, { owner: "Firewall", readers: ["Firewall"] }) }));
    const line = r.entries[0]?.line ?? "";
    expect(line).toContain("+ K =");
    expect(line).toContain("owner=Firewall");
    expect(line).toContain("readers=1");
    expect(line).toContain("源=overlay");
  });
});

describe("config-diff：CLI 读真实文件", () => {
  it("两个目录快照对比（不需要 git）", () => {
    const dirA = mkdtempSync(join(tmpdir(), "cfg-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "cfg-b-"));
    for (const [dir, decay, extra] of [
      [dirA, 0.7, {}],
      [dirB, 0.5, { NEW_KNOB: knob(1, { owner: "Firewall", readers: ["Firewall"] }) }],
    ]) {
      mkdirSync(join(dir, "spec", "config"), { recursive: true });
      writeFileSync(
        join(dir, "spec", "config", "engine.json"),
        JSON.stringify({ knobs: { DECAY_RATE: knob(decay) } }),
        "utf8",
      );
      writeFileSync(
        join(dir, "spec", "config", "v54.overlay.json"),
        JSON.stringify({ knobs: extra }),
        "utf8",
      );
    }
    const out = execFileSync(
      process.execPath,
      [join(process.cwd(), "tools", "config", "diff.mjs"), "--base", dirA, "--head", dirB, "--json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out) as { changed: number; added: number; entries: { name: string }[] };
    expect(parsed.changed).toBe(1);
    expect(parsed.added).toBe(1);
    expect(parsed.entries.map((e) => e.name).sort()).toEqual(["DECAY_RATE", "NEW_KNOB"]);
  });
});
